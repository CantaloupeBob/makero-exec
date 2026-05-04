import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";
import { getDb } from "../db/client.ts";
import { apiWallets } from "../db/schema.ts";
import { decryptSecret } from "../lib/crypto.ts";

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
    const rows = await db
      .select({
        encryptedValue: apiWallets.encryptedPrivateKey,
        valueNonce: apiWallets.privateKeyNonce,
        encryptedDek: apiWallets.encryptedDek,
        dekNonce: apiWallets.dekNonce,
      })
      .from(apiWallets)
      .where(eq(apiWallets.userAddress, userAddress))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new Error(`No API wallet found for user ${userAddress}`);
    }

    const plaintext = decryptSecret(row);
    // Tolerate keys persisted with or without the `0x` prefix.
    const hex = (
      plaintext.startsWith("0x") ? plaintext : `0x${plaintext}`
    ) as `0x${string}`;
    return privateKeyToAccount(hex);
  }
}
