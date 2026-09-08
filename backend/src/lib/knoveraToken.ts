import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

/**
 * The Knovera application session token — proves only "this browser
 * successfully authenticated as the single Knovera operator." It never
 * contains, derives from, or substitutes for a Whop credential (see
 * KNOVERA_AUTH_VS_PROVIDER_AUTH in the Phase 4D PR description).
 *
 * Implemented as a real, maintained HS256 JWT via `jose` — deliberately NOT
 * hand-rolled (an earlier revision of this file hand-signed/parsed the JWT
 * directly with node:crypto; that was replaced after review in favor of a
 * standard library's serialization, signature verification, expiry
 * enforcement, and algorithm pinning, none of which should be reimplemented
 * by hand). `jose` was chosen because no JWT/JWS dependency already existed
 * in this backend and it's a small, actively maintained, dependency-free
 * implementation of the standard.
 */

export const KNOVERA_TOKEN_TYPE = "knovera_session";
export const KNOVERA_TOKEN_SUBJECT = "knovera-operator";
const KNOVERA_TOKEN_ALG = "HS256";

/** 12 hours — short enough that a stolen token has bounded value, long enough that the single operator isn't repeatedly re-prompted within a working session. Reassess once real usage patterns exist. */
export const KNOVERA_TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface KnoveraTokenPayload {
  sub: string;
  type: string;
  iat: number;
  exp: number;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueKnoveraToken(secret: string, ttlSeconds: number = KNOVERA_TOKEN_TTL_SECONDS): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: KNOVERA_TOKEN_TYPE })
    .setProtectedHeader({ alg: KNOVERA_TOKEN_ALG, typ: "JWT" })
    .setSubject(KNOVERA_TOKEN_SUBJECT)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secretKey(secret));
}

/**
 * Verifies signature, expected algorithm, expiration, and token type — all
 * via `jose`'s own validated implementation (algorithm pinned to HS256, so
 * a token asserting a different/"none" algorithm in its header is rejected
 * before any signature check). Returns null for any failure (malformed,
 * tampered, wrong secret, wrong algorithm, expired, wrong type) —
 * deliberately a single generic outcome so a caller can't distinguish
 * "expired" from "tampered" from the return value alone, same principle as
 * the login endpoint's generic invalid-credential response.
 */
export async function verifyKnoveraToken(token: string, secret: string): Promise<KnoveraTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: [KNOVERA_TOKEN_ALG] });
    if (payload.type !== KNOVERA_TOKEN_TYPE) return null;
    if (typeof payload.sub !== "string" || typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    return { sub: payload.sub, type: payload.type, iat: payload.iat, exp: payload.exp };
  } catch (err) {
    // jose throws typed errors for every failure mode (JWTExpired,
    // JWSSignatureVerificationFailed, JWTInvalid, JWSInvalid, etc.) — all
    // treated identically here, but re-thrown if something unrelated to
    // token validation goes wrong (e.g. a programming error), rather than
    // silently swallowed as "invalid token."
    if (err instanceof joseErrors.JOSEError) return null;
    throw err;
  }
}
