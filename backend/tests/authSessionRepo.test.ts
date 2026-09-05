import { describe, it, expect, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  saveAuthSession,
  getAuthSession,
  markAuthRequired,
  updateAccessToken,
  deleteAuthSession,
} from "../src/db/authSessionRepo.js";
import { createTestPool } from "./helpers/testDb.js";

const pool = createTestPool();
const KEY = randomBytes(32).toString("base64");

afterEach(async () => {
  await deleteAuthSession(pool);
});
afterAll(async () => {
  await pool.end();
});

describe("authSessionRepo (single-operator session)", () => {
  it("returns null when no session has ever been saved", async () => {
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });

  it("saves and reads back a session, decrypting both tokens correctly", async () => {
    await saveAuthSession(
      pool,
      {
        whopUserId: "user_abc",
        accessToken: "whop_access_token_value",
        refreshToken: "whop_refresh_token_value",
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      },
      KEY,
    );

    const session = await getAuthSession(pool, KEY);
    expect(session?.whopUserId).toBe("user_abc");
    expect(session?.accessToken).toBe("whop_access_token_value");
    expect(session?.refreshToken).toBe("whop_refresh_token_value");
    expect(session?.status).toBe("active");
  });

  it("never stores the plaintext token anywhere retrievable except through decryption", async () => {
    await saveAuthSession(
      pool,
      {
        whopUserId: null,
        accessToken: "plaintext-access-marker",
        refreshToken: "plaintext-refresh-marker",
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      },
      KEY,
    );

    const raw = await pool.query(
      "SELECT encrypted_access_token, encrypted_refresh_token FROM auth_sessions WHERE id = 1",
    );
    const encryptedAccess: Buffer = raw.rows[0].encrypted_access_token;
    const encryptedRefresh: Buffer = raw.rows[0].encrypted_refresh_token;
    expect(encryptedAccess.toString("utf8")).not.toContain("plaintext-access-marker");
    expect(encryptedRefresh.toString("utf8")).not.toContain("plaintext-refresh-marker");
  });

  it("re-saving replaces the single session row rather than creating a second one", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "a1", refreshToken: "r1", accessTokenExpiresAt: new Date() },
      KEY,
    );
    await saveAuthSession(
      pool,
      { whopUserId: "user_2", accessToken: "a2", refreshToken: "r2", accessTokenExpiresAt: new Date() },
      KEY,
    );

    const count = await pool.query("SELECT count(*)::int AS n FROM auth_sessions");
    expect(count.rows[0].n).toBe(1);
    expect((await getAuthSession(pool, KEY))?.whopUserId).toBe("user_2");
  });

  it("updateAccessToken refreshes the access token and expiry without touching the refresh token, unless Whop rotated it", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "old-access", refreshToken: "stable-refresh", accessTokenExpiresAt: new Date() },
      KEY,
    );

    const newExpiry = new Date(Date.now() + 3600_000);
    await updateAccessToken(pool, "new-access", newExpiry, KEY, null);

    const session = await getAuthSession(pool, KEY);
    expect(session?.accessToken).toBe("new-access");
    expect(session?.refreshToken).toBe("stable-refresh");
    expect(session?.accessTokenExpiresAt.getTime()).toBe(newExpiry.getTime());
  });

  it("updateAccessToken rotates the refresh token when Whop issues a new one", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "old-access", refreshToken: "old-refresh", accessTokenExpiresAt: new Date() },
      KEY,
    );

    await updateAccessToken(pool, "new-access", new Date(), KEY, "rotated-refresh");

    const session = await getAuthSession(pool, KEY);
    expect(session?.refreshToken).toBe("rotated-refresh");
  });

  it("markAuthRequired flips status without deleting the row (completed history stays intact)", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() },
      KEY,
    );

    await markAuthRequired(pool);

    const session = await getAuthSession(pool, KEY);
    expect(session?.status).toBe("auth_required");
    expect(session?.refreshToken).toBe("r");
  });

  it("deleteAuthSession (explicit disconnect) removes the row entirely", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() },
      KEY,
    );
    await deleteAuthSession(pool);
    expect(await getAuthSession(pool, KEY)).toBeNull();
  });
});
