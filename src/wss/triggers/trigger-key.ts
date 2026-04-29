/**
 * A trigger source string is stored in the database in the form:
 *   `{provider}:{slug}:{conditionId}`
 *
 * e.g. `polymarket:trump-announces-end-of-...:0xfa59...c191d4`
 *
 * `TriggerKey` is the parsed, normalized representation. It is intentionally
 * a plain value object — equality/uniqueness is established via the `id`
 * field which is a deterministic, lowercased composite of provider+conditionId.
 *
 * Using `id` (instead of the raw string) as the set/map key guarantees that:
 *   - case differences in the conditionId don't create duplicate connections
 *   - the same market referenced under slightly different slugs (rare, but
 *     possible if a market is renamed) is still treated as one subscription
 */
export type TriggerProvider = "polymarket";

export interface TriggerKey {
  /** Stable identity for set/map use. `${provider}:${conditionId}` lowercased. */
  readonly id: string;
  readonly provider: TriggerProvider;
  readonly slug: string;
  readonly conditionId: string;
  /** The original raw string from the DB, kept for diagnostics/logging. */
  readonly raw: string;
}

export class TriggerParseError extends Error {
  constructor(raw: string, reason: string) {
    super(`Invalid trigger source "${raw}": ${reason}`);
    this.name = "TriggerParseError";
  }
}

const SUPPORTED_PROVIDERS: ReadonlySet<TriggerProvider> = new Set([
  "polymarket",
]);

export function parseTriggerKey(raw: string): TriggerKey {
  const parts = raw.split(":");
  if (parts.length !== 3) {
    throw new TriggerParseError(
      raw,
      `expected 3 colon-separated parts, got ${parts.length}`,
    );
  }
  const [providerRaw, slug, conditionId] = parts as [string, string, string];
  const provider = providerRaw.toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider as TriggerProvider)) {
    throw new TriggerParseError(raw, `unsupported provider "${providerRaw}"`);
  }
  if (!slug) throw new TriggerParseError(raw, "empty slug");
  if (!conditionId.startsWith("0x")) {
    throw new TriggerParseError(raw, "conditionId must start with 0x");
  }

  const normalizedConditionId = conditionId.toLowerCase();
  return {
    id: `${provider}:${normalizedConditionId}`,
    provider: provider as TriggerProvider,
    slug,
    conditionId: normalizedConditionId,
    raw,
  };
}

export function tryParseTriggerKey(raw: string): TriggerKey | null {
  try {
    return parseTriggerKey(raw);
  } catch {
    return null;
  }
}
