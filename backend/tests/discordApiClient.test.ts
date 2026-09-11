import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listBotGuilds,
  getGuild,
  listGuildChannels,
  probeChannelReadable,
  listChannelMessagesPage,
  leaveGuild,
  getApplicationInfo,
  hasMessageContentIntent,
  ensureMessageContentIntentEnabled,
  DiscordApiError,
  DiscordApiRateLimitedError,
  DiscordApiUnauthorizedError,
  DiscordApiForbiddenError,
  DiscordApiNotFoundError,
  DiscordMessageContentNotEnabledError,
} from "../src/discord/discordApiClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const TOKEN = "test-bot-token";

describe("discordApiClient (Phase 4K-B)", () => {
  it("listBotGuilds authenticates with Authorization: Bot <token> and maps the response", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://discord.com/api/v10/users/@me/guilds");
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
      return jsonResponse(200, [{ id: "111", name: "Trading Community A", icon: null, owner: false, permissions: "0" }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const guilds = await listBotGuilds(TOKEN);
    expect(guilds).toEqual([{ id: "111", name: "Trading Community A" }]);
  });

  it("getGuild fetches a single guild by id", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://discord.com/api/v10/guilds/222");
      return jsonResponse(200, { id: "222", name: "Guild Two" });
    }));
    expect(await getGuild("222", TOKEN)).toEqual({ id: "222", name: "Guild Two" });
  });

  it("listGuildChannels marks text-capable channel types and passes through voice/category types as not text-capable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, [
          { id: "1", name: "trade-reviews", type: 0, parent_id: "10" },
          { id: "2", name: "announcements", type: 5, parent_id: null },
          { id: "3", name: "General VC", type: 2, parent_id: null },
          { id: "4", name: "Categories", type: 4, parent_id: null },
        ]),
      ),
    );
    const channels = await listGuildChannels("222", TOKEN);
    expect(channels).toEqual([
      { id: "1", name: "trade-reviews", type: 0, parentId: "10", textCapable: true },
      { id: "2", name: "announcements", type: 5, parentId: null, textCapable: true },
      { id: "3", name: "General VC", type: 2, parentId: null, textCapable: false },
      { id: "4", name: "Categories", type: 4, parentId: null, textCapable: false },
    ]);
  });

  it("probeChannelReadable returns true on a successful bounded fetch (limit=1)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.get("limit")).toBe("1");
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeChannelReadable("1", TOKEN)).toBe(true);
  });

  it("probeChannelReadable returns false (not an error) on 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { message: "Missing Access" })));
    expect(await probeChannelReadable("1", TOKEN)).toBe(false);
  });

  it("listChannelMessagesPage extracts attachments and the oldest message id, passes `before` when given", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("before")).toBe("999");
      return jsonResponse(200, [
        { id: "888", attachments: [{ id: "att1", filename: "clip.mp4", url: "https://cdn.discordapp.com/attachments/1/att1/clip.mp4?ex=1", size: 1000, content_type: "video/mp4" }] },
        { id: "887", attachments: [] },
        { id: "886", attachments: [{ id: "att2", filename: "clip2.mp4", url: "https://cdn.discordapp.com/attachments/1/att2/clip2.mp4?ex=1", size: 2000 }] },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await listChannelMessagesPage("1", TOKEN, "999");
    expect(page.oldestMessageId).toBe("886");
    expect(page.attachments).toEqual([
      { messageId: "888", attachment: { id: "att1", filename: "clip.mp4", url: "https://cdn.discordapp.com/attachments/1/att1/clip.mp4?ex=1", contentType: "video/mp4", size: 1000 } },
      { messageId: "886", attachment: { id: "att2", filename: "clip2.mp4", url: "https://cdn.discordapp.com/attachments/1/att2/clip2.mp4?ex=1", contentType: null, size: 2000 } },
    ]);
  });

  it("listChannelMessagesPage returns oldestMessageId: undefined for an empty page (end of history)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, [])));
    const page = await listChannelMessagesPage("1", TOKEN);
    expect(page.oldestMessageId).toBeUndefined();
    expect(page.attachments).toEqual([]);
  });

  it("retries once on 429, respecting retry_after, then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { message: "rate limited", retry_after: 0.05 });
      return jsonResponse(200, [{ id: "1", name: "G" }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const guilds = await listBotGuilds(TOKEN);
    expect(guilds).toEqual([{ id: "1", name: "G" }]);
    expect(calls).toBe(2);
  });

  it("throws DiscordApiRateLimitedError if STILL 429 after the one retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(429, { message: "rate limited", retry_after: 0.01 })));
    await expect(listBotGuilds(TOKEN)).rejects.toThrow(DiscordApiRateLimitedError);
  });

  it("maps 401/403/404 to distinct typed errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));
    await expect(getGuild("x", TOKEN)).rejects.toThrow(DiscordApiUnauthorizedError);
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, {})));
    await expect(getGuild("x", TOKEN)).rejects.toThrow(DiscordApiForbiddenError);
    vi.unstubAllGlobals();

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, {})));
    await expect(getGuild("x", TOKEN)).rejects.toThrow(DiscordApiNotFoundError);
  });

  it("never includes the bot token in a thrown error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "internal error" })));
    let caught: unknown;
    try {
      await getGuild("x", "super-secret-bot-token-value");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiscordApiError);
    expect((caught as Error).message).not.toContain("super-secret-bot-token-value");
  });

  it("leaveGuild is best-effort and never throws even on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(leaveGuild("1", TOKEN)).resolves.toBeUndefined();
  });
});

describe("Discord Message Content Intent readiness (Phase 4K-B review fix)", () => {
  it("getApplicationInfo reads the application's flags via GET /oauth2/applications/@me", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://discord.com/api/v10/oauth2/applications/@me");
        expect((init!.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
        return jsonResponse(200, { id: "app1", flags: 524288 });
      }),
    );
    expect(await getApplicationInfo(TOKEN)).toEqual({ id: "app1", flags: 524288 });
  });

  it("getApplicationInfo defaults flags to 0 when Discord omits the field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: "app1" })));
    expect((await getApplicationInfo(TOKEN)).flags).toBe(0);
  });

  it("hasMessageContentIntent recognizes the verified (bit 18) flag", () => {
    expect(hasMessageContentIntent(1 << 18)).toBe(true);
  });

  it("hasMessageContentIntent recognizes the unverified/limited (bit 19) flag", () => {
    expect(hasMessageContentIntent(1 << 19)).toBe(true);
  });

  it("hasMessageContentIntent is false when neither bit is set, even if other unrelated flags are", () => {
    expect(hasMessageContentIntent(0)).toBe(false);
    expect(hasMessageContentIntent(1 << 12)).toBe(false); // some unrelated application flag
  });

  it("hasMessageContentIntent is true when BOTH bits happen to be set", () => {
    expect(hasMessageContentIntent((1 << 18) | (1 << 19))).toBe(true);
  });

  it("ensureMessageContentIntentEnabled resolves silently when the intent is enabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: "app1", flags: 1 << 19 })));
    await expect(ensureMessageContentIntentEnabled(TOKEN)).resolves.toBeUndefined();
  });

  it("ensureMessageContentIntentEnabled throws DiscordMessageContentNotEnabledError with an actionable message when the intent is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: "app1", flags: 0 })));
    await expect(ensureMessageContentIntentEnabled(TOKEN)).rejects.toThrow(DiscordMessageContentNotEnabledError);
    let caught: unknown;
    try {
      await ensureMessageContentIntentEnabled(TOKEN);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/Message Content/i);
  });
});
