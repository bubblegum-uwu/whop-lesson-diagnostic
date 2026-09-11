import { describe, it, expect } from "vitest";
import { loadConfig, requireKnoveraAuthEnv } from "../src/config.js";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ALLOWED_ORIGIN: "https://example.github.io",
    GEMINI_API_KEY: "gemini-key",
    WHOP_CLIENT_ID: "app_abc123",
    WHOP_COURSE_ID: "cors_x",
    WHOP_EXPERIENCE_ID: "exp_x",
    WHOP_COURSE_SLUG: "scarface-trades-mastermind",
    WHOP_OPERATOR_USER_ID: "user_abc123",
    DB_USER: "app_user",
    DB_PASSWORD: "db-password",
    DB_NAME: "whop_lesson_platform",
    REFRESH_TOKEN_ENCRYPTION_KEY: "base64key",
    ...overrides,
  };
}

describe("loadConfig — WHOP_OPERATOR_USER_ID", () => {
  it("loads successfully with a well-formed operator id", () => {
    const config = loadConfig(baseEnv());
    expect(config.whopOperatorUserId).toBe("user_abc123");
  });

  it("fails application startup outright when WHOP_OPERATOR_USER_ID is missing", () => {
    expect(() => loadConfig(baseEnv({ WHOP_OPERATOR_USER_ID: undefined }))).toThrow(
      /WHOP_OPERATOR_USER_ID/,
    );
  });

  it("fails application startup when WHOP_OPERATOR_USER_ID is malformed (no user_ prefix)", () => {
    expect(() => loadConfig(baseEnv({ WHOP_OPERATOR_USER_ID: "not-a-whop-id" }))).toThrow(
      /must look like a Whop user id/,
    );
  });

  it("fails on an empty string, rather than silently treating it as unset-and-permissive", () => {
    expect(() => loadConfig(baseEnv({ WHOP_OPERATOR_USER_ID: "" }))).toThrow(/WHOP_OPERATOR_USER_ID/);
  });

  it("fails on a value containing unsafe characters, even if it starts with user_", () => {
    expect(() => loadConfig(baseEnv({ WHOP_OPERATOR_USER_ID: "user_abc; rm -rf /" }))).toThrow(
      /must look like a Whop user id/,
    );
  });
});

describe("loadConfig — Phase 4K YOUTUBE_API_KEY", () => {
  it("is undefined when YOUTUBE_API_KEY is not set — channel discovery fails closed, never a silent degraded mode", () => {
    const config = loadConfig(baseEnv());
    expect(config.youtubeApiKey).toBeUndefined();
  });

  it("is populated when YOUTUBE_API_KEY is set", () => {
    const config = loadConfig(baseEnv({ YOUTUBE_API_KEY: "yt-key-123" }));
    expect(config.youtubeApiKey).toBe("yt-key-123");
  });
});

describe("loadConfig — Phase 4D Knovera auth config", () => {
  it("knoveraAuth is undefined when none of the KNOVERA_* vars are set (worker role never needs it)", () => {
    const config = loadConfig(baseEnv());
    expect(config.knoveraAuth).toBeUndefined();
  });

  it("knoveraAuth is populated when all three KNOVERA_* vars are set", () => {
    const config = loadConfig(
      baseEnv({ KNOVERA_LOGIN_EMAIL: "owner@example.com", KNOVERA_PASSWORD_HASH: "scrypt:aa:bb", KNOVERA_AUTH_SECRET: "secret" }),
    );
    expect(config.knoveraAuth).toEqual({
      loginEmail: "owner@example.com",
      passwordHash: "scrypt:aa:bb",
      authSecret: "secret",
    });
  });

  it("knoveraAuth stays undefined if only some of the three vars are set — never a partially-configured auth", () => {
    const config = loadConfig(baseEnv({ KNOVERA_LOGIN_EMAIL: "owner@example.com" }));
    expect(config.knoveraAuth).toBeUndefined();
  });
});

describe("requireKnoveraAuthEnv", () => {
  it("returns the config when knoveraAuth is present", () => {
    const config = loadConfig(
      baseEnv({ KNOVERA_LOGIN_EMAIL: "owner@example.com", KNOVERA_PASSWORD_HASH: "scrypt:aa:bb", KNOVERA_AUTH_SECRET: "secret" }),
    );
    expect(requireKnoveraAuthEnv(config)).toEqual({
      loginEmail: "owner@example.com",
      passwordHash: "scrypt:aa:bb",
      authSecret: "secret",
    });
  });

  it("throws a clear error (naming the required env vars, never a configured value) when knoveraAuth is missing", () => {
    const config = loadConfig(baseEnv());
    expect(() => requireKnoveraAuthEnv(config)).toThrow(
      /KNOVERA_LOGIN_EMAIL.*KNOVERA_PASSWORD_HASH.*KNOVERA_AUTH_SECRET/s,
    );
  });
});
