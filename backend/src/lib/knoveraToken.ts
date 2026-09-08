import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The Knovera application session token — proves only "this browser
 * successfully authenticated as the single Knovera operator." It never
 * contains, derives from, or substitutes for a Whop credential (see
 * KNOVERA_AUTH_VS_PROVIDER_AUTH in the Phase 4D PR description).
 *
 * Implemented as a standard HS256 JWT (header.payload.signature, base64url,
 * HMAC-SHA256) using only `node:crypto` — no new dependency, matching this
 * repo's existing convention of hand-rolling well-known primitives directly
 * (see lib/crypto.ts's AES-256-GCM envelope) rather than pulling in a JWT
 * library for something this small. The signature algorithm is the same
 * HMAC-SHA256 a `jsonwebtoken`-style HS256 token would use; this file only
 * skips the wrapper, never the cryptography itself.
 */

export const KNOVERA_TOKEN_TYPE = "knovera_session";
export const KNOVERA_TOKEN_SUBJECT = "knovera-operator";

/** 12 hours — short enough that a stolen token has bounded value, long enough that the single operator isn't repeatedly re-prompted within a working session. Reassess once real usage patterns exist. */
export const KNOVERA_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface KnoveraTokenPayload {
  sub: string;
  type: string;
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function issueKnoveraToken(secret: string, ttlSeconds: number = KNOVERA_TOKEN_TTL_SECONDS): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload: KnoveraTokenPayload = {
    sub: KNOVERA_TOKEN_SUBJECT,
    type: KNOVERA_TOKEN_TYPE,
    iat: now,
    exp: now + ttlSeconds,
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = sign(`${header}.${encodedPayload}`, secret);
  return `${header}.${encodedPayload}.${signature}`;
}

/**
 * Verifies signature, expiration, and token type. Returns null for any
 * failure (malformed, wrong signature, expired, wrong type) — deliberately
 * a single generic outcome so a caller can't distinguish "expired" from
 * "tampered" from the return value alone, same principle as the login
 * endpoint's generic invalid-credential response.
 */
export function verifyKnoveraToken(token: string, secret: string): KnoveraTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, encodedPayload, signature] = parts;

  const expectedSignature = sign(`${header}.${encodedPayload}`, secret);
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let payload: KnoveraTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as KnoveraTokenPayload;
  } catch {
    return null;
  }

  if (payload.type !== KNOVERA_TOKEN_TYPE) return null;
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}
