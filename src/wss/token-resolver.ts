import type { ClobClient } from "@polymarket/clob-client-v2";
import type { TriggerKey } from "./triggers/trigger-key.ts";

/**
 * Resolves a TriggerKey into the upstream token IDs that need to be
 * subscribed to. Abstracted as an interface so the WssManager can be
 * unit-tested without a live SDK / network.
 */
export interface TokenResolver {
  resolve(trigger: TriggerKey): Promise<string[]>;
}

/** A single outcome token as returned by the CLOB market-info endpoint. */
interface MarketToken {
  readonly t: string;
  readonly o: string;
}

/**
 * Polymarket market-token resolver. A single `getClobMarketInfo` call backs
 * two distinct consumers:
 *
 *   - the WSS layer needs *all* outcome token IDs to subscribe the market
 *     feed (`resolve`, satisfying {@link TokenResolver});
 *   - the strategy layer needs the *YES* outcome token id, whose price is the
 *     market's implied probability (`resolveYes` / `getYes`).
 *
 * Previously these were two classes (`PolymarketTokenResolver` and
 * `YesTokenResolver`) each making their own round-trip to the same endpoint
 * for the same market. They're collapsed here so each market is fetched once,
 * with both views derived from the cached result. Results are cached forever —
 * a market's outcome tokens never change.
 */
export class PolymarketMarketResolver implements TokenResolver {
  private readonly tokensCache = new Map<string, MarketToken[]>();
  private readonly tokensInflight = new Map<string, Promise<MarketToken[]>>();
  private readonly yesCache = new Map<string, string>();

  constructor(private readonly client: ClobClient) {}

  /** All outcome token IDs for the market's WS subscription. */
  async resolve(trigger: TriggerKey): Promise<string[]> {
    const tokens = await this.loadTokens(trigger);
    const ids = tokens.filter((t) => !!t.t).map((t) => t.t);
    if (ids.length === 0) {
      throw new Error(
        `No tokens returned for condition ${trigger.conditionId} (${trigger.slug})`,
      );
    }
    return ids;
  }

  /** Resolve (and cache) the YES outcome token id. */
  async resolveYes(trigger: TriggerKey): Promise<string> {
    const cached = this.yesCache.get(trigger.conditionId);
    if (cached) return cached;
    const tokens = await this.loadTokens(trigger);
    return this.deriveYes(trigger, tokens);
  }

  /**
   * Synchronous lookup of the YES token; returns null if the trigger hasn't
   * been resolved yet. Used by the strategy engine's hot path.
   */
  getYes(trigger: TriggerKey): string | null {
    return this.yesCache.get(trigger.conditionId) ?? null;
  }

  private deriveYes(trigger: TriggerKey, tokens: MarketToken[]): string {
    const cached = this.yesCache.get(trigger.conditionId);
    if (cached) return cached;

    // Only tokens carrying an outcome label can be classified as YES/NO.
    const labeled = tokens.filter((t) => typeof t.o === "string");
    if (labeled.length === 0) {
      throw new Error(
        `No outcome tokens found for condition ${trigger.conditionId} (${trigger.slug})`,
      );
    }

    // Polymarket binary markets come in two flavours:
    //   1. Yes/No outcomes (most political, news markets)
    //   2. Domain-specific paired outcomes (Up/Down, Trump/Harris, …)
    //
    // For (1) the "Yes" token's price IS the probability of the event.
    // For (2) there is no canonical "Yes" — by convention we use the FIRST
    // listed outcome's token, which Polymarket emits in a stable order
    // matching the market's natural framing (e.g. "BTC Up or Down" → "Up"
    // first → "Up" probability). Strategy authors must understand that for
    // non-Yes/No markets the threshold refers to the first outcome's price.
    const explicitYes = labeled.find((t) => t.o.toLowerCase() === "yes");
    const chosen = explicitYes ?? labeled[0]!;
    if (!explicitYes) {
      console.warn(
        `[market-resolver] market ${trigger.slug} has no "Yes" outcome — ` +
          `using first outcome "${chosen.o}" as the probability source`,
      );
    }
    this.yesCache.set(trigger.conditionId, chosen.t);
    return chosen.t;
  }

  private loadTokens(trigger: TriggerKey): Promise<MarketToken[]> {
    if (trigger.provider !== "polymarket") {
      return Promise.reject(
        new Error(
          `PolymarketMarketResolver only supports polymarket; got ${trigger.id}`,
        ),
      );
    }
    const cached = this.tokensCache.get(trigger.conditionId);
    if (cached) return Promise.resolve(cached);

    const inflight = this.tokensInflight.get(trigger.conditionId);
    if (inflight) return inflight;

    const p = this.fetchTokens(trigger).finally(() => {
      this.tokensInflight.delete(trigger.conditionId);
    });
    this.tokensInflight.set(trigger.conditionId, p);
    return p;
  }

  private async fetchTokens(trigger: TriggerKey): Promise<MarketToken[]> {
    const info = await this.client.getClobMarketInfo(trigger.conditionId);
    const tokens = (info?.t ?? []).filter(
      (t): t is MarketToken => !!t && typeof t.t === "string",
    );
    this.tokensCache.set(trigger.conditionId, tokens);
    return tokens;
  }
}
