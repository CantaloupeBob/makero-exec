import {
  newEventId,
  strategyTopic,
  type BusEvent,
  type EventBus,
  type StrategyTriggeredEvent,
  type WssMarketEvent,
} from "../event-bus/event-bus.ts";
import type { ProbabilityExtractor } from "./probability-extractor.ts";
import type { LoadedStrategy } from "./types.ts";

export interface StrategyEngineOptions {
  readonly bus: EventBus;
  readonly extractor: ProbabilityExtractor;
  /**
   * If true (default), each strategy fires at most once. After firing it is
   * removed from the index so subsequent ticks for the same trigger don't
   * re-emit. The executor / DB layer can later re-add a strategy if it should
   * remain armed (out of scope here).
   */
  readonly fireOnce?: boolean;
}

/**
 * In-memory consumer of the event bus. Holds strategies indexed by their
 * trigger id and, on each WSS market event, evaluates only the strategies
 * attached to that trigger. Triggered strategies are republished on the bus
 * as `StrategyTriggeredEvent`s — the engine never executes anything itself.
 *
 * Single responsibility:
 *   facts (WssMarketEvent) → decisions (StrategyTriggeredEvent)
 */
export class StrategyEngine {
  private readonly bus: EventBus;
  private readonly extractor: ProbabilityExtractor;
  private readonly fireOnce: boolean;

  /** triggerId → strategies keyed by strategyId. */
  private readonly index = new Map<string, Map<string, LoadedStrategy>>();
  private unsubscribe: (() => void) | null = null;

  constructor(opts: StrategyEngineOptions) {
    this.bus = opts.bus;
    this.extractor = opts.extractor;
    this.fireOnce = opts.fireOnce ?? true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Subscribes the engine to the bus. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe("wss.*", (event: BusEvent) => {
      if (event.source !== "wss" || event.type === "error") return;
      this.handleEvent(event as WssMarketEvent);
    });
  }

  /** Unsubscribes the engine. Does not clear the index. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // ---------------------------------------------------------------------------
  // Index management
  // ---------------------------------------------------------------------------

  addStrategy(strategy: LoadedStrategy): void {
    let bucket = this.index.get(strategy.trigger.id);
    if (!bucket) {
      bucket = new Map();
      this.index.set(strategy.trigger.id, bucket);
    }
    bucket.set(strategy.id, strategy);
  }

  addStrategies(strategies: Iterable<LoadedStrategy>): void {
    for (const s of strategies) this.addStrategy(s);
  }

  removeStrategy(strategyId: string, triggerId: string): void {
    const bucket = this.index.get(triggerId);
    if (!bucket) return;
    bucket.delete(strategyId);
    if (bucket.size === 0) this.index.delete(triggerId);
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /** Total number of strategies currently armed. */
  size(): number {
    let n = 0;
    for (const bucket of this.index.values()) n += bucket.size;
    return n;
  }

  /** Number of distinct triggers being watched. */
  triggerCount(): number {
    return this.index.size;
  }

  // ---------------------------------------------------------------------------
  // Hot path
  // ---------------------------------------------------------------------------

  handleEvent(event: WssMarketEvent): void {
    const bucket = this.index.get(event.triggerId);
    if (!bucket || bucket.size === 0) return;

    const probability = this.extractor.extract(event);
    if (probability === null) return;

    // Snapshot to allow safe mutation (fireOnce removes from the bucket).
    const candidates = [...bucket.values()];
    for (const strategy of candidates) {
      if (!this.evaluate(strategy, probability)) continue;
      this.fire(strategy, probability, event);
      if (this.fireOnce) {
        this.removeStrategy(strategy.id, strategy.trigger.id);
      }
    }
  }

  private evaluate(
    strategy: LoadedStrategy,
    observedProbability: number,
  ): boolean {
    return strategy.direction === ">="
      ? observedProbability >= strategy.probability
      : observedProbability <= strategy.probability;
  }

  private fire(
    strategy: LoadedStrategy,
    observedProbability: number,
    cause: WssMarketEvent,
  ): void {
    const now = Date.now();
    const triggered: StrategyTriggeredEvent = {
      id: newEventId(),
      topic: strategyTopic(strategy.id, "triggered"),
      source: "strategy",
      type: "triggered",
      timestamp: now,
      publishedAt: now,
      correlationId: cause.id,
      strategyId: strategy.id,
      userAddress: strategy.userAddress,
      triggerId: strategy.trigger.id,
      trigger: strategy.trigger,
      payload: {
        observedProbability,
        threshold: strategy.probability,
        direction: strategy.direction,
        causeEventId: cause.id,
      },
    };
    this.bus.publish(triggered);
  }
}
