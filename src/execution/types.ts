import type { StrategyTriggeredEvent } from "../event-bus/event-bus.ts";

/**
 * The denormalized, ready-to-execute representation of a single row from
 * the `orders` table. Numeric fields have been parsed once at load time so
 * the hot path doesn't need to coerce strings repeatedly.
 */
export interface ExecutableOrder {
  readonly id: string;
  readonly userAddress: string;
  readonly strategyId: string;
  /** Asset symbol as stored by the user (e.g. "BTC"). Venue-agnostic. */
  readonly asset: string;
  readonly isLong: boolean;
  /** Notional position size, denominated in USDC. */
  readonly sizeUsdc: number;
  readonly leverage: number;
  /** Take-profit, expressed as percent gain (e.g. 12.5 = +12.5%). */
  readonly takeProfitPct: number | null;
  /** Stop-loss, expressed as percent loss (e.g. 5 = -5%). */
  readonly stopLossPct: number | null;
  readonly reduceOnly: boolean;
  /** Unix ms after which the order is no longer valid. */
  readonly orderDeadline: number;
}

/**
 * Result of attempting to place a single order on a venue. We never throw
 * out of `Venue.execute`; one bad order in a strategy must not abort the
 * sibling orders.
 */
export type OrderExecutionResult =
  | {
      readonly status: "filled" | "resting" | "submitted";
      readonly orderId: string;
      readonly venueRef?: string;
    }
  | {
      readonly status: "skipped";
      readonly orderId: string;
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly orderId: string;
      readonly error: string;
    };

/**
 * A venue is anything that can take a list of `ExecutableOrder`s for a
 * specific user and try to put them on the wire. Venues own their own
 * formatting, signing, and SDK details. Adding a new venue (e.g. a CEX,
 * a different perp DEX) is a matter of dropping a new implementation in
 * `src/execution/venues/<name>` and registering it with the executor.
 */
export interface Venue {
  /** Stable identifier, used for routing and logging. */
  readonly name: string;
  /**
   * Execute the orders attached to a strategy that just triggered. Implementations
   * MUST swallow per-order errors and surface them as `{ status: "failed" }`
   * results so a single broken order can't prevent the rest of the batch.
   */
  execute(
    cause: StrategyTriggeredEvent,
    orders: readonly ExecutableOrder[],
  ): Promise<readonly OrderExecutionResult[]>;
}
