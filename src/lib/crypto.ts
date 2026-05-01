import sodium from "libsodium-wrappers";

// ─── Module state ────────────────────────────────────────────────

let ready: Promise<void> | null = null;
let masterKey: Uint8Array | null = null;

/**
 * Initialise libsodium and load the master key from the environment.
 * Idempotent — safe to call from app bootstrap and from any cold helper.
 *
 * Throws synchronously-after-await if MASTER_KEY is missing / malformed,
 * so the process fails fast on boot rather than at first encryption call.
 */
export function initCrypto(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await sodium.ready;

    const raw = process.env.MASTER_KEY;
    if (!raw) {
      throw new Error(
        "MASTER_KEY environment variable is not set. " +
          "Generate one with: openssl rand -base64 32",
      );
    }

    let decoded: Uint8Array;
    try {
      decoded = sodium.from_base64(raw, sodium.base64_variants.ORIGINAL);
    } catch {
      throw new Error("MASTER_KEY must be valid base64");
    }

    if (decoded.length !== sodium.crypto_secretbox_KEYBYTES) {
      throw new Error(
        `MASTER_KEY must decode to exactly ${sodium.crypto_secretbox_KEYBYTES} bytes ` +
          `(got ${decoded.length}). Generate one with: openssl rand -base64 32`,
      );
    }

    masterKey = decoded;
  })();
  return ready;
}

function ensureReady(): Uint8Array {
  if (!masterKey) {
    throw new Error("Crypto subsystem not initialised — call initCrypto()");
  }
  return masterKey;
}

/**
 * Unwrap a previously wrapped DEK using the master key.
 * Throws on auth-tag failure (tampering / wrong master key).
 */
function decryptDEK(ciphertext: Uint8Array, nonce: Uint8Array): Uint8Array {
  const key = ensureReady();
  return sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
}

/**
 * On-disk shape of an encrypted secret. Every field is base64 (sodium
 * ORIGINAL variant). All four are required; partial envelopes MUST be
 * rejected at the boundary by the caller.
 */
export interface EncryptedEnvelope {
  encryptedValue: string;
  valueNonce: string;
  encryptedDek: string;
  dekNonce: string;
}

/**
 * Decrypt a previously persisted envelope back to the original UTF-8
 * plaintext. Throws if any component is missing/corrupt or if the auth
 * tag fails (i.e. the row was tampered with or the master key is wrong).
 *
 * SECURITY: callers must NEVER log, persist, or transmit the returned
 * plaintext. Use it inline (e.g. to sign one request) and let it fall
 * out of scope.
 */
export function decryptSecret(env: EncryptedEnvelope): string {
  ensureReady();

  const b64 = sodium.base64_variants.ORIGINAL;
  const encryptedDek = sodium.from_base64(env.encryptedDek, b64);
  const dekNonce = sodium.from_base64(env.dekNonce, b64);
  const encryptedValue = sodium.from_base64(env.encryptedValue, b64);
  const valueNonce = sodium.from_base64(env.valueNonce, b64);

  const dek = decryptDEK(encryptedDek, dekNonce);
  try {
    const plaintextBytes = sodium.crypto_secretbox_open_easy(
      encryptedValue,
      valueNonce,
      dek,
    );
    const plaintext = sodium.to_string(plaintextBytes);
    sodium.memzero(plaintextBytes);
    return plaintext;
  } finally {
    sodium.memzero(dek);
  }
}
