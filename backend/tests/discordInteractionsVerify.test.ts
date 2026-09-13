import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyDiscordInteractionSignature } from "../src/discord/discordInteractionsVerify.js";

/** Extracts the raw 32-byte Ed25519 public key from a KeyObject's SPKI DER export — the inverse of the module's own SPKI_ED25519_PREFIX wrapping, used only here to build a realistic test fixture from a REAL generated keypair. */
function rawPublicKeyHex(publicKeyDer: Buffer): string {
  return publicKeyDer.subarray(publicKeyDer.length - 32).toString("hex");
}

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = rawPublicKeyHex(publicKey.export({ type: "spki", format: "der" }) as Buffer);
  return { publicKey, privateKey, publicKeyHex };
}

function signInteraction(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], timestamp: string, rawBody: Buffer): string {
  const message = Buffer.concat([Buffer.from(timestamp, "utf-8"), rawBody]);
  return sign(null, message, privateKey).toString("hex");
}

describe("verifyDiscordInteractionSignature (Phase 4K-B revised — real Ed25519 keypairs, not mocked)", () => {
  it("accepts a genuinely valid signature over the exact raw body + timestamp", () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const rawBody = Buffer.from(JSON.stringify({ type: 1 }));
    const timestamp = "1700000000";
    const signature = signInteraction(privateKey, timestamp, rawBody);

    expect(verifyDiscordInteractionSignature(rawBody, signature, timestamp, publicKeyHex)).toBe(true);
  });

  it("rejects a signature verified against the WRONG public key", () => {
    const { privateKey } = makeKeyPair();
    const { publicKeyHex: wrongPublicKeyHex } = makeKeyPair();
    const rawBody = Buffer.from(JSON.stringify({ type: 1 }));
    const timestamp = "1700000000";
    const signature = signInteraction(privateKey, timestamp, rawBody);

    expect(verifyDiscordInteractionSignature(rawBody, signature, timestamp, wrongPublicKeyHex)).toBe(false);
  });

  it("rejects when the body was altered after signing (byte-for-byte tamper detection)", () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const rawBody = Buffer.from(JSON.stringify({ type: 2, data: { name: "save-to-knovera" } }));
    const timestamp = "1700000000";
    const signature = signInteraction(privateKey, timestamp, rawBody);

    const tamperedBody = Buffer.from(JSON.stringify({ type: 2, data: { name: "save-to-evil" } }));
    expect(verifyDiscordInteractionSignature(tamperedBody, signature, timestamp, publicKeyHex)).toBe(false);
  });

  it("rejects when the timestamp was altered after signing", () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const rawBody = Buffer.from(JSON.stringify({ type: 1 }));
    const signature = signInteraction(privateKey, "1700000000", rawBody);

    expect(verifyDiscordInteractionSignature(rawBody, signature, "1700000099", publicKeyHex)).toBe(false);
  });

  it("rejects a malformed (non-hex, wrong-length) signature without throwing", () => {
    const { publicKeyHex } = makeKeyPair();
    const rawBody = Buffer.from(JSON.stringify({ type: 1 }));
    expect(verifyDiscordInteractionSignature(rawBody, "not-hex-at-all", "1700000000", publicKeyHex)).toBe(false);
    expect(verifyDiscordInteractionSignature(rawBody, "ab", "1700000000", publicKeyHex)).toBe(false);
    expect(verifyDiscordInteractionSignature(rawBody, "", "1700000000", publicKeyHex)).toBe(false);
  });

  it("rejects a missing timestamp without throwing", () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const rawBody = Buffer.from(JSON.stringify({ type: 1 }));
    const signature = signInteraction(privateKey, "1700000000", rawBody);
    expect(verifyDiscordInteractionSignature(rawBody, signature, "", publicKeyHex)).toBe(false);
  });

  it("rejects a malformed public key configuration without throwing", () => {
    const rawBody = Buffer.from(JSON.stringify({ type: 1 }));
    expect(verifyDiscordInteractionSignature(rawBody, "ab".repeat(64), "1700000000", "not-a-valid-key")).toBe(false);
    expect(verifyDiscordInteractionSignature(rawBody, "ab".repeat(64), "1700000000", "aabbcc")).toBe(false); // too short
  });
});
