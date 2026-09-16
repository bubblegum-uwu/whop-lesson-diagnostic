import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { claimNextEligibleSynthesisSetRun, markSynthesisSetRunCompleted, markSynthesisSetRunFailed, type SynthesisSetRunRow } from "../db/synthesisSetRunsRepo.js";
import { gatherSynthesisSetRunInput } from "../synthesis/gatherSynthesisSetRunInput.js";
import { runSynthesis, type SynthesisResult } from "../synthesis/runSynthesis.js";
import type { SynthesisStageDeps } from "../synthesis/geminiStage.js";
import { SYNTHESIS_PROMPT_VERSION } from "../synthesis/version.js";
import { SynthesisInvariantError } from "../synthesis/errors.js";
import { estimateCost } from "../pricing/geminiPricing.js";
import { classifyError } from "../pipeline/errorClassification.js";
import { globalRedactor, type SecretRedactor } from "../lib/redact.js";
import { logger as defaultLogger, type SafeLogger } from "../lib/logger.js";

export interface SynthesisSetRunWorkerDeps {
  pool: Pool;
  gemini: SynthesisStageDeps["gemini"];
  /**
   * The worker's own currently-configured default model (e.g.
   * `config.geminiModel`) — kept here as the deployment's baseline, but
   * NEVER read by processOneSynthesisSetRun to decide what model a Run
   * actually executes under. That decision is `run.model` alone, frozen at
   * Run creation (createSynthesisSetRun) — see the review fix documented
   * on processOneSynthesisSetRun below. If worker config changes (a
   * deploy bumps the configured model) between a Run's creation and its
   * execution, the Run must still run under the model it was created
   * with, never silently pick up the new default.
   */
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
 *
 *      ACCEPTED PHASE 4M LIMITATION (review follow-up): the session-level
 *      pg_advisory_lock this loop takes (see acquireLock above) is held by
 *      one Postgres connection/session and is automatically released the
 *      moment that session dies — a worker crash, container eviction, or
 *      lost DB connection. If that death happens WHILE an outbound Gemini
 *      HTTP request from processOneSynthesisSetRun is still in flight, the
 *      advisory lock is gone immediately, but the Run's row-level lease
 *      (claimed up front, 15 minutes, not renewed) is still held until it
 *      expires. Once it expires, a second worker execution can claim the
 *      SAME Run and start a SECOND, fully independent Gemini call for the
 *      same frozen input — real duplicate cost, not merely a race. This is
 *      NOT a data-corruption risk: `markSynthesisSetRunCompleted`/
 *      `markSynthesisSetRunFailed` are fenced on `run_id AND lease_owner`
 *      (see synthesisSetRunsRepo.ts), so whichever execution's write lands
 *      second with the now-stale first lease_owner simply fails its
 *      `WHERE lease_owner = $2` match and is discarded — the persisted
 *      result is always whichever execution's write is accepted first,
 *      never a corrupt mix of two. What fencing does NOT prevent is BOTH
 *      executions actually calling Gemini and being billed. Phase 4M
 *      deliberately accepts this (rather than adding heartbeat/lease
 *      renewal here, which would be a real architecture change to this
 *      loop) because: the failure mode requires the specific overlap of
 *      "worker/DB-session dies mid-call" AND "the SAME Run's lease then
 *      expires before any other work reclaims it," which is rare relative
 *      to normal operation, and the advisory lock alone already prevents
 *      the much more common case (two healthy concurrent workers both
 *      entering this loop) from ever double-executing. If duplicate-cost
 *      exposure from this specific edge case becomes a real problem,
 *      add heartbeat/lease renewal matching worker/synthesisLoop.ts's
 *      mechanism (renewSynthesisLease-equivalent) as a follow-up — do not
 *      shorten the 15-minute lease as a substitute; that only narrows the
 *      window, it doesn't close it.
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
 *
 * FROZEN PROVENANCE MUST NEVER LIE (review follow-up): a Run's `model` and
 * `promptVersion` are frozen once, at creation (createSynthesisSetRun),
 * specifically so they remain a truthful record of what actually produced
 * the result even if worker config or prompt logic changes before a QUEUED
 * Run gets executed. Both are checked BEFORE any Gemini call:
 *   - `run.model` is read directly — never `deps.model` (the worker's own
 *     currently-configured default) — so a worker redeployed with a
 *     different configured model still executes old queued Runs under the
 *     exact model they were created with. A Run somehow missing its frozen
 *     model fails loudly (SynthesisInvariantError, below) rather than
 *     silently falling back to whatever the worker happens to be
 *     configured with right now.
 *   - `run.promptVersion` is compared against the CURRENT
 *     SYNTHESIS_PROMPT_VERSION constant. This codebase keeps exactly one
 *     live prompt implementation per version (see synthesis/version.ts —
 *     there is no versioned-dispatch mechanism to run an OLDER prompt on
 *     demand), so a Run frozen under an older prompt version cannot
 *     actually be executed truthfully post-deploy: executing it anyway
 *     would run the CURRENT prompt logic while the persisted
 *     `promptVersion` field kept claiming the old one — a lie. Refusing
 *     explicitly (SynthesisInvariantError) is the smallest safe behavior
 *     available without building versioned prompt dispatch; it fails the
 *     Run (visible, queryable, retriable via a fresh Run) rather than
 *     silently substituting current logic under false provenance.
 */
async function processOneSynthesisSetRun(run: SynthesisSetRunRow, leaseOwner: string, deps: SynthesisSetRunWorkerDeps): Promise<void> {
  const redactor = deps.redactor ?? globalRedactor;
  const log = deps.logger ?? defaultLogger;
  const startedAt = new Date();

  try {
    if (!run.model) {
      throw new SynthesisInvariantError(`Run ${run.runId} has no frozen model recorded — refusing to execute under an unknown/guessed model.`);
    }
    if (run.promptVersion !== SYNTHESIS_PROMPT_VERSION) {
      throw new SynthesisInvariantError(
        `Run ${run.runId} was frozen under synthesis prompt version "${run.promptVersion ?? "(none)"}", but this worker only implements "${SYNTHESIS_PROMPT_VERSION}" — refusing to execute under a different prompt version than the Run's own provenance claims.`,
      );
    }

    const setResult = await deps.pool.query<{ name: string }>(`SELECT name FROM synthesis_sets WHERE id = $1`, [run.synthesisSetId]);
    const synthesisSetName = setResult.rows[0]?.name ?? "Synthesis Set";

    const input = await gatherSynthesisSetRunInput(deps.pool, synthesisSetName, run.runId);

    const result: SynthesisResult = await runSynthesis({ gemini: deps.gemini, model: run.model }, input);

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
