import type { ClobClient } from "@polymarket/clob-client-v2";
import type { TriggerKey } from "../wss/triggers/trigger-key.ts";

/**
 * Resolves a Polymarket condition_id to the asset_id of its `Yes` outcome
 * token. Polymarket markets are binary CLOBs, and by construction
 *
 *   P(Yes outcome) ≈ price(Yes token)
 *
 * so identifying the "Yes" token is what lets the strategy engine convert a
 * book/price event into an implied probability.
 *
 * Results are cached forever — a market's outcome tokens never change.
 */
export class YesTokenResolver {
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly client: ClobClient) {}

  async resolve(trigger: TriggerKey): Promise<string> {
    const cached = this.cache.get(trigger.conditionId);
    if (cached) return cached;

    const inflight = this.inflight.get(trigger.conditionId);
    if (inflight) return inflight;

    const p = this.fetch(trigger).finally(() => {
      this.inflight.delete(trigger.conditionId);
    });
    this.inflight.set(trigger.conditionId, p);
    return p;
  }

  /** Synchronous lookup; returns null if the trigger hasn't been resolved yet. */
  get(trigger: TriggerKey): string | null {
    return this.cache.get(trigger.conditionId) ?? null;
  }

  private async fetch(trigger: TriggerKey): Promise<string> {
    if (trigger.provider !== "polymarket") {
      throw new Error(
        `YesTokenResolver only supports polymarket; got ${trigger.id}`,
      );
    }
    const info = await this.client.getClobMarketInfo(trigger.conditionId);
    const tokens = (info?.t ?? []).filter(
      (t): t is { t: string; o: string } =>
        !!t && typeof t.t === "string" && typeof t.o === "string",
    );
    if (tokens.length === 0) {
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
    const explicitYes = tokens.find((t) => t.o.toLowerCase() === "yes");
    const chosen = explicitYes ?? tokens[0]!;
    if (!explicitYes) {
      console.warn(
        `[yes-token] market ${trigger.slug} has no "Yes" outcome — ` +
          `using first outcome "${chosen.o}" as the probability source`,
      );
    }
    this.cache.set(trigger.conditionId, chosen.t);
    return chosen.t;
  }
}
