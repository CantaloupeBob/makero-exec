import { eq, and } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { orders, strategies } from "../db/schema.ts";
import type { ExecutableOrder } from "./types.ts";

/**
 * Load the pending, not-yet-executed orders for a strategy. We deliberately
 * read at trigger-time (rather than caching at boot) because:
 *   - the user may have cancelled an order between arming and firing;
 *   - the order set is small (one strategy = a handful of orders);
 *   - it gives us a single source of truth for `status` / `is_executed`.
 */
export async function loadPendingOrdersForStrategy(
  strategyId: string,
): Promise<ExecutableOrder[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.strategyId, strategyId),
        eq(orders.isExecuted, false),
        eq(orders.status, "pending"),
      ),
    );

  const out: ExecutableOrder[] = [];
  for (const row of rows) {
    const sizeUsdc = Number(row.sizeUsdc);
    if (!Number.isFinite(sizeUsdc) || sizeUsdc <= 0) {
      console.warn(
        `[exec] order ${row.id} has invalid size_usdc="${row.sizeUsdc}" — skipping`,
      );
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
      reduceOnly: row.reduceOnly,
      orderDeadline: row.orderDeadline.getTime(),
    });
  }
  return out;
}

/**
 * Mark an order's terminal status. Best-effort; logs on failure but never
 * throws (the order is already on-chain at this point — DB drift is the
 * lesser evil compared to crashing the executor loop).
 */
export async function markOrderStatus(
  orderId: string,
  status: "submitted" | "filled" | "failed" | "skipped",
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
export async function markStrategyAttempted(strategyId: string): Promise<void> {
  const db = getDb();
  try {
    await db
      .update(strategies)
      .set({ hasBeenAttempted: true })
      .where(eq(strategies.id, strategyId));
  } catch (err) {
    console.error(
      `[exec] failed to mark strategy ${strategyId} as attempted:`,
      err instanceof Error ? err.message : err,
    );
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
