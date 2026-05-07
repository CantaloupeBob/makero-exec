import { strategies } from "../db/schema.ts";
import { getDb } from "../db/client.ts";
import { eq } from "drizzle-orm";
import { parseTriggerKey } from "../wss/triggers/trigger-key.ts";
import {
  StrategyParseError,
  type LoadedStrategy,
  type TriggerDirection,
} from "./types.ts";

/**
 * Return the set of strategy IDs that have already been attempted by the
 * executor. Used at boot to skip re-arming strategies that have already
 * fired, preventing the engine from re-emitting on every WSS tick after
 * a restart where probability is still above threshold.
 */
export async function loadAttemptedStrategyIds(): Promise<Set<string>> {
  const db = getDb();
  const rows = await db
    .select({ id: strategies.id })
    .from(strategies)
    .where(eq(strategies.hasBeenAttempted, true));
  return new Set(rows.map((r) => r.id));
}

/**
 * Return the set of all strategy IDs that currently exist in the DB,
 * regardless of `hasBeenAttempted`. Used by the polling loop to detect
 * strategies the user has deleted out from under us, so the in-memory
 * engine state and WSS/book-tracking resources can be torn down.
 */
export async function loadAllStrategyIds(): Promise<Set<string>> {
  const db = getDb();
  const rows = await db.select({ id: strategies.id }).from(strategies);
  return new Set(rows.map((r) => r.id));
}

/**
 * Read a single strategy by id from the DB. Returns null if the row no
 * longer exists (the user deleted it after it was armed). The executor
 * uses this at dispatch time so that any user-updated fields (notably
 * `userAddress`) are honored on the actual trade rather than executing
 * against the in-memory snapshot captured when the strategy was armed.
 */
export async function loadStrategyById(
  id: string,
): Promise<LoadedStrategy | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: strategies.id,
      userAddress: strategies.userAddress,
      name: strategies.strategyName,
      triggerSource: strategies.triggerSource,
      triggerProbability: strategies.triggerProbability,
      triggerDirection: strategies.triggerDirection,
      createdAt: strategies.createdAt,
    })
    .from(strategies)
    .where(eq(strategies.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const parsed = parseStrategyRows(rows);
  return parsed[0] ?? null;
}

export async function loadAllStrategies(): Promise<LoadedStrategy[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: strategies.id,
      userAddress: strategies.userAddress,
      name: strategies.strategyName,
      triggerSource: strategies.triggerSource,
      triggerProbability: strategies.triggerProbability,
      triggerDirection: strategies.triggerDirection,
      createdAt: strategies.createdAt,
    })
    .from(strategies);
  return parseStrategyRows(rows);
}

/**
 * Load strategies that have not yet been attempted. Used by the polling loop
 * to pick up strategies armed after boot.
 *
 * NOTE: we deliberately do NOT filter by `createdAt > since`. The `created_at`
 * column is `timestamp` (no timezone), so comparing it against a JS Date is
 * subject to TZ skew between the app and DB server and can silently exclude
 * rows. The pending-strategies set is small, so a full scan filtered by
 * `hasBeenAttempted = false` is cheap and correct. The `since` parameter is
 * kept for log/diagnostic purposes only.
 */
export async function loadNewStrategies(
  since: Date,
): Promise<LoadedStrategy[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: strategies.id,
      userAddress: strategies.userAddress,
      name: strategies.strategyName,
      triggerSource: strategies.triggerSource,
      triggerProbability: strategies.triggerProbability,
      triggerDirection: strategies.triggerDirection,
      createdAt: strategies.createdAt,
    })
    .from(strategies)
    .where(eq(strategies.hasBeenAttempted, false));
  const parsed = parseStrategyRows(rows);
  if (rows.length > 0 && parsed.length === 0) {
    console.error(
      `[strategy] loadNewStrategies found ${rows.length} DB row(s) since ${since.toISOString()} but all failed to parse — check PARSE ERROR logs above`,
    );
  }
  return parsed;
}

function parseStrategyRows(
  rows: Array<{
    id: string;
    userAddress: string;
    name: string;
    triggerSource: string;
    triggerProbability: number;
    triggerDirection: string;
    createdAt: Date;
  }>,
): LoadedStrategy[] {
  const out: LoadedStrategy[] = [];
  for (const row of rows) {
    try {
      out.push(toLoadedStrategy(row));
    } catch (err) {
      console.error(
        `[strategy] PARSE ERROR — skipping strategy ${row.id} (triggerSource="${row.triggerSource}", direction="${row.triggerDirection}", probability=${row.triggerProbability}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

function toLoadedStrategy(row: {
  id: string;
  userAddress: string;
  name: string;
  triggerSource: string;
  triggerProbability: number;
  triggerDirection: string;
  createdAt: Date;
}): LoadedStrategy {
  const trigger = parseTriggerKey(row.triggerSource);

  const direction = row.triggerDirection as TriggerDirection;
  if (direction !== ">=" && direction !== "<=") {
    throw new StrategyParseError(
      row.id,
      `unsupported trigger_direction "${row.triggerDirection}"`,
    );
  }

  const probability = Number(row.triggerProbability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new StrategyParseError(
      row.id,
      `trigger_probability ${row.triggerProbability} is outside [0, 1]`,
    );
  }

  return {
    id: row.id,
    userAddress: row.userAddress,
    name: row.name,
    trigger,
    probability,
    direction,
  };
}
