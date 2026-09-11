import type { Pool } from "pg";
import { createDiscordSource, deleteProjectSource } from "../db/projectSourcesRepo.js";
import { saveProjectSourceMedia } from "../db/projectSourceMediaRepo.js";
import { listChannelMessagesPage } from "./discordApiClient.js";
import { downloadDiscordAttachment as defaultDownloadDiscordAttachment, DiscordAttachmentDownloadError, type DownloadedDiscordAttachment } from "./downloadDiscordAttachment.js";
import { parseDiscordVideoUrl, DiscordUrlParseError } from "../lib/discordUrl.js";

/**
 * Phase 4K-B — channel content discovery + import, the Discord analogue of
 * youtube/discoverYoutubeChannelVideos.ts's discoverAndImportYouTubeChannelPages
 * (sourceCollections.ts). Same shape deliberately: page through the
 * channel's message history (Discord's own `before`-message-id
 * pagination, newest-to-oldest), up to `maxPages` per call, importing
 * every SUPPORTED video attachment found — never every attachment type
 * (spec section 15/38: an image/PDF/audio/embed attachment is silently
 * omitted from the catalog, never turned into a malformed "video" source)
 * — and persisting a continuation cursor when the channel's history is
 * bigger than one call can cover (spec section 19/22).
 *
 * Durable capture happens INLINE, per newly-discovered attachment, while
 * its signed CDN URL is still fresh (spec section 17/18): this is
 * deliberately different from YouTube's discovery (which never touches
 * video bytes) because a Discord attachment's URL expires and can never be
 * reconstructed later — the exact same reasoning that already governs the
 * pre-existing à-la-carte single/batch Discord handlers
 * (http/routes/projectSources.ts), reused verbatim here via the same
 * downloadDiscordAttachment + saveProjectSourceMedia + compensating-delete
 * sequence. An attachment ALREADY known (à-la-carte or a previous
 * discovery pass) is adopted (collection_id/title backfilled — never
 * re-downloaded, since its media is already captured — spec section
 * 35/36).
 */
export const DISCORD_DISCOVERY_MAX_PAGES_PER_CALL = 20;

export interface DiscoverAndImportDiscordResult {
  /** Supported (video) attachments seen across every page scanned this call — never counts skipped unsupported attachment types. */
  discoveredCount: number;
  /** Genuinely new project_sources rows, successfully durably captured. */
  importedCount: number;
  /** Already-existing project_sources rows (à-la-carte or previously discovered) — adopted into this collection, never re-downloaded. */
  adoptedCount: number;
  /** New attachments whose durable capture failed — the row is rolled back (compensating delete), never left in a half-imported state. */
  failedCount: number;
  /** Opaque `before` cursor to persist on the collection — null when this pass reached the actual start of the channel's history, or (when earlyStopOnFullyKnownPage) caught up to already-known attachments. */
  nextBeforeMessageId: string | null;
}

export interface DiscoverAndImportDiscordOptions {
  startBeforeMessageId?: string | null;
  /** Same semantics as YouTube's identical option — see discoverAndImportYouTubeChannelPages's doc comment. Never used for a channel's first-ever import pass. */
  earlyStopOnFullyKnownPage: boolean;
  maxPages?: number;
  /** Test-only override, same convention as http/routes/projectSources.ts's ProjectSourcesRouteDeps.downloadDiscordAttachment. */
  downloadDiscordAttachment?: (sourceUrl: string) => Promise<DownloadedDiscordAttachment>;
}

export async function discoverAndImportDiscordChannelPages(
  pool: Pool,
  projectId: number,
  collectionId: number,
  channelId: string,
  botToken: string,
  options: DiscoverAndImportDiscordOptions,
): Promise<DiscoverAndImportDiscordResult> {
  const maxPages = options.maxPages ?? DISCORD_DISCOVERY_MAX_PAGES_PER_CALL;
  const downloadFn = options.downloadDiscordAttachment ?? defaultDownloadDiscordAttachment;
  let before = options.startBeforeMessageId ?? undefined;
  let discoveredCount = 0;
  let importedCount = 0;
  let adoptedCount = 0;
  let failedCount = 0;
  let nextBeforeMessageId: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const result = await listChannelMessagesPage(channelId, botToken, before ?? undefined);
    let pageNewCount = 0;

    for (const { attachment } of result.attachments) {
      let parsed;
      try {
        parsed = parseDiscordVideoUrl(attachment.url);
      } catch (err) {
        if (err instanceof DiscordUrlParseError) continue; // unsupported attachment type — silently omitted from the catalog, never a malformed source (spec section 15/38)
        throw err;
      }
      discoveredCount++;

      const { source, created } = await createDiscordSource(pool, {
        projectId,
        externalId: parsed.externalId,
        sourceUrl: parsed.sourceUrl,
        collectionId,
        title: attachment.filename,
      });

      if (!created) {
        adoptedCount++;
        continue;
      }
      pageNewCount++;
      try {
        const media = await downloadFn(parsed.sourceUrl);
        await saveProjectSourceMedia(pool, { projectSourceId: source.id, content: media.content, contentType: media.contentType, byteSize: media.byteSize });
        importedCount++;
      } catch (err) {
        if (!(err instanceof DiscordAttachmentDownloadError)) throw err;
        await deleteProjectSource(pool, source.id);
        failedCount++;
      }
    }

    if (options.earlyStopOnFullyKnownPage && result.attachments.length > 0 && pageNewCount === 0) {
      nextBeforeMessageId = null;
      break;
    }
    if (!result.oldestMessageId) {
      nextBeforeMessageId = null;
      break;
    }
    before = result.oldestMessageId;
    nextBeforeMessageId = result.oldestMessageId;
  }

  return { discoveredCount, importedCount, adoptedCount, failedCount, nextBeforeMessageId };
}
