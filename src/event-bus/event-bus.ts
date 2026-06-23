import type { TriggerKey } from "../wss/triggers/trigger-key.ts";

/**
 * The event bus is the single in-process integration point between the
 * various subsystems (wss feeds, scheduler, strategy engine, executor, …).
 * Every event that crosses a module boundary should flow through here.
 *
 * Topics are dot-delimited hierarchical strings:
 *
 *   `<source>.<entity>.<type>`
 *
 * For WSS market data this is `wss.<triggerId>.<eventType>`, e.g.
 *   `wss.polymarket:0xfa59…c191d4.price_change`
 *
 * This shape lets subscribers be as broad or narrow as they need:
 *   - `wss.*`                                       → every wss event
 *   - `wss.polymarket:0xfa59…c191d4.*`              → one market, all types
 *   - `wss.polymarket:0xfa59…c191d4.price_change`   → one market, one type
 *   - `*`                                           → everything
 */

// ---------------------------------------------------------------------------
// Event shape — discriminated union, all variants share `BusEventMeta`.
// ---------------------------------------------------------------------------

export interface BusEventMeta {
  /** Globally unique id for this event (UUID-ish). For tracing/dedup. */
  readonly id: string;
  /** Routing key the event was published under. */
  readonly topic: string;
  /** Originating subsystem (`wss`, `scheduler`, `strategy`, …). */
  readonly source: string;
  /** Subsystem-specific event type. Forms the last segment of `topic`. */
  readonly type: string;
  /** Origin/source timestamp (ms since epoch) — when the event happened upstream. */
  readonly timestamp: number;
  /** When `bus.publish()` ran (ms since epoch) — useful for latency bookkeeping. */
  readonly publishedAt: number;
  /** Optional correlation id, for tying together events that share a cause. */
  readonly correlationId?: string;
}

/** A market-data update from the WSS layer (`book`, `price_change`, …). */
export interface WssMarketEvent extends BusEventMeta {
  readonly source: "wss";
  readonly type: string;
  readonly triggerId: string;
  readonly trigger: TriggerKey;
  /** When this process received the upstream message (ms). */
  readonly receivedAt: number;
  /** Raw upstream payload (JSON-decoded). */
  readonly payload: unknown;
}

/** A non-fatal connection-level error from the WSS layer. */
export interface WssErrorEvent extends BusEventMeta {
  readonly source: "wss";
  readonly type: "error";
  readonly triggerId: string;
  readonly trigger: TriggerKey;
}

/**
 * Emitted by the strategy engine when a strategy's trigger condition
 * evaluates to true. Topic shape: `strategy.<strategyId>.triggered`.
 *
 * This is the seam the executor will subscribe to.
 */
export interface StrategyTriggeredEvent extends BusEventMeta {
  readonly source: "strategy";
  readonly type: "triggered";
  readonly strategyId: string;
  readonly userAddress: string;
  readonly triggerId: string;
  readonly trigger: TriggerKey;
  readonly payload: {
    /** The probability observed on the market that caused the trigger. */
    readonly observedProbability: number;
    /** The threshold the strategy was configured with. */
    readonly threshold: number;
    /** The direction (`>=` or `<=`) the strategy was configured with. */
    readonly direction: ">=" | "<=";
    /** Bus id of the WSS event that produced the trigger (for tracing). */
    readonly causeEventId: string;
  };
}

/**
 * The discriminated union of every event kind the bus knows about.
 * Add new variants here as new subsystems land.
 */
export type BusEvent = WssMarketEvent | WssErrorEvent | StrategyTriggeredEvent;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export type EventHandler<E extends BusEvent = BusEvent> = (event: E) => void;
/** Cancels a subscription. Idempotent. */
export type Unsubscribe = () => void;

export interface EventBus {
  /** Publish an event. Synchronous fan-out to matching subscribers. */
  publish(event: BusEvent): void;
  /**
   * Subscribe to a topic pattern. Supported patterns:
   *   - exact:           `wss.foo.book`
   *   - prefix wildcard: `wss.foo.*`   (matches `wss.foo.<anything>`, any depth)
   *   - global:          `*`           (matches every event)
   *
   * Returns an idempotent unsubscribe function.
   */
  subscribe<E extends BusEvent = BusEvent>(
    topic: string,
    handler: EventHandler<E>,
  ): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

interface PrefixSub {
  readonly prefix: string; // includes trailing "."; empty string ⇒ global
  readonly handler: EventHandler;
}

/**
 * In-process implementation. Synchronous fan-out is intentional — handlers
 * that need async work should schedule it themselves. A throwing handler is
 * isolated so it cannot affect siblings or the publisher.
 */
export class InMemoryEventBus implements EventBus {
  private readonly exact = new Map<string, Set<EventHandler>>();
  private readonly prefixed: PrefixSub[] = [];

  publish(event: BusEvent): void {
    const exactSet = this.exact.get(event.topic);
    if (exactSet) {
      for (const h of exactSet) this.invoke(h, event);
    }
    if (this.prefixed.length === 0) return;
    for (const sub of this.prefixed) {
      if (sub.prefix === "" || event.topic.startsWith(sub.prefix)) {
        this.invoke(sub.handler, event);
      }
    }
  }

  subscribe<E extends BusEvent = BusEvent>(
    topic: string,
    handler: EventHandler<E>,
  ): Unsubscribe {
    const h = handler as EventHandler;

    if (topic === "*") {
      const sub: PrefixSub = { prefix: "", handler: h };
      this.prefixed.push(sub);
      return () => {
        const i = this.prefixed.indexOf(sub);
        if (i >= 0) this.prefixed.splice(i, 1);
      };
    }

    if (topic.endsWith(".*")) {
      const prefix = topic.slice(0, -1); // keep trailing "."
      const sub: PrefixSub = { prefix, handler: h };
      this.prefixed.push(sub);
      return () => {
        const i = this.prefixed.indexOf(sub);
        if (i >= 0) this.prefixed.splice(i, 1);
      };
    }

    let set = this.exact.get(topic);
    if (!set) {
      set = new Set();
      this.exact.set(topic, set);
    }
    set.add(h);
    return () => {
      const s = this.exact.get(topic);
      if (!s) return;
      s.delete(h);
      if (s.size === 0) this.exact.delete(topic);
    };
  }

  private invoke(handler: EventHandler, event: BusEvent): void {
    try {
      handler(event);
    } catch (err) {
      // A faulty subscriber must never break the publisher or siblings.
      console.error(`[event-bus] handler for "${event.topic}" threw:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `wss.<triggerId>.<type>` topic. */
export function wssTopic(triggerId: string, type: string): string {
  return `wss.${triggerId}.${type}`;
}

/** Build a `strategy.<strategyId>.<type>` topic. */
export function strategyTopic(strategyId: string, type: string): string {
  return `strategy.${strategyId}.${type}`;
}

export function newEventId(): string {
  return crypto.randomUUID();
}
