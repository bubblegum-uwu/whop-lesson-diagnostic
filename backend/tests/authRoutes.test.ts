import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import {
  createEstablishSessionHandler,
  createAuthStatusHandler,
  createDisconnectHandler,
} from "../src/http/routes/auth.js";
import { saveAuthSession, getAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { WhopIdentityError, type WhopOAuthClient } from "../src/whop/oauthClient.js";
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
  return {
    refreshAccessToken: vi.fn(),
    revokeRefreshToken: vi.fn(async () => undefined),
    verifyAccessToken: vi.fn(async () => ({ sub: "user_verified" })),
    ...overrides,
  };
}

describe("POST /api/auth/session", () => {
  it("rejects a body missing required fields, without calling out to Whop at all", async () => {
    const oauthClient = makeOAuthClient();
    const handler = createEstablishSessionHandler({ pool, oauthClient, refreshTokenEncryptionKey: KEY });
    const { res, statusCode, body } = makeResponse();
    await handler({ body: { access_token: "only-this" } } as Request, res);
    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({ error: { type: "invalid_request" } });
    expect(oauthClient.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("verifies the access token against Whop and persists the verified sub as the operator identity", async () => {
    const verifyAccessToken = vi.fn(async (token: string) => {
      expect(token).toBe("a");
      return { sub: "user_42" };
    });
    const handler = createEstablishSessionHandler({ pool, oauthClient: makeOAuthClient({ verifyAccessToken }), refreshTokenEncryptionKey: KEY });
    const { res, statusCode } = makeResponse();

    await handler({ body: { access_token: "a", refresh_token: "r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(200);
    expect(verifyAccessToken).toHaveBeenCalledWith("a");
    const session = await getAuthSession(pool, KEY);
    expect(session?.accessToken).toBe("a");
    expect(session?.refreshToken).toBe("r");
    expect(session?.whopUserId).toBe("user_42");
  });

  it("rejects with 401 when the access token fails Whop verification, and stores nothing", async () => {
    const verifyAccessToken = vi.fn(async () => {
      throw new WhopIdentityError("invalid token");
    });
    const handler = createEstablishSessionHandler({ pool, oauthClient: makeOAuthClient({ verifyAccessToken }), refreshTokenEncryptionKey: KEY });
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { access_token: "forged", refresh_token: "r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(401);
    expect(body()).toMatchObject({ error: { type: "invalid_token" } });
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("authorization comes solely from the verified sub — a forged claim elsewhere in the body has no effect", async () => {
    const verifyAccessToken = vi.fn(async () => ({ sub: "user_real" }));
    const handler = createEstablishSessionHandler({ pool, oauthClient: makeOAuthClient({ verifyAccessToken }), refreshTokenEncryptionKey: KEY });
    const { res } = makeResponse();

    await handler(
      // Deliberately including bogus identity-shaped fields the handler must never read.
      { body: { access_token: "a", refresh_token: "r", expires_in: 3600, whop_user_id: "user_attacker", sub: "user_attacker" } } as Request,
      res,
    );

    expect((await getAuthSession(pool, KEY))?.whopUserId).toBe("user_real");
  });

  it("returns 403 and does not overwrite the singleton session when a different Whop user tries to establish a session", async () => {
    await saveAuthSession(pool, { whopUserId: "user_original", accessToken: "orig-a", refreshToken: "orig-r", accessTokenExpiresAt: new Date() }, KEY);
    const verifyAccessToken = vi.fn(async () => ({ sub: "user_intruder" }));
    const handler = createEstablishSessionHandler({ pool, oauthClient: makeOAuthClient({ verifyAccessToken }), refreshTokenEncryptionKey: KEY });
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { access_token: "intruder-a", refresh_token: "intruder-r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(403);
    expect(body()).toMatchObject({ error: { type: "forbidden_operator" } });
    const session = await getAuthSession(pool, KEY);
    expect(session?.whopUserId).toBe("user_original");
    expect(session?.accessToken).toBe("orig-a");
  });

  it("allows the SAME operator to re-establish their session (e.g. re-login) without a 403", async () => {
    await saveAuthSession(pool, { whopUserId: "user_original", accessToken: "old-a", refreshToken: "old-r", accessTokenExpiresAt: new Date() }, KEY);
    const verifyAccessToken = vi.fn(async () => ({ sub: "user_original" }));
    const handler = createEstablishSessionHandler({ pool, oauthClient: makeOAuthClient({ verifyAccessToken }), refreshTokenEncryptionKey: KEY });
    const { res, statusCode } = makeResponse();

    await handler({ body: { access_token: "new-a", refresh_token: "new-r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(200);
    expect((await getAuthSession(pool, KEY))?.accessToken).toBe("new-a");
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
