import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import {
  createEstablishSessionHandler,
  createAuthStatusHandler,
  createDisconnectHandler,
  type AuthRoutesDeps,
} from "../src/http/routes/auth.js";
import { saveAuthSession, getAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { WhopIdentityError, type WhopOAuthClient } from "../src/whop/oauthClient.js";
import { createTestPool } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const KEY = randomBytes(32).toString("base64");
const OPERATOR_ID = "user_operator";

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
    verifyAccessToken: vi.fn(async () => ({ sub: OPERATOR_ID })),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AuthRoutesDeps> = {}): AuthRoutesDeps {
  return {
    pool,
    oauthClient: makeOAuthClient(),
    refreshTokenEncryptionKey: KEY,
    whopOperatorUserId: OPERATOR_ID,
    ...overrides,
  };
}

describe("POST /api/auth/session", () => {
  it("rejects a body missing required fields, without calling out to Whop at all", async () => {
    const oauthClient = makeOAuthClient();
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient }));
    const { res, statusCode, body } = makeResponse();
    await handler({ body: { access_token: "only-this" } } as Request, res);
    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({ error: { type: "invalid_request" } });
    expect(oauthClient.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("empty database + configured operator => session may be established", async () => {
    const verifyAccessToken = vi.fn(async (token: string) => {
      expect(token).toBe("a");
      return { sub: OPERATOR_ID };
    });
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res, statusCode } = makeResponse();

    await handler({ body: { access_token: "a", refresh_token: "r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(200);
    expect(verifyAccessToken).toHaveBeenCalledWith("a");
    const session = await getAuthSession(pool, KEY);
    expect(session?.accessToken).toBe("a");
    expect(session?.refreshToken).toBe("r");
    expect(session?.whopUserId).toBe(OPERATOR_ID);
  });

  it("empty database + wrong verified Whop user => 403, and nothing is persisted", async () => {
    const verifyAccessToken = vi.fn(async () => ({ sub: "user_someone_else" }));
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { access_token: "a", refresh_token: "r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(403);
    expect(body()).toMatchObject({ error: { type: "forbidden_operator" } });
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("a wrong user can never become operator just because auth_sessions is empty — configuration decides, not the database", async () => {
    // Same scenario as above, phrased as the specific regression this fix targets:
    // "first authenticated user wins" must be impossible regardless of DB state.
    const verifyAccessToken = vi.fn(async () => ({ sub: "user_first_to_arrive" }));
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res, statusCode } = makeResponse();

    await handler({ body: { access_token: "a", refresh_token: "r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(403);
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("rejects with 401 when the access token fails Whop verification, and stores nothing", async () => {
    const verifyAccessToken = vi.fn(async () => {
      throw new WhopIdentityError("invalid token");
    });
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { access_token: "forged", refresh_token: "r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(401);
    expect(body()).toMatchObject({ error: { type: "invalid_token" } });
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("authorization comes solely from the verified sub — a forged claim elsewhere in the body has no effect", async () => {
    const verifyAccessToken = vi.fn(async () => ({ sub: OPERATOR_ID }));
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res } = makeResponse();

    await handler(
      // Deliberately including bogus identity-shaped fields the handler must never read.
      { body: { access_token: "a", refresh_token: "r", expires_in: 3600, whop_user_id: "user_attacker", sub: "user_attacker" } } as Request,
      res,
    );

    expect((await getAuthSession(pool, KEY))?.whopUserId).toBe(OPERATOR_ID);
  });

  it("returns 403 and does not overwrite the singleton session when a different Whop user tries to establish a session", async () => {
    await saveAuthSession(pool, { whopUserId: OPERATOR_ID, accessToken: "orig-a", refreshToken: "orig-r", accessTokenExpiresAt: new Date() }, KEY);
    const verifyAccessToken = vi.fn(async () => ({ sub: "user_intruder" }));
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { access_token: "intruder-a", refresh_token: "intruder-r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(403);
    expect(body()).toMatchObject({ error: { type: "forbidden_operator" } });
    const session = await getAuthSession(pool, KEY);
    expect(session?.whopUserId).toBe(OPERATOR_ID);
    expect(session?.accessToken).toBe("orig-a");
  });

  it("existing correct operator reconnect succeeds (e.g. re-login)", async () => {
    await saveAuthSession(pool, { whopUserId: OPERATOR_ID, accessToken: "old-a", refreshToken: "old-r", accessTokenExpiresAt: new Date() }, KEY);
    const verifyAccessToken = vi.fn(async () => ({ sub: OPERATOR_ID }));
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res, statusCode } = makeResponse();

    await handler({ body: { access_token: "new-a", refresh_token: "new-r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(200);
    expect((await getAuthSession(pool, KEY))?.accessToken).toBe("new-a");
  });

  it("existing mismatched DB operator fails closed, even when the caller IS the configured operator", async () => {
    // Simulates stale/corrupted data: the persisted row belongs to someone
    // other than the currently-configured WHOP_OPERATOR_USER_ID.
    await saveAuthSession(pool, { whopUserId: "user_stale_from_before_this_fix", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    const verifyAccessToken = vi.fn(async () => ({ sub: OPERATOR_ID }));
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { access_token: "a", refresh_token: "r", expires_in: 3600 } } as Request, res);

    expect(statusCode()).toBe(500);
    expect(body()).toMatchObject({ error: { type: "operator_configuration_conflict" } });
    // Refuses to proceed — the stale row is left exactly as it was, not repaired or overwritten.
    expect((await getAuthSession(pool, KEY))?.whopUserId).toBe("user_stale_from_before_this_fix");
  });

  it("never includes the caller's raw bearer token in the error response for any rejection path", async () => {
    const secretToken = "super-secret-caller-access-token";
    const verifyAccessToken = vi.fn(async () => ({ sub: "user_someone_else" }));
    const handler = createEstablishSessionHandler(makeDeps({ oauthClient: makeOAuthClient({ verifyAccessToken }) }));
    const { res, body } = makeResponse();

    await handler({ body: { access_token: secretToken, refresh_token: "r", expires_in: 3600 } } as Request, res);

    expect(JSON.stringify(body())).not.toContain(secretToken);
  });
});

describe("GET /api/auth/status", () => {
  it("reports not connected when no session exists", async () => {
    const handler = createAuthStatusHandler(makeDeps());
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect(body()).toEqual({ connected: false, status: null, whopUserId: null });
  });

  it("reports connected + whopUserId without ever including a token value", async () => {
    await saveAuthSession(pool, { whopUserId: OPERATOR_ID, accessToken: "secret-access", refreshToken: "secret-refresh", accessTokenExpiresAt: new Date() }, KEY);
    const handler = createAuthStatusHandler(makeDeps());
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect(body()).toEqual({ connected: true, status: "active", whopUserId: OPERATOR_ID });
    expect(JSON.stringify(body())).not.toContain("secret");
  });

  it("reports connected:false while auth_required, even though the row still exists", async () => {
    await saveAuthSession(pool, { whopUserId: OPERATOR_ID, accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    await pool.query("UPDATE auth_sessions SET status = 'auth_required' WHERE id = 1");
    const handler = createAuthStatusHandler(makeDeps());
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect(body()).toEqual({ connected: false, status: "auth_required", whopUserId: OPERATOR_ID });
  });
});

describe("POST /api/auth/disconnect", () => {
  it("revokes with Whop and deletes the local session", async () => {
    await saveAuthSession(pool, { whopUserId: OPERATOR_ID, accessToken: "a", refreshToken: "r-to-revoke", accessTokenExpiresAt: new Date() }, KEY);
    const revokeRefreshToken = vi.fn(async () => undefined);
    const handler = createDisconnectHandler(makeDeps({ oauthClient: makeOAuthClient({ revokeRefreshToken }) }));
    const { res, statusCode } = makeResponse();

    await handler({} as Request, res);

    expect(statusCode()).toBe(200);
    expect(revokeRefreshToken).toHaveBeenCalledWith("r-to-revoke");
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("still clears the local session even when Whop's revoke call fails", async () => {
    await saveAuthSession(pool, { whopUserId: OPERATOR_ID, accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    const revokeRefreshToken = vi.fn(async () => {
      throw new Error("Whop revoke endpoint down");
    });
    const handler = createDisconnectHandler(makeDeps({ oauthClient: makeOAuthClient({ revokeRefreshToken }) }));
    const { res, statusCode } = makeResponse();

    await handler({} as Request, res);

    expect(statusCode()).toBe(200);
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("is a no-op success when there was never a session to disconnect", async () => {
    const revokeRefreshToken = vi.fn();
    const handler = createDisconnectHandler(makeDeps({ oauthClient: makeOAuthClient({ revokeRefreshToken }) }));
    const { res, statusCode } = makeResponse();
    await handler({} as Request, res);
    expect(statusCode()).toBe(200);
    expect(revokeRefreshToken).not.toHaveBeenCalled();
  });
});
