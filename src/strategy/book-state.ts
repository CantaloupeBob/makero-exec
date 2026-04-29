/**
 * In-memory order book for a single Polymarket asset (token id).
 *
 * Polymarket pushes:
 *   - `book`         — full snapshot, replaces local state.
 *   - `price_change` — single-level delta. `size === 0` means the level
 *                      was removed; any other size is the new resting size
 *                      at that price.
 *
 * Maintaining this state locally is the only way to compute a realtime
 * mid-price. Without it, mid only refreshes when Polymarket happens to
 * resend a snapshot.
 *
 * Storage choice: `Map<price, size>` plus an O(n) scan for best price.
 * Polymarket books are ≤ a few hundred levels per side and we re-scan only
 * when a probability is actually requested, so this is well within budget
 * and avoids an external dep on a sorted structure.
 */
export class BookState {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();

  /** Replace the entire book with the given levels. */
  applySnapshot(
    bids: ReadonlyArray<{ price: number; size: number }>,
    asks: ReadonlyArray<{ price: number; size: number }>,
  ): void {
    this.bids.clear();
    this.asks.clear();
    for (const lvl of bids) {
      if (lvl.size > 0) this.bids.set(lvl.price, lvl.size);
    }
    for (const lvl of asks) {
      if (lvl.size > 0) this.asks.set(lvl.price, lvl.size);
    }
  }

  /**
   * Apply one delta. `size === 0` removes the level; otherwise the value
   * is the new resting size (deltas are absolute, not relative).
   */
  applyDelta(side: "buy" | "sell", price: number, size: number): void {
    const book = side === "buy" ? this.bids : this.asks;
    if (size <= 0) book.delete(price);
    else book.set(price, size);
  }

  bestBid(): { price: number; size: number } | null {
    return scanBest(this.bids, /* highest */ true);
  }

  bestAsk(): { price: number; size: number } | null {
    return scanBest(this.asks, /* highest */ false);
  }

  /** True only if the book has been seeded by at least one snapshot/delta. */
  hasAnyDepth(): boolean {
    return this.bids.size > 0 || this.asks.size > 0;
  }

  /**
   * Snapshot the current state as plain level arrays. Useful for handing
   * the book to a hasher or for diagnostics. Order is unspecified; callers
   * that need a particular order should sort it themselves.
   */
  levels(): {
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  } {
    return {
      bids: [...this.bids].map(([price, size]) => ({ price, size })),
      asks: [...this.asks].map(([price, size]) => ({ price, size })),
    };
  }
}

function scanBest(
  book: Map<number, number>,
  highest: boolean,
): { price: number; size: number } | null {
  let bestPrice = highest ? -Infinity : Infinity;
  let bestSize = 0;
  let found = false;
  for (const [price, size] of book) {
    if (size <= 0) continue;
    if (highest ? price > bestPrice : price < bestPrice) {
      bestPrice = price;
      bestSize = size;
      found = true;
    }
  }
  return found ? { price: bestPrice, size: bestSize } : null;
}
