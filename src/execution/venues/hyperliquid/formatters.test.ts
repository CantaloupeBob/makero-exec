import { describe, it, expect } from "bun:test";
import {
  aggressiveLimitPrice,
  sizeFromUsdcNotional,
  triggerPriceFromPct,
  DEFAULT_SLIPPAGE,
} from "./formatters";
import { HYPERLIQUID_MARKETS } from "../../../lib/constants/hyperliquid-constants";

// Helper: look up szDecimals for a named market
function sz(name: string): number {
  const market = HYPERLIQUID_MARKETS.perps.find((m) => m.name === name);
  if (!market) throw new Error(`Unknown market: ${name}`);
  return market.szDecimals;
}

// ---------------------------------------------------------------------------
// aggressiveLimitPrice
// ---------------------------------------------------------------------------
describe("aggressiveLimitPrice", () => {
  it("long: prices above mid by default slippage (BTC, szDecimals=5)", () => {
    const mid = 60_000;
    const szDecimals = sz("BTC"); // 5
    const price = aggressiveLimitPrice(mid, true, szDecimals);
    const expected = mid * (1 + DEFAULT_SLIPPAGE);
    expect(Number(price)).toBeGreaterThan(mid);
    // formatPrice rounds to 5 significant figures; allow up to 1 tick of rounding
    expect(Math.abs(Number(price) - expected)).toBeLessThan(expected * 0.001);
  });

  it("short: prices below mid by default slippage (BTC, szDecimals=5)", () => {
    const mid = 60_000;
    const szDecimals = sz("BTC");
    const price = aggressiveLimitPrice(mid, false, szDecimals);
    expect(Number(price)).toBeLessThan(mid);
    expect(Number(price)).toBeCloseTo(mid * (1 - DEFAULT_SLIPPAGE), 0);
  });

  it("long: custom slippage applied correctly (ETH, szDecimals=4)", () => {
    const mid = 3_200;
    const szDecimals = sz("ETH"); // 4
    const slippage = 0.01; // 100 bps
    const price = aggressiveLimitPrice(mid, true, szDecimals, slippage);
    const expected = mid * (1 + slippage);
    expect(Number(price)).toBeCloseTo(expected, 0);
  });

  it("returns a string", () => {
    expect(typeof aggressiveLimitPrice(1_000, true, sz("SOL"))).toBe("string");
  });

  it("formats correctly for low-decimal asset (DOGE, szDecimals=0)", () => {
    const mid = 0.15;
    const szDecimals = sz("DOGE"); // 0
    const price = aggressiveLimitPrice(mid, true, szDecimals);
    // formatPrice with szDecimals=0 uses 5 sig-figs, price should be a valid number
    expect(Number(price)).toBeGreaterThan(mid);
  });

  it("formats correctly for SUI (szDecimals=1)", () => {
    const mid = 1.5;
    const szDecimals = sz("SUI"); // 1
    const price = aggressiveLimitPrice(mid, false, szDecimals);
    expect(Number(price)).toBeLessThan(mid);
  });
});

// ---------------------------------------------------------------------------
// sizeFromUsdcNotional
// ---------------------------------------------------------------------------
describe("sizeFromUsdcNotional", () => {
  it("computes base size from USDC notional for BTC (szDecimals=5)", () => {
    const mid = 60_000;
    const szDecimals = sz("BTC"); // 5
    const sizeUsdc = 300; // $300 → 0.005 BTC
    const size = sizeFromUsdcNotional(sizeUsdc, mid, szDecimals, 0);
    expect(Number(size)).toBeCloseTo(sizeUsdc / mid, 5);
  });

  it("computes base size for SOL (szDecimals=2)", () => {
    const mid = 150;
    const szDecimals = sz("SOL"); // 2
    const sizeUsdc = 1_500; // $1500 → 10 SOL
    const size = sizeFromUsdcNotional(sizeUsdc, mid, szDecimals, 0);
    expect(Number(size)).toBeCloseTo(10, 2);
  });

  it("computes base size for XRP (szDecimals=0)", () => {
    const mid = 0.5;
    const szDecimals = sz("XRP"); // 0
    const sizeUsdc = 500; // $500 → 1000 XRP
    const size = sizeFromUsdcNotional(sizeUsdc, mid, szDecimals, 0);
    expect(Number(size)).toBeCloseTo(1_000, 0);
  });

  it("inflates size by the slippage buffer to clear the $10 minimum after truncation", () => {
    // LTC-like: mid ~$58.66, szDecimals=2, $11 notional, 50bps slippage.
    // Without buffer: 11 / 58.66 = 0.1875… → truncates to 0.18 → notional $10.56.
    // The buffer ensures we stay strictly above Hyperliquid's $10 floor even
    // if the mark drifts slightly between the mid read and order acceptance.
    const mid = 58.66;
    const sizeUsdc = 11;
    const slippage = 0.005;
    const size = sizeFromUsdcNotional(sizeUsdc, mid, 2, slippage);
    const notional = Number(size) * mid;
    // Must clear Hyperliquid's $10 minimum.
    expect(notional).toBeGreaterThan(10);
    // Must not exceed user intent by more than the slippage buffer + one
    // szDecimal tick (the unit of upward rounding from formatSize truncation
    // when the buffer crosses a decimal boundary).
    const oneTick = mid * Math.pow(10, -2);
    expect(notional).toBeLessThanOrEqual(sizeUsdc * (1 + slippage) + oneTick);
  });

  it("buffer pushes size up by one tick when the truncation boundary is crossed", () => {
    // Choose mid+sizeUsdc so that without buffer we truncate to N, with buffer
    // we cross to N+1 tick. mid=10, szDecimals=1, sizeUsdc=1.95:
    //   without buffer → 0.195 → truncates to 0.1 (notional $1)
    //   with 5% buffer → 2.0475/10 = 0.2047 → truncates to 0.2 (notional $2)
    const noBuffer = sizeFromUsdcNotional(1.95, 10, 1, 0);
    const withBuffer = sizeFromUsdcNotional(1.95, 10, 1, 0.05);
    expect(Number(noBuffer)).toBe(0.1);
    expect(Number(withBuffer)).toBe(0.2);
  });

  it("throws for mid <= 0", () => {
    expect(() => sizeFromUsdcNotional(100, 0, 5)).toThrow(RangeError);
    expect(() => sizeFromUsdcNotional(100, -1, 5)).toThrow(RangeError);
  });

  it("returns a string", () => {
    expect(typeof sizeFromUsdcNotional(1_000, 50_000, sz("BTC"))).toBe(
      "string",
    );
  });
});

// ---------------------------------------------------------------------------
// triggerPriceFromPct
// ---------------------------------------------------------------------------
describe("triggerPriceFromPct", () => {
  // TP for long: entry * (1 + pct/100)
  it("TP long: price above entry (ETH, szDecimals=4)", () => {
    const entry = 3_000;
    const szDecimals = sz("ETH"); // 4
    const price = triggerPriceFromPct(entry, 5, true, "tp", szDecimals);
    expect(Number(price)).toBeCloseTo(entry * 1.05, 0);
    expect(Number(price)).toBeGreaterThan(entry);
  });

  // TP for short: entry * (1 - pct/100)
  it("TP short: price below entry (ETH, szDecimals=4)", () => {
    const entry = 3_000;
    const szDecimals = sz("ETH");
    const price = triggerPriceFromPct(entry, 5, false, "tp", szDecimals);
    expect(Number(price)).toBeCloseTo(entry * 0.95, 0);
    expect(Number(price)).toBeLessThan(entry);
  });

  // SL for long: entry * (1 - pct/100)
  it("SL long: price below entry (BTC, szDecimals=5)", () => {
    const entry = 60_000;
    const szDecimals = sz("BTC");
    const price = triggerPriceFromPct(entry, 2, true, "sl", szDecimals);
    expect(Number(price)).toBeCloseTo(entry * 0.98, 0);
    expect(Number(price)).toBeLessThan(entry);
  });

  // SL for short: entry * (1 + pct/100)
  it("SL short: price above entry (BTC, szDecimals=5)", () => {
    const entry = 60_000;
    const szDecimals = sz("BTC");
    const price = triggerPriceFromPct(entry, 2, false, "sl", szDecimals);
    expect(Number(price)).toBeCloseTo(entry * 1.02, 0);
    expect(Number(price)).toBeGreaterThan(entry);
  });

  it("throws RangeError when computed price is non-positive", () => {
    // SL short with 200% pct → entry * (1 + 2) = 3 * entry, fine; but
    // TP short with 200% → entry * (1 - 2) = negative
    expect(() => triggerPriceFromPct(100, 200, false, "tp", 4)).toThrow(
      RangeError,
    );
  });

  it("returns a string", () => {
    expect(typeof triggerPriceFromPct(1_000, 1, true, "tp", sz("SOL"))).toBe(
      "string",
    );
  });

  it("works with DOGE (szDecimals=0) low entry price", () => {
    const entry = 0.15;
    const szDecimals = sz("DOGE"); // 0
    const price = triggerPriceFromPct(entry, 10, true, "tp", szDecimals);
    expect(Number(price)).toBeGreaterThan(entry);
  });

  it("works with ARB (szDecimals=1)", () => {
    const entry = 1.2;
    const szDecimals = sz("ARB"); // 1
    const tp = triggerPriceFromPct(entry, 5, true, "tp", szDecimals);
    const sl = triggerPriceFromPct(entry, 5, true, "sl", szDecimals);
    expect(Number(tp)).toBeGreaterThan(entry);
    expect(Number(sl)).toBeLessThan(entry);
  });
});
