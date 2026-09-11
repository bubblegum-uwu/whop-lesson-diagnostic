import { fetchYouTubeDataApi, YouTubeApiRequestError, YouTubeApiNotConfiguredError } from "./youtubeDataApiClient.js";

export { YouTubeApiNotConfiguredError };

export class YouTubeChannelDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeChannelDiscoveryError";
  }
}

export interface DiscoveredYouTubeVideo {
  videoId: string;
  title: string;
  /** ISO 8601 — null if the API omitted it (never fabricated). */
  publishedAt: string | null;
  sourceUrl: string;
}

/**
 * Phase 4K — channel video discovery, via the YouTube Data API v3
 * (`channels.list` + `playlistItems.list`), REPLACING the earlier RSS-feed
 * approach. Investigation order followed (per the product requirement):
 *   1. Existing configured YouTube Data API capability/key — none existed
 *      before this change (confirmed via package.json/config.ts).
 *   2. YouTube Data API playlist/channel uploads enumeration — THIS is
 *      what's implemented: every YouTube channel has a "uploads" playlist
 *      (`channels.list?part=contentDetails` → `contentDetails.relatedPlaylists.uploads`)
 *      that `playlistItems.list` paginates with a real `nextPageToken`
 *      cursor, covering the channel's FULL upload history, not just its
 *      most recent items.
 *   3/4. Not needed — the Data API is a stable, documented, officially
 *      supported mechanism, so no further fallback (and no rendered-page
 *      scraping) was considered.
 *
 * Requires YOUTUBE_API_KEY (see config.ts/README.md); throws
 * YouTubeApiNotConfiguredError if unset — callers must surface this as a
 * distinct "not configured" response, never silently degrade to the old
 * ~15-most-recent-uploads behavior.
 *
 * Discovery only: gathers metadata (id/title/publish date) to create/list
 * catalog items, never downloads or analyzes a video (Phase 4K spec
 * section 16) — same bounded-fetch shape as
 * resolveYoutubeChannel.ts / discord/downloadDiscordAttachment.ts, via
 * youtubeDataApiClient.ts.
 */
export const YOUTUBE_PLAYLIST_ITEMS_PAGE_SIZE = 50;

interface ChannelsContentDetailsResponse {
  items?: Array<{
    snippet?: { title?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }>;
}

export interface ChannelUploadsPlaylist {
  uploadsPlaylistId: string;
  channelTitle: string;
}

/** One Data API call: resolves a channel id to its "uploads" playlist id + current title. Called once per discovery/refresh pass (not once per page). */
export async function getChannelUploadsPlaylistId(channelId: string, apiKey: string | undefined): Promise<ChannelUploadsPlaylist> {
  if (!apiKey) throw new YouTubeApiNotConfiguredError();

  let data: ChannelsContentDetailsResponse;
  try {
    data = await fetchYouTubeDataApi<ChannelsContentDetailsResponse>("channels", { part: "contentDetails,snippet", id: channelId }, apiKey);
  } catch (err) {
    throw new YouTubeChannelDiscoveryError(err instanceof YouTubeApiRequestError ? err.message : "Could not look up this channel.");
  }

  const item = data.items?.[0];
  const uploadsPlaylistId = item?.contentDetails?.relatedPlaylists?.uploads;
  if (!item || !uploadsPlaylistId) {
    throw new YouTubeChannelDiscoveryError("No YouTube channel exists with this ID.");
  }
  return { uploadsPlaylistId, channelTitle: item.snippet?.title ?? "YouTube Channel" };
}

interface PlaylistItemsResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      publishedAt?: string;
      resourceId?: { videoId?: string };
    };
  }>;
  nextPageToken?: string;
}

export interface DiscoverChannelPageResult {
  videos: DiscoveredYouTubeVideo[];
  /** Opaque YouTube Data API pagination cursor for the NEXT page — null when this was the last page (the channel's full upload history has been walked back to this point). */
  nextPageToken: string | null;
}

/**
 * ONE page (up to 50 items) of a channel's uploads playlist, oldest-to-newest
 * ordering as YouTube returns it (newest first). Pass the `nextPageToken`
 * from a previous call to continue deeper into the channel's history —
 * this is what makes videos beyond the old RSS feed's ~15-item window
 * reachable (see sourceCollections.ts's discoverAndImportYouTubeChannelPages,
 * which drives this in a loop and persists the cursor for channels larger
 * than one discovery pass can cover).
 */
export async function discoverYoutubeChannelVideosPage(
  uploadsPlaylistId: string,
  apiKey: string | undefined,
  pageToken?: string,
): Promise<DiscoverChannelPageResult> {
  if (!apiKey) throw new YouTubeApiNotConfiguredError();

  let data: PlaylistItemsResponse;
  try {
    data = await fetchYouTubeDataApi<PlaylistItemsResponse>(
      "playlistItems",
      { part: "snippet", maxResults: String(YOUTUBE_PLAYLIST_ITEMS_PAGE_SIZE), playlistId: uploadsPlaylistId, ...(pageToken ? { pageToken } : {}) },
      apiKey,
    );
  } catch (err) {
    throw new YouTubeChannelDiscoveryError(err instanceof YouTubeApiRequestError ? err.message : "Could not discover this channel's videos.");
  }

  const videos: DiscoveredYouTubeVideo[] = [];
  for (const item of data.items ?? []) {
    const videoId = item.snippet?.resourceId?.videoId;
    const title = item.snippet?.title;
    if (!videoId || !title) continue;
    videos.push({
      videoId,
      title,
      publishedAt: item.snippet?.publishedAt ?? null,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  return { videos, nextPageToken: data.nextPageToken ?? null };
}
