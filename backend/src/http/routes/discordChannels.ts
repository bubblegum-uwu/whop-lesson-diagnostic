import type { Request, Response } from "express";
import type { Pool } from "pg";
import type { KnoveraAuthedRequest } from "../middleware/knoveraAuth.js";
import { getProjectById } from "../../db/projectsRepo.js";
import { getDiscordGuildById, type DiscordGuildRow } from "../../db/discordGuildsRepo.js";
import { isDiscordGuildAuthorizedForIdentity } from "../../db/discordGuildAuthorizationsRepo.js";
import {
  createSourceCollection,
  markCollectionSynced,
  markCollectionSyncFailed,
  type SourceCollectionRow,
} from "../../db/sourceCollectionsRepo.js";
import { listGuildChannels, ensureMessageContentIntentEnabled, DiscordApiError, DiscordMessageContentNotEnabledError } from "../../discord/discordApiClient.js";
import { discoverAndImportDiscordChannelPages, type DiscoverAndImportDiscordResult } from "../../discord/discordChannelDiscovery.js";
import type { DownloadedDiscordAttachment } from "../../discord/downloadDiscordAttachment.js";

export interface DiscordChannelsRouteDeps {
  pool: Pool;
  discordBotToken?: string;
  /** Test-only override, threaded through to discoverAndImportDiscordChannelPages. */
  discordDiscoveryMaxPagesPerCall?: number;
  /** Test-only override — see discoverAndImportDiscordChannelPages's identical option. */
  downloadDiscordAttachment?: (sourceUrl: string) => Promise<DownloadedDiscordAttachment>;
}

const NOT_CONFIGURED = {
  error: { message: "Discord authenticated collections require DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN to be configured on this deployment.", type: "discord_api_not_configured" },
} as const;
const NOT_FOUND_PROJECT = { error: { message: "Unknown project.", type: "project_not_found" } } as const;
const NOT_FOUND_GUILD = { error: { message: "Unknown or disconnected Discord guild.", type: "guild_not_found" } } as const;

function messageContentNotEnabledBody(err: unknown) {
  return {
    error: {
      message: err instanceof DiscordMessageContentNotEnabledError ? err.message : "Discord Message Content access could not be verified.",
      type: "discord_message_content_not_enabled",
    },
  };
}

/** Every route in this file sits behind knoveraAuth (http/app.ts) — always present. */
function identityOf(req: Request): string {
  return (req as KnoveraAuthedRequest).knoveraOperator!;
}

interface ImportDiscordChannelsBody {
  guildId?: unknown; // our internal discord_guilds.id
  channelIds?: unknown; // Discord snowflake channel ids
}

export interface DiscordChannelImportResultEntry {
  channelId: string;
  kind: "imported" | "invalid";
  collection?: { id: number; title: string };
  discoveredCount?: number;
  importedCount?: number;
  adoptedCount?: number;
  failedCount?: number;
  hasMoreHistory?: boolean;
  message?: string;
}

/**
 * POST /api/projects/:projectId/collections/discord/import — Phase 4K-B.
 * The user explicitly picks which channels of a connected guild become
 * this project's catalog (spec section 13: never every channel
 * automatically). Each selected channel becomes (or reuses) one
 * source_collection — provider=DISCORD, external_id=channel id (spec
 * section 14) — then runs one bounded discovery+import pass exactly like
 * a YouTube channel's first Add Channel call. Per-channel partial success:
 * one bad channel id never fails the whole request.
 *
 * Review fix: this project may belong to ANY authenticated Knovera
 * identity (projects themselves are not identity-scoped — see the
 * project-model migration's own doc comment), so project ownership alone
 * can never be the guard here. The guild referenced by `guildId` is only
 * usable if the CALLING identity is explicitly authorized for it
 * (discord_guild_authorizations) — never "is this guild installed
 * anywhere in the deployment," which would let any identity import any
 * guild's channels into any project it can reach.
 */
export function createImportDiscordChannelsHandler(deps: DiscordChannelsRouteDeps) {
  return async function importDiscordChannelsHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json(NOT_FOUND_PROJECT);
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json(NOT_FOUND_PROJECT);
      return;
    }

    if (!deps.discordBotToken) {
      res.status(501).json(NOT_CONFIGURED);
      return;
    }
    const botToken = deps.discordBotToken;

    const body = req.body as ImportDiscordChannelsBody;
    const internalGuildId = Number(body?.guildId);
    if (!Number.isInteger(internalGuildId)) {
      res.status(400).json({ error: { message: "guildId is required.", type: "invalid_request" } });
      return;
    }
    if (!Array.isArray(body?.channelIds) || body.channelIds.length === 0 || !body.channelIds.every((c): c is string => typeof c === "string")) {
      res.status(400).json({ error: { message: "channelIds must be a non-empty array of strings.", type: "invalid_request" } });
      return;
    }
    const channelIds = body.channelIds;

    const identity = identityOf(req);
    const [guild, authorized] = await Promise.all([getDiscordGuildById(deps.pool, internalGuildId), isDiscordGuildAuthorizedForIdentity(deps.pool, internalGuildId, identity)]);
    if (!guild || guild.status !== "CONNECTED" || !authorized) {
      res.status(404).json(NOT_FOUND_GUILD);
      return;
    }

    try {
      await ensureMessageContentIntentEnabled(botToken);
    } catch (err) {
      res.status(503).json(messageContentNotEnabledBody(err));
      return;
    }

    let liveChannels;
    try {
      liveChannels = await listGuildChannels(guild.guildId, botToken);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof DiscordApiError ? err.message : "Could not list this guild's channels.", type: "discord_channels_failed" } });
      return;
    }
    const channelById = new Map(liveChannels.map((c) => [c.id, c]));

    const results: DiscordChannelImportResultEntry[] = [];
    for (const channelId of channelIds) {
      const liveChannel = channelById.get(channelId);
      if (!liveChannel || !liveChannel.textCapable) {
        results.push({ channelId, kind: "invalid", message: "This channel does not exist or is not a supported (text-capable) channel type." });
        continue;
      }

      const { collection } = await createSourceCollection(deps.pool, {
        projectId,
        provider: "DISCORD",
        externalId: channelId,
        title: `#${liveChannel.name}`,
        sourceUrl: `https://discord.com/channels/${guild.guildId}/${channelId}`,
      });
      await attachGuildToCollection(deps.pool, collection.id, guild.id);

      let result: DiscoverAndImportDiscordResult;
      try {
        result = await discoverAndImportDiscordChannelPages(deps.pool, projectId, collection.id, channelId, botToken, {
          earlyStopOnFullyKnownPage: false,
          maxPages: deps.discordDiscoveryMaxPagesPerCall,
          downloadDiscordAttachment: deps.downloadDiscordAttachment,
        });
      } catch (err) {
        const message = err instanceof DiscordApiError ? err.message : "Could not discover this channel's content.";
        await markCollectionSyncFailed(deps.pool, collection.id, message);
        results.push({ channelId, kind: "invalid", message });
        continue;
      }

      await markCollectionSynced(deps.pool, collection.id, `#${liveChannel.name}`, result.nextBeforeMessageId);
      results.push({
        channelId,
        kind: "imported",
        collection: { id: collection.id, title: `#${liveChannel.name}` },
        discoveredCount: result.discoveredCount,
        importedCount: result.importedCount,
        adoptedCount: result.adoptedCount,
        failedCount: result.failedCount,
        hasMoreHistory: result.nextBeforeMessageId !== null,
      });
    }

    res.status(201).json({ results });
  };
}

async function attachGuildToCollection(pool: Pool, collectionId: number, discordGuildRowId: number): Promise<void> {
  await pool.query(`UPDATE source_collections SET discord_guild_id = $1 WHERE id = $2 AND discord_guild_id IS NULL`, [discordGuildRowId, collectionId]);
}

/**
 * Called from http/routes/sourceCollections.ts's createRefreshSourceCollectionHandler
 * when the collection's provider is DISCORD — the one, clearly-scoped
 * dispatch point added to that already-approved file (spec section 60).
 * Same adaptive-cursor semantics as the YouTube refresh path it sits
 * alongside: continues from a pending discoveryCursor if one exists,
 * otherwise checks the front of the channel for new attachments with an
 * early stop as soon as a page is fully already-known.
 *
 * Review fix: resolveOwnedCollection (sourceCollections.ts) only proves
 * this collection belongs to the given PROJECT — projects are not
 * identity-scoped in this codebase, so that alone would let any
 * authenticated identity refresh any Discord collection in any project it
 * can reach. `knoveraIdentity` (the caller's req.knoveraOperator) must
 * also be explicitly authorized for the collection's OWN guild
 * (collection.discordGuildId) — a collection with no guild backlink at
 * all (legacy data, or a bug) fails closed rather than silently allowing.
 */
export type RefreshDiscordCollectionOutcome =
  | { ok: true; result: DiscoverAndImportDiscordResult }
  | { ok: false; status: number; body: { error: { message: string; type: string } } };

const GUILD_NOT_AUTHORIZED = { error: { message: "You are not authorized to use this Discord server.", type: "discord_guild_not_authorized" } } as const;

export async function refreshDiscordCollection(
  pool: Pool,
  project: { id: number },
  collection: SourceCollectionRow,
  knoveraIdentity: string,
  deps: DiscordChannelsRouteDeps,
): Promise<RefreshDiscordCollectionOutcome> {
  if (!deps.discordBotToken) {
    return { ok: false, status: 501, body: NOT_CONFIGURED };
  }
  const botToken = deps.discordBotToken;

  if (collection.discordGuildId === null || !(await isDiscordGuildAuthorizedForIdentity(pool, collection.discordGuildId, knoveraIdentity))) {
    return { ok: false, status: 404, body: GUILD_NOT_AUTHORIZED };
  }
  try {
    await ensureMessageContentIntentEnabled(botToken);
  } catch (err) {
    return { ok: false, status: 503, body: messageContentNotEnabledBody(err) };
  }

  const hadPendingHistory = collection.discoveryCursor !== null;
  let result: DiscoverAndImportDiscordResult;
  try {
    result = await discoverAndImportDiscordChannelPages(pool, project.id, collection.id, collection.externalId, botToken, {
      startBeforeMessageId: hadPendingHistory ? collection.discoveryCursor : undefined,
      earlyStopOnFullyKnownPage: !hadPendingHistory,
      maxPages: deps.discordDiscoveryMaxPagesPerCall,
      downloadDiscordAttachment: deps.downloadDiscordAttachment,
    });
  } catch (err) {
    const message = err instanceof DiscordApiError ? err.message : "Could not refresh this channel.";
    await markCollectionSyncFailed(pool, collection.id, message);
    return { ok: false, status: 502, body: { error: { message, type: "discord_discovery_failed" } } };
  }

  await markCollectionSynced(pool, collection.id, collection.title, result.nextBeforeMessageId);
  return { ok: true, result };
}

export type { DiscordGuildRow };
