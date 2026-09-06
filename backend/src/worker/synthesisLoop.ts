import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  claimNextEligibleSynthesisRun,
  renewSynthesisLease,
  updateSynthesisProgress,
  markSynthesisCompleted,
  markSynthesisFailed,
  type SynthesisRun,
  type SynthesisProgressUpdate,
} from "../db/synthesisRunsRepo.js";
import { createStrategyCluster } from "../db/strategyClustersRepo.js";
import { createCanonicalStrategy } from "../db/canonicalStrategiesRepo.js";
import { createCoursePlaybook } from "../db/coursePlaybooksRepo.js";
import { gatherSynthesisInput } from "../synthesis/sourceData.js";
import { runSynthesis, type SynthesisResult, type SynthesisProgressEvent } from "../synthesis/runSynthesis.js";
import type { SynthesisStageDeps } from "../synthesis/geminiStage.js";
import { startHeartbeat } from "./heartbeat.js";
import { estimateCost } from "../pricing/geminiPricing.js";
import { classifyError } from "../pipeline/errorClassification.js";
import { globalRedactor, type SecretRedactor } from "../lib/redact.js";
import { logger as defaultLogger, type SafeLogger } from "../lib/logger.js";

export interface SynthesisWorkerDeps {
  pool: Pool;
  gemini: SynthesisStageDeps["gemini"];
  model: string;
  redactor?: SecretRedactor;
  logger?: SafeLogger;
  /** Overridable only for tests — production always uses the default. */
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * A SEPARATE session-level advisory lock key from advisoryLock.ts's
 * WORKER_LOCK_KEY, deliberately not sharing that function/key — synthesis
 * runs are rare, user-initiated, and independent of the continuous
 * lesson-analysis queue; giving them their own lock means a synthesis run
 * in progress never blocks (or is blocked by) lesson-job claiming, and vice
 * versa. This never touches worker/advisoryLock.ts or mainLoop.ts.
 */
const SYNTHESIS_LOCK_KEY = 5_902_331_005;

interface SynthesisLock {
  acquired: boolean;
  release(): Promise<void>;
}

async function acquireSynthesisLock(pool: Pool): Promise<SynthesisLock> {
  const client: PoolClient = await pool.connect();
  client.on("error", () => undefined);
  const result = await client.query<{ pg_try_advisory_lock: boolean }>("SELECT pg_try_advisory_lock($1)", [SYNTHESIS_LOCK_KEY]);
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
        await client.query("SELECT pg_advisory_unlock($1)", [SYNTHESIS_LOCK_KEY]);
      } finally {
        client.release();
      }
    },
  };
}

async function processOneSynthesisRun(run: SynthesisRun, leaseOwner: string, deps: SynthesisWorkerDeps): Promise<void> {
  const redactor = deps.redactor ?? globalRedactor;
  const log = deps.logger ?? defaultLogger;

  // A single chain both the pure heartbeat timer and every real progress
  // event serialize through — this is what guarantees no two DB writes for
  // this run's lease/progress ever overlap (a heartbeat tick landing mid-
  // stage-transition, or two progress events firing back to back, both
  // wait their turn instead of racing).
  let leaseLost = false;
  let renewChain: Promise<boolean> = Promise.resolve(true);

  /** Pure heartbeat: renews the lease/last_heartbeat_at only, touching no progress column — the independent timer below calls this on its own schedule, never tied to a Gemini callback or stage transition. */
  function renewNow(): Promise<boolean> {
    const next = renewChain.then(async () => {
      if (leaseLost) return false;
      const ok = await renewSynthesisLease(deps.pool, run.runId, leaseOwner);
      if (!ok) leaseLost = true;
      return ok;
    });
    renewChain = next.catch(() => false);
    return next;
  }

  /** A real progress event (stage transition or item-count increment) — also renews the lease/heartbeat as part of the same write, chained through the same renewChain as the pure heartbeat above. Always awaited by its caller (never fire-and-forget) so a checkpoint like "cluster i complete" is guaranteed durable before the next unit of work starts. */
  function reportProgress(update: SynthesisProgressUpdate): Promise<boolean> {
    const next = renewChain.then(async () => {
      if (leaseLost) return false;
      const ok = await updateSynthesisProgress(deps.pool, run.runId, leaseOwner, update);
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
    const courseTitleResult = await deps.pool.query<{ title: string }>(`SELECT title FROM courses WHERE id = $1`, [run.courseId]);
    const courseTitle = courseTitleResult.rows[0]?.title ?? "Course";

    const input = await gatherSynthesisInput(deps.pool, courseTitle, run.sourceAnalysisIds);

    // Returning (not `void`-ing) reportProgress's promise here is what
    // makes runSynthesis's internal `await onProgress?.(...)` actually
    // wait for this write to land — see runSynthesis's doc comment on why
    // that matters: it's what guarantees "cluster i complete" (and its
    // contribution to cumulativeUsage) is durably persisted before cluster
    // i+1 is even attempted, so a mid-pipeline failure can never race an
    // unpersisted completion.
    const result: SynthesisResult = await runSynthesis({ gemini: deps.gemini, model: deps.model }, input, async (event: SynthesisProgressEvent) => {
      await reportProgress({
        currentStage: event.stage,
        completedItems: event.completedItems,
        totalItems: event.totalItems,
        currentItem: event.currentItem,
        inputTokens: event.cumulativeUsage.inputTokens,
        outputTokens: event.cumulativeUsage.outputTokens,
        thinkingTokens: event.cumulativeUsage.thinkingTokens,
        estimatedCost: estimateCost(event.cumulativeUsage),
      });
    });

    if (leaseLost) throw new LeaseLostError();

    const completedAt = new Date();
    const estimatedCost = estimateCost(result.usage);

    // Awaited (unlike a pure heartbeat tick, which never blocks the
    // pipeline) — this is a deliberate checkpoint that must land before
    // the persistence transaction below begins, or a completed run could
    // show stale mid-pipeline progress instead of VALIDATING. Uses
    // result.usage (the authoritative final total, already computed
    // above) rather than re-deriving it — by this point they're the same
    // value.
    await reportProgress({
      currentStage: "VALIDATING",
      completedItems: null,
      totalItems: null,
      currentItem: null,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      thinkingTokens: result.usage.thinkingTokens,
      estimatedCost,
    });
    if (leaseLost) throw new LeaseLostError();

    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      for (const { cluster, canonicalStrategy } of result.clusters) {
        const clusterRow = await createStrategyCluster(client, run.runId, cluster);
        await createCanonicalStrategy(client, run.runId, clusterRow.clusterId, canonicalStrategy);
      }
      await createCoursePlaybook(client, {
        runId: run.runId,
        title: result.playbook.title,
        coreFramework: result.coreFramework,
        playbook: result.playbook,
        decisionFramework: result.decisionFramework,
      });

      const succeeded = await markSynthesisCompleted(client, run.runId, leaseOwner, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        thinkingTokens: result.usage.thinkingTokens,
        estimatedCost,
        processingDurationSeconds: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
      });
      if (!succeeded) {
        await client.query("ROLLBACK");
        log.warn("Discarding synthesis result — lease was reclaimed before completion.", { runId: run.runId });
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
      log.warn("Abandoning synthesis run — lease was reclaimed mid-processing.", { runId: run.runId });
      return;
    }
    const classification = classifyError(err);
    const sanitizedMessage = redactor.redact(err instanceof Error ? err.message : "Unknown synthesis worker error.");
    log.error("Course synthesis run failed", { runId: run.runId, classification, message: sanitizedMessage });
    // current_stage/completed_items/total_items/current_item/input_tokens/
    // output_tokens/thinking_tokens/estimated_cost are deliberately NOT
    // passed here — markSynthesisFailed never touches them, so whatever
    // reportProgress last durably persisted (see above) stays exactly as
    // the "progress reached" / "cost so far" snapshot at the point of
    // failure. Only the duration needs computing fresh, since a failed run
    // never reaches the success path's own duration calculation.
    const processingDurationSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
    await markSynthesisFailed(deps.pool, run.runId, leaseOwner, classification, sanitizedMessage, processingDurationSeconds);
  } finally {
    heartbeat.stop();
  }
}

class LeaseLostError extends Error {
  constructor() {
    super("Synthesis lease was reclaimed by another worker execution.");
    this.name = "LeaseLostError";
  }
}

/**
 * The Cloud Run Job entrypoint's SECOND phase — called after runWorkerLoop
 * (lesson analysis) has already drained, from the SAME container/execution
 * (see server.ts). Claims and processes eligible synthesis_runs one at a
 * time until none remain, exactly like runWorkerLoop's shape but scoped to
 * its own advisory lock, so it can never interact with or be blocked by
 * the lesson-analysis queue's own lock/claim loop.
 */
export async function runSynthesisLoop(deps: SynthesisWorkerDeps): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const lock = await acquireSynthesisLock(deps.pool);
  if (!lock.acquired) {
    log.info("Another synthesis worker execution already holds the lock — exiting.", {});
    return;
  }

  const leaseOwner = `${process.env.CLOUD_RUN_EXECUTION ?? "local"}:${process.env.CLOUD_RUN_TASK_INDEX ?? "0"}:${randomUUID()}`;

  try {
    for (;;) {
      const run = await claimNextEligibleSynthesisRun(deps.pool, leaseOwner);
      if (!run) break;
      log.info("Claimed synthesis run", { runId: run.runId, courseId: run.courseId });
      await processOneSynthesisRun(run, leaseOwner, deps);
    }
  } finally {
    await lock.release();
  }
}
