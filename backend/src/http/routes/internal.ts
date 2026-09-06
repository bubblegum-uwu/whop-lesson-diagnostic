import type { Request, Response } from "express";
import type { Pool } from "pg";
import { requireBearerToken, MissingAuthorizationError } from "../../lib/authHeader.js";
import { hasEligibleWork } from "../../db/analysisJobsRepo.js";
import { hasEligibleSynthesisWork } from "../../db/synthesisRunsRepo.js";
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
 * It checks for durable work a newly started worker execution could
 * ACTUALLY claim right now — QUEUED-and-due or lease-expired lesson
 * analysis jobs (analysisJobsRepo.hasEligibleWork) OR QUEUED/lease-expired
 * course synthesis runs (synthesisRunsRepo.hasEligibleSynthesisWork, the
 * exact same claimability predicate claimNextEligibleSynthesisRun uses to
 * claim one) — and triggers a Job execution if either exists; otherwise it
 * does nothing.
 *
 * Phase 3.5B fix: this route previously checked ONLY lesson-analysis
 * eligibility. A real production failure showed the gap: a synthesis run
 * was QUEUED, the worker execution that would have claimed it died (a Cloud
 * SQL network timeout) before claiming it, and every subsequent Scheduler
 * tick saw an empty analysis_jobs table and returned 204 — the QUEUED
 * synthesis run sat stranded until a human manually started a Cloud Run Job
 * execution. hasEligibleSynthesisWork already existed in
 * synthesisRunsRepo.ts (added for Phase 3.4's own lease-recovery story) but
 * was never wired into this route. Worker recovery now covers durable work
 * for BOTH lesson analysis jobs and course synthesis runs.
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

    const [lessonWorkEligible, synthesisWorkEligible] = await Promise.all([
      hasEligibleWork(deps.pool),
      hasEligibleSynthesisWork(deps.pool),
    ]);
    logger.info("ensure-worker-running eligibility check", { lessonWorkEligible, synthesisWorkEligible });
    if (!lessonWorkEligible && !synthesisWorkEligible) {
      res.status(204).end();
      return;
    }

    await deps.jobTrigger.triggerRun();
    res.status(200).json({ triggered: true });
  };
}
