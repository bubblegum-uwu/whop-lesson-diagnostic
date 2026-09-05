/**
 * Parses the `Authorization: Bearer <token>` header the frontend sends
 * containing the user's own short-lived Whop OAuth access token.
 *
 * This token is never logged (callers must register it with the redactor
 * immediately after a successful parse — see http/routes/analyzeLesson.ts).
 */

export class MissingAuthorizationError extends Error {
  constructor(message = "Missing or malformed Authorization header.") {
    super(message);
    this.name = "MissingAuthorizationError";
  }
}

/**
 * Extracts the bearer token from a raw `Authorization` header value.
 * Returns null if the header is absent or doesn't match the `Bearer <token>`
 * shape. Case-insensitive on the "Bearer" scheme, per RFC 6750/7235.
 */
export function parseBearerToken(headerValue: string | string[] | undefined): string | null {
  if (Array.isArray(headerValue)) {
    // Multiple Authorization headers is invalid/ambiguous — reject.
    return null;
  }
  if (!headerValue) return null;

  const trimmed = headerValue.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  if (!match) return null;

  const token = match[1];
  if (!token || token.length === 0) return null;

  return token;
}

/** Like parseBearerToken but throws MissingAuthorizationError instead of returning null. */
export function requireBearerToken(headerValue: string | string[] | undefined): string {
  const token = parseBearerToken(headerValue);
  if (!token) {
    throw new MissingAuthorizationError();
  }
  return token;
}
