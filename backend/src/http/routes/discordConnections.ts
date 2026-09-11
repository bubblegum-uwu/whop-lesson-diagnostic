import type { Request, Response } from "express";
import type { Pool } from "pg";
import type { KnoveraAuthedRequest } from "../middleware/knoveraAuth.js";
import { issueDiscordConnectState, verifyDiscordConnectState } from "../../lib/discordOAuthState.js";
import { markDiscordOAuthStateUsed } from "../../db/discordOAuthStateUsesRepo.js";
import { upsertDiscordGuild, listDiscordGuilds, getDiscordGuildById, markDiscordGuildDisconnected, type DiscordGuildRow } from "../../db/discordGuildsRepo.js";
import {
  authorizeDiscordGuildForIdentity,
  isDiscordGuildAuthorizedForIdentity,
  listAuthorizedDiscordGuildIds,
  countDiscordGuildAuthorizations,
  revokeDiscordGuildAuthorization,
} from "../../db/discordGuildAuthorizationsRepo.js";
import {
  getGuild,
  listGuildChannels,
  probeChannelReadable,
  leaveGuild,
  ensureMessageContentIntentEnabled,
  DiscordApiError,
  DiscordMessageContentNotEnabledError,
  type DiscordChannelSummary,
} from "../../discord/discordApiClient.js";
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
// CHANNEL permission set that can identify a guild's channels and read
// their message history. NOTE: these permissions alone are NOT sufficient
// for attachment discovery — see backend/README.md's "Discord Message
// Content Intent" section. The permissions bitfield below cannot request
// or grant that intent; it is a separate, application-level Developer
// Portal setting (ensureMessageContentIntentEnabled below is what actually
// verifies it's live).
const BOT_PERMISSIONS_BITFIELD = (0x400 | 0x10000).toString(); // 66560 = VIEW_CHANNEL | READ_MESSAGE_HISTORY

const NOT_CONFIGURED = {
  error: { message: "Discord authenticated collections require DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN to be configured on this deployment.", type: "discord_api_not_configured" },
} as const;
const NOT_FOUND_GUILD = { error: { message: "Unknown Discord guild.", type: "guild_not_found" } } as const;

function messageContentNotEnabledBody(err: unknown) {
  return {
    error: {
      message: err instanceof DiscordMessageContentNotEnabledError ? err.message : "Discord Message Content access could not be verified.",
      type: "discord_message_content_not_enabled",
    },
  };
}

function identityOf(req: Request): string {
  // Always present — every route this file registers sits behind
  // knoveraAuth (http/app.ts) except the public callback below, which
  // never calls this and derives identity from the signed state instead.
  return (req as KnoveraAuthedRequest).knoveraOperator!;
}

function callbackUrl(deps: DiscordConnectionsRouteDeps): string {
  return `${deps.publicApiBaseUrl}/api/discord/connect/callback`;
}

/**
 * POST /api/discord/connect/start — Knovera-authed. Issues a short-lived
 * signed state token bound to the CALLING identity (spec section 42/43;
 * review fix: the callback below uses this binding to grant
 * discord_guild_authorizations to the right identity, never an implicit
 * global grant) and returns the Discord bot-install authorize URL for the
 * frontend to navigate to. `redirect_uri` is built server-side from
 * config, never accepted from the client (spec section 43 — "do not trust
 * arbitrary parameters"). Also verifies Message Content access up front —
 * failing fast here (before the user goes through Discord's own consent
 * screen) is strictly better than only discovering it later as an empty
 * catalog.
 */
export function createStartDiscordConnectHandler(deps: DiscordConnectionsRouteDeps) {
  return async function startDiscordConnectHandler(req: Request, res: Response): Promise<void> {
    if (!deps.discordClientId || !deps.discordBotToken || !deps.publicApiBaseUrl) {
      res.status(501).json(NOT_CONFIGURED);
      return;
    }
    try {
      await ensureMessageContentIntentEnabled(deps.discordBotToken);
    } catch (err) {
      res.status(503).json(messageContentNotEnabledBody(err));
      return;
    }

    const state = await issueDiscordConnectState(deps.stateSecret, identityOf(req));
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
 * itself requires an authenticated Knovera session, expires after
 * DISCORD_STATE_TTL_SECONDS, and (review fix) can only ever be used ONCE
 * (db/discordOAuthStateUsesRepo.ts) — a replayed callback URL is rejected
 * exactly like an invalid state, never re-run.
 *
 * Review fix: this is also the ONE place a discord_guild_authorizations
 * grant is ever created, bound to the state's embedded identity — never
 * to "whichever guild_id the query string happens to name" alone. This is
 * what turns "the bot is installed in guild G" into "identity I is
 * authorized to use guild G."
 */
export function createDiscordConnectCallbackHandler(deps: DiscordConnectionsRouteDeps) {
  return async function discordConnectCallbackHandler(req: Request, res: Response): Promise<void> {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const guildId = typeof req.query.guild_id === "string" ? req.query.guild_id : "";

    const statePayload = state.length > 0 ? await verifyDiscordConnectState(state, deps.stateSecret) : null;
    if (!statePayload) {
      res.redirect(302, `${deps.allowedOrigin}/#/?discordConnectError=invalid_state`);
      return;
    }
    // Single-use: the FIRST caller to present this exact state wins: every
    // subsequent presentation (a replayed URL, a double-click, a retried
    // request) is indistinguishable from an invalid state from here on.
    const firstUse = await markDiscordOAuthStateUsed(deps.pool, statePayload.jti);
    if (!firstUse) {
      res.redirect(302, `${deps.allowedOrigin}/#/?discordConnectError=invalid_state`);
      return;
    }
    if (!guildId || !deps.discordBotToken) {
      res.redirect(302, `${deps.allowedOrigin}/#/?discordConnectError=missing_guild`);
      return;
    }

    try {
      const guild = await getGuild(guildId, deps.discordBotToken);
      const guildRow = await upsertDiscordGuild(deps.pool, guild.id, guild.name);
      await authorizeDiscordGuildForIdentity(deps.pool, guildRow.id, statePayload.identity);
    } catch (err) {
      logger.error("Discord guild connect failed after OAuth callback", { message: err instanceof Error ? err.message : String(err) });
      res.redirect(302, `${deps.allowedOrigin}/#/?discordConnectError=guild_lookup_failed`);
      return;
    }

    res.redirect(302, `${deps.allowedOrigin}/#/?discordConnected=1`);
  };
}

/**
 * GET /api/discord/guilds — review fix: only guilds the REQUESTING
 * identity is explicitly authorized for (discord_guild_authorizations),
 * never every guild the deployment's shared bot happens to be installed
 * in. A guild the bot is in but this identity was never granted is
 * indistinguishable from a guild the bot was never added to at all, from
 * this identity's point of view.
 */
export function createListDiscordGuildsHandler(deps: DiscordConnectionsRouteDeps) {
  return async function listDiscordGuildsHandler(req: Request, res: Response): Promise<void> {
    const identity = identityOf(req);
    const [guilds, authorizedIds] = await Promise.all([listDiscordGuilds(deps.pool), listAuthorizedDiscordGuildIds(deps.pool, identity)]);
    const authorized = new Set(authorizedIds);
    res.status(200).json({ guilds: guilds.filter((g) => g.status === "CONNECTED" && authorized.has(g.id)).map(toGuildSummary) });
  };
}

function toGuildSummary(g: DiscordGuildRow) {
  return { id: g.id, guildId: g.guildId, guildName: g.guildName, status: g.status, connectedAt: g.connectedAt };
}

/**
 * POST /api/discord/guilds/:guildId/disconnect — review fix: only an
 * identity actually authorized for this guild may disconnect it (a 404,
 * not a 403, for anyone else — never confirms the guild exists to an
 * unauthorized identity). Revokes ONLY the calling identity's own grant;
 * a guild shared with other authorized identities (spec: "explicitly
 * supported sharing model") stays CONNECTED and usable by them. The
 * underlying bot installation is marked DISCONNECTED and best-effort
 * leaves the guild via the Discord API only once NO identity remains
 * authorized for it — existing imported channels/items/analyses are
 * never touched either way (spec section 26). `:guildId` here is our
 * internal numeric id, not Discord's snowflake — matches every other
 * :id-style route param in this codebase.
 */
export function createDisconnectDiscordGuildHandler(deps: DiscordConnectionsRouteDeps) {
  return async function disconnectDiscordGuildHandler(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.guildId);
    if (!Number.isInteger(id)) {
      res.status(404).json(NOT_FOUND_GUILD);
      return;
    }
    const identity = identityOf(req);
    const [guild, authorized] = await Promise.all([getDiscordGuildById(deps.pool, id), isDiscordGuildAuthorizedForIdentity(deps.pool, id, identity)]);
    if (!guild || !authorized) {
      res.status(404).json(NOT_FOUND_GUILD);
      return;
    }

    await revokeDiscordGuildAuthorization(deps.pool, id, identity);
    const remaining = await countDiscordGuildAuthorizations(deps.pool, id);
    if (remaining === 0) {
      await markDiscordGuildDisconnected(deps.pool, id);
      if (deps.discordBotToken) await leaveGuild(guild.guildId, deps.discordBotToken);
    }
    res.status(200).json({ ok: true });
  };
}

/**
 * GET /api/discord/guilds/:guildId/channels — review fix: 404s for any
 * identity not authorized for this guild (same "never confirm existence"
 * rule as disconnect above), before ever calling the Discord API. Live
 * Discord API call listing the guild's channels, with a bounded
 * readability probe per text-capable channel (spec section 12).
 */
export function createListDiscordGuildChannelsHandler(deps: DiscordConnectionsRouteDeps) {
  return async function listDiscordGuildChannelsHandler(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.guildId);
    if (!Number.isInteger(id)) {
      res.status(404).json(NOT_FOUND_GUILD);
      return;
    }
    const identity = identityOf(req);
    const [guild, authorized] = await Promise.all([getDiscordGuildById(deps.pool, id), isDiscordGuildAuthorizedForIdentity(deps.pool, id, identity)]);
    if (!guild || guild.status !== "CONNECTED" || !authorized) {
      res.status(404).json(NOT_FOUND_GUILD);
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
