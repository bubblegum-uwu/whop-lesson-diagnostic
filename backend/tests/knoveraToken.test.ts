import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { issueKnoveraToken, verifyKnoveraToken, KNOVERA_TOKEN_TYPE, KNOVERA_TOKEN_SUBJECT } from "../src/lib/knoveraToken.js";

const SECRET = "test-knovera-auth-secret";

describe("issueKnoveraToken / verifyKnoveraToken", () => {
  it("F/G a valid token round-trips with the correct claims", () => {
    const token = issueKnoveraToken(SECRET);
    const payload = verifyKnoveraToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(KNOVERA_TOKEN_SUBJECT);
    expect(payload!.type).toBe(KNOVERA_TOKEN_TYPE);
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it("rejects a token signed with a different secret", () => {
    const token = issueKnoveraToken(SECRET);
    expect(verifyKnoveraToken(token, "wrong-secret")).toBeNull();
  });

  it("G: rejects a tampered payload even with a structurally valid signature format", () => {
    const token = issueKnoveraToken(SECRET);
    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ sub: "attacker", type: KNOVERA_TOKEN_TYPE, iat: 0, exp: 9999999999 })).toString("base64url");
    expect(verifyKnoveraToken(`${header}.${tamperedPayload}.${signature}`, SECRET)).toBeNull();
  });

  it("F: rejects an expired token", () => {
    const token = issueKnoveraToken(SECRET, -1);
    expect(verifyKnoveraToken(token, SECRET)).toBeNull();
  });

  it("rejects a token whose type claim isn't knovera_session (defends against a future differently-typed token being reused here)", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: KNOVERA_TOKEN_SUBJECT, type: "some_other_token", iat: 0, exp: 9999999999 })).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
    expect(verifyKnoveraToken(`${header}.${payload}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects malformed tokens (wrong number of segments, garbage input)", () => {
    expect(verifyKnoveraToken("not-a-token", SECRET)).toBeNull();
    expect(verifyKnoveraToken("a.b", SECRET)).toBeNull();
    expect(verifyKnoveraToken("", SECRET)).toBeNull();
  });

  it("never embeds anything that looks like a Whop credential in the token itself", () => {
    const token = issueKnoveraToken(SECRET);
    expect(token.toLowerCase()).not.toContain("whop");
  });
});
