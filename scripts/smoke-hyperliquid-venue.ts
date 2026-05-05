/**
 * smoke-hyperliquid-venue.ts
 *
 * Quick manual smoke test for HyperliquidVenue.execute().
 * Uses the real ApiWalletLoader + decryption flow — no private key needed
 * in the environment, only the master encryption key and the target address.
 *
 * Usage:
 *   bun run scripts/smoke-hyperliquid-venue.ts
 *
 * Required env vars:
 *   SCRIPT_WALLET  – EVM address of the master account whose API wallet is in the DB
 *   MASTER_KEY     – base64 master encryption key (same as the app uses)
 *   DATABASE_URL   – Postgres connection string (same as the app uses)
 */

import type { StrategyTriggeredEvent } from "../src/event-bus/event-bus.ts";
import type { ExecutableOrder } from "../src/execution/types.ts";
import { ApiWalletLoader } from "../src/execution/wallet-loader.ts";
import { HyperliquidVenue } from "../src/execution/venues/hyperliquid/hyperliquid-venue.ts";
import { defaultHyperliquidTransport } from "../src/execution/venues/hyperliquid/asset-resolver.ts";
import { initCrypto } from "../src/lib/crypto.ts";

// ---------------------------------------------------------------------------
// Config — edit these or set env vars
// ---------------------------------------------------------------------------

const USER_ADDRESS = process.env.SCRIPT_WALLET ?? "";

/** Switch to mainnet by changing defaultHyperliquidTransport in asset-resolver.ts */

// ---------------------------------------------------------------------------
// Order params
// ---------------------------------------------------------------------------

const ORDER: ExecutableOrder = {
  id: "smoke-order-001",
  userAddress: USER_ADDRESS,
  strategyId: "smoke-strategy",
  asset: "BTC",
  isLong: true,
  sizeUsdc: 11, // ~minimum notional
  leverage: 3,
  takeProfitPct: 5, // +5%
  stopLossPct: 3, // -3%
  maxSlippagePct: 0.5, // 50 bps
  reduceOnly: false,
  orderDeadline: Date.now() + 60_000, // valid for 60 s
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!USER_ADDRESS) {
    console.error(
      "Please set SCRIPT_WALLET env var to the master EVM address.",
    );
    process.exit(1);
  }

  await initCrypto();

  const transport = defaultHyperliquidTransport();
  const walletLoader = new ApiWalletLoader();

  const venue = new HyperliquidVenue({ walletLoader, transport });

  const cause: StrategyTriggeredEvent = {
    id: "smoke-event-001",
    topic: "strategy.smoke.triggered",
    source: "strategy",
    type: "triggered",
    strategyId: "smoke-strategy",
    userAddress: USER_ADDRESS,
    triggerId: "smoke-trigger",
    trigger: {
      id: "polymarket:0x0",
      provider: "polymarket",
      slug: "smoke-market",
      conditionId: "0x0",
      raw: "polymarket:smoke-market:0x0",
    },
    timestamp: Date.now(),
    publishedAt: Date.now(),
    payload: {
      observedProbability: 0.9,
      threshold: 0.8,
      direction: ">=",
      causeEventId: "smoke-cause-001",
    },
  };

  console.log("Submitting smoke order to Hyperliquid...");
  console.log("  userAddress:", USER_ADDRESS);
  console.log("  asset      :", ORDER.asset);
  console.log("  side       :", ORDER.isLong ? "LONG" : "SHORT");
  console.log("  sizeUsdc   :", ORDER.sizeUsdc);
  console.log("  leverage   :", ORDER.leverage, "x");
  console.log("  TP         :", ORDER.takeProfitPct, "%");
  console.log("  SL         :", ORDER.stopLossPct, "%");
  console.log("  slippage   :", ORDER.maxSlippagePct, "%");
  console.log("  deadline   :", new Date(ORDER.orderDeadline).toISOString());
  console.log();

  const results = await venue.execute(cause, [ORDER]);

  for (const r of results) {
    switch (r.status) {
      case "filled":
        console.log(
          "FILLED       orderId=" + r.orderId + " venueRef=" + r.venueRef,
        );
        break;
      case "filled_unprotected":
        console.warn(
          "FILLED_NO_TPSL  orderId=" + r.orderId + " venueRef=" + r.venueRef,
        );
        break;
      case "submitted":
        console.log(
          "SUBMITTED    orderId=" +
            r.orderId +
            " venueRef=" +
            (r.venueRef ?? "-"),
        );
        break;
      case "resting":
        console.log(
          "RESTING      orderId=" +
            r.orderId +
            " venueRef=" +
            (r.venueRef ?? "-"),
        );
        break;
      case "skipped":
        console.log(
          "SKIPPED      orderId=" + r.orderId + " reason=" + r.reason,
        );
        break;
      case "failed":
        console.error(
          "FAILED       orderId=" + r.orderId + " error=" + r.error,
        );
        break;
    }
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
