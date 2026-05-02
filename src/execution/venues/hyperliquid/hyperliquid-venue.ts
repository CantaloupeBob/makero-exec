import { ExchangeClient, type IRequestTransport } from "@nktkas/hyperliquid";
import type { OrderParameters } from "@nktkas/hyperliquid/api/exchange";
import type { PrivateKeyAccount } from "viem";
import type { StrategyTriggeredEvent } from "../../../event-bus/event-bus.ts";
import type {
  ExecutableOrder,
  OrderExecutionResult,
  Venue,
} from "../../types.ts";
import type { ApiWalletLoader } from "../../wallet-loader.ts";
import {
  HyperliquidAssetResolver,
  defaultHyperliquidTransport,
} from "./asset-resolver.ts";
import {
  aggressiveLimitPrice,
  sizeFromUsdcNotional,
  triggerPriceFromPct,
  DEFAULT_SLIPPAGE,
} from "./formatters.ts";

export interface HyperliquidVenueOptions {
  readonly walletLoader: ApiWalletLoader;
  /** Reused across all users. */
  readonly transport?: IRequestTransport;
  /** Aggressiveness of the IOC entry leg (in price fraction, e.g. 0.005 = 50 bps). */
  readonly slippage?: number;
}

/**
 * Hyperliquid implementation of {@link Venue}.
 *
 * Per triggered strategy we:
 *   1. resolve the user's API wallet (decrypted) into a viem `PrivateKeyAccount`,
 *   2. build a fresh `ExchangeClient` bound to that wallet,
 *   3. for each order, look up the asset id + szDecimals + current mid,
 *   4. translate user inputs (USDC notional, %TP/SL) into Hyperliquid-native
 *      units using the SDK's formatters,
 *   5. update leverage if needed, then submit:
 *        - if no TP/SL → a single IOC limit order
 *        - else        → an entry IOC + a TP trigger + an SL trigger,
 *                        grouped as `positionTpsl` so they auto-resize with the position.
 *
 * Exceptions are caught per-order and surfaced as `failed` results so one
 * bad symbol doesn't kill a multi-leg strategy.
 */
export class HyperliquidVenue implements Venue {
  readonly name = "hyperliquid";

  private readonly transport: IRequestTransport;
  private readonly walletLoader: ApiWalletLoader;
  private readonly assetResolver: HyperliquidAssetResolver;
  private readonly slippage: number;
  /** Per-user ExchangeClient cache — keyed by lowercased master address.
   *  The account object is stored alongside so we can detect if the wallet
   *  loader has returned a different account (key rotation) and rebuild. */
  private readonly clients = new Map<
    string,
    { account: PrivateKeyAccount; client: ExchangeClient }
  >();

  constructor(opts: HyperliquidVenueOptions) {
    this.transport = opts.transport ?? defaultHyperliquidTransport();
    this.walletLoader = opts.walletLoader;
    this.assetResolver = new HyperliquidAssetResolver(this.transport);
    this.slippage = opts.slippage ?? DEFAULT_SLIPPAGE;
  }

  async execute(
    cause: StrategyTriggeredEvent,
    orders: readonly ExecutableOrder[],
  ): Promise<readonly OrderExecutionResult[]> {
    if (orders.length === 0) return [];

    // Use the authoritative userAddress from the triggering event, not from
    // orders[0] — the event is the verified source of truth and avoids a
    // potential panic when the orders slice is empty or cross-user.
    const userAddress = cause.userAddress;
    let client: ExchangeClient;
    try {
      client = await this.getClient(userAddress);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return orders.map((o) => ({
        status: "failed" as const,
        orderId: o.id,
        error: `wallet load failed: ${reason}`,
      }));
    }

    const results: OrderExecutionResult[] = [];
    for (const order of orders) {
      try {
        results.push(await this.executeOne(client, cause, order));
      } catch (err) {
        results.push({
          status: "failed",
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async getClient(userAddress: string): Promise<ExchangeClient> {
    const key = userAddress.toLowerCase();
    // Always load through ApiWalletLoader so we pick up any account change
    // (e.g. future key rotation) rather than blindly serving a stale client.
    const wallet: PrivateKeyAccount = await this.walletLoader.load(userAddress);
    const cached = this.clients.get(key);
    if (cached && cached.account === wallet) return cached.client;
    const client = new ExchangeClient({
      transport: this.transport,
      wallet,
    });
    this.clients.set(key, { account: wallet, client });
    return client;
  }

  private async executeOne(
    client: ExchangeClient,
    cause: StrategyTriggeredEvent,
    order: ExecutableOrder,
  ): Promise<OrderExecutionResult> {
    if (Date.now() > order.orderDeadline) {
      return {
        status: "skipped",
        orderId: order.id,
        reason: "order_deadline_passed",
      };
    }

    const { assetId, szDecimals } = await this.assetResolver.resolve(
      order.asset,
    );
    const mid = await this.assetResolver.mid(order.asset);

    const entryPx = aggressiveLimitPrice(
      mid,
      order.isLong,
      szDecimals,
      this.slippage,
    );
    // Numeric entry price used as the reference for TP/SL percentage calculations.
    // Must be derived from the formatted string so it matches the exact price
    // sent to the exchange (formatPrice applies rounding / sig-fig rules).
    const entryPxNum = Number(entryPx);
    const sz = sizeFromUsdcNotional(order.sizeUsdc, mid, szDecimals);

    // Best-effort leverage update. Failing here shouldn't block the order
    // — the user already has *some* leverage configured server-side and
    // the order will simply use that.
    try {
      await client.updateLeverage({
        asset: assetId,
        isCross: true, // TODO - Update this source to come from DB when isoalted margin is supported
        leverage: order.leverage,
      });
    } catch (err) {
      console.warn(
        `[hyperliquid] updateLeverage(${order.asset}, ${order.leverage}x) failed for ` +
          `order ${order.id}: ${err instanceof Error ? err.message : err}`,
      );
    }

    const orderLegs: OrderParameters["orders"] = [
      {
        a: assetId,
        b: order.isLong,
        p: entryPx,
        s: sz,
        r: order.reduceOnly,
        t: { limit: { tif: "Ioc" } },
      },
    ];

    if (order.takeProfitPct !== null) {
      const tpPx = triggerPriceFromPct(
        entryPxNum,
        order.takeProfitPct,
        order.isLong,
        "tp",
        szDecimals,
      );
      orderLegs.push({
        a: assetId,
        b: !order.isLong, // closing leg flips side
        p: tpPx,
        s: sz,
        r: true,
        t: {
          trigger: {
            isMarket: true,
            triggerPx: tpPx,
            tpsl: "tp",
          },
        },
      });
    }
    if (order.stopLossPct !== null) {
      const slPx = triggerPriceFromPct(
        entryPxNum,
        order.stopLossPct,
        order.isLong,
        "sl",
        szDecimals,
      );
      orderLegs.push({
        a: assetId,
        b: !order.isLong,
        p: slPx,
        s: sz,
        r: true,
        t: {
          trigger: {
            isMarket: true,
            triggerPx: slPx,
            tpsl: "sl",
          },
        },
      });
    }

    const grouping: "na" | "positionTpsl" =
      orderLegs.length > 1 ? "positionTpsl" : "na";

    const resp = await client.order({ orders: orderLegs, grouping });

    // Inspect the entry status (always the first leg) to map onto our
    // execution-result enum. Errors on TP/SL legs are logged but don't
    // fail the order — the position is open and the user has a partial
    // safety net.
    const statuses = resp.response.data.statuses;
    const entryStatus = statuses[0];
    if (entryStatus === undefined) {
      return {
        status: "failed",
        orderId: order.id,
        error: "Hyperliquid response contained no statuses",
      };
    }

    for (let i = 1; i < statuses.length; i++) {
      const s = statuses[i];
      if (s !== undefined && typeof s !== "string" && "error" in s) {
        console.warn(
          `[hyperliquid] order ${order.id} TP/SL leg ${i} rejected: ${s.error}`,
        );
      }
    }

    if (typeof entryStatus !== "string" && "filled" in entryStatus) {
      console.log(
        `[hyperliquid] order ${order.id} FILLED ` +
          `${order.isLong ? "LONG" : "SHORT"} ${order.asset} ` +
          `${entryStatus.filled.totalSz}@${entryStatus.filled.avgPx} ` +
          `(strategy=${cause.strategyId})`,
      );
      return {
        status: "filled",
        orderId: order.id,
        venueRef: String(entryStatus.filled.oid),
      };
    }
    if (typeof entryStatus !== "string" && "resting" in entryStatus) {
      return {
        status: "resting",
        orderId: order.id,
        venueRef: String(entryStatus.resting.oid),
      };
    }
    if (
      typeof entryStatus !== "string" &&
      "error" in (entryStatus as Record<string, unknown>)
    ) {
      return {
        status: "failed",
        orderId: order.id,
        error: (entryStatus as { error: string }).error,
      };
    }
    return {
      status: "submitted",
      orderId: order.id,
      venueRef: typeof entryStatus === "string" ? entryStatus : undefined,
    };
  }
}
