import type { ParsedYouTubeChannelRef } from "../lib/youtubeChannelUrl.js";
import { fetchYouTubeDataApi, YouTubeApiRequestError, YouTubeApiNotConfiguredError } from "./youtubeDataApiClient.js";

export class YouTubeChannelResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeChannelResolveError";
  }
}

interface ChannelsForHandleResponse {
  items?: Array<{ id?: string }>;
}

/**
 * Resolves a "handle"-form channel reference (an @handle, /c/CustomName, or
 * /user/LegacyName — see youtubeChannelUrl.ts) to YouTube's own stable
 * "UCxxxx..." channel id, via the YouTube Data API's `channels.list`
 * `forHandle` parameter — the documented, provider-supported mechanism for
 * exactly this lookup (added specifically to replace the deprecated
 * `forUsername` param for @handle resolution). Requires YOUTUBE_API_KEY;
 * throws YouTubeApiNotConfiguredError if it isn't set (see config.ts).
 *
 * Honest limitation: `/c/CustomName` and `/user/LegacyName` are LEGACY
 * custom-URL forms that predate @handles. For most channels YouTube
 * migrated these to an equivalent @handle and `forHandle` resolves them
 * correctly, but a channel whose legacy custom URL genuinely differs from
 * its current @handle will fail to resolve here — the fix is to paste the
 * channel's `/channel/UC...` URL or its current @handle instead, not to
 * build a second, scraping-based resolution path for this edge case.
 *
 * This is identity resolution only ("which channel is this handle?"),
 * never content discovery ("what videos does this channel have?" — see
 * discoverYoutubeChannelVideos.ts).
 */
export async function resolveYouTubeChannelId(ref: ParsedYouTubeChannelRef, apiKey: string | undefined): Promise<string> {
  if (ref.kind === "channel_id") return ref.channelId;
  if (!apiKey) throw new YouTubeApiNotConfiguredError();

  let data: ChannelsForHandleResponse;
  try {
    data = await fetchYouTubeDataApi<ChannelsForHandleResponse>("channels", { part: "id", forHandle: `@${ref.handle}` }, apiKey);
  } catch (err) {
    throw new YouTubeChannelResolveError(err instanceof YouTubeApiRequestError ? err.message : "Could not resolve this YouTube channel.");
  }

  const channelId = data.items?.[0]?.id;
  if (typeof channelId !== "string" || channelId.length === 0) {
    throw new YouTubeChannelResolveError(`Could not resolve "@${ref.handle}" to a YouTube channel — the channel may not exist, or this is a legacy custom URL that differs from the channel's current @handle.`);
  }
  return channelId;
}
