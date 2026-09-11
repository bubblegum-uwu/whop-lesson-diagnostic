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
import { authorizeDiscordGuildForIdentity, isDiscordGuildAuthorizedForIdentity } from "../src/db/discordGuildAuthorizationsRepo.js";
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
// Every real Discord application has SOME flags value; the LIMITED bit
// (bit 19, for apps under the ~10,000-reachable-user verification
// threshold) is the realistic "just enabled it in the portal" case used
// as the default happy-path fixture throughout this file.
const MESSAGE_CONTENT_ENABLED_FLAGS = 1 << 19;
const IDENTITY_A = "identity-a";
const IDENTITY_B = "identity-b";

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

/**
 * Dispatches every Discord API call this file's handlers can make.
 * `applicationFlags` answers GET /oauth2/applications/@me (undefined = the
 * application has zero flags, i.e. Message Content NOT enabled);
 * `handlers` covers everything else, keyed by exact pathname.
 */
function stubDiscord(opts: { applicationFlags?: number; handlers?: Record<string, () => Response> } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/v10/oauth2/applications/@me") {
      return jsonResponse(200, { id: "app1", flags: opts.applicationFlags ?? 0 });
    }
    const handler = opts.handlers?.[parsed.pathname];
    if (handler) return handler();
    return jsonResponse(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function reqWithIdentity(identity: string, rest: Partial<Request> = {}): Request {
  return { knoveraOperator: identity, ...rest } as unknown as Request;
}

function callStart(identity: string, d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createStartDiscordConnectHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler(reqWithIdentity(identity), res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callCallback(query: Record<string, string>, d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createDiscordConnectCallbackHandler(d);
  const { res, statusCode, redirectedTo } = makeResponse();
  return handler({ query } as unknown as Request, res).then(() => ({ statusCode: statusCode(), redirectedTo: redirectedTo() }));
}

function callListGuilds(identity: string, d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createListDiscordGuildsHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler(reqWithIdentity(identity), res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callDisconnect(identity: string, guildId: string, d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createDisconnectDiscordGuildHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler(reqWithIdentity(identity, { params: { guildId } } as Partial<Request>), res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callListChannels(identity: string, guildId: string, d: DiscordConnectionsRouteDeps = deps()) {
  const handler = createListDiscordGuildChannelsHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler(reqWithIdentity(identity, { params: { guildId } } as Partial<Request>), res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

describe("POST /api/discord/connect/start", () => {
  it("issues a bot-install authorize URL with least-privilege permissions and a signed state bound to the calling identity, never a code-exchange param", async () => {
    stubDiscord({ applicationFlags: MESSAGE_CONTENT_ENABLED_FLAGS });
    const { statusCode, body } = await callStart(IDENTITY_A);
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
    stubDiscord({ applicationFlags: MESSAGE_CONTENT_ENABLED_FLAGS });
    const first = await callStart(IDENTITY_A);
    const second = await callStart(IDENTITY_A);
    expect(new URL(first.body.authorizeUrl as string).searchParams.get("state")).not.toBe(new URL(second.body.authorizeUrl as string).searchParams.get("state"));
  });

  it("responds 501 when DISCORD_CLIENT_ID/DISCORD_BOT_TOKEN aren't configured on this deployment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { statusCode, body } = await callStart(IDENTITY_A, deps({ discordClientId: undefined, discordBotToken: undefined }));
    expect(statusCode).toBe(501);
    expect((body.error as Record<string, unknown>).type).toBe("discord_api_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("responds 503 discord_message_content_not_enabled — and never issues a state/authorize URL — when the application lacks the Message Content intent", async () => {
    stubDiscord({ applicationFlags: 0 });
    const { statusCode, body } = await callStart(IDENTITY_A);
    expect(statusCode).toBe(503);
    expect((body.error as Record<string, unknown>).type).toBe("discord_message_content_not_enabled");
    expect(body.authorizeUrl).toBeUndefined();
  });

  it("either the verified (bit 18) or unverified/limited (bit 19) Message Content flag is sufficient", async () => {
    stubDiscord({ applicationFlags: 1 << 18 });
    expect((await callStart(IDENTITY_A)).statusCode).toBe(200);
  });
});

describe("GET /api/discord/connect/callback", () => {
  it("a valid, freshly-issued state token + guild_id connects the guild, authorizes the INITIATING identity, and redirects with discordConnected=1", async () => {
    const guildId = randomId("guild");
    stubDiscord({ handlers: { [`/api/v10/guilds/${guildId}`]: () => jsonResponse(200, { id: guildId, name: "Trading Community" }) } });
    const state = await issueDiscordConnectState(STATE_SECRET, IDENTITY_A);

    const { statusCode, redirectedTo } = await callCallback({ state, guild_id: guildId });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnected=1");

    const guild = await getDiscordGuildByGuildId(pool, guildId);
    expect(guild?.status).toBe("CONNECTED");
    expect(guild?.guildName).toBe("Trading Community");
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild!.id, IDENTITY_A)).toBe(true);
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild!.id, IDENTITY_B)).toBe(false);
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
    const foreignState = await issueDiscordConnectState("some-other-secret-an-attacker-controls", IDENTITY_A);
    const { statusCode, redirectedTo } = await callCallback({ state: foreignState, guild_id: randomId("guild") });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=invalid_state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an expired state token", async () => {
    const state = await issueDiscordConnectState(STATE_SECRET, IDENTITY_A, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const { statusCode, redirectedTo } = await callCallback({ state, guild_id: randomId("guild") });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=invalid_state");
  });

  it("rejects a callback with a valid state but no guild_id (the user cancelled/denied Discord's install prompt)", async () => {
    const state = await issueDiscordConnectState(STATE_SECRET, IDENTITY_A);
    const { statusCode, redirectedTo } = await callCallback({ state });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=missing_guild");
  });

  it("a guild lookup failure after a valid state still fails cleanly with a sanitized redirect, never leaking the bot token", async () => {
    stubDiscord({ handlers: { [`/api/v10/guilds/x`]: () => jsonResponse(500, { message: "internal error" }) } });
    const state = await issueDiscordConnectState(STATE_SECRET, IDENTITY_A);
    const { statusCode, redirectedTo } = await callCallback({ state, guild_id: "x" });
    expect(statusCode).toBe(302);
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=guild_lookup_failed");
    expect(redirectedTo).not.toContain(BOT_TOKEN);
  });

  it("reconnecting an already-known (previously disconnected) guild reactivates it and (re-)authorizes the connecting identity, rather than erroring", async () => {
    const guildId = randomId("guild");
    await upsertDiscordGuild(pool, guildId, "Old Name");
    stubDiscord({ handlers: { [`/api/v10/guilds/${guildId}`]: () => jsonResponse(200, { id: guildId, name: "Renamed Community" }) } });
    const state = await issueDiscordConnectState(STATE_SECRET, IDENTITY_A);

    const { redirectedTo } = await callCallback({ state, guild_id: guildId });
    expect(redirectedTo).toBe("https://app.knovera.test/#/?discordConnected=1");
    const guild = await getDiscordGuildByGuildId(pool, guildId);
    expect(guild?.status).toBe("CONNECTED");
    expect(guild?.guildName).toBe("Renamed Community");
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild!.id, IDENTITY_A)).toBe(true);
  });

  describe("single-use / replay", () => {
    it("a SECOND presentation of the exact same (already-used) state is rejected exactly like an invalid state, even though it hasn't expired", async () => {
      const guildId = randomId("guild");
      stubDiscord({ handlers: { [`/api/v10/guilds/${guildId}`]: () => jsonResponse(200, { id: guildId, name: "Trading Community" }) } });
      const state = await issueDiscordConnectState(STATE_SECRET, IDENTITY_A);

      const first = await callCallback({ state, guild_id: guildId });
      expect(first.redirectedTo).toBe("https://app.knovera.test/#/?discordConnected=1");

      const second = await callCallback({ state, guild_id: guildId });
      expect(second.redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=invalid_state");
    });

    it("a replay cannot bind a DIFFERENT guild_id to the originating identity — the replay is rejected before the guild is ever looked up", async () => {
      const guildId = randomId("guild");
      const otherGuildId = randomId("guild");
      const fetchMock = stubDiscord({
        handlers: {
          [`/api/v10/guilds/${guildId}`]: () => jsonResponse(200, { id: guildId, name: "Trading Community" }),
          [`/api/v10/guilds/${otherGuildId}`]: () => jsonResponse(200, { id: otherGuildId, name: "Someone Else's Community" }),
        },
      });
      const state = await issueDiscordConnectState(STATE_SECRET, IDENTITY_A);
      await callCallback({ state, guild_id: guildId }); // legitimate first use
      fetchMock.mockClear();

      const replay = await callCallback({ state, guild_id: otherGuildId });
      expect(replay.redirectedTo).toBe("https://app.knovera.test/#/?discordConnectError=invalid_state");
      expect(fetchMock).not.toHaveBeenCalled(); // never even reached getGuild for the substituted guild
      const otherGuild = await getDiscordGuildByGuildId(pool, otherGuildId);
      expect(otherGuild).toBeNull(); // never created
    });
  });
});

describe("GET /api/discord/guilds", () => {
  it("lists only guilds the CALLING identity is authorized for, never every guild the deployment bot is installed in", async () => {
    const guildForA = await upsertDiscordGuild(pool, randomId("guild"), "A's Server");
    await authorizeDiscordGuildForIdentity(pool, guildForA.id, IDENTITY_A);
    const guildForB = await upsertDiscordGuild(pool, randomId("guild"), "B's Server");
    await authorizeDiscordGuildForIdentity(pool, guildForB.id, IDENTITY_B);

    const { body: bodyA } = await callListGuilds(IDENTITY_A);
    const guildsA = bodyA.guilds as Array<Record<string, unknown>>;
    expect(guildsA.map((g) => g.guildId)).toContain(guildForA.guildId);
    expect(guildsA.map((g) => g.guildId)).not.toContain(guildForB.guildId);

    const { body: bodyB } = await callListGuilds(IDENTITY_B);
    const guildsB = bodyB.guilds as Array<Record<string, unknown>>;
    expect(guildsB.map((g) => g.guildId)).toContain(guildForB.guildId);
    expect(guildsB.map((g) => g.guildId)).not.toContain(guildForA.guildId);
  });

  it("a guild with zero authorized identities never appears for anyone", async () => {
    const orphan = await upsertDiscordGuild(pool, randomId("guild"), "Nobody's Server");
    const { body } = await callListGuilds(IDENTITY_A);
    expect((body.guilds as Array<Record<string, unknown>>).map((g) => g.guildId)).not.toContain(orphan.guildId);
  });

  it("lists only CONNECTED guilds, never guilds the bot isn't currently in", async () => {
    const connected = await upsertDiscordGuild(pool, randomId("guild"), "Connected Guild");
    await authorizeDiscordGuildForIdentity(pool, connected.id, IDENTITY_A);
    const other = await upsertDiscordGuild(pool, randomId("guild"), "Will Disconnect");
    await authorizeDiscordGuildForIdentity(pool, other.id, IDENTITY_A);
    stubDiscord({});
    await callDisconnect(IDENTITY_A, String(other.id));

    const { statusCode, body } = await callListGuilds(IDENTITY_A);
    expect(statusCode).toBe(200);
    const guilds = body.guilds as Array<Record<string, unknown>>;
    expect(guilds.map((g) => g.guildId)).toContain(connected.guildId);
    expect(guilds.map((g) => g.guildId)).not.toContain(other.guildId);
  });
});

describe("POST /api/discord/guilds/:guildId/disconnect", () => {
  it("marks the guild disconnected, best-effort leaves it via the Discord API, and preserves already-imported collections/items", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_A);
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

    const { statusCode } = await callDisconnect(IDENTITY_A, String(guild.id));
    expect(statusCode).toBe(200);
    expect(leaveFetch).toHaveBeenCalledTimes(1); // the only authorized identity revoked -> bot actually leaves

    const reloaded = await getDiscordGuildByGuildId(pool, guild.guildId);
    expect(reloaded?.status).toBe("DISCONNECTED");

    const stillThere = await pool.query(`SELECT 1 FROM source_collections WHERE id = $1`, [collection.id]);
    expect(stillThere.rows).toHaveLength(1);
  });

  it("a guild shared by two identities stays CONNECTED (and the bot stays installed) when only ONE of them disconnects", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Shared Server");
    await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_A);
    await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_B);
    const leaveFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", leaveFetch);

    const { statusCode } = await callDisconnect(IDENTITY_A, String(guild.id));
    expect(statusCode).toBe(200);
    expect(leaveFetch).not.toHaveBeenCalled(); // identity B is still authorized — the bot must not actually leave

    const reloaded = await getDiscordGuildByGuildId(pool, guild.guildId);
    expect(reloaded?.status).toBe("CONNECTED");
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, IDENTITY_A)).toBe(false);
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, IDENTITY_B)).toBe(true);

    // B's own view is unaffected — the guild is still theirs to use.
    const { body } = await callListGuilds(IDENTITY_B);
    expect((body.guilds as Array<Record<string, unknown>>).map((g) => g.guildId)).toContain(guild.guildId);
  });

  it("disconnect is best-effort against Discord — a leave-API failure never blocks marking the guild disconnected locally", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Flaky Guild");
    await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_A);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const { statusCode } = await callDisconnect(IDENTITY_A, String(guild.id));
    expect(statusCode).toBe(200);
    const reloaded = await getDiscordGuildByGuildId(pool, guild.guildId);
    expect(reloaded?.status).toBe("DISCONNECTED");
  });

  it("an unknown guild id 404s", async () => {
    const { statusCode } = await callDisconnect(IDENTITY_A, "999999999");
    expect(statusCode).toBe(404);
  });

  describe("cross-identity isolation", () => {
    it("an identity with NO authorization for a guild cannot disconnect/revoke it — 404, indistinguishable from a nonexistent guild, and the real owner's authorization is untouched", async () => {
      const guild = await upsertDiscordGuild(pool, randomId("guild"), "A's Server");
      await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_A);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { statusCode, body } = await callDisconnect(IDENTITY_B, String(guild.id));
      expect(statusCode).toBe(404);
      expect((body.error as Record<string, unknown>).type).toBe("guild_not_found");
      expect(fetchMock).not.toHaveBeenCalled(); // never even attempted to leave the guild on B's behalf

      expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, IDENTITY_A)).toBe(true); // A's grant is untouched
      const reloaded = await getDiscordGuildByGuildId(pool, guild.guildId);
      expect(reloaded?.status).toBe("CONNECTED");
    });
  });
});

describe("GET /api/discord/guilds/:guildId/channels", () => {
  it("lists text-capable channels only, with a per-channel readability probe, excluding voice/category types", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_A);
    stubDiscord({
      handlers: {
        [`/api/v10/guilds/${guild.guildId}/channels`]: () =>
          jsonResponse(200, [
            { id: "1", name: "trade-reviews", type: 0, parent_id: null },
            { id: "2", name: "readonly-private", type: 0, parent_id: null },
            { id: "3", name: "General VC", type: 2, parent_id: null },
          ]),
        "/api/v10/channels/1/messages": () => jsonResponse(200, []),
        "/api/v10/channels/2/messages": () => jsonResponse(403, { message: "Missing Access" }),
      },
    });

    const { statusCode, body } = await callListChannels(IDENTITY_A, String(guild.id));
    expect(statusCode).toBe(200);
    const channels = body.channels as Array<Record<string, unknown>>;
    expect(channels.map((c) => c.id)).toEqual(["1", "2"]); // voice channel (type 2) never presented as a supported/importable channel
    expect(channels.find((c) => c.id === "1")?.readable).toBe(true);
    expect(channels.find((c) => c.id === "2")?.readable).toBe(false);
  });

  it("an unconnected/unknown guild 404s", async () => {
    const { statusCode } = await callListChannels(IDENTITY_A, "999999999");
    expect(statusCode).toBe(404);
  });

  it("responds 501 when DISCORD_BOT_TOKEN isn't configured", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_A);
    const { statusCode } = await callListChannels(IDENTITY_A, String(guild.id), deps({ discordBotToken: undefined }));
    expect(statusCode).toBe(501);
  });

  describe("cross-identity isolation", () => {
    it("an identity with no authorization for the guild gets 404, never the live Discord channel list", async () => {
      const guild = await upsertDiscordGuild(pool, randomId("guild"), "A's Server");
      await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_A);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { statusCode, body } = await callListChannels(IDENTITY_B, String(guild.id));
      expect(statusCode).toBe(404);
      expect((body.error as Record<string, unknown>).type).toBe("guild_not_found");
      expect(fetchMock).not.toHaveBeenCalled(); // never reaches the Discord API on B's behalf
    });

    it("hand-crafting the request with A's guild id does not help B enumerate channels via any typed/guessed variation", async () => {
      const guild = await upsertDiscordGuild(pool, randomId("guild"), "A's Server");
      await authorizeDiscordGuildForIdentity(pool, guild.id, IDENTITY_A);
      vi.stubGlobal("fetch", vi.fn());

      for (const attempt of [String(guild.id), String(guild.id) + " ", `${guild.id}.0`]) {
        const { statusCode } = await callListChannels(IDENTITY_B, attempt);
        expect(statusCode).not.toBe(200);
      }
    });
  });
});
