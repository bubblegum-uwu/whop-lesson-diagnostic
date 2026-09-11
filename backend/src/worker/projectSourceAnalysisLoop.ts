import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  claimNextEligibleJob,
  renewLease,
  markSucceeded,
  markForRetry,
  markFailed,
  type ProjectSourceAnalysisJob,
} from "../db/projectSourceAnalysisJobsRepo.js";
import { createProjectSourceAnalysis, findLatestByFingerprint } from "../db/projectSourceAnalysesRepo.js";
import { getProjectSourceById, ANALYZABLE_PROJECT_SOURCE_PROVIDERS, type ProjectSourceRow } from "../db/projectSourcesRepo.js";
import { acquireYouTubeVideo } from "../youtube/acquireYouTubeVideo.js";
import { acquireDiscordVideo } from "../discord/acquireDiscordVideo.js";
import { runRawTwoPassCalls, validateAndCombineTwoPassResult } from "../pipeline/twoPassExtraction.js";
import { classifyError, computeNextRetryAt } from "../pipeline/errorClassification.js";
import { PROMPT_VERSION, SCHEMA_VERSION, EXTRACTOR_VERSION } from "../pipeline/analysisVersion.js";
import { buildAnalysisSummary } from "../pipeline/analysisSummary.js";
import { estimateCost } from "../pricing/geminiPricing.js";
import { startHeartbeat } from "./heartbeat.js";
import type { GeminiClient, VideoInputRef } from "../gemini/client.js";
import { globalRedactor, type SecretRedactor } from "../lib/redact.js";
import { logger as defaultLogger, type SafeLogger } from "../lib/logger.js";

export interface ProjectSourceAnalysisWorkerDeps {
  pool: Pool;
  gemini: GeminiClient;
  geminiModel: string;
  geminiProcessingMode: "agentic" | "static";
  redactor?: SecretRedactor;
  logger?: SafeLogger;
  /** Overridable only for tests — production always uses the default. */
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * A SEPARATE session-level advisory lock key from advisoryLock.ts's
 * WORKER_LOCK_KEY and synthesisLoop.ts's SYNTHESIS_LOCK_KEY — this queue
 * has its own lock so it can never block, or be blocked by, the
 * lesson-analysis or course-synthesis queues. Never touches
 * worker/advisoryLock.ts or worker/mainLoop.ts.
 */
const PROJECT_SOURCE_ANALYSIS_LOCK_KEY = 5_902_331_006;

interface ProjectSourceAnalysisLock {
  acquired: boolean;
  release(): Promise<void>;
}

async function acquireProjectSourceAnalysisLock(pool: Pool): Promise<ProjectSourceAnalysisLock> {
  const client: PoolClient = await pool.connect();
  client.on("error", () => undefined);
  const result = await client.query<{ pg_try_advisory_lock: boolean }>("SELECT pg_try_advisory_lock($1)", [PROJECT_SOURCE_ANALYSIS_LOCK_KEY]);
  const acquired = result.rows[0]?.pg_try_advisory_lock === true;

  if (!acquired) {
    client.release();
    return { acquired: false, release: async () => undefined };
  }

  let released = false;
  return {
    acquired: true,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [PROJECT_SOURCE_ANALYSIS_LOCK_KEY]);
      } finally {
        client.release();
      }
    },
  };
}

class LeaseLostError extends Error {
  constructor() {
    super("Project-source analysis lease was reclaimed by another worker execution.");
    this.name = "LeaseLostError";
  }
}

/**
 * Phase 4I — the ONE place provider-specific acquisition is dispatched.
 * Everything before this (claim, lease, idempotency check) and everything
 * after (the two-pass Gemini analysis, validation, persistence) is fully
 * shared and has no per-provider branches — see the module doc comment's
 * "provider-specific acquisition → generic analysis" boundary. Adding a
 * future provider means adding one branch here, never touching the rest
 * of this file.
 */
function acquireVideoForSource(source: ProjectSourceRow): VideoInputRef {
  if (source.provider === "YOUTUBE") {
    // Reconstructs the canonical YouTube URL from the validated external_id
    // ONLY — see acquireYouTubeVideo's doc comment. Synchronous, no network
    // call; never touches source.sourceUrl.
    return acquireYouTubeVideo(source.externalId);
  }
  // provider === "DISCORD" (the only other ANALYZABLE_PROJECT_SOURCE_PROVIDERS
  // member) — see acquireDiscordVideo's doc comment for why this one
  // legitimately needs sourceUrl too, and how it's revalidated + cross
  // -checked against externalId before use.
  return acquireDiscordVideo({ externalId: source.externalId, sourceUrl: source.sourceUrl });
}

function subjectTitleFallback(source: ProjectSourceRow): string {
  const providerLabel = source.provider === "YOUTUBE" ? "YouTube" : "Discord";
  return `${providerLabel} video ${source.externalId}`;
}

async function processOneProjectSourceJob(job: ProjectSourceAnalysisJob, leaseOwner: string, deps: ProjectSourceAnalysisWorkerDeps): Promise<void> {
  const redactor = deps.redactor ?? globalRedactor;
  const log = deps.logger ?? defaultLogger;

  const source = await getProjectSourceById(deps.pool, job.projectSourceId);
  if (!source) {
    await markFailed(deps.pool, job.jobId, leaseOwner, "permanent", "Project source no longer exists.");
    return;
  }
  // Defensive only — the enqueue route (http/routes/projectSourceAnalysis.ts)
  // already rejects any non-analyzable provider before a job is ever
  // created, so this can never actually be reached today.
  if (!ANALYZABLE_PROJECT_SOURCE_PROVIDERS.has(source.provider)) {
    await markFailed(deps.pool, job.jobId, leaseOwner, "permanent", "Unsupported source provider.");
    return;
  }

  // Idempotency: an identical successful analysis may already exist (e.g. a
  // second job was queued for the same source before this one was
  // claimed). Never spend a Gemini call re-deriving it — mirrors
  // worker/mainLoop.ts's processOneJob.
  const existing = await findLatestByFingerprint(deps.pool, job.analysisFingerprint);
  if (existing && (existing.status === "completed" || existing.status === "no_strategy")) {
    await markSucceeded(deps.pool, job.jobId, leaseOwner, existing.status === "completed" ? "COMPLETED" : "NO_STRATEGY");
    return;
  }

  let leaseLost = false;
  let renewChain: Promise<boolean> = Promise.resolve(true);
  function renewNow(status?: ProjectSourceAnalysisJob["status"]): Promise<boolean> {
    const next = renewChain.then(async () => {
      if (leaseLost) return false;
      const ok = await renewLease(deps.pool, job.jobId, leaseOwner, { status });
      if (!ok) leaseLost = true;
      return ok;
    });
    renewChain = next.catch(() => false);
    return next;
  }

  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeat = startHeartbeat({ intervalMs: heartbeatIntervalMs, renew: () => renewNow() });

  const startedAt = new Date();
  try {
    // Acquisition dispatched by provider — see acquireVideoForSource above.
    // Synchronous, no network call, no upload; Gemini fetches the video
    // server-side once given the URL directly, for every provider here.
    const video = acquireVideoForSource(source);
    const subject = {
      title: source.title ?? subjectTitleFallback(source),
      durationSeconds: source.durationSeconds,
    };

    await renewNow("ANALYZING");
    if (leaseLost) throw new LeaseLostError();
    const raw = await runRawTwoPassCalls(video, {
      gemini: deps.gemini,
      geminiModel: deps.geminiModel,
      geminiProcessingMode: deps.geminiProcessingMode,
    });

    await renewNow("VALIDATING");
    if (leaseLost) throw new LeaseLostError();
    const result = validateAndCombineTwoPassResult(subject, raw);

    const completedAt = new Date();
    const status: "completed" | "no_strategy" = result.analysis.strategy_found ? "completed" : "no_strategy";
    const estimatedCost = estimateCost({
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      thinkingTokens: result.usage.thinkingTokens,
    });

    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      await createProjectSourceAnalysis(client, {
        projectSourceId: source.id,
        jobId: job.jobId,
        status,
        strategyFound: result.analysis.strategy_found,
        validatedJson: result.analysis,
        analysisSummary: buildAnalysisSummary(result.analysis),
        model: deps.geminiModel,
        promptVersion: PROMPT_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
        schemaVersion: SCHEMA_VERSION,
        analysisFingerprint: job.analysisFingerprint,
        startedAt,
        completedAt,
        processingDurationSeconds: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        thinkingTokens: result.usage.thinkingTokens,
        estimatedCost,
      });

      // The final fenced check: if this execution's lease was reclaimed at
      // any point, this returns false and we roll back everything above.
      const succeeded = await markSucceeded(client, job.jobId, leaseOwner, status === "completed" ? "COMPLETED" : "NO_STRATEGY");
      if (!succeeded) {
        await client.query("ROLLBACK");
        log.warn("Discarding project-source analysis result — lease was reclaimed before completion.", { jobId: job.jobId });
        return;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof LeaseLostError) {
      log.warn("Abandoning project-source analysis job — lease was reclaimed mid-processing.", { jobId: job.jobId });
      return;
    }
    const classification = classifyError(err);
    const sanitizedMessage = redactor.redact(err instanceof Error ? err.message : "Unknown worker error.");
    log.error("Project-source analysis job failed", { jobId: job.jobId, classification, message: sanitizedMessage });

    if (classification === "transient") {
      await markForRetry(deps.pool, job.jobId, leaseOwner, computeNextRetryAt(job.attemptCount), "transient", sanitizedMessage);
    } else {
      // "auth_required" can never actually occur here (YouTube analysis
      // never calls Whop) — collapsed into permanent failure defensively
      // rather than introducing an AUTH_REQUIRED state this job type has
      // no use for.
      await markFailed(deps.pool, job.jobId, leaseOwner, classification === "auth_required" ? "permanent" : classification, sanitizedMessage);
    }
  } finally {
    heartbeat.stop();
  }
}

/**
 * The Cloud Run Job entrypoint's THIRD phase — called after runWorkerLoop
 * (lesson analysis) and runSynthesisLoop (course synthesis) have already
 * drained, from the SAME container/execution (see server.ts). Claims and
 * processes eligible project_source_analysis_jobs one at a time until none
 * remain, exactly like the other two loops' shape but scoped to its own
 * advisory lock — this never interacts with or is blocked by either of the
 * other two queues' locks/claim loops. Preferred over a second Cloud Run
 * Job, per the same reasoning course synthesis already established.
 */
export async function runProjectSourceAnalysisLoop(deps: ProjectSourceAnalysisWorkerDeps): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const lock = await acquireProjectSourceAnalysisLock(deps.pool);
  if (!lock.acquired) {
    log.info("Another project-source analysis worker execution already holds the lock — exiting.", {});
    return;
  }

  const leaseOwner = `${process.env.CLOUD_RUN_EXECUTION ?? "local"}:${process.env.CLOUD_RUN_TASK_INDEX ?? "0"}:${randomUUID()}`;

  try {
    for (;;) {
      const job = await claimNextEligibleJob(deps.pool, leaseOwner);
      if (!job) break;
      log.info("Claimed project-source analysis job", { jobId: job.jobId, projectSourceId: job.projectSourceId });
      await processOneProjectSourceJob(job, leaseOwner, deps);
    }
  } finally {
    await lock.release();
  }
}
