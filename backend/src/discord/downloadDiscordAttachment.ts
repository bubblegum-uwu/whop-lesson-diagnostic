import { parseDiscordVideoUrl } from "../lib/discordUrl.js";
import type { SecretRedactor } from "../lib/redact.js";
import { globalRedactor } from "../lib/redact.js";

export class DiscordAttachmentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordAttachmentDownloadError";
  }
}

export interface DownloadedDiscordAttachment {
  content: Buffer;
  contentType: string;
  byteSize: number;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;

// Discord's own attachment size ceiling tops out well under this even for
// boosted servers — this is a safety bound against a misbehaving/malicious
// response, not a expected-to-bind-in-practice limit.
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Phase 4I durability fix — downloads a Discord CDN attachment's bytes
 * ONE TIME, at add-time, while the pasted URL is still guaranteed valid
 * (see the 1789600000000_project-source-media.sql migration's comment for
 * the full "why"). Never called again afterward — analysis and
 * re-analysis read the persisted bytes instead (see
 * db/projectSourceMediaRepo.ts / worker/projectSourceAnalysisLoop.ts).
 *
 * Re-validates `sourceUrl` through the exact same strict parser used
 * everywhere else in the Discord path before ever issuing a request —
 * this function only ever fetches a URL that has already passed the
 * host/path/extension allowlist, the same SSRF boundary as every other
 * Discord entry point.
 *
 * The URL (whose query string functions as a temporary access credential)
 * is registered with the redactor and never otherwise logged; only the
 * sanitized error types below ever surface to a caller.
 */
export async function downloadDiscordAttachment(
  sourceUrl: string,
  opts: { maxBytes?: number; redactor?: SecretRedactor } = {},
): Promise<DownloadedDiscordAttachment> {
  const parsed = parseDiscordVideoUrl(sourceUrl);
  const redactor = opts.redactor ?? globalRedactor;
  redactor.register(sourceUrl);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(parsed.sourceUrl, { signal: controller.signal });
  } catch (err) {
    throw new DiscordAttachmentDownloadError(
      `Could not download this Discord attachment — the link may already be invalid or expired (${
        err instanceof Error ? err.name : "network error"
      }).`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // A 403/404 here is exactly the "signature already expired" case the
    // durability fix exists to prevent from ever recurring after this one
    // capture — surfaced with a clear, actionable message rather than a
    // raw status code.
    throw new DiscordAttachmentDownloadError(
      `Could not download this Discord attachment (HTTP ${res.status}) — the link may already be invalid or expired. Please paste a fresh attachment link.`,
    );
  }

  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > maxBytes) {
    throw new DiscordAttachmentDownloadError(`This attachment is too large to analyze (over ${Math.round(maxBytes / (1024 * 1024))}MB).`);
  }

  if (!res.body) {
    throw new DiscordAttachmentDownloadError("Discord returned an empty response for this attachment.");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DiscordAttachmentDownloadError(`This attachment is too large to analyze (over ${Math.round(maxBytes / (1024 * 1024))}MB).`);
    }
    chunks.push(Buffer.from(value));
  }

  return {
    content: Buffer.concat(chunks),
    contentType: res.headers.get("content-type") ?? "video/mp4",
    byteSize: total,
  };
}
