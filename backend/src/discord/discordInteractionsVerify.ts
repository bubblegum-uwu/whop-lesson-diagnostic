import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Phase 4K-B (revised) — Ed25519 request-signature verification for
 * Discord's Interactions endpoint (spec section 14). Discord signs every
 * interaction POST with `X-Signature-Ed25519` + `X-Signature-Timestamp`
 * over the EXACT raw request body (timestamp + body bytes, concatenated) —
 * verifying a re-serialized/parsed JSON body would silently accept a
 * tampered payload whose re-serialization happens to match byte-for-byte
 * in the common case but is not the same guarantee, so the raw body must
 * be captured before any JSON parsing (see http/app.ts's route-scoped
 * `express.raw` middleware, mounted before `express.json()`).
 *
 * Deliberately node:crypto's built-in Ed25519 support (native since
 * Node 12), not a hand-rolled implementation and not a new dependency —
 * Discord's public key is a raw 32-byte Ed25519 key, which Node's
 * `crypto.createPublicKey` accepts once wrapped in a minimal SPKI DER
 * envelope (a fixed, well-known 12-byte prefix for the Ed25519 OID —
 * see SPKI_ED25519_PREFIX below); this is the same technique the
 * `discord-interactions` reference library and countless framework-free
 * Discord bots use to avoid depending on a signing library like tweetnacl.
 */

// The fixed ASN.1 DER prefix for an Ed25519 SubjectPublicKeyInfo,
// preceding the raw 32-byte public key — this is not something computed
// or guessed; it is the standard, unchanging DER encoding of the Ed25519
// AlgorithmIdentifier (OID 1.3.101.112) wrapping a 32-byte BIT STRING.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class DiscordSignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordSignatureVerificationError";
  }
}

function publicKeyFromHex(publicKeyHex: string) {
  const raw = Buffer.from(publicKeyHex, "hex");
  if (raw.length !== 32) {
    throw new DiscordSignatureVerificationError("DISCORD_PUBLIC_KEY is not a valid 32-byte Ed25519 public key.");
  }
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

/**
 * Returns true only if `signatureHex` is a valid Ed25519 signature (by
 * `publicKeyHex`) over the exact bytes `timestamp + rawBody` — false for
 * any malformed input (never throws on attacker-controlled data; a
 * malformed signature/timestamp is just "not valid", not a crash).
 */
export function verifyDiscordInteractionSignature(rawBody: Buffer, signatureHex: string, timestamp: string, publicKeyHex: string): boolean {
  if (!signatureHex || !timestamp || signatureHex.length !== 128 || !/^[0-9a-fA-F]+$/.test(signatureHex)) return false;
  let publicKey;
  try {
    publicKey = publicKeyFromHex(publicKeyHex);
  } catch {
    return false;
  }
  const message = Buffer.concat([Buffer.from(timestamp, "utf-8"), rawBody]);
  const signature = Buffer.from(signatureHex, "hex");
  try {
    // `null` as the algorithm argument is correct (and required) for
    // Ed25519 with node:crypto's crypto.verify — Ed25519 is a
    // "one-shot"/PureEdDSA signature scheme with no separate digest
    // algorithm to select, unlike ECDSA/RSA.
    return cryptoVerify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}
