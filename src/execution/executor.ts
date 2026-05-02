import type {
  BusEvent,
  EventBus,
  StrategyTriggeredEvent,
  Unsubscribe,
} from "../event-bus/event-bus.ts";
import {
  loadPendingOrdersForStrategy,
  markOrderStatus,
  markStrategyAttempted,
} from "./order-repository.ts";
import type { Venue, OrderExecutionResult } from "./types.ts";

export interface StrategyExecutorOptions {
  readonly bus: EventBus;
  /**
   * Map from a triggered strategy to the venue that should handle it. The
   * default routes everything to the lone registered venue (typical case
   * today). When multiple venues are registered, callers must supply a
   * router — there is no implicit "first one wins".
   */
  readonly venues: readonly Venue[];
  readonly route?: (
    cause: StrategyTriggeredEvent,
    venues: readonly Venue[],
  ) => Venue | null;
}

/**
 * Subscribes to `strategy.*` events and, on each `triggered` event, loads
 * the strategy's pending orders from the DB and hands them off to the
 * appropriate {@link Venue}.
 *
 * This is the seam the user asked for: the engine *decides*, this
 * component *acts*. The executor is intentionally venue-agnostic — adding
 * a new exchange means writing a `Venue` and registering it here.
 */
export class StrategyExecutor {
  private readonly bus: EventBus;
  private readonly venues: readonly Venue[];
  private readonly route: NonNullable<StrategyExecutorOptions["route"]>;
  private unsubscribe: Unsubscribe | null = null;
  /** Re-entrancy guard: don't double-process if the bus replays an event. */
  private readonly inflight = new Set<string>();

  constructor(opts: StrategyExecutorOptions) {
    this.bus = opts.bus;
    this.venues = opts.venues;
    this.route =
      opts.route ??
      ((_cause, venues) => (venues.length === 1 ? venues[0]! : null));
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe("strategy.*", (event: BusEvent) => {
      if (event.source !== "strategy" || event.type !== "triggered") return;
      // Fire-and-forget: the bus is synchronous, but execution is async.
      // We deliberately don't await to keep the publisher's callstack short.
      void this.handle(event as StrategyTriggeredEvent);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async handle(cause: StrategyTriggeredEvent): Promise<void> {
    if (this.inflight.has(cause.strategyId)) {
      console.warn(
        `[exec] strategy ${cause.strategyId} already executing — ignoring duplicate trigger`,
      );
      return;
    }
    this.inflight.add(cause.strategyId);
    try {
      await this.dispatch(cause);
    } catch (err) {
      console.error(
        `[exec] unexpected error handling strategy ${cause.strategyId}:`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    } finally {
      this.inflight.delete(cause.strategyId);
    }
  }

  private async dispatch(cause: StrategyTriggeredEvent): Promise<void> {
    const venue = this.route(cause, this.venues);
    if (!venue) {
      console.warn(
        `[exec] no venue for strategy ${cause.strategyId} — cannot execute`,
      );
      return;
    }

    const orders = await loadPendingOrdersForStrategy(cause.strategyId);
    if (orders.length === 0) {
      console.warn(
        `[exec] strategy ${cause.strategyId} fired but has no pending orders`,
      );
      // Still flip the flag — the strategy fired, the executor ran, and
      // there is nothing left to do. Leaving it false would make the row
      // look perpetually pending to any auditor.
      await markStrategyAttempted(cause.strategyId);
      return;
    }

    console.log(
      `[exec] dispatching strategy ${cause.strategyId} → ${venue.name} ` +
        `(${orders.length} order(s), user=${orders[0]!.userAddress})`,
    );

    const results = await venue.execute(cause, orders);
    await Promise.all(results.map((r) => persistResult(r)));
    // After every order has had its turn (filled, resting, skipped, or
    // failed) we mark the strategy attempted. This is intentionally
    // unconditional: per-order outcomes live on the orders themselves,
    // and `hasBeenAttempted` is purely a "the executor saw this" flag.
    await markStrategyAttempted(cause.strategyId);
  }
}

function persistResult(result: OrderExecutionResult): Promise<void> {
  switch (result.status) {
    case "filled":
      return markOrderStatus(result.orderId, "filled", true);
    case "resting":
    case "submitted":
      return markOrderStatus(result.orderId, "submitted", true);
    case "skipped":
      console.warn(`[exec] order ${result.orderId} skipped: ${result.reason}`);
      return markOrderStatus(result.orderId, "skipped", false);
    case "failed":
      console.error(`[exec] order ${result.orderId} failed: ${result.error}`);
      return markOrderStatus(result.orderId, "failed", false);
  }
}
