import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import {
  createStartDiscordConnectHandler,
  createDiscordConnectCallbackHandler,
  createListDiscordGuildsHandler,
  createDisconnectDiscordGuildHandler,
  createListDiscordGuildChannelsHandler,
  type DiscordConnectionsRouteDeps,
} from "../src/http/routes/discordConnections.js";
import { issueDiscordConnectState } from "../src/lib/discordOAuthState.js";
import { upsertDiscordGuild, getDiscordGuildByGuildId } from "../src/db/discordGuildsRepo.js";
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const STATE_SECRET = "test-discord-state-secret";
const BOT_TOKEN = "test-bot-token";

function deps(overrides: Partial<DiscordConnectionsRouteDeps> = {}): DiscordConnectionsRouteDeps {
  return {
    pool,
    discordClientId: "test-client-id",
    discordBotToken: BOT_TOKEN,
    publicApiBaseUrl: "https://api.knovera.test",
    allowedOrigin: "https://app.knovera.test",
    stateSecret: STATE_SECRET,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function callStart(d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createStartDiscordConnectHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({} as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callCallback(query: Record<string, string>, d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createDiscordConnectCallbackHandler(d);
  const { res, statusCode, redirectedTo } = makeResponse();
  return handler({ query } as unknown as Request, res).then(() => ({ statusCode: statusCode(), redirectedTo: redirectedTo() }));
}

function callListGuilds(d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createListDiscordGuildsHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({} as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callDisconnect(guildId: string, d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createDisconnectDiscordGuildHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { guildId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callListChannels(guildId: string, d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createListDiscordGuildChannelsHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { guildId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

describe("POST /api/discord/connect/start", () => {
  it("issues a bot-install authorize URL with least-privilege permissions and a signed state, never a code-exchange param", async () => {
    const { statusCode, body } = await callStart();
    expect(statusCode).toBe(200);
    const url = new URL(body.authorizeUrl as string);
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("scope")).toBe("bot");
    expect(url.searchParams.get("permissions")).toBe("66560"); // VIEW_CHANNEL | READ_MESSAGE_HISTORY only
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.knovera.test/api/discord/connect/callback");
    expect(url.searchParams.get("response_type")).toBeNull(); // no code exchange in the bot-install flow
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("two calls issue different, unpredictable state tokens", async () => {
    const first = await callStart();
    const second = await callStart();
    expect(new URL(first.body.authorizeUrl as string).searchParams.get("state")).not.toBe(new URL(second.body.authorizeUrl as string).searchParams.get("state"));
  });

  it("responds 501 when DISCORD_CLIENT_ID/DISCORD_BOT_TOKEN aren't configured on this deployment", async () => {
    const { statusCode, body } = await callStart(deps({ discordClientId: undefined, discordBotToken: undefined }));
    expect(statusCode).toBe(501);
    expect((body.error as Record<string, unknown>).type).toBe("discord_api_not_configured");
  });
});

describe("GET /api/discord/connect/callback", () => {
  it("a valid, freshly-issued state token + guild_id connects the guild and redirects with discordConnected=1", async () => {
    const guildId = randomId("guild");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: guildId, name: "Trading Community" })));
    const state = await issueDiscordConnectState(STATE_SECRET);

    const { statusCode, redirectedTo } = await callCallback({ state, guild_id: guildId });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnected=1");

    const guild = await getDiscordGuildByGuildId(pool, guildId);
    expect(guild?.status).toBe("CONNECTED");
    expect(guild?.guildName).toBe("Trading Community");
  });

  it("rejects a state token that was never issued by /connect/start (garbage), never calling the Discord API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { statusCode, redirectedTo } = await callCallback({ state: "not-a-real-token", guild_id: randomId("guild") });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=invalid_state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a state token signed with a different secret than this deployment's (a forged/stolen callback attempt)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const foreignState = await issueDiscordConnectState("some-other-secret-an-attacker-controls");
    const { statusCode, redirectedTo } = await callCallback({ state: foreignState, guild_id: randomId("guild") });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=invalid_state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an expired state token", async () => {
    const state = await issueDiscordConnectState(STATE_SECRET, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const { statusCode, redirectedTo } = await callCallback({ state, guild_id: randomId("guild") });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=invalid_state");
  });

  it("rejects a callback with a valid state but no guild_id (the user cancelled/denied Discord's install prompt)", async () => {
    const state = await issueDiscordConnectState(STATE_SECRET);
    const { statusCode, redirectedTo } = await callCallback({ state });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=missing_guild");
  });

  it("a guild lookup failure after a valid state still fails cleanly with a sanitized redirect, never leaking the bot token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "internal error" })));
    const state = await issueDiscordConnectState(STATE_SECRET);
    const { statusCode, redirectedTo } = await callCallback({ state, guild_id: randomId("guild") });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=guild_lookup_failed");
    expect(redirectedTo).not.toContain(BOT_TOKEN);
  });

  it("reconnecting an already-known (previously disconnected) guild reactivates it rather than erroring", async () => {
    const guildId = randomId("guild");
    await upsertDiscordGuild(pool, guildId, "Old Name");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: guildId, name: "Renamed Community" })));
    const state = await issueDiscordConnectState(STATE_SECRET);

    const { redirectedTo } = await callCallback({ state, guild_id: guildId });
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnected=1");
    const guild = await getDiscordGuildByGuildId(pool, guildId);
    expect(guild?.status).toBe("CONNECTED");
    expect(guild?.guildName).toBe("Renamed Community");
  });
});

describe("GET /api/discord/guilds", () => {
  it("lists only CONNECTED guilds, never guilds the bot isn't currently in", async () => {
    const connected = await upsertDiscordGuild(pool, randomId("guild"), "Connected Guild");
    const disconnectHandler = createDisconnectDiscordGuildHandler(deps());
    const other = await upsertDiscordGuild(pool, randomId("guild"), "Will Disconnect");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {})));
    const { res } = makeResponse();
    await disconnectHandler({ params: { guildId: String(other.id) } } as unknown as Request, res);

    const { statusCode, body } = await callListGuilds();
    expect(statusCode).toBe(200);
    const guilds = body.guilds as Array<Record<string, unknown>>;
    expect(guilds.map((g) => g.guildId)).toContain(connected.guildId);
    expect(guilds.map((g) => g.guildId)).not.toContain(other.guildId);
  });
});

describe("POST /api/discord/guilds/:guildId/disconnect", () => {
  it("marks the guild disconnected, best-effort leaves it via the Discord API, and preserves already-imported collections/items", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    const project = await makeProject();
    const { collection } = await createSourceCollection(pool, {
      projectId: project.id,
      provider: "DISCORD",
      externalId: randomId("chan"),
      title: "#trade-reviews",
      sourceUrl: "https://discord.com/channels/g/c",
    });
    await pool.query(`UPDATE source_collections SET discord_guild_id = $1 WHERE id = $2`, [guild.id, collection.id]);

    const leaveFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`https://discord.com/api/v10/users/@me/guilds/${guild.guildId}`);
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", leaveFetch);

    const { statusCode } = await callDisconnect(String(guild.id));
    expect(statusCode).toBe(200);
    expect(leaveFetch).toHaveBeenCalledTimes(1);

    const reloaded = await getDiscordGuildByGuildId(pool, guild.guildId);
    expect(reloaded?.status).toBe("DISCONNECTED");

    const stillThere = await pool.query(`SELECT 1 FROM source_collections WHERE id = $1`, [collection.id]);
    expect(stillThere.rows).toHaveLength(1);
  });

  it("disconnect is best-effort against Discord — a leave-API failure never blocks marking the guild disconnected locally", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Flaky Guild");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const { statusCode } = await callDisconnect(String(guild.id));
    expect(statusCode).toBe(200);
    const reloaded = await getDiscordGuildByGuildId(pool, guild.guildId);
    expect(reloaded?.status).toBe("DISCONNECTED");
  });

  it("an unknown guild id 404s", async () => {
    const { statusCode } = await callDisconnect("999999999");
    expect(statusCode).toBe(404);
  });
});

describe("GET /api/discord/guilds/:guildId/channels", () => {
  it("lists text-capable channels only, with a per-channel readability probe, excluding voice/category types", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === `/api/v10/guilds/${guild.guildId}/channels`) {
        return jsonResponse(200, [
          { id: "1", name: "trade-reviews", type: 0, parent_id: null },
          { id: "2", name: "readonly-private", type: 0, parent_id: null },
          { id: "3", name: "General VC", type: 2, parent_id: null },
        ]);
      }
      if (parsed.pathname === "/api/v10/channels/1/messages") return jsonResponse(200, []);
      if (parsed.pathname === "/api/v10/channels/2/messages") return jsonResponse(403, { message: "Missing Access" });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { statusCode, body } = await callListChannels(String(guild.id));
    expect(statusCode).toBe(200);
    const channels = body.channels as Array<Record<string, unknown>>;
    expect(channels.map((c) => c.id)).toEqual(["1", "2"]); // voice channel (type 2) never presented as a supported/importable channel
    expect(channels.find((c) => c.id === "1")?.readable).toBe(true);
    expect(channels.find((c) => c.id === "2")?.readable).toBe(false);
  });

  it("an unconnected/unknown guild 404s", async () => {
    const { statusCode } = await callListChannels("999999999");
    expect(statusCode).toBe(404);
  });

  it("responds 501 when DISCORD_BOT_TOKEN isn't configured", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    const { statusCode } = await callListChannels(String(guild.id), deps({ discordBotToken: undefined }));
    expect(statusCode).toBe(501);
  });
});
