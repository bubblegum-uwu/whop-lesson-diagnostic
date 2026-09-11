import type { Request, Response } from "express";
import type { Pool } from "pg";
import { issueDiscordConnectState, verifyDiscordConnectState } from "../../lib/discordOAuthState.js";
import { upsertDiscordGuild, listDiscordGuilds, getDiscordGuildById, markDiscordGuildDisconnected, type DiscordGuildRow } from "../../db/discordGuildsRepo.js";
import { getGuild, listGuildChannels, probeChannelReadable, leaveGuild, DiscordApiError, type DiscordChannelSummary } from "../../discord/discordApiClient.js";
import { logger } from "../../lib/logger.js";

export interface DiscordConnectionsRouteDeps {
  pool: Pool;
  /** Public — embedded in the authorize URL the frontend redirects to. */
  discordClientId?: string;
  /** Secret — never sent to the frontend, never logged. */
  discordBotToken?: string;
  /** Used to build the fixed, non-client-suppliable redirect_uri (spec section 43/44) — this service's own public URL. */
  publicApiBaseUrl?: string;
  /** Where the callback sends the browser back to after connecting — the deployed frontend's origin. */
  allowedOrigin: string;
  /** Reused to sign/verify the short-lived connect-state token — see lib/discordOAuthState.ts's doc comment on why this specific secret is reused rather than a new one added. */
  stateSecret: string;
}

const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
// VIEW_CHANNEL (0x400) + READ_MESSAGE_HISTORY (0x10000) — the narrowest
// permission set that can identify a guild's channels and read their
// message history for attachment discovery (spec section 5/7). No message
// send/delete, no role/guild management — never requested since this
// integration never needs them.
const BOT_PERMISSIONS_BITFIELD = (0x400 | 0x10000).toString(); // 66560 = VIEW_CHANNEL | READ_MESSAGE_HISTORY

const NOT_CONFIGURED = {
  error: { message: "Discord authenticated collections require DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN to be configured on this deployment.", type: "discord_api_not_configured" },
} as const;

function callbackUrl(deps: DiscordConnectionsRouteDeps): string {
  return `${deps.publicApiBaseUrl}/api/discord/connect/callback`;
}

/**
 * POST /api/discord/connect/start — Knovera-authed. Issues a short-lived
 * signed state token (spec section 42/43) and returns the Discord
 * bot-install authorize URL for the frontend to navigate to. `redirect_uri`
 * is built server-side from config, never accepted from the client (spec
 * section 43 — "do not trust arbitrary parameters").
 */
export function createStartDiscordConnectHandler(deps: DiscordConnectionsRouteDeps) {
  return async function startDiscordConnectHandler(_req: Request, res: Response): Promise<void> {
    if (!deps.discordClientId || !deps.discordBotToken || !deps.publicApiBaseUrl) {
      res.status(501).json(NOT_CONFIGURED);
      return;
    }
    const state = await issueDiscordConnectState(deps.stateSecret);
    const url = new URL(DISCORD_AUTHORIZE_URL);
    url.searchParams.set("client_id", deps.discordClientId);
    url.searchParams.set("scope", "bot");
    url.searchParams.set("permissions", BOT_PERMISSIONS_BITFIELD);
    url.searchParams.set("redirect_uri", callbackUrl(deps));
    url.searchParams.set("state", state);
    res.status(200).json({ authorizeUrl: url.toString() });
  };
}

/**
 * GET /api/discord/connect/callback — PUBLIC (Discord redirects the
 * user's browser here directly; no Knovera Authorization header is
 * possible on a plain navigation). The signed `state` token IS the
 * authorization for this request (spec section 44: "confirm the
 * connection belongs to the authenticated initiating context") — it can
 * only have been issued by createStartDiscordConnectHandler above, which
 * itself requires an authenticated Knovera session, and expires after
 * DISCORD_STATE_TTL_SECONDS.
 */
export function createDiscordConnectCallbackHandler(deps: DiscordConnectionsRouteDeps) {
  return async function discordConnectCallbackHandler(req: Request, res: Response): Promise<void> {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const guildId = typeof req.query.guild_id === "string" ? req.query.guild_id : "";

    const stateValid = state.length > 0 && (await verifyDiscordConnectState(state, deps.stateSecret));
    if (!stateValid) {
      res.redirect(302, `${deps.allowedOrigin}/#/?discordConnectError=invalid_state`);
      return;
    }
    if (!guildId || !deps.discordBotToken) {
      res.redirect(302, `${deps.allowedOrigin}/#/?discordConnectError=missing_guild`);
      return;
    }

    try {
      const guild = await getGuild(guildId, deps.discordBotToken);
      await upsertDiscordGuild(deps.pool, guild.id, guild.name);
    } catch (err) {
      logger.error("Discord guild connect failed after OAuth callback", { message: err instanceof Error ? err.message : String(err) });
      res.redirect(302, `${deps.allowedOrigin}/#/?discordConnectError=guild_lookup_failed`);
      return;
    }

    res.redirect(302, `${deps.allowedOrigin}/#/?discordConnected=1`);
  };
}

/** GET /api/discord/guilds — every guild the bot is currently connected to (deployment-wide — see discord_guilds's doc comment; never project-scoped). */
export function createListDiscordGuildsHandler(deps: DiscordConnectionsRouteDeps) {
  return async function listDiscordGuildsHandler(_req: Request, res: Response): Promise<void> {
    const guilds = await listDiscordGuilds(deps.pool);
    res.status(200).json({ guilds: guilds.filter((g) => g.status === "CONNECTED").map(toGuildSummary) });
  };
}

function toGuildSummary(g: DiscordGuildRow) {
  return { id: g.id, guildId: g.guildId, guildName: g.guildName, status: g.status, connectedAt: g.connectedAt };
}

/** POST /api/discord/guilds/:guildId/disconnect — marks the guild disconnected and best-effort leaves it via the Discord API; existing imported channels/items/analyses are never touched (spec section 26). `:guildId` here is our internal numeric id, not Discord's snowflake — matches every other :id-style route param in this codebase. */
export function createDisconnectDiscordGuildHandler(deps: DiscordConnectionsRouteDeps) {
  return async function disconnectDiscordGuildHandler(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.guildId);
    if (!Number.isInteger(id)) {
      res.status(404).json({ error: { message: "Unknown Discord guild.", type: "guild_not_found" } });
      return;
    }
    const guild = await getDiscordGuildById(deps.pool, id);
    if (!guild) {
      res.status(404).json({ error: { message: "Unknown Discord guild.", type: "guild_not_found" } });
      return;
    }
    await markDiscordGuildDisconnected(deps.pool, id);
    if (deps.discordBotToken) await leaveGuild(guild.guildId, deps.discordBotToken);
    res.status(200).json({ ok: true });
  };
}

/** GET /api/discord/guilds/:guildId/channels — live Discord API call listing the guild's channels, with a bounded readability probe per text-capable channel (spec section 12). */
export function createListDiscordGuildChannelsHandler(deps: DiscordConnectionsRouteDeps) {
  return async function listDiscordGuildChannelsHandler(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.guildId);
    if (!Number.isInteger(id)) {
      res.status(404).json({ error: { message: "Unknown Discord guild.", type: "guild_not_found" } });
      return;
    }
    const guild = await getDiscordGuildById(deps.pool, id);
    if (!guild || guild.status !== "CONNECTED") {
      res.status(404).json({ error: { message: "Unknown Discord guild.", type: "guild_not_found" } });
      return;
    }
    if (!deps.discordBotToken) {
      res.status(501).json(NOT_CONFIGURED);
      return;
    }

    let channels: DiscordChannelSummary[];
    try {
      channels = await listGuildChannels(guild.guildId, deps.discordBotToken);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof DiscordApiError ? err.message : "Could not list this guild's channels.", type: "discord_channels_failed" } });
      return;
    }

    const items = await Promise.all(
      channels
        .filter((c) => c.textCapable)
        .map(async (c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          parentId: c.parentId,
          readable: await probeChannelReadable(c.id, deps.discordBotToken!).catch(() => false),
        })),
    );

    res.status(200).json({ guildId: guild.guildId, guildName: guild.guildName, channels: items });
  };
}
