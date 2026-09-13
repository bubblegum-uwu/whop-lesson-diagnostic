/**
 * Recognizes anchor hrefs that LOOK like a supported YouTube video link
 * form. Deliberately permissive/light-touch: this is a pre-filter only —
 * the Knovera backend re-validates and canonicalizes every URL server-side
 * (see backend/src/lib/youtubeUrl.ts), so this extractor's only job is to
 * avoid sending Discord obviously-irrelevant links (images, other sites,
 * Discord's own CDN) — never to be the source of truth for what's a valid
 * video id.
 */

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]);

export function isLikelyYouTubeVideoUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return false;

  if (host === "youtu.be" || host === "www.youtu.be") {
    return url.pathname.split("/").filter((s) => s.length > 0).length === 1;
  }
  return url.pathname === "/watch" || /^\/(shorts|live)\/[^/]+\/?$/.test(url.pathname);
}

/** Every distinct YouTube-looking href among the given anchors, in first-seen order — never a duplicate within one message. */
export function extractYouTubeUrls(anchorHrefs: readonly string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const href of anchorHrefs) {
    if (!isLikelyYouTubeVideoUrl(href) || seen.has(href)) continue;
    seen.add(href);
    results.push(href);
  }
  return results;
}
