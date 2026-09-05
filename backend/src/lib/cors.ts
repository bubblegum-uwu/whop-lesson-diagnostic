/**
 * Strict, exact-match CORS origin check.
 *
 * The browser's `Origin` header never includes a path (e.g. for
 * `https://bubblegum-uwu.github.io/whop-lesson-diagnostic/`, the Origin
 * header sent is exactly `https://bubblegum-uwu.github.io`). We therefore
 * compare against the configured allowed origin exactly — no wildcards, no
 * prefix/suffix matching, no subdomain matching.
 */

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function isAllowedOrigin(
  origin: string | undefined | null,
  allowedOrigin: string,
): boolean {
  if (!origin) return false;
  return stripTrailingSlash(origin) === stripTrailingSlash(allowedOrigin);
}

/**
 * Express middleware factory. Sets CORS headers only when the request's
 * Origin exactly matches `allowedOrigin`; otherwise no CORS headers are
 * set (the browser will block the cross-origin response).
 */
export function corsMiddleware(allowedOrigin: string) {
  return function (
    req: { headers: { origin?: string }; method: string },
    res: {
      setHeader: (name: string, value: string) => void;
      status: (code: number) => { end: () => void };
    },
    next: () => void,
  ) {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin, allowedOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
