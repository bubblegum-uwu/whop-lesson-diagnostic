/**
 * Redaction utilities.
 *
 * Two layers, applied together:
 *
 * 1. Exact-value redaction: any string that's been registered as a known
 *    runtime secret (an Authorization bearer token, a Whop access token, a
 *    signed_video_playback_token, a full signed Mux URL, GEMINI_API_KEY,
 *    etc.) is stripped out wherever it appears verbatim.
 * 2. Pattern-based backstop redaction: catches secrets we didn't explicitly
 *    register (e.g. a token embedded in an unexpected ffmpeg stderr line,
 *    or a differently-cased header) using known shapes:
 *      - "Authorization: Bearer <token>" / "Bearer <token>"
 *      - "...?token=<value>" (Mux signed URL query param)
 *      - JSON field "signed_video_playback_token": "<value>"
 *
 * Both layers run on every string before it is ever written to stdout/stderr
 * or included in an error message returned to a client.
 */

const REDACTED = "[REDACTED]";

const BACKSTOP_PATTERNS: RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9\-_.~+/]+=*/gi,
  /([?&]token=)[^&\s"'<>]+/gi,
  /("signed_video_playback_token"\s*:\s*")[^"]*(")/gi,
  /("signed_playback_id"\s*:\s*")[^"]*(")/gi,
  /(stream\.mux\.com\/)[^\s"'?]+(\.m3u8)/gi,
];

export interface SecretRedactor {
  /** Registers one more runtime secret value to strip from all future output. */
  register(secret: string | null | undefined): void;
  /** Returns a redacted copy of the input string. */
  redact(input: string): string;
  /** Convenience: JSON.stringify then redact. */
  redactJson(value: unknown): string;
}

/** Minimum length before we bother exact-matching a "secret" — avoids over-redacting short/common strings. */
const MIN_SECRET_LENGTH = 8;

export function createSecretRedactor(): SecretRedactor {
  const secrets = new Set<string>();

  function register(secret: string | null | undefined): void {
    if (secret && secret.length >= MIN_SECRET_LENGTH) {
      secrets.add(secret);
    }
  }

  function redact(input: string): string {
    let out = input;

    // Longest secrets first, so a longer secret containing a shorter one
    // (e.g. a full URL containing a token) is fully replaced first.
    const ordered = Array.from(secrets).sort((a, b) => b.length - a.length);
    for (const secret of ordered) {
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED);
      }
    }

    for (const pattern of BACKSTOP_PATTERNS) {
      out = out.replace(pattern, (...args: string[]) => {
        // args = [fullMatch, ...capturedGroups, offset, wholeString]
        const groups = args.slice(1, -2).filter((g) => typeof g === "string");
        if (groups.length >= 2) {
          return `${groups[0]}${REDACTED}${groups[1]}`;
        }
        if (groups.length === 1) {
          return `${groups[0]}${REDACTED}`;
        }
        return REDACTED;
      });
    }

    return out;
  }

  function redactJson(value: unknown): string {
    return redact(JSON.stringify(value));
  }

  return { register, redact, redactJson };
}

/** A process-wide redactor. Register every secret as soon as it's known. */
export const globalRedactor = createSecretRedactor();
