import type { WssMarketEvent } from "../event-bus/event-bus.ts";
import { BookStore } from "./book-store.ts";
import type { YesTokenResolver } from "./yes-token-resolver.ts";

/**
 * Pulls a *live* implied probability in `[0, 1]` out of a WSS event, or
 * returns `null` if the current book is too thin/wide to trust.
 *
 * Realtime book maintenance
 * -------------------------
 * Polymarket sends:
 *   - `book`         — full snapshot. Replaces our local book.
 *   - `price_change` — single-level delta. Mutates our local book.
 *
 * We maintain a local YES-token book in `BookStore` and recompute the mid
 * on *every* event, including deltas. Without this, mid-price would only
 * refresh whenever Polymarket happened to resend a snapshot — which can be
 * tens of seconds apart on quiet markets.
 *
 * Source policy
 * -------------
 * Only events for the YES asset_id contribute. `last_trade_price` events
 * are not used for probability triggering — a single fill on a thin book
 * can spike the last-trade far away from where the market really is.
 *
 * Thin-book guard
 * ---------------
 *   - `maxSpread`        — reject if (best_ask - best_bid) > maxSpread
 *   - `minTopSize`       — reject if min(bestBidSize, bestAskSize) < minTopSize
 *   - `requireBothSides` — if true (default), reject when only one side has depth
 */
export interface ProbabilityExtractor {
  extract(event: WssMarketEvent): number | null;
}

export interface ProbabilityFilterOptions {
  /**
   * Maximum spread for using the mid-price. If (best_ask - best_bid) > maxSpread,
   * falls back to last trade price instead. Matches Polymarket's own display logic
   * (they use $0.10 / 10 cents as the threshold). Set to 1 to always use mid.
   */
  readonly maxSpread: number;
  /** Minimum size required at *both* the best bid and the best ask. */
  readonly minTopSize: number;
  /** If true, both sides of the book must be present; if false, fall back to the live side. */
  readonly requireBothSides: boolean;
  /**
   * Maximum tolerated absolute jump between consecutive mids on the same
   * asset. A jump larger than this almost always means we mis-applied a
   * delta or dropped one — the local book is suspect and a resync is
   * scheduled. Set to 1 (or higher) to disable.
   */
  readonly maxMidJump: number;
}

export const DEFAULT_FILTER_OPTIONS: ProbabilityFilterOptions = {
  maxSpread: 0.1,
  minTopSize: 0,
  requireBothSides: true,
  maxMidJump: 0.2,
};

/**
 * Reasons the extractor decided the local book looks suspect and asked
 * for a resync. Mirrored to the {@link SuspectBookHandler} callback so
 * callers can route to {@link BookSynchronizer.requestResync} (or just
 * log) without leaking the synchronizer into the extractor.
 */
export type SuspectReason =
  | "crossed-book" // bestBid >= bestAsk
  | "negative-spread" // ask < bid by any amount
  | "mid-out-of-range" // mid < 0 or mid > 1
  | "mid-jump"; // |prevMid - newMid| > maxMidJump

export type SuspectBookHandler = (
  assetId: string,
  reason: SuspectReason,
) => void;

/**
 * Fired every time the extractor produces a *clean* mid for a YES book.
 * `slug` is the human-readable market identifier from the trigger key;
 * `assetId` is the YES token address; `mid` is the implied probability in [0,1].
 */
export type MidUpdateHandler = (
  slug: string,
  assetId: string,
  mid: number,
) => void;

export class PolymarketProbabilityExtractor implements ProbabilityExtractor {
  private readonly opts: ProbabilityFilterOptions;
  private readonly books: BookStore;
  private readonly onSuspect: SuspectBookHandler | null;
  private readonly onMid: MidUpdateHandler | null;
  /** Last *valid* mid we returned per asset, used for the jump-detector. */
  private readonly lastMid = new Map<string, number>();

  constructor(
    private readonly yesTokens: YesTokenResolver,
    opts: Partial<ProbabilityFilterOptions> = {},
    books?: BookStore,
    onSuspect?: SuspectBookHandler,
    onMid?: MidUpdateHandler,
  ) {
    this.opts = { ...DEFAULT_FILTER_OPTIONS, ...opts };
    this.books = books ?? new BookStore();
    this.onSuspect = onSuspect ?? null;
    this.onMid = onMid ?? null;
  }

  extract(event: WssMarketEvent): number | null {
    // 1. Maintain the local book regardless of strategy outcome. We must
    //    apply deltas even when no probability can be returned right now,
    //    or the next snapshot-less tick will read a stale book.
    const touchedAssetIds = this.books.ingest(event);

    // 2. Identify the YES asset for this trigger. Until the YES token is
    //    resolved we can't compute a probability, but ingestion above has
    //    already happened so no information is lost.
    const yesAssetId = this.yesTokens.get(event.trigger);
    if (!yesAssetId) return null;

    // 3. Only react when the YES book was among the touched assets.
    if (!touchedAssetIds.includes(yesAssetId)) return null;

    const book = this.books.get(yesAssetId);
    if (!book || !book.hasAnyDepth()) return null;

    const bid = book.bestBid();
    const ask = book.bestAsk();
    const lastTradePrice = this.books.getLastTradePrice(yesAssetId);

    // 4. Sanity checks. A book that is crossed, has a negative spread, or
    //    produces a mid outside [0, 1] is almost certainly the result of
    //    a dropped delta, an out-of-order update, or a mis-applied size.
    //    Don't trust it for triggering, and ask the synchronizer to fetch
    //    a fresh snapshot. We *do not* clear `lastMid` — once the resync
    //    lands the next event will reset it on a known-good mid.
    if (bid && ask) {
      if (bid.price > ask.price) {
        this.flag(yesAssetId, "crossed-book");
        return null;
      }
      if (ask.price < bid.price) {
        // Equivalent to crossed-book in our scalar model, kept distinct
        // so monitoring can tell which invariant tripped.
        this.flag(yesAssetId, "negative-spread");
        return null;
      }
    }

    const mid = applyFilters(bid, ask, lastTradePrice, this.opts);
    if (mid === null) {
      this.logRejection(yesAssetId, event.trigger.slug, bid, ask);
      return null;
    }

    if (mid < 0 || mid > 1) {
      this.flag(yesAssetId, "mid-out-of-range");
      return null;
    }

    // 5. Jump detector. Real Polymarket markets do move fast, but a
    //    *single tick* moving the mid by more than `maxMidJump` is far
    //    more likely to be local-state corruption than a real fill. We
    //    return null *and* request a resync so the next decision is made
    //    against a known-good book.
    const prev = this.lastMid.get(yesAssetId);
    if (prev !== undefined && Math.abs(prev - mid) > this.opts.maxMidJump) {
      this.flag(yesAssetId, "mid-jump");
      return null;
    }
    this.lastMid.set(yesAssetId, mid);
    this.onMid?.(event.trigger.slug, yesAssetId, mid);
    return mid;
  }

  private flag(assetId: string, reason: SuspectReason): void {
    if (this.onSuspect) this.onSuspect(assetId, reason);
  }

  /**
   * Throttled (1/s/asset) log so we can see when filter settings are
   * silently dropping every tick — without this, a misconfigured
   * `maxSpread` or `requireBothSides` causes strategies to never fire
   * and there's no observable signal anywhere.
   */
  private readonly lastRejectLogAt = new Map<string, number>();
  private logRejection(
    assetId: string,
    slug: string,
    bid: { price: number; size: number } | null,
    ask: { price: number; size: number } | null,
  ): void {
    const now = Date.now();
    const last = this.lastRejectLogAt.get(assetId) ?? 0;
    if (now - last < 1000) return;
    this.lastRejectLogAt.set(assetId, now);
    const spread = bid && ask ? (ask.price - bid.price).toFixed(4) : "n/a";
    console.warn(
      `[extractor] rejected tick for ${slug} — ` +
        `bid=${bid ? `${bid.price}@${bid.size}` : "∅"} ` +
        `ask=${ask ? `${ask.price}@${ask.size}` : "∅"} ` +
        `spread=${spread} (filters: requireBothSides=${this.opts.requireBothSides}, ` +
        `maxSpread=${this.opts.maxSpread}, minTopSize=${this.opts.minTopSize})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function applyFilters(
  bid: { price: number; size: number } | null,
  ask: { price: number; size: number } | null,
  lastTradePrice: number | null,
  opts: ProbabilityFilterOptions,
): number | null {
  if (opts.requireBothSides && (!bid || !ask)) return null;

  if (bid && ask) {
    const spread = ask.price - bid.price;
    if (spread < 0) return null; // crossed/malformed book — don't trust it
    if (
      opts.minTopSize > 0 &&
      (bid.size < opts.minTopSize || ask.size < opts.minTopSize)
    ) {
      return null;
    }
    // Polymarket display rule: mid if spread ≤ maxSpread, else last trade price.
    if (spread <= opts.maxSpread) {
      return clamp01((bid.price + ask.price) / 2);
    }
    return lastTradePrice !== null ? clamp01(lastTradePrice) : null;
  }

  // One-sided book and the caller is OK with that.
  if (bid) {
    if (opts.minTopSize > 0 && bid.size < opts.minTopSize) return null;
    return clamp01(bid.price);
  }
  if (ask) {
    if (opts.minTopSize > 0 && ask.size < opts.minTopSize) return null;
    return clamp01(ask.price);
  }
  return null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
