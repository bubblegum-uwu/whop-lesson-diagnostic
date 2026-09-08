import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/**
 * Password hashing for the Phase 4D single-operator Knovera login.
 *
 * Uses Node's built-in `scrypt` (no new dependency — the same "hand-roll a
 * well-known primitive via node:crypto" convention this repo already uses
 * for refresh-token encryption, see lib/crypto.ts) rather than inventing
 * anything: scrypt is a standard, memory-hard KDF Node.js itself documents
 * as the recommended building block for password hashing when a dedicated
 * library like bcrypt isn't already a dependency.
 *
 * Stored format: `scrypt:<saltHex>:<hashHex>` — self-describing so the
 * scheme can change later without breaking already-stored hashes.
 */

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Timing-safe verification. Returns false (never throws) for a malformed
 * stored hash — e.g. a misconfigured KNOVERA_PASSWORD_HASH — since that
 * must fail closed exactly like a wrong password, not crash the request.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, hashHex] = parts;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;

  const actual = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return timingSafeEqual(actual, expected);
}
