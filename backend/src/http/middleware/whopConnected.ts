import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { getAuthSessionStatus } from "../../db/authSessionRepo.js";

export interface WhopConnectedDeps {
  pool: Pool;
}

/**
 * Gates the handful of routes that genuinely need Whop — course sync today
 * (see http/app.ts's route classification). A cheap existence/status check
 * against the stored `auth_sessions` row only: it never calls Whop itself
 * and never attempts a token refresh (that remains
 * whop/sessionService.ts's getValidAccessToken, still called inside
 * courseSync.ts's own handler exactly as before — this middleware only
 * short-circuits the common case of "never connected" or "explicitly
 * disconnected" before the handler runs).
 *
 * Returns 409 WHOP_NOT_CONNECTED — deliberately distinct from a 401, which
 * requireKnoveraAuth (checked first on every route that stacks this) already
 * owns. A stored session that exists but whose refresh token has itself gone
 * stale is NOT caught here; it still surfaces as the handler's own existing
 * 401 auth_required path once a refresh is actually attempted.
 */
export function requireWhopConnected(deps: WhopConnectedDeps) {
  return async function whopConnectedMiddleware(_req: Request, res: Response, next: NextFunction): Promise<void> {
    const status = await getAuthSessionStatus(deps.pool);
    if (!status || status.status !== "active") {
      res.status(409).json({
        error: {
          message: "Whop is not connected. Connect Whop from the project's Sources page to use this feature.",
          type: "WHOP_NOT_CONNECTED",
        },
      });
      return;
    }
    next();
  };
}
