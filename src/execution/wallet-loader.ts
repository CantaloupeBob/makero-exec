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
 * The returned account is cached per user — viem accounts are pure value
 * objects, but `privateKeyToAccount` does some non-trivial setup we'd
 * rather not repeat on every trigger. Cache invalidation is intentionally
 * absent: rotating an API wallet requires a process restart for now.
 */
export class ApiWalletLoader {
  private readonly cache = new Map<string, PrivateKeyAccount>();
  private readonly inflight = new Map<string, Promise<PrivateKeyAccount>>();

  async load(userAddress: string): Promise<PrivateKeyAccount> {
    const key = userAddress.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const promise = this.fetchAndDecrypt(userAddress)
      .then((account) => {
        this.cache.set(key, account);
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
