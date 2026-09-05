import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { requireBearerToken, MissingAuthorizationError } from "../../lib/authHeader.js";
import { getAuthSessionStatus } from "../../db/authSessionRepo.js";
import { WhopIdentityError, type WhopOAuthClient } from "../../whop/oauthClient.js";
import { globalRedactor } from "../../lib/redact.js";

export interface OperatorAuthDeps {
  pool: Pool;
  oauthClient: WhopOAuthClient;
}

export interface OperatorAuthedRequest extends Request {
  operatorWhopUserId?: string;
}

/**
 * Gates every sensitive route behind the verified operator identity — never
 * CORS, Origin, client_id, or an unverified id_token claim, none of which
 * a non-browser caller is required to respect.
 *
 * 1. Extract the caller's own bearer token (registered with the redactor
 *    immediately, so it can never leak into a log line even on failure).
 * 2. Reject outright if no operator session has ever been established —
 *    there's nothing to authorize against yet.
 * 3. Verify the token against Whop's userinfo endpoint (the one source of
 *    truth for identity anywhere in this backend).
 * 4. Compare the verified `sub` to the persisted operator. Match → attach
 *    it to the request and continue. Mismatch → 403: a real Whop account,
 *    just not the one this deployment belongs to.
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

    if (verified.sub !== operator.whopUserId) {
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
