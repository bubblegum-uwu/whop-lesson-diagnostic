import type { Request, Response } from "express";
import type { Pool } from "pg";
import { requireBearerToken, MissingAuthorizationError } from "../../lib/authHeader.js";
import { hasEligibleWork } from "../../db/analysisJobsRepo.js";
import type { JobTrigger } from "../../jobs/runJobTrigger.js";
import type { GoogleOidcVerifier } from "../../lib/googleOidc.js";
import { InvalidOidcTokenError } from "../../lib/googleOidc.js";
import { logger } from "../../lib/logger.js";

export interface InternalRouteDeps {
  pool: Pool;
  jobTrigger: JobTrigger;
  oidcVerifier: GoogleOidcVerifier;
}

/**
 * POST /internal/ensure-worker-running — the Cloud Scheduler safety net
 * (~every 5 minutes). Trusts ONLY a Google-signed OIDC identity token whose
 * subject is exactly the configured Scheduler service account — never CORS,
 * an Origin header, the Whop operator bearer token, or a shared
 * query-string secret (see backend/README.md "Security model").
 *
 * This route NEVER converts AUTH_REQUIRED jobs back to QUEUED — that only
 * ever happens from a successful operator reconnect (POST /api/auth/session).
 * It only checks for QUEUED-and-due or lease-expired work (see
 * analysisJobsRepo.hasEligibleWork) and triggers a Job execution if any
 * exists; otherwise it does nothing.
 */
export function createEnsureWorkerRunningHandler(deps: InternalRouteDeps) {
  return async function ensureWorkerRunningHandler(req: Request, res: Response): Promise<void> {
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

    try {
      await deps.oidcVerifier.verify(token);
    } catch (err) {
      if (err instanceof InvalidOidcTokenError) {
        logger.warn("Rejected ensure-worker-running call with an invalid/unexpected identity token", {});
        res.status(403).json({ error: { message: "Invalid identity token.", type: "forbidden" } });
        return;
      }
      throw err;
    }

    const eligible = await hasEligibleWork(deps.pool);
    if (!eligible) {
      res.status(204).end();
      return;
    }

    await deps.jobTrigger.triggerRun();
    res.status(200).json({ triggered: true });
  };
}
