import { strategies } from "../../db/schema.ts";
import { getDb } from "../../db/client.ts";
import { eq } from "drizzle-orm";
import { parseTriggerKey, type TriggerKey } from "./trigger-key.ts";

/**
 * Scan all **unattempted** strategies in the database and return a
 * deduplicated set of trigger keys. Already-attempted strategies are excluded
 * so the engine never opens a WSS feed or pre-warms a book for a trigger that
 * only has exhausted strategies behind it.
 *
 * De-duplication is performed by `TriggerKey.id`, which is the normalized
 * `${provider}:${conditionId}` composite — so the same market referenced by
 * many strategies still results in exactly one entry.
 *
 * Invalid/malformed `trigger_source` rows are logged and skipped rather than
 * crashing startup; one bad row should not take down the executor.
 */
export async function loadAllTriggerKeys(): Promise<Map<string, TriggerKey>> {
  const db = getDb();
  const rows = await db
    .select({ triggerSource: strategies.triggerSource })
    .from(strategies)
    .where(eq(strategies.hasBeenAttempted, false));

  const out = new Map<string, TriggerKey>();
  for (const row of rows) {
    try {
      const key = parseTriggerKey(row.triggerSource);
      if (!out.has(key.id)) out.set(key.id, key);
    } catch (err) {
      console.warn(
        `[triggers] skipping invalid trigger_source "${row.triggerSource}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}
