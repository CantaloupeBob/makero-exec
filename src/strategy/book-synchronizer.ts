import type { ClobClient } from "@polymarket/clob-client-v2";
import type { BookStore } from "./book-store.ts";

/**
 * Refetches a fresh snapshot for an asset. Default impl wraps the CLOB SDK's
 * REST `getOrderBook`. Returns the parsed levels plus the upstream hash.
 *
 * Abstracted so the synchronizer is unit-testable without the SDK.
 */
export interface BookResyncer {
  resync(assetId: string): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
    hash: string | null;
  }>;
}

export class SdkBookResyncer implements BookResyncer {
  constructor(private readonly client: ClobClient) {}
  async resync(assetId: string) {
    const book = await this.client.getOrderBook(assetId);
    return {
      bids: (book.bids ?? [])
        .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size)),
      asks: (book.asks ?? [])
        .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size)),
      hash: book.hash ?? null,
    };
  }
}

// ---------------------------------------------------------------------------

export interface BookSynchronizerOptions {
  /**
   * Periodically refresh every tracked book even if no drift is suspected.
   * This is our primary integrity guarantee against silently lost deltas,
   * mis-applied messages, or quiet-market staleness. Set to 0 to disable.
   */
  readonly periodicRefreshMs: number;
  /**
   * Minimum gap between consecutive resyncs of the *same* asset. Prevents
   * a flapping book or a chatty caller from triggering a REST stampede.
   */
  readonly minResyncIntervalMs: number;
  /**
   * Stagger periodic refreshes across tracked assets to avoid thundering
   * the REST endpoint when many assets are tracked. Each asset gets a
   * uniform jitter in [0, jitterMs) on its first periodic tick.
   */
  readonly periodicJitterMs: number;
}

export const DEFAULT_SYNCHRONIZER_OPTIONS: BookSynchronizerOptions = {
  periodicRefreshMs: 5 * 60_000,
  minResyncIntervalMs: 5_000,
  periodicJitterMs: 30_000,
};

export type ResyncReason = "periodic" | "suspect" | "reconnect" | "manual";

/**
 * Owns book-integrity policy. Two responsibilities:
 *
 *   1. **Scheduled refresh**: every `periodicRefreshMs`, fetch a fresh
 *      REST snapshot for every tracked asset and overwrite the local book.
 *      This is the only mechanism that *guarantees* convergence with
 *      upstream truth — Polymarket's `hash` field is `sha1(JSON(orderbook))`
 *      including server-side metadata (timestamp, tick_size, …) that we
 *      can't reproduce locally, so per-delta hash verification is unreliable.
 *
 *   2. **On-demand refresh**: callers (WSS layer on reconnect, monitors
 *      that detect suspect data) call `requestResync(assetId, reason)`.
 *      Concurrent calls coalesce; rapid calls debounce.
 *
 * A resync replaces the local book wholesale via `BookStore.replaceFromSnapshot`.
 * Deltas that arrive during the in-flight REST call are still ingested into
 * the (about-to-be-replaced) book; the next periodic/suspect resync re-aligns
 * us if any were missed.
 */
export class BookSynchronizer {
  private readonly opts: BookSynchronizerOptions;
  private readonly tracked = new Set<string>();
  private readonly assetTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly assetTimeouts = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly lastResyncAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private started = false;
  private stopped = false;

  constructor(
    private readonly store: BookStore,
    private readonly resyncer: BookResyncer,
    opts: Partial<BookSynchronizerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SYNCHRONIZER_OPTIONS, ...opts };
  }

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    for (const assetId of this.tracked) this.armTimer(assetId);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.assetTimers.values()) clearInterval(t);
    for (const t of this.assetTimeouts.values()) clearTimeout(t);
    this.assetTimers.clear();
    this.assetTimeouts.clear();
  }

  /**
   * Tell the synchronizer to keep this asset healthy. Idempotent.
   * If `start()` has already been called, immediately kicks off an
   * initial resync (so we have a known-good baseline) and arms the
   * periodic timer.
   */
  track(assetId: string): void {
    if (this.tracked.has(assetId)) return;
    this.tracked.add(assetId);
    if (this.started && !this.stopped) {
      void this.requestResync(assetId, "manual");
      this.armTimer(assetId);
    }
  }

  /** Stop tracking. Idempotent. Local book state is preserved. */
  untrack(assetId: string): void {
    this.tracked.delete(assetId);
    const i = this.assetTimers.get(assetId);
    if (i) {
      clearInterval(i);
      this.assetTimers.delete(assetId);
    }
    const t = this.assetTimeouts.get(assetId);
    if (t) {
      clearTimeout(t);
      this.assetTimeouts.delete(assetId);
    }
  }

  /**
   * Public hook for callers that have reason to believe the local book may
   * be stale (WSS reconnect, observed gap, downstream consumer flagged
   * implausible value, etc.). Returns the in-flight or scheduled resync
   * promise so callers can await if they want.
   */
  requestResync(assetId: string, reason: ResyncReason): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.inflight.get(assetId);
    if (existing) return existing;

    const last = this.lastResyncAt.get(assetId) ?? 0;
    const since = Date.now() - last;
    if (reason !== "periodic" && since < this.opts.minResyncIntervalMs) {
      return Promise.resolve(); // debounced
    }

    const p = this.doResync(assetId, reason).finally(() =>
      this.inflight.delete(assetId),
    );
    this.inflight.set(assetId, p);
    return p;
  }

  /** Force a resync of every tracked asset (e.g. on WSS reconnect). */
  async resyncAll(reason: ResyncReason = "reconnect"): Promise<void> {
    await Promise.all(
      Array.from(this.tracked).map((id) => this.requestResync(id, reason)),
    );
  }

  // -------------------------------------------------------------------------

  private armTimer(assetId: string): void {
    if (this.opts.periodicRefreshMs <= 0) return;
    if (this.assetTimers.has(assetId) || this.assetTimeouts.has(assetId))
      return;
    const jitter = Math.floor(
      Math.random() * Math.max(1, this.opts.periodicJitterMs),
    );
    const initial = setTimeout(() => {
      this.assetTimeouts.delete(assetId);
      if (this.stopped || !this.tracked.has(assetId)) return;
      const interval = setInterval(() => {
        if (this.stopped || !this.tracked.has(assetId)) return;
        void this.requestResync(assetId, "periodic");
      }, this.opts.periodicRefreshMs);
      this.assetTimers.set(assetId, interval);
    }, jitter);
    this.assetTimeouts.set(assetId, initial);
  }

  private async doResync(assetId: string, reason: ResyncReason): Promise<void> {
    try {
      const fresh = await this.resyncer.resync(assetId);
      this.store.replaceFromSnapshot(
        assetId,
        fresh.bids,
        fresh.asks,
        fresh.hash,
      );
      this.lastResyncAt.set(assetId, Date.now());
      if (reason !== "periodic") {
        console.warn(
          `[book-sync] resynced ${assetId} (${reason}) — bids=${fresh.bids.length} asks=${fresh.asks.length}`,
        );
      }
    } catch (err) {
      console.warn(
        `[book-sync] resync failed for ${assetId} (${reason}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
