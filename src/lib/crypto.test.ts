import { describe, it, expect, beforeAll } from "bun:test";
import { initCrypto, decryptSecret } from "./crypto.ts";
import { getDb, closeDb } from "../db/client.ts";
import { apiWallets } from "../db/schema.ts";
import { eq } from "drizzle-orm";

const USER_ADDRESS = "0x816C87e532c34B65a6A3c00C178E4514b3063BF6";

// Load .env so DATABASE_URL and MASTER_KEY are available when running via bun test
const envFile = Bun.file(new URL("../../../.env", import.meta.url));
if (await envFile.exists()) {
  const text = await envFile.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

describe("decryptSecret — live DB round-trip", () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it("decrypts the API wallet private key for the target user", async () => {
    const db = getDb();

    const rows = await db
      .select({
        apiWalletAddress: apiWallets.apiWalletAddress,
        encryptedPrivateKey: apiWallets.encryptedPrivateKey,
        privateKeyNonce: apiWallets.privateKeyNonce,
        encryptedDek: apiWallets.encryptedDek,
        dekNonce: apiWallets.dekNonce,
      })
      .from(apiWallets)
      .where(eq(apiWallets.userAddress, USER_ADDRESS));

    expect(rows.length).toBeGreaterThan(0);

    for (const wallet of rows) {
      const plaintext = decryptSecret({
        encryptedValue: wallet.encryptedPrivateKey,
        valueNonce: wallet.privateKeyNonce,
        encryptedDek: wallet.encryptedDek,
        dekNonce: wallet.dekNonce,
      });

      // A raw EVM private key is 32 bytes → 64 hex chars, optionally prefixed with 0x
      expect(plaintext).toMatch(/^(0x)?[0-9a-fA-F]{64}$/);

      // intentionally not logging any fragment of the plaintext PK
    }

    await closeDb();
  });
});
