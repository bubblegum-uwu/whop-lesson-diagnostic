import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/passwordHash.js";

describe("hashPassword / verifyPassword", () => {
  it("verifies the correct password against its own hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("never stores the plaintext password in the hash string", async () => {
    const hash = await hashPassword("super-secret-value");
    expect(hash).not.toContain("super-secret-value");
  });

  it("produces a different hash each call, even for the same password (random salt)", async () => {
    const hashA = await hashPassword("same-password");
    const hashB = await hashPassword("same-password");
    expect(hashA).not.toBe(hashB);
    expect(await verifyPassword("same-password", hashA)).toBe(true);
    expect(await verifyPassword("same-password", hashB)).toBe(true);
  });

  it("is self-describing: scheme:salt:hash", async () => {
    const hash = await hashPassword("x");
    expect(hash.split(":")).toHaveLength(3);
    expect(hash.startsWith("scrypt:")).toBe(true);
  });

  it("fails closed (returns false, never throws) for a malformed stored hash", async () => {
    await expect(verifyPassword("anything", "not-a-real-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything", "scrypt:onlytwoparts")).resolves.toBe(false);
    await expect(verifyPassword("anything", "bcrypt:aa:bb")).resolves.toBe(false);
  });
});
