import {
  HttpTransport,
  InfoClient,
  type IRequestTransport,
} from "@nktkas/hyperliquid";
import { SymbolConverter } from "@nktkas/hyperliquid/utils";

/**
 * Resolves human-readable Hyperliquid asset symbols (e.g. `"BTC"`) to the
 * integer `assetId` and `szDecimals` that the exchange API requires.
 *
 * Wraps the SDK's {@link SymbolConverter}, but adds:
 *   - lazy initialisation (no network on construction)
 *   - a single in-flight refresh promise so concurrent triggers don't
 *     each fire their own `meta` request on cold-start
 *   - a `mid()` helper for live mark-price reads (used to translate
 *     USDC-denominated sizes and percent-based TP/SL into native units)
 */
export class HyperliquidAssetResolver {
  private converter: SymbolConverter | null = null;
  private converterReady: Promise<SymbolConverter> | null = null;
  private readonly info: InfoClient;
  private midsCache: {
    fetchedAt: number;
    mids: Record<string, string>;
  } | null = null;
  private midsInflight: Promise<Record<string, string>> | null = null;

  constructor(
    private readonly transport: IRequestTransport,
    /** Cap on how stale a cached mid can be before we refetch. */
    private readonly midTtlMs: number = 1_000,
  ) {
    this.info = new InfoClient({ transport });
  }

  private getConverter(): Promise<SymbolConverter> {
    if (this.converter) return Promise.resolve(this.converter);
    if (this.converterReady) return this.converterReady;
    this.converterReady = SymbolConverter.create({
      transport: this.transport,
    }).then((c) => {
      this.converter = c;
      return c;
    });
    return this.converterReady;
  }

  async resolve(
    asset: string,
  ): Promise<{ assetId: number; szDecimals: number }> {
    const c = await this.getConverter();
    const assetId = c.getAssetId(asset);
    const szDecimals = c.getSzDecimals(asset);
    if (assetId === undefined || szDecimals === undefined) {
      throw new Error(`Unknown Hyperliquid asset "${asset}"`);
    }
    return { assetId, szDecimals };
  }

  /**
   * Returns the latest mid for `asset` (perp). Cached for `midTtlMs`
   * because every order in a freshly-triggered strategy will ask for the
   * same mid within a few hundred microseconds of each other.
   */
  async mid(asset: string): Promise<number> {
    const mids = await this.allMids();
    const raw = mids[asset];
    if (!raw) {
      throw new Error(`No mid price for "${asset}" in Hyperliquid allMids`);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid mid price "${raw}" for "${asset}"`);
    }
    return n;
  }

  private async allMids(): Promise<Record<string, string>> {
    const now = Date.now();
    if (this.midsCache && now - this.midsCache.fetchedAt < this.midTtlMs) {
      return this.midsCache.mids;
    }
    if (this.midsInflight) return this.midsInflight;
    this.midsInflight = this.info
      .allMids()
      .then((mids) => {
        this.midsCache = { fetchedAt: Date.now(), mids };
        this.midsInflight = null;
        return mids;
      })
      .catch((err) => {
        this.midsInflight = null;
        throw err;
      });
    return this.midsInflight;
  }
}

/** Convenience: a default mainnet HTTP transport. */
export function defaultHyperliquidTransport(): IRequestTransport {
  return new HttpTransport();
}
