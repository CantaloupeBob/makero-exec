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
    const yesToken = (info?.t ?? []).find(
      (t): t is { t: string; o: string } =>
        !!t && typeof t.o === "string" && t.o.toLowerCase() === "yes",
    );
    if (!yesToken) {
      throw new Error(
        `No "Yes" token found for condition ${trigger.conditionId} (${trigger.slug})`,
      );
    }
    this.cache.set(trigger.conditionId, yesToken.t);
    return yesToken.t;
  }
}
