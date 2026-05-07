import type { TriggerKey } from "../wss/triggers/trigger-key.ts";

/**
 * Direction of the comparison the user expressed in the strategy:
 *   ">="  → fire when market probability ≥ threshold
 *   "<="  → fire when market probability ≤ threshold
 */
export type TriggerDirection = ">=" | "<=";

/**
 * A strategy as held in memory by the engine. This is the row from `strategies`
 * with the `trigger_source` already parsed into a normalized `TriggerKey` so
 * the engine never has to re-parse on the hot path.
 */
export interface LoadedStrategy {
  readonly id: string;
  readonly userAddress: string;
  readonly name: string;
  readonly trigger: TriggerKey;
  /** Probability threshold in `[0, 1]`. */
  readonly probability: number;
  readonly direction: TriggerDirection;
  /**
   * Wall-clock instant at which the underlying market expires. After this
   * point the strategy MUST NOT fire — the book may still emit
   * post-resolution noise (stale resting orders being torn down) but those
   * ticks no longer reflect a tradeable view of the world.
   *
   * Stored in the DB as `timestamptz`. Postgres normalises to UTC on write
   * and node-postgres always returns a correct absolute instant regardless
   * of the process's local TZ. No manual TZ conversion is needed.
   */
  readonly triggerEndDateTime: Date;
}

export class StrategyParseError extends Error {
  constructor(strategyId: string, reason: string) {
    super(`Strategy ${strategyId} is invalid: ${reason}`);
    this.name = "StrategyParseError";
  }
}
