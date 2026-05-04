import type {
  BusEvent,
  EventBus,
  StrategyTriggeredEvent,
  Unsubscribe,
} from "../event-bus/event-bus.ts";
import {
  hasStrategyBeenAttempted,
  loadPendingOrdersForStrategy,
  markOrderStatus,
  markStrategyAttempted,
} from "./order-repository.ts";
import type { Venue, OrderExecutionResult } from "./types.ts";
export interface StrategyExecutorOptions {
  readonly bus: EventBus;
  readonly venues: readonly Venue[];
  readonly route?: (
    cause: StrategyTriggeredEvent,
    venues: readonly Venue[],
  ) => Venue | null;
  /**
   * After this many consecutive venue errors the executor pauses and refuses
   * to process new strategies until `resetCircuitBreaker()` is called or the
   * process restarts. This prevents hammering a degraded API indefinitely.
   * Defaults to 5.
   */
  readonly circuitBreakerThreshold?: number;
}

export class StrategyExecutor {
  private readonly bus: EventBus;
  private readonly venues: readonly Venue[];
  private readonly route: NonNullable<StrategyExecutorOptions["route"]>;
  private readonly circuitBreakerThreshold: number;
  private unsubscribe: Unsubscribe | null = null;
  private readonly inflight = new Set<string>();

  /** Count of consecutive hard failures (wallet load failure or venue throw). */
  private consecutiveFailures = 0;
  private circuitOpen = false;

  constructor(opts: StrategyExecutorOptions) {
    this.bus = opts.bus;
    this.venues = opts.venues;
    this.route =
      opts.route ??
      ((_cause, venues) => (venues.length === 1 ? venues[0]! : null));
    this.circuitBreakerThreshold = opts.circuitBreakerThreshold ?? 5;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe("strategy.*", (event: BusEvent) => {
      if (event.source !== "strategy" || event.type !== "triggered") return;
      const p = this.handle(event as StrategyTriggeredEvent);
      // Attach a catch so the rejection is never unhandled. Errors inside
      // handle() are already caught and logged; this is a final safety net.
      p.catch((err) => {
        console.error(
          "[exec] unhandled rejection escaped handle():",
          err instanceof Error ? (err.stack ?? err.message) : err,
        );
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Manually close the circuit breaker after investigating the root cause. */
  resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
    this.circuitOpen = false;
    console.log("[exec] circuit breaker reset — execution resumed");
  }

  private async handle(cause: StrategyTriggeredEvent): Promise<void> {
    if (this.circuitOpen) {
      console.error(
        `[exec] circuit breaker OPEN — dropping strategy ${cause.strategyId}. ` +
          `Call resetCircuitBreaker() after investigating.`,
      );
      return;
    }
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
    if (await hasStrategyBeenAttempted(cause.strategyId)) {
      console.warn(
        `[exec] strategy ${cause.strategyId} has already been attempted — skipping`,
      );
      return;
    }

    const venue = this.route(cause, this.venues);
    if (!venue) {
      console.warn(
        `[exec] no venue for strategy ${cause.strategyId} — cannot execute`,
      );
      return;
    }

    const orders = await loadPendingOrdersForStrategy(cause.strategyId);
    if (orders.allFiltered) {
      // Rows exist in the DB but every one failed a validation guard
      // (e.g. all orders exceed MAX_ORDER_USDC). Do NOT latch as attempted —
      // this needs operator investigation. The strategy stays armed so it
      // can be fixed and retried after a config/data correction.
      console.error(
        `[exec] strategy ${cause.strategyId} has orders but ALL were rejected by ` +
          `validation guards — NOT latching. Operator investigation required.`,
      );
      return;
    }
    if (orders.orders.length === 0) {
      // No pending rows at all (cancelled, already executed, or deadline passed).
      // Latch to prevent re-evaluation on every subsequent WSS tick.
      console.warn(
        `[exec] strategy ${cause.strategyId} fired but has no pending orders — latching`,
      );
      await markStrategyAttempted(cause.strategyId);
      return;
    }

    console.log(
      `[exec] dispatching strategy ${cause.strategyId} → ${venue.name} ` +
        `(${orders.orders.length} order(s), user=${orders.orders[0]!.userAddress})`,
    );

    // Latch before execution: crash-after-latch = missed trade (acceptable).
    // Crash-after-execution-without-latch = double trade (not acceptable).
    // If the DB write fails we abort — do NOT proceed to the venue.
    try {
      await markStrategyAttempted(cause.strategyId);
    } catch (err) {
      this.consecutiveFailures++;
      console.error(
        `[exec] ABORTING strategy ${cause.strategyId} — failed to write attempted latch ` +
          `(consecutive failures: ${this.consecutiveFailures}/${this.circuitBreakerThreshold}):`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
        this.circuitOpen = true;
        console.error(
          `[exec] circuit breaker TRIPPED after ${this.consecutiveFailures} consecutive failures — ` +
            `execution paused. Investigate and call resetCircuitBreaker().`,
        );
      }
      return;
    }

    let results: readonly OrderExecutionResult[];
    try {
      results = await venue.execute(cause, orders.orders);
      // Successful round-trip to venue resets the failure counter.
      this.consecutiveFailures = 0;
    } catch (err) {
      // The venue threw entirely (network down, SDK panic, etc.).
      // Per-order errors are caught inside the venue and returned as results,
      // so reaching here means a hard infrastructure failure.
      // IMPORTANT: the strategy is already latched as attempted in the DB.
      // Log with maximum prominence so operators know this strategy was
      // latched but NO trade was placed and manual review is required.
      this.consecutiveFailures++;
      console.error(
        `[exec] CRITICAL: venue "${venue.name}" threw for strategy ${cause.strategyId} AFTER latch — ` +
          `strategy is marked attempted in DB but NO trade was placed. ` +
          `Manual review required. ` +
          `(consecutive failures: ${this.consecutiveFailures}/${this.circuitBreakerThreshold}):`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
        this.circuitOpen = true;
        console.error(
          `[exec] circuit breaker TRIPPED after ${this.consecutiveFailures} consecutive failures — ` +
            `execution paused. Investigate and call resetCircuitBreaker().`,
        );
      }
      return;
    }

    await Promise.all(results.map((r) => persistResult(r)));
  }
}

function persistResult(result: OrderExecutionResult): Promise<void> {
  switch (result.status) {
    case "filled":
      return markOrderStatus(result.orderId, "filled", true);
    case "filled_unprotected":
      // Position is open but TP/SL failed. Mark executed so we don't retry,
      // but use a distinct status so operators can find and manually protect.
      console.error(
        `[exec] order ${result.orderId} FILLED but TP/SL submission failed — ` +
          `position is open with NO protective orders. Immediate manual review required.`,
      );
      return markOrderStatus(result.orderId, "filled_unprotected", true);
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
