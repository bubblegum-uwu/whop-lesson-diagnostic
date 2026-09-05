import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import {
  createEstablishSessionHandler,
  createAuthStatusHandler,
  createDisconnectHandler,
} from "../src/http/routes/auth.js";
import { saveAuthSession, getAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import type { WhopOAuthClient } from "../src/whop/oauthClient.js";
import { createTestPool } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const KEY = randomBytes(32).toString("base64");

afterEach(async () => {
  await deleteAuthSession(pool);
});
afterAll(async () => {
  await pool.end();
});

function makeOAuthClient(overrides: Partial<WhopOAuthClient> = {}): WhopOAuthClient {
  return { refreshAccessToken: vi.fn(), revokeRefreshToken: vi.fn(async () => undefined), ...overrides };
}

describe("POST /api/auth/session", () => {
  it("rejects a body missing required fields", async () => {
    const handler = createEstablishSessionHandler({ pool, oauthClient: makeOAuthClient(), refreshTokenEncryptionKey: KEY });
    const { res, statusCode, body } = makeResponse();
    await handler({ body: { access_token: "only-this" } } as Request, res);
    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({ error: { type: "invalid_request" } });
  });

  it("persists a valid session and extracts the sub claim from id_token", async () => {
    const handler = createEstablishSessionHandler({ pool, oauthClient: makeOAuthClient(), refreshTokenEncryptionKey: KEY });
    const idToken = `header.${Buffer.from(JSON.stringify({ sub: "user_42" })).toString("base64url")}.sig`;
    const { res, statusCode } = makeResponse();

    await handler(
      { body: { access_token: "a", refresh_token: "r", expires_in: 3600, id_token: idToken } } as Request,
      res,
    );

    expect(statusCode()).toBe(200);
    const session = await getAuthSession(pool, KEY);
    expect(session?.accessToken).toBe("a");
    expect(session?.refreshToken).toBe("r");
    expect(session?.whopUserId).toBe("user_42");
  });

  it("stores a null whopUserId when id_token is absent or unparseable, without failing the request", async () => {
    const handler = createEstablishSessionHandler({ pool, oauthClient: makeOAuthClient(), refreshTokenEncryptionKey: KEY });
    const { res, statusCode } = makeResponse();
    await handler({ body: { access_token: "a", refresh_token: "r", expires_in: 3600, id_token: "garbage" } } as Request, res);
    expect(statusCode()).toBe(200);
    expect((await getAuthSession(pool, KEY))?.whopUserId).toBeNull();
  });
});

describe("GET /api/auth/status", () => {
  it("reports not connected when no session exists", async () => {
    const handler = createAuthStatusHandler({ pool, oauthClient: makeOAuthClient(), refreshTokenEncryptionKey: KEY });
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect(body()).toEqual({ connected: false, status: null, whopUserId: null });
  });

  it("reports connected + whopUserId without ever including a token value", async () => {
    await saveAuthSession(pool, { whopUserId: "user_1", accessToken: "secret-access", refreshToken: "secret-refresh", accessTokenExpiresAt: new Date() }, KEY);
    const handler = createAuthStatusHandler({ pool, oauthClient: makeOAuthClient(), refreshTokenEncryptionKey: KEY });
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect(body()).toEqual({ connected: true, status: "active", whopUserId: "user_1" });
    expect(JSON.stringify(body())).not.toContain("secret");
  });

  it("reports connected:false while auth_required, even though the row still exists", async () => {
    await saveAuthSession(pool, { whopUserId: "user_1", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    await pool.query("UPDATE auth_sessions SET status = 'auth_required' WHERE id = 1");
    const handler = createAuthStatusHandler({ pool, oauthClient: makeOAuthClient(), refreshTokenEncryptionKey: KEY });
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect(body()).toEqual({ connected: false, status: "auth_required", whopUserId: "user_1" });
  });
});

describe("POST /api/auth/disconnect", () => {
  it("revokes with Whop and deletes the local session", async () => {
    await saveAuthSession(pool, { whopUserId: "user_1", accessToken: "a", refreshToken: "r-to-revoke", accessTokenExpiresAt: new Date() }, KEY);
    const revokeRefreshToken = vi.fn(async () => undefined);
    const handler = createDisconnectHandler({ pool, oauthClient: makeOAuthClient({ revokeRefreshToken }), refreshTokenEncryptionKey: KEY });
    const { res, statusCode } = makeResponse();

    await handler({} as Request, res);

    expect(statusCode()).toBe(200);
    expect(revokeRefreshToken).toHaveBeenCalledWith("r-to-revoke");
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("still clears the local session even when Whop's revoke call fails", async () => {
    await saveAuthSession(pool, { whopUserId: "user_1", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    const revokeRefreshToken = vi.fn(async () => {
      throw new Error("Whop revoke endpoint down");
    });
    const handler = createDisconnectHandler({ pool, oauthClient: makeOAuthClient({ revokeRefreshToken }), refreshTokenEncryptionKey: KEY });
    const { res, statusCode } = makeResponse();

    await handler({} as Request, res);

    expect(statusCode()).toBe(200);
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("is a no-op success when there was never a session to disconnect", async () => {
    const revokeRefreshToken = vi.fn();
    const handler = createDisconnectHandler({ pool, oauthClient: makeOAuthClient({ revokeRefreshToken }), refreshTokenEncryptionKey: KEY });
    const { res, statusCode } = makeResponse();
    await handler({} as Request, res);
    expect(statusCode()).toBe(200);
    expect(revokeRefreshToken).not.toHaveBeenCalled();
  });
});
