import { describe, it, expect, beforeEach } from "vitest";
import { getDiscordApplicationId, buildDiscordInstallUrl } from "../discordAppConfig";

describe("getDiscordApplicationId", () => {
  const original = import.meta.env.VITE_DISCORD_APPLICATION_ID;

  beforeEach(() => {
    import.meta.env.VITE_DISCORD_APPLICATION_ID = original;
  });

  it("returns the configured application id", () => {
    import.meta.env.VITE_DISCORD_APPLICATION_ID = "111222333";
    expect(getDiscordApplicationId()).toBe("111222333");
  });

  it("returns null when unset", () => {
    delete (import.meta.env as Record<string, unknown>).VITE_DISCORD_APPLICATION_ID;
    expect(getDiscordApplicationId()).toBeNull();
  });
});

describe("buildDiscordInstallUrl", () => {
  it("builds a USER_INSTALL-only authorize link — integration_type=1, never a guild-install/bot-permissions link", () => {
    const url = buildDiscordInstallUrl("111222333");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("111222333");
    expect(parsed.searchParams.get("integration_type")).toBe("1");
    expect(parsed.searchParams.get("scope")).toBe("applications.commands");
    expect(parsed.searchParams.has("permissions")).toBe(false); // never a bot-permissions grant
  });
});
