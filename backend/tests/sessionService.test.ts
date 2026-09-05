import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { saveAuthSession, getAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { getValidAccessToken, AuthRequiredError } from "../src/whop/sessionService.js";
import { WhopRefreshError, type WhopOAuthClient } from "../src/whop/oauthClient.js";
import { createTestPool } from "./helpers/testDb.js";

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
    revokeRefreshToken: vi.fn(),
    ...overrides,
  };
}

describe("getValidAccessToken", () => {
  it("throws AuthRequiredError when no session has ever been established", async () => {
    const oauth = makeOAuthClient();
    await expect(getValidAccessToken(pool, oauth, KEY)).rejects.toBeInstanceOf(AuthRequiredError);
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("returns the stored access token as-is when it isn't near expiry", async () => {
    await saveAuthSession(
      pool,
      {
        whopUserId: "user_1",
        accessToken: "still-fresh",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      },
      KEY,
    );
    const oauth = makeOAuthClient();

    const token = await getValidAccessToken(pool, oauth, KEY);
    expect(token).toBe("still-fresh");
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("proactively refreshes when less than the margin remains, and persists the new token", async () => {
    await saveAuthSession(
      pool,
      {
        whopUserId: "user_1",
        accessToken: "about-to-expire",
        refreshToken: "refresh-1",
        accessTokenExpiresAt: new Date(Date.now() + 60_000), // 1 min left, under the 5 min margin
      },
      KEY,
    );
    const oauth = makeOAuthClient({
      refreshAccessToken: vi.fn(async () => ({
        access_token: "refreshed-access",
        refresh_token: "refreshed-refresh",
        expires_in: 3600,
        token_type: "bearer",
      })),
    });

    const token = await getValidAccessToken(pool, oauth, KEY);
    expect(token).toBe("refreshed-access");
    expect(oauth.refreshAccessToken).toHaveBeenCalledWith("refresh-1");

    const persisted = await getAuthSession(pool, KEY);
    expect(persisted?.accessToken).toBe("refreshed-access");
    expect(persisted?.refreshToken).toBe("refreshed-refresh");
    expect(persisted?.status).toBe("active");
  });

  it("keeps the existing refresh token when Whop doesn't rotate it", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "old", refreshToken: "stable-refresh", accessTokenExpiresAt: new Date() },
      KEY,
    );
    const oauth = makeOAuthClient({
      refreshAccessToken: vi.fn(async () => ({ access_token: "new", expires_in: 3600, token_type: "bearer" })),
    });

    await getValidAccessToken(pool, oauth, KEY);
    expect((await getAuthSession(pool, KEY))?.refreshToken).toBe("stable-refresh");
  });

  it("marks the session AUTH_REQUIRED and throws AuthRequiredError when refresh itself fails", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "old", refreshToken: "revoked-refresh", accessTokenExpiresAt: new Date() },
      KEY,
    );
    const oauth = makeOAuthClient({
      refreshAccessToken: vi.fn(async () => {
        throw new WhopRefreshError("invalid_grant");
      }),
    });

    await expect(getValidAccessToken(pool, oauth, KEY)).rejects.toBeInstanceOf(AuthRequiredError);
    const session = await getAuthSession(pool, KEY);
    expect(session?.status).toBe("auth_required");
    // Completed work / the row itself is preserved, not deleted.
    expect(session?.refreshToken).toBe("revoked-refresh");
  });

  it("throws AuthRequiredError immediately (without calling refresh) once a session is already auth_required", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "old", refreshToken: "r", accessTokenExpiresAt: new Date() },
      KEY,
    );
    const failingOauth = makeOAuthClient({
      refreshAccessToken: vi.fn(async () => {
        throw new WhopRefreshError("invalid_grant");
      }),
    });
    await getValidAccessToken(pool, failingOauth, KEY).catch(() => undefined); // sets status to auth_required

    const oauth = makeOAuthClient();
    await expect(getValidAccessToken(pool, oauth, KEY)).rejects.toBeInstanceOf(AuthRequiredError);
    expect(oauth.refreshAccessToken).not.toHaveBeenCalled();
  });
});
