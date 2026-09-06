import type { Request, Response } from "express";
import type { Pool } from "pg";
import { saveAuthSession, getAuthSession, getAuthSessionStatus, deleteAuthSession } from "../../db/authSessionRepo.js";
import { resumeAllAuthRequiredJobs } from "../../db/analysisJobsRepo.js";
import { WhopIdentityError, type WhopOAuthClient } from "../../whop/oauthClient.js";
import type { JobTrigger } from "../../jobs/runJobTrigger.js";
import { globalRedactor } from "../../lib/redact.js";
import { logger } from "../../lib/logger.js";

export interface AuthRoutesDeps {
  pool: Pool;
  oauthClient: WhopOAuthClient;
  refreshTokenEncryptionKey: string;
  /** The one Whop user allowed to become (or remain) this deployment's operator. */
  whopOperatorUserId: string;
  /**
   * Optional: when present, a successful reconnect resumes every
   * AUTH_REQUIRED analysis job (PR2) and ensures a worker execution is
   * running to pick them back up — this is the ONLY path that ever moves a
   * job out of AUTH_REQUIRED; the Cloud Scheduler safety net never does.
   */
  jobTrigger?: JobTrigger;
}

interface EstablishSessionBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * POST /api/auth/session — the frontend calls this once, right after its
 * existing PKCE code-exchange succeeds, to hand the resulting tokens off
 * for server-side storage (§04 of the architecture proposal). The frontend
 * never writes these to localStorage; this is the only place they're
 * persisted, encrypted at rest.
 *
 * This is the one route reachable before any operator session exists —
 * every other sensitive route requires one already be established. But
 * "reachable before a session exists" does NOT mean "whoever calls this
 * first becomes the operator": the verified `sub` must equal the deployment's
 * configured `WHOP_OPERATOR_USER_ID` (config.ts fails startup if that's
 * unset or malformed) — the database's current contents never decide who is
 * *allowed* to become the operator, only who currently *is*. There is no
 * id_token in this request at all; nothing here trusts a client-supplied
 * identity claim.
 */
export function createEstablishSessionHandler(deps: AuthRoutesDeps) {
  return async function establishSessionHandler(req: Request, res: Response): Promise<void> {
    const body = req.body as EstablishSessionBody;
    if (!body?.access_token || !body?.refresh_token || !body?.expires_in) {
      res.status(400).json({
        error: { message: "Missing access_token, refresh_token, or expires_in.", type: "invalid_request" },
      });
      return;
    }

    globalRedactor.register(body.access_token);
    globalRedactor.register(body.refresh_token);

    let verified;
    try {
      verified = await deps.oauthClient.verifyAccessToken(body.access_token);
    } catch (err) {
      if (err instanceof WhopIdentityError) {
        res.status(401).json({
          error: { message: "Could not verify the supplied Whop access token.", type: "invalid_token" },
        });
        return;
      }
      throw err;
    }

    if (verified.sub !== deps.whopOperatorUserId) {
      res.status(403).json({
        error: {
          message: "This Whop account is not the configured operator for this deployment.",
          type: "forbidden_operator",
        },
      });
      return;
    }

    // Defense in depth: even though the caller IS the configured operator,
    // refuse to touch a persisted row that disagrees with configuration
    // (stale data from before this check existed, manual DB edits, a
    // restored backup, …) rather than silently overwriting it.
    const existingOperator = await getAuthSessionStatus(deps.pool);
    if (existingOperator && existingOperator.whopUserId !== deps.whopOperatorUserId) {
      logger.error("Stored operator session does not match configured WHOP_OPERATOR_USER_ID", {});
      res.status(500).json({
        error: {
          message: "Stored operator session does not match the configured operator. Refusing to proceed.",
          type: "operator_configuration_conflict",
        },
      });
      return;
    }

    await saveAuthSession(
      deps.pool,
      {
        whopUserId: verified.sub,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        accessTokenExpiresAt: new Date(Date.now() + body.expires_in * 1000),
      },
      deps.refreshTokenEncryptionKey,
    );

    if (deps.jobTrigger) {
      const resumedCount = await resumeAllAuthRequiredJobs(deps.pool);
      if (resumedCount > 0) {
        try {
          await deps.jobTrigger.triggerRun();
        } catch (err) {
          logger.error("Failed to trigger worker Job execution after resuming AUTH_REQUIRED jobs", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    res.status(200).json({ ok: true });
  };
}

/** GET /api/auth/status — never returns a token value, only connection state. */
export function createAuthStatusHandler(deps: AuthRoutesDeps) {
  return async function authStatusHandler(_req: Request, res: Response): Promise<void> {
    const status = await getAuthSessionStatus(deps.pool);
    if (!status) {
      res.status(200).json({ connected: false, status: null, whopUserId: null });
      return;
    }
    res.status(200).json({
      connected: status.status === "active",
      status: status.status,
      whopUserId: status.whopUserId,
    });
  };
}

/** POST /api/auth/disconnect — revokes with Whop (best-effort) then always clears the local session. */
export function createDisconnectHandler(deps: AuthRoutesDeps) {
  return async function disconnectHandler(_req: Request, res: Response): Promise<void> {
    const session = await getAuthSession(deps.pool, deps.refreshTokenEncryptionKey).catch(() => null);
    if (session) {
      try {
        await deps.oauthClient.revokeRefreshToken(session.refreshToken);
      } catch (err) {
        logger.warn("Whop refresh-token revoke failed during disconnect (clearing local session anyway)", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await deleteAuthSession(deps.pool);
    res.status(200).json({ ok: true });
  };
}
