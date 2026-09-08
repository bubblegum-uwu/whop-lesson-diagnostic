import type { Request, Response, NextFunction } from "express";
import { requireBearerToken, MissingAuthorizationError } from "../../lib/authHeader.js";
import { verifyKnoveraToken } from "../../lib/knoveraToken.js";

export interface KnoveraAuthDeps {
  authSecret: string;
}

export interface KnoveraAuthedRequest extends Request {
  knoveraOperator?: string;
}

/**
 * Gates every route that only needs "is this browser logged into Knovera" —
 * Projects, Sources, lesson/analysis reads, synthesis, enqueue/retry/cancel,
 * and the Whop-connection-management routes themselves (status/disconnect/
 * connect-completion). Verifies ONLY the Knovera session token: it never
 * calls Whop, never touches auth_sessions, never requires a Whop refresh
 * token. A route that also needs an active Whop connection stacks
 * requireWhopConnected (whopConnected.ts) after this middleware — the two
 * are deliberately independent checks, never merged into one.
 */
export function requireKnoveraAuth(deps: KnoveraAuthDeps) {
  return async function knoveraAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    let token: string;
    try {
      token = requireBearerToken(req.headers.authorization);
    } catch (err) {
      if (err instanceof MissingAuthorizationError) {
        res.status(401).json({ error: { message: err.message, type: "missing_authorization" } });
        return;
      }
      throw err;
    }

    const payload = await verifyKnoveraToken(token, deps.authSecret);
    if (!payload) {
      res.status(401).json({
        error: { message: "Invalid or expired Knovera session — please log in again.", type: "knovera_unauthenticated" },
      });
      return;
    }

    (req as KnoveraAuthedRequest).knoveraOperator = payload.sub;
    next();
  };
}
