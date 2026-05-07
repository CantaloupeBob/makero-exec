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
  /**
   * Called after a strategy fires AND is removed from the index (fireOnce only).
   * Receives the fired strategy and the triggerId of the bucket it belonged to,
   * plus a boolean indicating whether that trigger now has zero remaining strategies.
   * Use this to clean up WSS subscriptions and book tracking when a market is
   * no longer needed.
   */
  readonly onStrategyFired?: (
    strategy: LoadedStrategy,
    triggerId: string,
    triggerNowEmpty: boolean,
  ) => void;
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
  private readonly onStrategyFired: NonNullable<
    StrategyEngineOptions["onStrategyFired"]
  > | null;

  /** triggerId → strategies keyed by strategyId. */
  private readonly index = new Map<string, Map<string, LoadedStrategy>>();
  private unsubscribe: (() => void) | null = null;

  constructor(opts: StrategyEngineOptions) {
    this.bus = opts.bus;
    this.extractor = opts.extractor;
    this.fireOnce = opts.fireOnce ?? true;
    this.onStrategyFired = opts.onStrategyFired ?? null;
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

  /**
   * Snapshot of every armed strategy, flattened. Returns a fresh array so
   * callers can mutate the engine (e.g. evict deleted strategies) while
   * iterating. Cheap: O(n) where n is total armed strategies.
   */
  listArmedStrategies(): Array<{
    triggerId: string;
    strategy: LoadedStrategy;
  }> {
    const out: Array<{ triggerId: string; strategy: LoadedStrategy }> = [];
    for (const [triggerId, bucket] of this.index) {
      for (const strategy of bucket.values()) out.push({ triggerId, strategy });
    }
    return out;
  }

  /** True if the engine has any strategies armed for `triggerId`. */
  hasTrigger(triggerId: string): boolean {
    return this.index.has(triggerId);
  }

  // ---------------------------------------------------------------------------
  // Hot path
  // ---------------------------------------------------------------------------

  handleEvent(event: WssMarketEvent): void {
    const bucket = this.index.get(event.triggerId);
    if (!bucket || bucket.size === 0) return;

    // One throttled log per (trigger, eventType) pair so we can confirm WSS
    // ticks are actually reaching the engine for the markets we care about,
    // without spamming on every price_change.
    this.logTick(event);

    const probability = this.extractor.extract(event);
    if (probability === null) return;

    this.logProbability(event.triggerId, probability);

    // Snapshot to allow safe mutation (fireOnce removes from the bucket).
    const candidates = [...bucket.values()];
    for (const strategy of candidates) {
      if (!this.evaluate(strategy, probability)) continue;
      this.fire(strategy, probability, event);
      if (this.fireOnce) {
        this.removeStrategy(strategy.id, strategy.trigger.id);
        const triggerNowEmpty = !this.index.has(strategy.trigger.id);
        this.onStrategyFired?.(strategy, strategy.trigger.id, triggerNowEmpty);
      }
    }
  }

  private readonly lastTickLogAt = new Map<string, number>();
  private logTick(event: WssMarketEvent): void {
    const key = `${event.triggerId}:${event.type}`;
    const now = Date.now();
    const last = this.lastTickLogAt.get(key) ?? 0;
    if (now - last < 5000) return;
    this.lastTickLogAt.set(key, now);
    console.log(
      `[engine] tick for ${event.trigger.slug} type=${event.type} (1/5s sample)`,
    );
  }

  private readonly lastProbLogAt = new Map<string, number>();
  private logProbability(triggerId: string, probability: number): void {
    const now = Date.now();
    const last = this.lastProbLogAt.get(triggerId) ?? 0;
    if (now - last < 5000) return;
    this.lastProbLogAt.set(triggerId, now);
    console.log(
      `[engine] ${triggerId} probability=${(probability * 100).toFixed(2)}% (1/5s sample)`,
    );
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
