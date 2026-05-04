import { strategies } from "../db/schema.ts";
import { getDb } from "../db/client.ts";
import { eq, gt, and } from "drizzle-orm";
import { parseTriggerKey } from "../wss/triggers/trigger-key.ts";
import {
  StrategyParseError,
  type LoadedStrategy,
  type TriggerDirection,
} from "./types.ts";

/**
 * Read all strategies from the DB, parse their trigger sources, and return
 * the in-memory representation. Malformed rows are logged + skipped so a
 * single bad row cannot prevent startup.
 */
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
 * Load strategies created after `since` that have not yet been attempted.
 * Used by the polling loop to pick up strategies armed after boot without
 * a full table scan on every tick.
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
    .where(
      and(
        gt(strategies.createdAt, since),
        eq(strategies.hasBeenAttempted, false),
      ),
    );
  return parseStrategyRows(rows);
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
      console.warn(
        `[strategy] skipping invalid strategy ${row.id}:`,
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
