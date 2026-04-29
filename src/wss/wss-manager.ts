import type { TriggerKey } from "./triggers/trigger-key.ts";
import {
  PolymarketConnection,
  type PolymarketConnectionOptions,
} from "./polymarket-connection.ts";
import type { TokenResolver } from "./token-resolver.ts";
import type {
  ErrorHandler,
  EventHandler,
  WssEvent,
  WssManagerStatus,
} from "./types.ts";

/**
 * Internal record of a single active subscription (one TriggerKey →
 * one upstream connection, plus a refcount of consumers that care about it).
 */
interface SubscriptionRecord {
  readonly trigger: TriggerKey;
  /** Set of consumer IDs currently subscribed. Connection lives while non-empty. */
  readonly consumers: Set<string>;
  /** Lazily created — null while the token-id resolution is in flight or has failed. */
  connection: PolymarketConnection | null;
}

export interface WssManagerOptions {
  readonly resolver: TokenResolver;
  readonly connectionOptions?: Partial<PolymarketConnectionOptions>;
}

/**
 * Top-level orchestrator for all upstream market-data WebSockets.
 *
 * Responsibilities:
 *  - maintain a unique-per-TriggerKey connection pool (no duplicate sockets)
 *  - refcount consumers so a connection is torn down only when nothing needs it
 *  - resolve a trigger's upstream token IDs once, then hand off to a
 *    `PolymarketConnection` for all reliability concerns
 *  - fan event/error notifications out to registered listeners
 *
 * Future event-bus integration: today, `onEvent` registers a process-local
 * callback. When the internal bus lands, the bootstrap layer can simply do:
 *   `manager.onEvent((e) => bus.publish("wss.event", e));`
 * — the manager itself does not need to change.
 */
export class WssManager {
  private readonly resolver: TokenResolver;
  private readonly connectionOptions?: Partial<PolymarketConnectionOptions>;

  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();

  private started = false;
  private stopped = false;

  constructor(opts: WssManagerOptions) {
    this.resolver = opts.resolver;
    this.connectionOptions = opts.connectionOptions;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.stopped) throw new Error("WssManager has been stopped");
    if (this.started) return;
    this.started = true;

    await Promise.all(
      [...this.subscriptions.values()].map((r) => this.openConnectionFor(r)),
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;

    const closes: Promise<void>[] = [];
    for (const record of this.subscriptions.values()) {
      if (record.connection) closes.push(record.connection.stop());
    }
    await Promise.all(closes);
    this.subscriptions.clear();
    this.eventHandlers.clear();
    this.errorHandlers.clear();
  }

  // ---------------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------------

  addSubscription(trigger: TriggerKey, consumerId: string): void {
    if (this.stopped) throw new Error("WssManager has been stopped");

    const existing = this.subscriptions.get(trigger.id);
    if (existing) {
      existing.consumers.add(consumerId);
      return;
    }

    const record: SubscriptionRecord = {
      trigger,
      consumers: new Set([consumerId]),
      connection: null,
    };
    this.subscriptions.set(trigger.id, record);

    if (this.started) {
      // Fire-and-forget: errors surface via registered error handlers.
      void this.openConnectionFor(record);
    }
  }

  removeSubscription(trigger: TriggerKey, consumerId: string): void {
    const record = this.subscriptions.get(trigger.id);
    if (!record) return;

    record.consumers.delete(consumerId);
    if (record.consumers.size > 0) return;

    this.subscriptions.delete(trigger.id);
    const conn = record.connection;
    if (conn) {
      void conn
        .stop()
        .catch((err) => this.emitError(record.trigger, toError(err)));
    }
  }

  // ---------------------------------------------------------------------------
  // Listeners
  // ---------------------------------------------------------------------------

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  getActiveSubscriptions(): TriggerKey[] {
    return [...this.subscriptions.values()].map((r) => r.trigger);
  }

  getStatus(): WssManagerStatus {
    return {
      connected: this.started && !this.stopped,
      subscriptions: this.subscriptions.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async openConnectionFor(record: SubscriptionRecord): Promise<void> {
    if (record.connection) return;
    let tokenIds: string[];
    try {
      tokenIds = await this.resolver.resolve(record.trigger);
    } catch (err) {
      this.emitError(record.trigger, toError(err));
      return;
    }

    // Subscription may have been removed while we awaited the resolver.
    if (!this.subscriptions.has(record.trigger.id)) return;

    const conn = new PolymarketConnection(
      record.trigger,
      tokenIds,
      {
        onEvent: (e) => this.emitEvent(e),
        onError: (e) => this.emitError(record.trigger, e),
      },
      this.connectionOptions,
    );
    record.connection = conn;
    conn.start();
  }

  private emitEvent(event: WssEvent): void {
    for (const h of this.eventHandlers) {
      try {
        h(event);
      } catch (err) {
        console.error("[wss] event handler threw:", err);
      }
    }
  }

  private emitError(trigger: TriggerKey, error: Error): void {
    if (this.errorHandlers.size === 0) {
      console.error(`[wss] ${trigger.id}:`, error.message);
      return;
    }
    for (const h of this.errorHandlers) {
      try {
        h({ triggerId: trigger.id, trigger, error });
      } catch (err) {
        console.error("[wss] error handler threw:", err);
      }
    }
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
