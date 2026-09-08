import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { createKnoveraLoginHandler, createKnoveraMeHandler, createKnoveraLogoutHandler } from "../src/http/routes/knoveraAuth.js";
import { hashPassword } from "../src/lib/passwordHash.js";
import { issueKnoveraToken, verifyKnoveraToken } from "../src/lib/knoveraToken.js";
import type { KnoveraAuthConfig } from "../src/config.js";
import { makeResponse } from "./helpers/httpMocks.js";

const EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery staple";
const SECRET = "test-routes-secret";

async function makeConfig(): Promise<KnoveraAuthConfig> {
  return { loginEmail: EMAIL, passwordHash: await hashPassword(PASSWORD), authSecret: SECRET };
}

function req(body: unknown = {}, headers: Record<string, string> = {}): Request {
  return { body, headers } as unknown as Request;
}

describe("POST /api/knovera-auth/login", () => {
  it("A: correct email/password => login success, returns a valid token", async () => {
    const handler = createKnoveraLoginHandler({ knoveraAuth: await makeConfig() });
    const { res, statusCode, body } = makeResponse();

    await handler(req({ email: EMAIL, password: PASSWORD }), res);

    expect(statusCode()).toBe(200);
    const { token } = body() as { token: string };
    expect(verifyKnoveraToken(token, SECRET)).not.toBeNull();
  });

  it("A: matches the configured email case-insensitively and with surrounding whitespace trimmed", async () => {
    const handler = createKnoveraLoginHandler({ knoveraAuth: await makeConfig() });
    const { res, statusCode } = makeResponse();

    await handler(req({ email: "  Owner@Example.com  ", password: PASSWORD }), res);

    expect(statusCode()).toBe(200);
  });

  it("B: wrong email => generic 401, identical shape to a wrong password", async () => {
    const handler = createKnoveraLoginHandler({ knoveraAuth: await makeConfig() });
    const { res, statusCode, body } = makeResponse();

    await handler(req({ email: "someone-else@example.com", password: PASSWORD }), res);

    expect(statusCode()).toBe(401);
    expect(body()).toEqual({ error: { message: "Invalid email or password.", type: "invalid_credentials" } });
  });

  it("C: wrong password => the exact same generic 401 as a wrong email", async () => {
    const handler = createKnoveraLoginHandler({ knoveraAuth: await makeConfig() });
    const { res, statusCode, body } = makeResponse();

    await handler(req({ email: EMAIL, password: "not-the-password" }), res);

    expect(statusCode()).toBe(401);
    expect(body()).toEqual({ error: { message: "Invalid email or password.", type: "invalid_credentials" } });
  });

  it("D: missing password => deterministic 400 validation failure, not a 401 or a crash", async () => {
    const handler = createKnoveraLoginHandler({ knoveraAuth: await makeConfig() });
    const { res, statusCode, body } = makeResponse();

    await handler(req({ email: EMAIL }), res);

    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({ error: { type: "invalid_request" } });
  });

  it("D: missing email => deterministic 400 validation failure", async () => {
    const handler = createKnoveraLoginHandler({ knoveraAuth: await makeConfig() });
    const { res, statusCode, body } = makeResponse();

    await handler(req({ password: PASSWORD }), res);

    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({ error: { type: "invalid_request" } });
  });

  it("never returns the configured password hash or any Whop information", async () => {
    const handler = createKnoveraLoginHandler({ knoveraAuth: await makeConfig() });
    const { res, body } = makeResponse();

    await handler(req({ email: EMAIL, password: PASSWORD }), res);

    const raw = JSON.stringify(body());
    expect(raw).not.toContain("scrypt:");
    expect(raw.toLowerCase()).not.toContain("whop");
  });
});

describe("GET /api/knovera-auth/me", () => {
  it("E: returns authenticated:true and the configured email (reachable only once requireKnoveraAuth has already verified the token)", async () => {
    const handler = createKnoveraMeHandler({ knoveraAuth: await makeConfig() });
    const { res, statusCode, body } = makeResponse();

    handler(req(), res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ authenticated: true, email: EMAIL });
  });

  it("never returns the password hash or auth secret", async () => {
    const handler = createKnoveraMeHandler({ knoveraAuth: await makeConfig() });
    const { res, body } = makeResponse();

    handler(req(), res);

    const raw = JSON.stringify(body());
    expect(raw).not.toContain("scrypt:");
    expect(raw).not.toContain(SECRET);
  });
});

describe("POST /api/knovera-auth/logout", () => {
  it("succeeds for a currently-valid token", async () => {
    const config = await makeConfig();
    const handler = createKnoveraLogoutHandler({ knoveraAuth: config });
    const token = issueKnoveraToken(config.authSecret);
    const { res, statusCode, body } = makeResponse();

    handler(req({}, { authorization: `Bearer ${token}` }), res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ok: true });
  });

  it("returns 401 for a missing token — this is a stateless token architecture: nothing server-side is revoked, the frontend discarding the token is what actually ends the session", async () => {
    const handler = createKnoveraLogoutHandler({ knoveraAuth: await makeConfig() });
    const { res, statusCode } = makeResponse();

    handler(req({}, {}), res);

    expect(statusCode()).toBe(401);
  });

  it("returns 401 for an already-expired token", async () => {
    const config = await makeConfig();
    const handler = createKnoveraLogoutHandler({ knoveraAuth: config });
    const expiredToken = issueKnoveraToken(config.authSecret, -1);
    const { res, statusCode } = makeResponse();

    handler(req({}, { authorization: `Bearer ${expiredToken}` }), res);

    expect(statusCode()).toBe(401);
  });
});
