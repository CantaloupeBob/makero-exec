import { eq, and, gt } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { orders, strategies } from "../db/schema.ts";
import type { ExecutableOrder } from "./types.ts";
import { DEFAULT_SLIPPAGE_PCT } from "../lib/constants/hyperliquid-constants.ts";
import { MAX_ORDER_SIZE_USDC } from "../lib/constants/global-constants.ts";

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
    if (sizeUsdc > MAX_ORDER_SIZE_USDC) {
      console.error(
        `[exec] order ${row.id} size_usdc=${sizeUsdc} exceeds MAX_ORDER_SIZE_USDC=${MAX_ORDER_SIZE_USDC} — skipping`,
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
 * Mark a strategy as having been attempted. This MUST succeed before the
 * executor calls the venue — if the DB write fails we throw so the caller
 * aborts rather than executing a trade that cannot be latched, which would
 * result in a double-execution on the next restart.
 *
 * Implemented as a compare-and-swap (UPDATE ... WHERE has_been_attempted = false):
 *   - if the row was already latched (by another process or an earlier in-flight
 *     handler that lost a race), rowCount === 0 and we throw `StrategyAlreadyLatched`,
 *   - the caller MUST treat that as "do not execute".
 */
export class StrategyAlreadyLatched extends Error {
  constructor(strategyId: string) {
    super(`Strategy ${strategyId} was already latched as attempted`);
    this.name = "StrategyAlreadyLatched";
  }
}

export async function markStrategyAttempted(strategyId: string): Promise<void> {
  const db = getDb();
  const result = await db
    .update(strategies)
    .set({ hasBeenAttempted: true })
    .where(
      and(
        eq(strategies.id, strategyId),
        eq(strategies.hasBeenAttempted, false),
      ),
    );
  // node-postgres returns rowCount on the underlying result. Drizzle surfaces it.
  // If the row was already latched, rowCount will be 0 and we must NOT execute.
  const rowCount =
    (result as unknown as { rowCount?: number | null }).rowCount ?? null;
  if (rowCount === 0) {
    throw new StrategyAlreadyLatched(strategyId);
  }
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
