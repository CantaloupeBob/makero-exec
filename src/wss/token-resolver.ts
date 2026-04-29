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

/**
 * Polymarket implementation: looks up the market by condition id via the
 * CLOB SDK and returns the (up to two) outcome token IDs.
 */
export class PolymarketTokenResolver implements TokenResolver {
  constructor(private readonly client: ClobClient) {}

  async resolve(trigger: TriggerKey): Promise<string[]> {
    if (trigger.provider !== "polymarket") {
      throw new Error(
        `PolymarketTokenResolver received non-polymarket trigger: ${trigger.id}`,
      );
    }
    const info = await this.client.getClobMarketInfo(trigger.conditionId);
    const tokens = (info?.t ?? [])
      .filter((t): t is { t: string; o: string } => !!t && !!t.t)
      .map((t) => t.t);
    if (tokens.length === 0) {
      throw new Error(
        `No tokens returned for condition ${trigger.conditionId} (${trigger.slug})`,
      );
    }
    return tokens;
  }
}
