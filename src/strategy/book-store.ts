import type { WssMarketEvent } from "../event-bus/event-bus.ts";
import { BookState } from "./book-state.ts";

/**
 * Maintains one `BookState` per Polymarket asset_id. The strategy layer only
 * cares about the YES token book, but `BookStore` is asset-agnostic — the
 * caller decides which asset_ids to track by ingesting events for them.
 *
 * Ingestion is idempotent and side-effect free outside of the per-asset
 * `BookState`. A snapshot fully replaces the book; a delta mutates one level.
 */
export class BookStore {
  private readonly books = new Map<string, BookState>();
  /** Last upstream `hash` we observed per asset_id, if any. */
  private readonly lastHash = new Map<string, string>();

  /**
   * Ingest a WSS event. Returns the asset_id whose book was touched, or
   * `null` if the event carried nothing the store could use.
   */
  /**
   * Ingest a WSS event. Returns the set of asset_ids whose books were touched
   * (may be empty). For `book` events this is always one id; for `price_change`
   * it can be multiple if the payload is batched.
   */
  ingest(event: WssMarketEvent): string[] {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") return [];

    switch (event.type) {
      case "book": {
        const assetId =
          typeof payload["asset_id"] === "string" ? payload["asset_id"] : null;
        if (!assetId) return [];
        if (!this.applySnapshot(assetId, payload)) return [];
        if (typeof payload["hash"] === "string") {
          this.lastHash.set(assetId, payload["hash"]);
        }
        return [assetId];
      }
      case "price_change":
        return this.applyPriceChangePayload(payload);
      default:
        return [];
    }
  }

  /** Read-only access to the book for a given asset. */
  get(assetId: string): BookState | null {
    return this.books.get(assetId) ?? null;
  }

  /** Most recent upstream `hash` observed for the asset, if any. */
  getLastHash(assetId: string): string | null {
    return this.lastHash.get(assetId) ?? null;
  }

  /**
   * Replace a book with a freshly-fetched snapshot (e.g. from REST resync).
   * Also resets the recorded upstream hash to match.
   */
  replaceFromSnapshot(
    assetId: string,
    bids: ReadonlyArray<{ price: number; size: number }>,
    asks: ReadonlyArray<{ price: number; size: number }>,
    hash: string | null,
  ): void {
    this.bookFor(assetId).applySnapshot(bids, asks);
    if (hash) this.lastHash.set(assetId, hash);
    else this.lastHash.delete(assetId);
  }

  // -------------------------------------------------------------------------

  private bookFor(assetId: string): BookState {
    let b = this.books.get(assetId);
    if (!b) {
      b = new BookState();
      this.books.set(assetId, b);
    }
    return b;
  }

  private applySnapshot(
    assetId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const bids = parseLevels(payload["bids"]);
    const asks = parseLevels(payload["asks"]);
    if (bids.length === 0 && asks.length === 0) return false;
    this.bookFor(assetId).applySnapshot(bids, asks);
    return true;
  }

  private applyPriceChangePayload(payload: Record<string, unknown>): string[] {
    // ── Shape 1 (live): { market, price_changes: [{ asset_id, price, side?, size? }] }
    if (Array.isArray(payload["price_changes"])) {
      const changes = payload["price_changes"] as Array<
        Record<string, unknown>
      >;
      const touched = new Set<string>();
      for (const ch of changes) {
        const assetId =
          typeof ch["asset_id"] === "string" ? ch["asset_id"] : null;
        if (!assetId) continue;
        const price = parseNum(ch["price"]);
        const size = parseNum(ch["size"]);
        const side = parseSide(ch["side"]);
        if (price !== null && size !== null && side !== null) {
          this.bookFor(assetId).applyDelta(side, price, size);
        }
        if (typeof ch["hash"] === "string") {
          this.lastHash.set(assetId, ch["hash"]);
        }
        touched.add(assetId);
      }
      return Array.from(touched);
    }

    // ── Shape 2 (legacy batched): { asset_id, changes: [{ price, side, size }] }
    // ── Shape 3 (legacy flat):    { asset_id, price, side, size }
    const assetId =
      typeof payload["asset_id"] === "string" ? payload["asset_id"] : null;
    if (!assetId) return [];

    const entries: Array<Record<string, unknown>> = Array.isArray(
      payload["changes"],
    )
      ? (payload["changes"] as Array<Record<string, unknown>>)
      : "price" in payload && "side" in payload && "size" in payload
        ? [payload]
        : [];

    if (entries.length === 0) return [];
    const book = this.bookFor(assetId);
    let touched = false;
    for (const ch of entries) {
      const price = parseNum(ch["price"]);
      const size = parseNum(ch["size"]);
      const side = parseSide(ch["side"]);
      if (price === null || size === null || side === null) continue;
      book.applyDelta(side, price, size);
      touched = true;
    }
    if (typeof payload["hash"] === "string") {
      this.lastHash.set(assetId, payload["hash"]);
    }
    return touched ? [assetId] : [];
  }
}

// ---------------------------------------------------------------------------

function parseLevels(v: unknown): Array<{ price: number; size: number }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ price: number; size: number }> = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const lvl = item as Record<string, unknown>;
    const price = parseNum(lvl["price"]);
    const size = parseNum(lvl["size"]);
    if (price === null || size === null) continue;
    out.push({ price, size });
  }
  return out;
}

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseSide(v: unknown): "buy" | "sell" | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase();
  if (s === "buy" || s === "bid") return "buy";
  if (s === "sell" || s === "ask") return "sell";
  return null;
}
