import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";
import { getDb } from "../db/client.ts";
import { apiWallets } from "../db/schema.ts";
import { decryptSecret } from "../lib/crypto.ts";
import { extraAgents } from "@nktkas/hyperliquid/api/info";
import { HttpTransport } from "@nktkas/hyperliquid";

/**
 * Resolves a master `userAddress` to a signing-ready viem account derived
 * from that user's API wallet. The plaintext private key is decrypted in
 * memory, handed to viem (which keeps it inside the account closure), and
 * never logged or persisted again.
 *
 * Accounts are cached per user with a TTL (default 5 minutes). On TTL expiry
 * the next call re-reads and re-decrypts from DB, picking up any key rotation.
 * Cache invalidation can also be forced via `invalidate(userAddress)`.
 */
export class ApiWalletLoader {
  private readonly ttlMs: number;
  private readonly cache = new Map<
    string,
    { account: PrivateKeyAccount; loadedAt: number }
  >();
  private readonly inflight = new Map<string, Promise<PrivateKeyAccount>>();

  constructor(ttlMs: number = 5 * 60_000) {
    this.ttlMs = ttlMs;
  }

  async load(userAddress: string): Promise<PrivateKeyAccount> {
    const key = userAddress.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.loadedAt < this.ttlMs) {
      return cached.account;
    }
    // TTL expired or not cached — evict stale entry and re-fetch.
    if (cached) this.cache.delete(key);

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const promise = this.fetchAndDecrypt(userAddress)
      .then((account) => {
        this.cache.set(key, { account, loadedAt: Date.now() });
        this.inflight.delete(key);
        return account;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Force-evict a cached wallet. Next call to `load()` will re-read from DB. */
  invalidate(userAddress: string): void {
    this.cache.delete(userAddress.toLowerCase());
  }

  private async fetchAndDecrypt(
    userAddress: string,
  ): Promise<PrivateKeyAccount> {
    const db = getDb();

    // Fetch registered extra agents from Hyperliquid and all DB rows in parallel.
    const transport = new HttpTransport();
    const [agents, rows] = await Promise.all([
      extraAgents({ transport }, { user: userAddress as `0x${string}` }),
      db
        .select({
          encryptedValue: apiWallets.encryptedPrivateKey,
          valueNonce: apiWallets.privateKeyNonce,
          encryptedDek: apiWallets.encryptedDek,
          dekNonce: apiWallets.dekNonce,
          apiWalletAddress: apiWallets.apiWalletAddress,
        })
        .from(apiWallets)
        .where(eq(apiWallets.userAddress, userAddress)),
    ]);

    if (rows.length === 0) {
      throw new Error(`No API wallet found for user ${userAddress}`);
    }

    const now = Date.now();

    // Build a lookup map of DB rows keyed by lowercased wallet address.
    const dbRowByAddress = new Map(
      rows.map((r) => [r.apiWalletAddress.toLowerCase(), r]),
    );

    // Iterate registered agents in order; use the first one that exists in DB
    // and has not expired.
    for (const agent of agents) {
      if (agent.validUntil < now) continue;
      const row = dbRowByAddress.get(agent.address.toLowerCase());
      if (!row) continue;

      const plaintext = decryptSecret(row);
      const hex = (
        plaintext.startsWith("0x") ? plaintext : `0x${plaintext}`
      ) as `0x${string}`;
      return privateKeyToAccount(hex);
    }

    throw new Error(
      `No valid registered API wallet found for user ${userAddress}. ` +
        `Either none of the DB wallets are registered as extra agents on Hyperliquid, ` +
        `or all registered agents have expired.`,
    );
  }
}
