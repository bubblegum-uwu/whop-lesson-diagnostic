import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

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
