import type { TriggerKey } from "./triggers/trigger-key.ts";
import type { WssEvent } from "./types.ts";

/**
 * Polymarket public market-data WebSocket endpoint.
 *
 * The CLOB exposes a "market" channel at this URL. Clients subscribe by
 * sending an initial JSON message containing the asset/token IDs they want
 * to receive updates for. The server then pushes book/price/trade events
 * for those tokens. No authentication is required for the market channel.
 */
const POLYMARKET_WS_URL =
  "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/** Tunable parameters for a single Polymarket connection. */
export interface PolymarketConnectionOptions {
  /** Interval (ms) between PING frames. */
  readonly heartbeatIntervalMs: number;
  /** If no message of any kind is received within this window, the socket is considered dead and is force-closed. */
  readonly idleTimeoutMs: number;
  /** Initial reconnect delay (ms). Doubled on each consecutive failure. */
  readonly initialBackoffMs: number;
  /** Maximum reconnect delay (ms). */
  readonly maxBackoffMs: number;
}

export const DEFAULT_CONNECTION_OPTIONS: PolymarketConnectionOptions = {
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 30_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
};

type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed";

interface ConnectionCallbacks {
  onEvent(event: WssEvent): void;
  onError(err: Error): void;
}

/**
 * Owns exactly one upstream WebSocket connection bound to one TriggerKey
 * (and therefore one set of token IDs). Encapsulates:
 *
 *  - initial subscribe handshake
 *  - heartbeat (PING) and idle-timeout detection
 *  - automatic reconnect with capped exponential backoff
 *  - graceful shutdown
 *
 * It is intentionally ignorant of consumers, the DB, or other connections;
 * the `WssManager` is responsible for that orchestration. This isolation is
 * what lets us scale to N markets safely — one bad feed cannot affect the
 * rest of the pool.
 */
export class PolymarketConnection {
  private readonly opts: PolymarketConnectionOptions;
  private readonly callbacks: ConnectionCallbacks;

  private ws: WebSocket | undefined;
  private state: ConnectionState = "idle";

  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private consecutiveFailures = 0;
  /** Set when stop() is called so we don't reconnect after intentional close. */
  private stopped = false;

  constructor(
    public readonly trigger: TriggerKey,
    public readonly tokenIds: readonly string[],
    callbacks: ConnectionCallbacks,
    opts: Partial<PolymarketConnectionOptions> = {},
  ) {
    if (tokenIds.length === 0) {
      throw new Error(
        `PolymarketConnection requires at least one token id (trigger ${trigger.id})`,
      );
    }
    this.callbacks = callbacks;
    this.opts = { ...DEFAULT_CONNECTION_OPTIONS, ...opts };
  }

  // ---------------------------------------------------------------------------
  // Public lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.stopped) {
      throw new Error(
        `Cannot restart a stopped PolymarketConnection (${this.trigger.id})`,
      );
    }
    if (this.state !== "idle" && this.state !== "closed") return;
    this.openSocket();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    if (!ws) {
      this.state = "closed";
      return;
    }
    if (ws.readyState === WebSocket.CLOSED) {
      this.state = "closed";
      return;
    }
    this.state = "closing";
    await new Promise<void>((resolve) => {
      const done = () => {
        ws.removeEventListener("close", done);
        resolve();
      };
      ws.addEventListener("close", done);
      try {
        ws.close(1000, "client shutdown");
      } catch {
        resolve();
      }
    });
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private openSocket(): void {
    this.state = "connecting";
    let ws: WebSocket;
    try {
      ws = new WebSocket(POLYMARKET_WS_URL);
    } catch (err) {
      this.handleFailure(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => this.onOpen());
    ws.addEventListener("message", (e) => this.onMessage(e));
    ws.addEventListener("error", (e) => this.onSocketError(e));
    ws.addEventListener("close", (e) => this.onClose(e));
  }

  private onOpen(): void {
    this.state = "open";
    this.consecutiveFailures = 0;

    // Polymarket subscribe handshake. Sending an empty `markets` array because
    // the market channel is keyed off token IDs (`assets_ids`).
    const subscribeMsg = {
      type: "MARKET",
      assets_ids: this.tokenIds,
    };
    try {
      this.ws?.send(JSON.stringify(subscribeMsg));
    } catch (err) {
      this.callbacks.onError(
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    this.startHeartbeat();
    this.bumpIdleTimer();
  }

  private onMessage(ev: MessageEvent): void {
    this.bumpIdleTimer();

    const raw = typeof ev.data === "string" ? ev.data : ev.data?.toString?.();
    if (!raw) return;

    // Polymarket sends "PONG" as a plain string in response to "PING".
    if (raw === "PONG" || raw === "pong") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.callbacks.onError(
        new Error(
          `Failed to parse upstream message: ${err instanceof Error ? err.message : err}`,
        ),
      );
      return;
    }

    // Polymarket sends either a single object or an array of events.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const now = Date.now();
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const type =
        typeof obj["event_type"] === "string"
          ? (obj["event_type"] as string)
          : typeof obj["type"] === "string"
            ? (obj["type"] as string)
            : "unknown";
      const tsRaw = obj["timestamp"];
      const timestamp =
        typeof tsRaw === "number"
          ? tsRaw
          : typeof tsRaw === "string"
            ? Number(tsRaw) || now
            : now;

      this.callbacks.onEvent({
        triggerId: this.trigger.id,
        trigger: this.trigger,
        type,
        timestamp,
        payload: item,
        receivedAt: now,
      });
    }
  }

  private onSocketError(ev: Event): void {
    const msg = (ev as ErrorEvent)?.message ?? "websocket error";
    this.callbacks.onError(new Error(msg));
    // Don't tear down here; the `close` event will follow and drive reconnect.
  }

  private onClose(ev: CloseEvent): void {
    this.clearTimers();
    this.ws = undefined;
    this.state = "closed";

    if (this.stopped) return;

    if (ev.code !== 1000) {
      this.callbacks.onError(
        new Error(
          `WebSocket closed unexpectedly (code=${ev.code} reason="${ev.reason}")`,
        ),
      );
    }
    this.scheduleReconnect();
  }

  private handleFailure(err: Error): void {
    this.callbacks.onError(err);
    this.clearTimers();
    this.ws = undefined;
    this.state = "closed";
    if (!this.stopped) this.scheduleReconnect();
  }

  // --- timers --------------------------------------------------------------

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        // Polymarket expects a literal "PING" text frame.
        ws.send("PING");
      } catch (err) {
        this.callbacks.onError(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }, this.opts.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private bumpIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.callbacks.onError(
        new Error(
          `Idle timeout (${this.opts.idleTimeoutMs}ms) — forcing reconnect`,
        ),
      );
      // Force close; onClose will schedule a reconnect.
      try {
        this.ws?.close(4000, "idle timeout");
      } catch {
        /* noop */
      }
    }, this.opts.idleTimeoutMs);
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.opts.maxBackoffMs,
      this.opts.initialBackoffMs * 2 ** this.consecutiveFailures,
    );
    // Add up to 25% jitter to avoid thundering herds when many feeds drop together.
    const jittered = delay + Math.floor(Math.random() * (delay * 0.25));
    this.consecutiveFailures += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.openSocket();
    }, jittered);
  }
}
