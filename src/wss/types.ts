import type { TriggerKey } from "./triggers/trigger-key.ts";

/** A normalized event emitted by a single subscribed market. */
export interface WssEvent {
  /** Identity of the trigger this event belongs to (TriggerKey.id). */
  readonly triggerId: string;
  /** Original trigger key, for downstream consumers that need slug/conditionId. */
  readonly trigger: TriggerKey;
  /**
   * Polymarket event type — `book`, `price_change`, `tick_size_change`,
   * `last_trade_price`, etc. Forwarded as-is from upstream.
   */
  readonly type: string;
  /** Server-side timestamp (ms) if the upstream provides one. */
  readonly timestamp: number;
  /** The raw upstream payload. */
  readonly payload: unknown;
  /** When this process received the event (ms). */
  readonly receivedAt: number;
}

/** A non-fatal connection-level error, scoped to a particular trigger. */
export interface WssError {
  readonly triggerId: string;
  readonly trigger: TriggerKey;
  readonly error: Error;
}

export type EventHandler = (event: WssEvent) => void;
export type ErrorHandler = (err: WssError) => void;

export interface WssManagerStatus {
  /** True iff `start()` has been called and `stop()` has not. */
  readonly connected: boolean;
  /** Number of unique active subscriptions (= number of WS connections). */
  readonly subscriptions: number;
}
