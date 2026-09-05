import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, InvalidEncryptionKeyError } from "../src/lib/crypto.js";

const KEY = randomBytes(32).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext secret", () => {
    const blob = encryptSecret("whop_refresh_token_abc123", KEY);
    expect(decryptSecret(blob, KEY)).toBe("whop_refresh_token_abc123");
  });

  it("produces a different IV (and different ciphertext) each call, even for the same plaintext", () => {
    const blobA = encryptSecret("same-secret", KEY);
    const blobB = encryptSecret("same-secret", KEY);
    expect(blobA.equals(blobB)).toBe(false);
    expect(blobA.subarray(0, 12).equals(blobB.subarray(0, 12))).toBe(false);
  });

  it("never leaks the plaintext into the encrypted blob", () => {
    const blob = encryptSecret("super-secret-refresh-token-value", KEY);
    expect(blob.toString("utf8")).not.toContain("super-secret-refresh-token-value");
  });

  it("rejects a key that doesn't decode to 32 bytes", () => {
    expect(() => encryptSecret("x", Buffer.from("too-short").toString("base64"))).toThrow(
      InvalidEncryptionKeyError,
    );
  });

  it("fails to decrypt (auth tag mismatch) with the wrong key", () => {
    const blob = encryptSecret("secret", KEY);
    const wrongKey = randomBytes(32).toString("base64");
    expect(() => decryptSecret(blob, wrongKey)).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const blob = encryptSecret("secret", KEY);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });
});
