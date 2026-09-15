import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { claimNextEligibleSynthesisSetRun, markSynthesisSetRunCompleted, markSynthesisSetRunFailed, type SynthesisSetRunRow } from "../db/synthesisSetRunsRepo.js";
import { gatherSynthesisSetRunInput } from "../synthesis/gatherSynthesisSetRunInput.js";
import { runSynthesis, type SynthesisResult } from "../synthesis/runSynthesis.js";
import type { SynthesisStageDeps } from "../synthesis/geminiStage.js";
import { estimateCost } from "../pricing/geminiPricing.js";
import { classifyError } from "../pipeline/errorClassification.js";
import { globalRedactor, type SecretRedactor } from "../lib/redact.js";
import { logger as defaultLogger, type SafeLogger } from "../lib/logger.js";

export interface SynthesisSetRunWorkerDeps {
  pool: Pool;
  gemini: SynthesisStageDeps["gemini"];
  model: string;
  redactor?: SecretRedactor;
  logger?: SafeLogger;
}

/**
 * A separate session-level advisory lock key from both worker/advisoryLock.ts's
 * WORKER_LOCK_KEY and worker/synthesisLoop.ts's SYNTHESIS_LOCK_KEY
 * (5_902_331_005) — native Synthesis Set Run execution is its own
 * independent phase (see server.ts), never blocking or blocked by lesson
 * analysis, legacy course synthesis, project-source analysis, or Discord
 * capture claiming.
 */
const SYNTHESIS_SET_RUN_LOCK_KEY = 5_902_331_006;

interface Lock {
  acquired: boolean;
  release(): Promise<void>;
}

async function acquireLock(pool: Pool): Promise<Lock> {
  const client = await pool.connect();
  client.on("error", () => undefined);
  const result = await client.query<{ pg_try_advisory_lock: boolean }>("SELECT pg_try_advisory_lock($1)", [SYNTHESIS_SET_RUN_LOCK_KEY]);
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
        await client.query("SELECT pg_advisory_unlock($1)", [SYNTHESIS_SET_RUN_LOCK_KEY]);
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Executes ONE claimed native Run. Deliberately simpler than
 * worker/synthesisLoop.ts's processOneSynthesisRun in two ways, both
 * documented tradeoffs rather than oversights (see the 1790500000000
 * migration's doc comment and synthesisSetRunsRepo.ts's LEASE_DURATION):
 *   1. No heartbeat/lease renewal mid-run — the 15-minute lease claimed
 *      up front must simply outlast one execution.
 *   2. No incremental stage-progress persistence — synthesis_set_runs has
 *      no current_stage/completed_items columns (out of scope for this
 *      follow-up); onProgress is passed as a no-op. The Run's status
 *      (QUEUED/RUNNING/COMPLETED/FAILED) and, on failure, its error, are
 *      still fully persisted — only fine-grained mid-run progress is not.
 *
 * THE EXECUTOR NEVER RE-RESOLVES CURRENT SYNTHESIS SET MEMBERSHIP: the only
 * input this reads is `run`'s own immutable snapshot (via
 * gatherSynthesisSetRunInput, which itself only ever queries
 * synthesis_set_run_sources/synthesis_set_run_lessons — never
 * synthesis_set_sources/synthesis_set_lessons).
 */
async function processOneSynthesisSetRun(run: SynthesisSetRunRow, leaseOwner: string, deps: SynthesisSetRunWorkerDeps): Promise<void> {
  const redactor = deps.redactor ?? globalRedactor;
  const log = deps.logger ?? defaultLogger;
  const startedAt = new Date();

  try {
    const setResult = await deps.pool.query<{ name: string }>(`SELECT name FROM synthesis_sets WHERE id = $1`, [run.synthesisSetId]);
    const synthesisSetName = setResult.rows[0]?.name ?? "Synthesis Set";

    const input = await gatherSynthesisSetRunInput(deps.pool, synthesisSetName, run.runId);

    const result: SynthesisResult = await runSynthesis({ gemini: deps.gemini, model: deps.model }, input);

    const completedAt = new Date();
    const estimatedCost = estimateCost(result.usage);

    const succeeded = await markSynthesisSetRunCompleted(deps.pool, run.runId, leaseOwner, {
      resultJson: {
        clusters: result.clusters,
        coreFramework: result.coreFramework,
        playbook: result.playbook,
        decisionFramework: result.decisionFramework,
      },
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      thinkingTokens: result.usage.thinkingTokens,
      estimatedCost,
      processingDurationSeconds: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
    });
    if (!succeeded) {
      log.warn("Discarding native synthesis-set-run result — lease was reclaimed before completion.", { runId: run.runId });
    }
  } catch (err) {
    const classification = classifyError(err);
    const sanitizedMessage = redactor.redact(err instanceof Error ? err.message : "Unknown synthesis-set-run execution error.");
    log.error("Native synthesis-set run failed", { runId: run.runId, classification, message: sanitizedMessage });
    const processingDurationSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
    await markSynthesisSetRunFailed(deps.pool, run.runId, leaseOwner, classification, sanitizedMessage, processingDurationSeconds);
  }
}

/**
 * The Cloud Run Job entrypoint's FIFTH phase (see server.ts), run after
 * Discord capture has already drained, from the same container/execution.
 * Claims and processes eligible native Synthesis Set Runs one at a time
 * until none remain — same shape as runSynthesisLoop, own advisory lock, so
 * it can never interact with or be blocked by any other phase's claiming.
 */
export async function runSynthesisSetRunLoop(deps: SynthesisSetRunWorkerDeps): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const lock = await acquireLock(deps.pool);
  if (!lock.acquired) {
    log.info("Another synthesis-set-run worker execution already holds the lock — exiting.", {});
    return;
  }

  const leaseOwner = `${process.env.CLOUD_RUN_EXECUTION ?? "local"}:${process.env.CLOUD_RUN_TASK_INDEX ?? "0"}:${randomUUID()}`;

  try {
    for (;;) {
      const run = await claimNextEligibleSynthesisSetRun(deps.pool, leaseOwner);
      if (!run) break;
      log.info("Claimed native synthesis-set run", { runId: run.runId, synthesisSetId: run.synthesisSetId });
      await processOneSynthesisSetRun(run, leaseOwner, deps);
    }
  } finally {
    await lock.release();
  }
}
