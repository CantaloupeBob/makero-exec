import { Chain, ClobClient } from "@polymarket/clob-client-v2";
import { closeDb } from "./db/client.ts";
import { loadAllTriggerKeys } from "./wss/triggers/repository.ts";
import {
  PolymarketTokenResolver,
  WssManager,
  type WssEvent,
  type WssError,
} from "./wss/index.ts";
import {
  InMemoryEventBus,
  newEventId,
  wssTopic,
  type BusEvent,
  type StrategyTriggeredEvent,
  type WssMarketEvent,
  type WssErrorEvent,
} from "./event-bus/index.ts";
import {
  BookStore,
  BookSynchronizer,
  loadAllStrategies,
  PolymarketProbabilityExtractor,
  SdkBookResyncer,
  StrategyEngine,
  YesTokenResolver,
} from "./strategy/index.ts";

const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";

async function main() {
  // ---- 1. External clients --------------------------------------------------
  // The CLOB client is used here purely to resolve `condition_id` →
  // outcome `token_id`s for the WSS market channel (a public, read-only call,
  // so no signer/creds required).
  const clobClient = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
  });

  // ---- 2. WSS manager -------------------------------------------------------
  const manager = new WssManager({
    resolver: new PolymarketTokenResolver(clobClient),
  });

  // ---- 2a. Event bus --------------------------------------------------------
  // Single in-process bus. The WSS manager publishes here; downstream
  // subsystems (strategy engine, executor, …) subscribe by topic pattern.
  const bus = new InMemoryEventBus();

  // Bridge: WSS events → bus topic `wss.<triggerId>.<type>`.
  manager.onEvent((event: WssEvent) => {
    const now = Date.now();
    const topic = wssTopic(event.triggerId, event.type);
    const busEvent: WssMarketEvent = {
      id: newEventId(),
      topic,
      source: "wss",
      type: event.type,
      timestamp: event.timestamp,
      publishedAt: now,
      triggerId: event.triggerId,
      trigger: event.trigger,
      receivedAt: event.receivedAt,
      payload: event.payload,
    };
    bus.publish(busEvent);
  });

  manager.onError((err: WssError) => {
    const now = Date.now();
    const topic = wssTopic(err.triggerId, "error");
    const busEvent: WssErrorEvent = {
      id: newEventId(),
      topic,
      source: "wss",
      type: "error",
      timestamp: now,
      publishedAt: now,
      triggerId: err.triggerId,
      trigger: err.trigger,
      payload: { message: err.error.message, stack: err.error.stack },
    };
    bus.publish(busEvent);
  });

  // Demo subscriptions — replace once real consumers exist.
  bus.subscribe("wss.*", (event: BusEvent) => {
    // console.log(
    //   `[bus] ${event.topic} @${event.timestamp}${summarizePayload(event)}`,
    // );
  });

  // ---- 2b. Strategy engine --------------------------------------------------
  // The engine is a single consumer of `wss.*`. It holds an in-memory index
  // of strategies keyed by triggerId and turns market events into decisions
  // (`StrategyTriggeredEvent`s) — it does NOT execute orders itself.
  const yesTokens = new YesTokenResolver(clobClient);
  // Shared local-book state. The extractor mutates it on every WSS event;
  // the synchronizer periodically (and on demand) overwrites it with a
  // REST snapshot to guarantee convergence with upstream truth.
  const bookStore = new BookStore();
  const bookSync = new BookSynchronizer(
    bookStore,
    new SdkBookResyncer(clobClient),
  );
  const engine = new StrategyEngine({
    bus,
    extractor: new PolymarketProbabilityExtractor(
      yesTokens,
      {},
      bookStore,
      // Suspect-book hook: any sanity-check failure (crossed book, mid
      // out of range, implausible mid jump) routes here. We forward to
      // the synchronizer, which debounces and coalesces in-flight resyncs.
      (assetId, reason) => {
        console.warn(
          `[extractor] suspect book ${assetId} (${reason}) — requesting resync`,
        );
        void bookSync.requestResync(assetId, "suspect");
      },
      // Probability logger: fires on every clean mid tick.
      (slug, assetId, mid) => {
        console.log(
          `[prob] ${slug} (${assetId.slice(0, 8)}…) mid=${(mid * 100).toFixed(2)}%`,
        );
      },
    ),
  });
  engine.start();
  bookSync.start();

  // Visibility into engine output. The executor will replace this listener.
  bus.subscribe("strategy.*", (event: BusEvent) => {
    if (event.source !== "strategy") return;
    const e = event as StrategyTriggeredEvent;
    console.log(
      `[strategy] FIRED ${e.strategyId} (${e.trigger.slug}) ` +
        `observed=${e.payload.observedProbability.toFixed(4)} ` +
        `${e.payload.direction} ${e.payload.threshold}`,
    );
  });

  // ---- 3. Discover triggers from DB and register subscriptions --------------
  const triggers = await loadAllTriggerKeys();
  console.log(
    `[boot] discovered ${triggers.size} unique trigger(s) from ${triggers.size > 0 ? "strategies" : "an empty strategies table"}`,
  );

  // Pre-warm the YES-token cache so the very first book snapshot from the
  // WSS layer can be turned into a probability without a cache miss.
  // Each successfully resolved YES asset is also tracked by the
  // synchronizer so it gets an immediate REST baseline + periodic refresh.
  await Promise.all(
    [...triggers.values()].map(async (t) => {
      try {
        const yesAssetId = await yesTokens.resolve(t);
        if (yesAssetId) bookSync.track(yesAssetId);
      } catch (err) {
        console.warn(
          `[boot] could not resolve YES token for ${t.slug}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }),
  );

  // Load strategies into the engine's in-memory index.
  const loadedStrategies = await loadAllStrategies();
  engine.addStrategies(loadedStrategies);
  console.log(
    `[boot] loaded ${loadedStrategies.length} strategy/strategies across ${engine.triggerCount()} trigger(s)`,
  );

  // The "consumer" here is the bootstrap module itself. When a strategy
  // engine comes online it will register its own consumer ID per strategy,
  // and refcounting will keep connections alive across consumers.
  const BOOT_CONSUMER = "bootstrap";
  for (const trigger of triggers.values()) {
    manager.addSubscription(trigger, BOOT_CONSUMER);
  }

  await manager.start();
  const status = manager.getStatus();
  console.log(
    `[boot] WSS manager started — connected=${status.connected} subscriptions=${status.subscriptions}`,
  );

  // ---- 4. Graceful shutdown -------------------------------------------------
  const shutdown = async (signal: string) => {
    console.log(`[boot] received ${signal}, shutting down…`);
    try {
      engine.stop();
      bookSync.stop();
      await manager.stop();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});

/**
 * Render the salient fields of a WSS payload as a short suffix for log lines.
 * The full payload is always available on `event.payload` for downstream
 * consumers; this is purely a debug-readability helper.
 */
function summarizePayload(event: BusEvent): string {
  if (event.source !== "wss") return "";
  const p = (event as WssMarketEvent).payload as
    | Record<string, unknown>
    | undefined;
  if (!p || typeof p !== "object") return "";

  switch (event.type) {
    case "price_change": {
      // Polymarket has shipped two shapes for this event:
      //   1) flat:    { price, size, side, ... }
      //   2) batched: { changes: [{ price, size, side }, ...] }
      const changes = Array.isArray(p["changes"])
        ? (p["changes"] as Array<Record<string, unknown>>)
        : hasPriceFields(p)
          ? [p]
          : [];
      if (changes.length === 0) {
        // Unknown shape — surface the keys + a snippet so we can adapt.
        return ` — ${JSON.stringify(p).slice(0, 200)}`;
      }
      const formatted = changes
        .map((c) => `${c["side"]} ${c["price"]}@${c["size"]}`)
        .join(", ");
      return ` — ${formatted}`;
    }
    case "last_trade_price": {
      return ` — ${p["side"]} ${p["price"]}@${p["size"]}`;
    }
    case "book": {
      const bids = Array.isArray(p["bids"]) ? p["bids"].length : 0;
      const asks = Array.isArray(p["asks"]) ? p["asks"].length : 0;
      return ` — book(bids=${bids}, asks=${asks})`;
    }
    case "tick_size_change": {
      return ` — tick ${p["old_tick_size"]}→${p["new_tick_size"]}`;
    }
    default:
      return "";
  }
}

function hasPriceFields(p: Record<string, unknown>): boolean {
  return "price" in p && "side" in p;
}
