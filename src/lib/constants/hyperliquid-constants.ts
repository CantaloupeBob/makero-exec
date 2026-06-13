/**
 * Default slippage applied to "market" IOC orders. We submit IOC limits
 * (Hyperliquid does not have a true market type for L1 actions) priced
 * `slippage` away from mid in the aggressive direction.
 */
export const DEFAULT_SLIPPAGE = 0.005; // 50 bps

/** DEFAULT_SLIPPAGE expressed as a percent (e.g. 0.005 → 0.5). Used as fallback when maxSlippagePct is absent or invalid. */
export const DEFAULT_SLIPPAGE_PCT = DEFAULT_SLIPPAGE * 100;

export type MarketCatagory = "All" | "Crypto" | "Tradfi";

export interface PerpMarket {
  szDecimals: number;
  name: string;
  maxLeverage: number;
  marginTableId: number;
  catagory: MarketCatagory;
}

export const HYPERLIQUID_MARKETS: { perps: PerpMarket[] } = {
  perps: [
    {
      szDecimals: 5,
      name: "BTC",
      maxLeverage: 40,
      marginTableId: 56,
      catagory: "Crypto",
    },
    {
      szDecimals: 4,
      name: "ETH",
      maxLeverage: 25,
      marginTableId: 55,
      catagory: "Crypto",
    },
    {
      szDecimals: 2,
      name: "SOL",
      maxLeverage: 20,
      marginTableId: 54,
      catagory: "Crypto",
    },
    {
      szDecimals: 2,
      name: "AVAX",
      maxLeverage: 10,
      marginTableId: 52,
      catagory: "Crypto",
    },
    {
      szDecimals: 3,
      name: "BNB",
      maxLeverage: 10,
      marginTableId: 51,
      catagory: "Crypto",
    },
    {
      szDecimals: 2,
      name: "LTC",
      maxLeverage: 10,
      marginTableId: 52,
      catagory: "Crypto",
    },
    {
      szDecimals: 1,
      name: "ARB",
      maxLeverage: 10,
      marginTableId: 51,
      catagory: "Crypto",
    },
    {
      szDecimals: 0,
      name: "DOGE",
      maxLeverage: 10,
      marginTableId: 52,
      catagory: "Crypto",
    },
    {
      szDecimals: 1,
      name: "SUI",
      maxLeverage: 10,
      marginTableId: 52,
      catagory: "Crypto",
    },
    {
      szDecimals: 1,
      name: "LINK",
      maxLeverage: 10,
      marginTableId: 52,
      catagory: "Crypto",
    },
    {
      szDecimals: 0,
      name: "XRP",
      maxLeverage: 20,
      marginTableId: 53,
      catagory: "Crypto",
    },
    {
      szDecimals: 2,
      name: "AAVE",
      maxLeverage: 10,
      marginTableId: 52,
      catagory: "Crypto",
    },
    {
      szDecimals: 0,
      name: "TRX",
      maxLeverage: 10,
      marginTableId: 51,
      catagory: "Crypto",
    },
    {
      szDecimals: 1,
      name: "UNI",
      maxLeverage: 10,
      marginTableId: 52,
      catagory: "Crypto",
    },
    {
      szDecimals: 0,
      name: "ENA",
      maxLeverage: 10,
      marginTableId: 52,
      catagory: "Crypto",
    },
  ],
};
