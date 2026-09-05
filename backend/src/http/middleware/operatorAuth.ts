import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { requireBearerToken, MissingAuthorizationError } from "../../lib/authHeader.js";
import { getAuthSessionStatus } from "../../db/authSessionRepo.js";
import { WhopIdentityError, type WhopOAuthClient } from "../../whop/oauthClient.js";
import { globalRedactor } from "../../lib/redact.js";

export interface OperatorAuthDeps {
  pool: Pool;
  oauthClient: WhopOAuthClient;
  /** The one Whop user this deployment is configured for — the root of trust, not the database. */
  whopOperatorUserId: string;
}

export interface OperatorAuthedRequest extends Request {
  operatorWhopUserId?: string;
}

/**
 * Gates every sensitive route behind the verified operator identity — never
 * CORS, Origin, client_id, or an unverified id_token claim, none of which a
 * non-browser caller is required to respect, and never "whoever the
 * database currently says is the operator" on its own.
 *
 * Authorization requires BOTH:
 *   1. The caller's bearer token verifies (via Whop's userinfo endpoint) as
 *      `sub === deps.whopOperatorUserId` — the configured operator.
 *   2. The persisted `auth_sessions.whop_user_id` also equals
 *      `deps.whopOperatorUserId`.
 *
 * (2) exists so a stale or corrupted database row (e.g. from before this
 * check existed, or manual tampering) can never grant access on its own —
 * the configuration is the root of trust, the database is merely storage
 * that must agree with it. A persisted session that disagrees with
 * configuration fails closed with `operator_configuration_conflict` rather
 * than being trusted or silently repaired.
 */
export function requireOperator(deps: OperatorAuthDeps) {
  return async function operatorAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
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
    globalRedactor.register(token);

    const operator = await getAuthSessionStatus(deps.pool);
    if (!operator) {
      res.status(401).json({
        error: { message: "No operator session has been established yet.", type: "auth_required" },
      });
      return;
    }

    if (operator.whopUserId !== deps.whopOperatorUserId) {
      res.status(500).json({
        error: {
          message: "Stored operator session does not match the configured operator.",
          type: "operator_configuration_conflict",
        },
      });
      return;
    }

    let verified;
    try {
      verified = await deps.oauthClient.verifyAccessToken(token);
    } catch (err) {
      if (err instanceof WhopIdentityError) {
        res.status(401).json({
          error: { message: "Invalid or expired Whop access token.", type: "invalid_token" },
        });
        return;
      }
      throw err;
    }

    if (verified.sub !== deps.whopOperatorUserId) {
      res.status(403).json({
        error: {
          message: "This Whop account is not the authorized operator for this deployment.",
          type: "forbidden_operator",
        },
      });
      return;
    }

    (req as OperatorAuthedRequest).operatorWhopUserId = verified.sub;
    next();
  };
}
