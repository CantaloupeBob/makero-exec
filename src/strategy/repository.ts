import { strategies } from "../db/schema.ts";
import { getDb } from "../db/client.ts";
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
    })
    .from(strategies);

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
