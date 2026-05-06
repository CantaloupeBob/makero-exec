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
  type WssMarketEvent,
  type WssErrorEvent,
} from "./event-bus/index.ts";
import {
  BookStore,
  BookSynchronizer,
  loadAllStrategies,
  loadAttemptedStrategyIds,
  loadNewStrategies,
  PolymarketProbabilityExtractor,
  SdkBookResyncer,
  StrategyEngine,
  YesTokenResolver,
} from "./strategy/index.ts";
import {
  ApiWalletLoader,
  HyperliquidVenue,
  StrategyExecutor,
} from "./execution/index.ts";
import { initCrypto } from "./lib/crypto.ts";

// ---- Environment validation ------------------------------------------------
// Fail fast at startup with a clear message rather than throwing deep in the
// call stack when a missing variable is first needed.
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val)
    throw new Error(`Required environment variable "${name}" is not set`);
  return val;
}

// Validated at module load so any misconfiguration kills the process before
// touching the network or DB.
requireEnv("DATABASE_URL");
requireEnv("MASTER_KEY");

const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";

// ---- Global error handlers -------------------------------------------------
// Catch any promise rejection that escapes all local try/catch blocks.
// Log prominently but do NOT exit — a single stray rejection must not kill
// the process while a position may be open.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[boot] UNHANDLED REJECTION — this is a bug, please investigate:",
    reason instanceof Error ? (reason.stack ?? reason.message) : reason,
  );
});
process.on("uncaughtException", (err) => {
  // An uncaught synchronous exception is fatal — log and exit cleanly.
  console.error(
    "[boot] UNCAUGHT EXCEPTION — exiting:",
    err.stack ?? err.message,
  );
  process.exit(1);
});

async function main() {
  // ---- 0. Crypto subsystem --------------------------------------------------
  await initCrypto();

  // ---- 1. External clients --------------------------------------------------
  const clobClient = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
  });

  // ---- 2. WSS manager -------------------------------------------------------
  const BOOT_CONSUMER = "bootstrap";
  const manager = new WssManager({
    resolver: new PolymarketTokenResolver(clobClient),
  });

  // ---- 2a. Event bus --------------------------------------------------------
  const bus = new InMemoryEventBus();

  // ---- 2b. Strategy engine --------------------------------------------------
  const yesTokens = new YesTokenResolver(clobClient);
  const bookStore = new BookStore();
  const bookSync = new BookSynchronizer(
    bookStore,
    new SdkBookResyncer(clobClient),
  );

  /**
   * Maps triggerId → resolved YES asset ID. Populated during pre-warm and the
   * polling loop so the engine's onStrategyFired callback can untrack the book
   * and remove the WSS subscription when the last strategy for a market fires.
   */
  const triggerYesAssetId = new Map<string, string>();

  const engine = new StrategyEngine({
    bus,
    extractor: new PolymarketProbabilityExtractor(
      yesTokens,
      {},
      bookStore,
      (assetId, reason) => {
        console.warn(
          `[extractor] suspect book ${assetId} (${reason}) — requesting resync`,
        );
        void bookSync.requestResync(assetId, "suspect");
      },
      (slug, assetId, mid) => {
        console.log(
          `[prob] ${slug} (${assetId.slice(0, 8)}…) mid=${(mid * 100).toFixed(2)}%`,
        );
      },
    ),
    onStrategyFired: (strategy, triggerId, triggerNowEmpty) => {
      if (!triggerNowEmpty) return;
      // Last strategy for this trigger has fired — tear down the WSS feed and
      // stop the periodic book resync so we don't hold open stale resources.
      console.log(
        `[engine] trigger ${triggerId} has no remaining strategies — closing WSS feed`,
      );
      manager.removeSubscription(strategy.trigger, BOOT_CONSUMER);
      const yesAssetId = triggerYesAssetId.get(triggerId);
      if (yesAssetId) {
        bookSync.untrack(yesAssetId);
        triggerYesAssetId.delete(triggerId);
      }
    },
  });

  // ---- 2c. Strategy executor ------------------------------------------------
  const walletLoader = new ApiWalletLoader();
  const hyperliquidVenue = new HyperliquidVenue({ walletLoader });
  const executor = new StrategyExecutor({
    bus,
    venues: [hyperliquidVenue],
  });

  // ---- 3. Discover triggers, pre-warm caches, load strategies ---------------
  const triggers = await loadAllTriggerKeys();
  console.log(
    `[boot] discovered ${triggers.size} unique trigger(s) from the strategies table`,
  );

  // Pre-warm YES-token cache and register assets for REST baseline tracking.
  // All track() calls must happen BEFORE bookSync.start() so every asset is
  // included in the warmup set and the cold-book gate works correctly.
  await Promise.all(
    [...triggers.values()].map(async (t) => {
      try {
        const yesAssetId = await yesTokens.resolve(t);
        if (yesAssetId) {
          console.log(
            `[boot] resolved YES token for ${t.slug}: ${yesAssetId} — tracking for warmup`,
          );
          bookSync.track(yesAssetId);
          triggerYesAssetId.set(t.id, yesAssetId);
        } else {
          console.warn(`[boot] YES token resolved to empty for ${t.slug}`);
        }
      } catch (err) {
        console.warn(
          `[boot] could not resolve YES token for ${t.slug}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }),
  );

  const [loadedStrategies, attemptedIds] = await Promise.all([
    loadAllStrategies(),
    loadAttemptedStrategyIds(),
  ]);
  const unattemptedStrategies = loadedStrategies.filter(
    (s) => !attemptedIds.has(s.id),
  );
  if (attemptedIds.size > 0) {
    console.log(
      `[boot] skipping ${attemptedIds.size} already-attempted strategy/strategies`,
    );
  }
  engine.addStrategies(unattemptedStrategies);
  console.log(
    `[boot] loaded ${unattemptedStrategies.length} strategy/strategies across ${engine.triggerCount()} trigger(s)`,
  );

  // ---- 4. Start subsystems --------------------------------------------------
  engine.start();
  executor.start();
  // bookSync.start() kicks off REST baseline fetches for all tracked assets.
  // The warmupComplete promise resolves once every asset has its first snapshot.
  bookSync.start();

  // ---- 5. Cold-book gate ----------------------------------------------------
  // Delay wiring the WSS → bus bridge until every tracked book has at least
  // one REST baseline. This eliminates the startup race where the first WSS
  // tick is evaluated against an empty BookStore.
  const WARMUP_TIMEOUT_MS = 30_000;
  await Promise.race([
    bookSync.warmupComplete,
    new Promise<void>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`book warmup timed out after ${WARMUP_TIMEOUT_MS}ms`),
          ),
        WARMUP_TIMEOUT_MS,
      ),
    ),
  ]).catch((err: unknown) => {
    // Non-fatal: log and proceed. The suspect-book hook will resync on bad ticks.
    console.warn(
      `[boot] ${err instanceof Error ? err.message : err} — opening WSS bridge anyway`,
    );
  });

  console.log("[boot] book warmup complete — opening WSS bridge");

  // ---- 6. Wire WSS → bus bridge and start manager --------------------------
  for (const trigger of triggers.values()) {
    manager.addSubscription(trigger, BOOT_CONSUMER);
  }

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
      payload: { message: err.error.message },
    };
    bus.publish(busEvent);
  });

  await manager.start();
  const status = manager.getStatus();
  console.log(
    `[boot] WSS manager started — connected=${status.connected} subscriptions=${status.subscriptions}`,
  );

  // ---- 7. WSS heartbeat watchdog --------------------------------------------
  // If no WSS events arrive within this window the connection is likely
  // silently stalled. Force a full book resync so probabilities don't
  // calcify on stale state.
  const WSS_HEARTBEAT_TIMEOUT_MS = 60_000;
  let lastWssEventAt = Date.now();
  manager.onEvent(() => {
    lastWssEventAt = Date.now();
  });

  const heartbeatTimer = setInterval(() => {
    const silenceMs = Date.now() - lastWssEventAt;
    if (silenceMs > WSS_HEARTBEAT_TIMEOUT_MS) {
      console.error(
        `[boot] no WSS events for ${Math.round(silenceMs / 1_000)}s — ` +
          `connection may be stalled, requesting full book resync`,
      );
      void bookSync.resyncAll("reconnect");
    }
  }, WSS_HEARTBEAT_TIMEOUT_MS);

  // ---- 8. New-strategy polling loop ----------------------------------------
  // Picks up strategies created after boot without a process restart.
  // Runs every 10 seconds. For each new strategy:
  //   - resolves its YES token (pre-warming the cache),
  //   - registers the book for tracking/resync if not already tracked,
  //   - adds a WSS subscription for the trigger if not already subscribed,
  //   - arms the strategy in the engine.
  const STRATEGY_POLL_INTERVAL_MS = 2_000;
  // Overlap buffer guards against DB/app server clock skew. We query for
  // strategies created after (lastPollAt - POLL_OVERLAP_MS) to ensure a
  // strategy inserted just before our cursor is never silently missed.
  // loadNewStrategies filters by hasBeenAttempted=false so the overlap
  // only causes redundant but harmless re-checks of already-armed strategies
  // (engine.addStrategy is idempotent — it won't duplicate an armed strategy).
  const POLL_OVERLAP_MS = 10_000;
  let lastStrategyPollAt = new Date();
  const strategyPollTimer = setInterval(() => {
    const since = new Date(lastStrategyPollAt.getTime() - POLL_OVERLAP_MS);
    // Advance the cursor before awaiting so a slow poll doesn't double-count
    // strategies created while this poll is in flight.
    lastStrategyPollAt = new Date();
    void (async () => {
      try {
        const newStrategies = await loadNewStrategies(since);
        if (newStrategies.length === 0) return;
        console.log(
          `[strategy-poll] discovered ${newStrategies.length} new strategy/strategies`,
        );

        await Promise.all(
          newStrategies.map(async (s) => {
            try {
              const yesAssetId = await yesTokens.resolve(s.trigger);
              if (yesAssetId) {
                bookSync.track(yesAssetId);
                triggerYesAssetId.set(s.trigger.id, yesAssetId);
              }
            } catch (err) {
              console.warn(
                `[strategy-poll] could not resolve YES token for ${s.trigger.slug}: ` +
                  `${err instanceof Error ? err.message : err}`,
              );
            }
            manager.addSubscription(s.trigger, BOOT_CONSUMER);
          }),
        );

        engine.addStrategies(newStrategies);
      } catch (err) {
        console.error(
          "[strategy-poll] error polling for new strategies:",
          err instanceof Error ? (err.stack ?? err.message) : err,
        );
      }
    })();
  }, STRATEGY_POLL_INTERVAL_MS);

  // ---- 9. Graceful shutdown -------------------------------------------------
  const shutdown = async (signal: string) => {
    console.log(`[boot] received ${signal}, shutting down…`);
    clearInterval(heartbeatTimer);
    clearInterval(strategyPollTimer);
    try {
      engine.stop();
      bookSync.stop();
      executor.stop();
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
