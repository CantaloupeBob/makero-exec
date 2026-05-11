import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

/**
 * Default slippage applied to "market" IOC orders. We submit IOC limits
 * (Hyperliquid does not have a true market type for L1 actions) priced
 * `slippage` away from mid in the aggressive direction.
 */
export const DEFAULT_SLIPPAGE = 0.005; // 50 bps

/**
 * Compute an aggressive IOC limit price from the current mid. For longs we
 * bid above mid; for shorts we offer below mid. The result is then formatted
 * to comply with Hyperliquid's tick / sig-fig rules.
 */
export function aggressiveLimitPrice(
  mid: number,
  isLong: boolean,
  szDecimals: number,
  slippage: number = DEFAULT_SLIPPAGE,
): string {
  const raw = isLong ? mid * (1 + slippage) : mid * (1 - slippage);
  // formatPrice handles 5-sig-fig + (6 - szDecimals) decimal-place rules.
  return formatPrice(raw, szDecimals, "perp");
}

/**
 * Translate a USDC-denominated notional to a base-asset size, formatted to
 * the asset's `szDecimals`.
 *
 * IMPORTANT: leverage does *not* multiply size here. On Hyperliquid the
 * order's `s` (size) is the base-asset quantity at full notional; leverage
 * is configured separately via `updateLeverage`. The user's "sizeUsdc"
 * field represents the *notional* they want to take, and the size on the
 * wire is therefore `sizeUsdc / mid`.
 *
 * Sizing also incorporates `slippage` as a *buffer*: we compute size from
 * `(sizeUsdc * (1 + slippage)) / mid` so that
 *   1. the truncation `formatSize` performs (rounding DOWN to `szDecimals`)
 *      doesn't push us below Hyperliquid's $10 minimum-notional check, and
 *   2. when the IOC fills at the aggressive limit price (mid ± slippage),
 *      the realized notional is still ≥ `sizeUsdc` rather than `sizeUsdc *
 *      (1 - slippage)`.
 */
export function sizeFromUsdcNotional(
  sizeUsdc: number,
  mid: number,
  szDecimals: number,
  slippage: number = DEFAULT_SLIPPAGE,
): string {
  if (mid <= 0) throw new RangeError("mid must be > 0");
  const baseSize = (sizeUsdc * (1 + slippage)) / mid;
  return formatSize(baseSize, szDecimals);
}

/**
 * Compute the trigger price for a TP/SL leg, expressed by the user as a
 * percent move from entry.
 *
 * - TP for a long: entry * (1 + pct/100)
 * - TP for a short: entry * (1 - pct/100)
 * - SL for a long: entry * (1 - pct/100)
 * - SL for a short: entry * (1 + pct/100)
 */
export function triggerPriceFromPct(
  entry: number,
  pct: number,
  isLong: boolean,
  side: "tp" | "sl",
  szDecimals: number,
): string {
  const sign =
    (side === "tp" && isLong) || (side === "sl" && !isLong) ? +1 : -1;
  const raw = entry * (1 + (sign * pct) / 100);
  if (raw <= 0) {
    throw new RangeError(
      `Computed ${side} trigger price ${raw} is non-positive`,
    );
  }
  return formatPrice(raw, szDecimals, "perp");
}
