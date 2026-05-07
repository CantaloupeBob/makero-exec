import type { ClobClient } from "@polymarket/clob-client-v2";
import type { TriggerKey } from "../wss/triggers/trigger-key.ts";

/**
 * Snapshot of a Polymarket market's lifecycle state. We treat the market
 * as "ended" (i.e. no further strategies should fire on it) when EITHER
 * `closed` is true OR `acceptingOrders` is false.
 *
 *   - `closed === true`            — market has resolved; book updates after
 *     this point are post-resolution noise (cancellations, expired GTCs).
 *   - `acceptingOrders === false`  — market is in the resolution window;
 *     no new orders accepted, so the book reflects only stale resting
 *     orders being torn down. NOT safe to fire on.
 *
 * `endDateIso` is informational only — it's frequently wrong (set days
 * after the actual close) for short-lived expiry markets like the
 * `btc-updown-5m-*` series. Do not use it as the primary gate.
 */
export interface MarketStatus {
  readonly closed: boolean;
  readonly acceptingOrders: boolean;
  readonly endDateIso: string | null;
  /** Convenience: closed || !acceptingOrders. */
  readonly ended: boolean;
}

interface CacheEntry {
  status: MarketStatus;
  fetchedAt: number;
}

/**
 * Fetches and caches market lifecycle status from the CLOB REST API.
 * Used by the bootstrap loop to evict armed strategies whose underlying
 * market has resolved, so post-resolution book noise can't cause spurious
 * fires (a single stale 0.99 bid with no asks would otherwise trip a
 * `>= 99%` strategy minutes after the market actually closed).
 *
 * Cache TTL is intentionally short (15s) so we react quickly when a
 * market closes, but not so short that we hammer the REST endpoint.
 */
export class MarketStatusResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<MarketStatus>>();
  private readonly ttlMs: number;

  constructor(
    private readonly client: ClobClient,
    opts: { ttlMs?: number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 15_000;
  }

  /**
   * Synchronous lookup. Returns the cached status if fresh, else null.
   * Callers in hot paths (e.g. the engine tick handler) should use this
   * and let the periodic background refresh keep it warm.
   */
  get(conditionId: string): MarketStatus | null {
    const entry = this.cache.get(conditionId);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > this.ttlMs) return null;
    return entry.status;
  }

  /** Fetch (or return cached) status. Coalesces concurrent calls. */
  async resolve(trigger: TriggerKey): Promise<MarketStatus> {
    const fresh = this.get(trigger.conditionId);
    if (fresh) return fresh;

    const inflight = this.inflight.get(trigger.conditionId);
    if (inflight) return inflight;

    const p = this.fetch(trigger).finally(() => {
      this.inflight.delete(trigger.conditionId);
    });
    this.inflight.set(trigger.conditionId, p);
    return p;
  }

  /** Drop the cache entry so the next call re-fetches. */
  invalidate(conditionId: string): void {
    this.cache.delete(conditionId);
  }

  private async fetch(trigger: TriggerKey): Promise<MarketStatus> {
    if (trigger.provider !== "polymarket") {
      throw new Error(
        `MarketStatusResolver only supports polymarket; got ${trigger.id}`,
      );
    }
    // SDK types this as `Promise<any>`. Shape mirrors GET /markets/<id>.
    const raw: unknown = await this.client.getMarket(trigger.conditionId);
    const obj = (raw ?? {}) as Record<string, unknown>;
    const closed = obj.closed === true;
    const acceptingOrders = obj.accepting_orders !== false; // default to true if absent
    const endDateIso =
      typeof obj.end_date_iso === "string" ? obj.end_date_iso : null;
    const status: MarketStatus = {
      closed,
      acceptingOrders,
      endDateIso,
      ended: closed || !acceptingOrders,
    };
    this.cache.set(trigger.conditionId, {
      status,
      fetchedAt: Date.now(),
    });
    return status;
  }
}
