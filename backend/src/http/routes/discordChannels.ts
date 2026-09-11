import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getDiscordGuildById, type DiscordGuildRow } from "../../db/discordGuildsRepo.js";
import {
  createSourceCollection,
  markCollectionSynced,
  markCollectionSyncFailed,
  type SourceCollectionRow,
} from "../../db/sourceCollectionsRepo.js";
import { listGuildChannels, DiscordApiError } from "../../discord/discordApiClient.js";
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

    const guild = await getDiscordGuildById(deps.pool, internalGuildId);
    if (!guild || guild.status !== "CONNECTED") {
      res.status(404).json({ error: { message: "Unknown or disconnected Discord guild.", type: "guild_not_found" } });
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
 */
export type RefreshDiscordCollectionOutcome =
  | { ok: true; result: DiscoverAndImportDiscordResult }
  | { ok: false; status: number; body: { error: { message: string; type: string } } };

export async function refreshDiscordCollection(
  pool: Pool,
  project: { id: number },
  collection: SourceCollectionRow,
  deps: DiscordChannelsRouteDeps,
): Promise<RefreshDiscordCollectionOutcome> {
  if (!deps.discordBotToken) {
    return { ok: false, status: 501, body: NOT_CONFIGURED };
  }
  const botToken = deps.discordBotToken;

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
