import { eq, and, gt } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { orders, strategies } from "../db/schema.ts";
import type { ExecutableOrder } from "./types.ts";
import { DEFAULT_SLIPPAGE } from "./venues/hyperliquid/formatters.ts";
import { MAX_ORDER_SIZE_USDC } from "../lib/constants/global-constants.ts";

/** DEFAULT_SLIPPAGE expressed as a percent (e.g. 0.005 → 0.5). Used as fallback when maxSlippagePct is absent or invalid. */
const DEFAULT_SLIPPAGE_PCT = DEFAULT_SLIPPAGE * 100;

/**
 * Hard cap on a single order's USDC notional. Read from the environment so
 * operators can configure it without a code change. Defaults to $10,000.
 * A DB value larger than this is rejected at load time, not at execution time,
 * so the strategy is skipped cleanly rather than attempting a partial batch.
 */
export const MAX_ORDER_USDC: number = (() => {
  const raw = MAX_ORDER_SIZE_USDC;
  if (!raw) return 10_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`MAX_ORDER_USDC env var "${raw}" is not a positive number`);
  }
  return n;
})();

export interface LoadPendingOrdersResult {
  /** Orders that passed all validation checks and are ready to execute. */
  readonly orders: ExecutableOrder[];
  /**
   * True if rows existed in the DB for this strategy but every one was
   * rejected by a validation guard (oversized, invalid size, etc.).
   * When true and `orders` is empty the strategy should NOT be silently
   * latched as attempted — an operator needs to investigate.
   */
  readonly allFiltered: boolean;
}

/**
 * Load the pending, not-yet-executed orders for a strategy. We deliberately
 * read at trigger-time (rather than caching at boot) because:
 *   - the user may have cancelled an order between arming and firing;
 *   - the order set is small (one strategy = a handful of orders);
 *   - it gives us a single source of truth for `status` / `is_executed`.
 */
export async function loadPendingOrdersForStrategy(
  strategyId: string,
): Promise<LoadPendingOrdersResult> {
  const db = getDb();
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.strategyId, strategyId),
        eq(orders.isExecuted, false),
        eq(orders.status, "pending"),
        gt(orders.orderDeadline, new Date()),
      ),
    );

  const out: ExecutableOrder[] = [];
  let rejectedCount = 0;
  for (const row of rows) {
    const sizeUsdc = Number(row.sizeUsdc);
    if (!Number.isFinite(sizeUsdc) || sizeUsdc <= 0) {
      console.warn(
        `[exec] order ${row.id} has invalid size_usdc="${row.sizeUsdc}" — skipping`,
      );
      rejectedCount++;
      continue;
    }
    if (sizeUsdc > MAX_ORDER_USDC) {
      console.error(
        `[exec] order ${row.id} size_usdc=${sizeUsdc} exceeds MAX_ORDER_USDC=${MAX_ORDER_USDC} — skipping`,
      );
      rejectedCount++;
      continue;
    }
    const tp =
      row.takeProfitPct === null || row.takeProfitPct === undefined
        ? null
        : Number(row.takeProfitPct);
    const sl =
      row.stopLossPct === null || row.stopLossPct === undefined
        ? null
        : Number(row.stopLossPct);
    const maxSlippagePct = Number(row.maxSlippagePct);
    out.push({
      id: row.id,
      userAddress: row.userAddress,
      strategyId: row.strategyId,
      asset: row.asset,
      isLong: row.isLong,
      sizeUsdc,
      leverage: row.leverage,
      takeProfitPct: tp !== null && Number.isFinite(tp) ? tp : null,
      stopLossPct: sl !== null && Number.isFinite(sl) ? sl : null,
      maxSlippagePct:
        Number.isFinite(maxSlippagePct) && maxSlippagePct > 0
          ? maxSlippagePct
          : DEFAULT_SLIPPAGE_PCT,
      reduceOnly: row.reduceOnly,
      orderDeadline: row.orderDeadline.getTime(),
    });
  }
  return {
    orders: out,
    allFiltered:
      rows.length > 0 && out.length === 0 && rejectedCount === rows.length,
  };
}

/**
 * Mark an order's terminal status. Best-effort; logs on failure but never
 * throws (the order is already on-chain at this point — DB drift is the
 * lesser evil compared to crashing the executor loop).
 */
export async function markOrderStatus(
  orderId: string,
  status: "submitted" | "filled" | "filled_unprotected" | "failed" | "skipped",
  isExecuted: boolean,
): Promise<void> {
  const db = getDb();
  try {
    await db
      .update(orders)
      .set({ status, isExecuted, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
  } catch (err) {
    console.error(
      `[exec] failed to update order ${orderId} → ${status}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Mark a strategy as having been attempted by the executor. This is a
 * one-way latch — once true, the row stays true. The intent is to give
 * downstream auditing / re-arm tooling a clear signal that the executor
 * has had its turn at this strategy, regardless of whether individual
 * orders inside it filled, errored, or were skipped.
 *
 * Best-effort: failing to flip the flag is logged but never thrown,
 * because the on-venue side effects have already happened.
 */
/**
 * Mark a strategy as having been attempted. This MUST succeed before the
 * executor calls the venue — if the DB write fails we throw so the caller
 * aborts rather than executing a trade that cannot be latched, which would
 * result in a double-execution on the next restart.
 *
 * The method is intentionally NOT best-effort.
 */
export async function markStrategyAttempted(strategyId: string): Promise<void> {
  const db = getDb();
  await db
    .update(strategies)
    .set({ hasBeenAttempted: true })
    .where(eq(strategies.id, strategyId));
}

export async function hasStrategyBeenAttempted(
  strategyId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ hasBeenAttempted: strategies.hasBeenAttempted })
    .from(strategies)
    .where(eq(strategies.id, strategyId))
    .limit(1);
  return rows.length > 0 && rows[0]!.hasBeenAttempted;
}
