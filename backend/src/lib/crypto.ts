import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope encryption for the one secret we persist to disk:
 * the user's Whop refresh token. The key comes from `REFRESH_TOKEN_ENCRYPTION_KEY`
 * (Secret Manager in production), never from the database itself.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export class InvalidEncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEncryptionKeyError";
  }
}

function decodeKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new InvalidEncryptionKeyError(
      `REFRESH_TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}.`,
    );
  }
  return key;
}

/**
 * Encrypts `plaintext` and returns one self-contained blob — a fresh random
 * IV followed by ciphertext+auth-tag — suitable for storing in a single
 * BYTEA column. Every call uses its own IV, so encrypting two different
 * secrets (e.g. an access token and a refresh token) under the same key is
 * safe: each gets an independent (key, IV) pair, as AES-GCM requires.
 */
export function encryptSecret(plaintext: string, base64Key: string): Buffer {
  const key = decodeKey(base64Key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]);
}

/** Inverse of {@link encryptSecret}. Throws if the key or blob has been tampered with. */
export function decryptSecret(blob: Buffer, base64Key: string): string {
  const key = decodeKey(base64Key);
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
