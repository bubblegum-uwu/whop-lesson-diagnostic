import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

export type SynthesisStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export const TERMINAL_SYNTHESIS_STATUSES: SynthesisStatus[] = ["COMPLETED", "FAILED"];

export interface SynthesisRun {
  runId: string;
  courseId: number;
  status: SynthesisStatus;
  currentStage: string | null;
  sourceAnalysisHash: string;
  sourceAnalysisIds: number[];
  model: string;
  synthesisPromptVersion: string;
  synthesisSchemaVersion: string;
  synthesizerVersion: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
  processingDurationSeconds: number | null;
  errorType: string | null;
  sanitizedError: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Countable progress within `currentStage`, when that stage has countable work (see synthesis/progress.ts) — null for a stage that's a single indeterminate Gemini call. */
  completedItems: number | null;
  totalItems: number | null;
  /** A short display label only (e.g. a canonical strategy's name) — never prompt content or raw course material. */
  currentItem: string | null;
}

interface SynthesisRunRow {
  run_id: string;
  course_id: string;
  status: SynthesisStatus;
  current_stage: string | null;
  source_analysis_hash: string;
  source_analysis_ids: string[];
  model: string;
  synthesis_prompt_version: string;
  synthesis_schema_version: string;
  synthesizer_version: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_heartbeat_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  estimated_cost: string | null;
  processing_duration_seconds: number | null;
  error_type: string | null;
  sanitized_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_items: number | null;
  total_items: number | null;
  current_item: string | null;
}

function mapRow(row: SynthesisRunRow): SynthesisRun {
  return {
    runId: row.run_id,
    courseId: Number(row.course_id),
    status: row.status,
    currentStage: row.current_stage,
    sourceAnalysisHash: row.source_analysis_hash,
    sourceAnalysisIds: (row.source_analysis_ids ?? []).map(Number),
    model: row.model,
    synthesisPromptVersion: row.synthesis_prompt_version,
    synthesisSchemaVersion: row.synthesis_schema_version,
    synthesizerVersion: row.synthesizer_version,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    thinkingTokens: row.thinking_tokens,
    estimatedCost: row.estimated_cost == null ? null : Number(row.estimated_cost),
    processingDurationSeconds: row.processing_duration_seconds,
    errorType: row.error_type,
    sanitizedError: row.sanitized_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedItems: row.completed_items,
    totalItems: row.total_items,
    currentItem: row.current_item,
  };
}

const COLUMNS = `run_id, course_id, status, current_stage, source_analysis_hash, source_analysis_ids,
  model, synthesis_prompt_version, synthesis_schema_version, synthesizer_version,
  lease_owner, lease_expires_at, last_heartbeat_at, started_at, completed_at,
  input_tokens, output_tokens, thinking_tokens, estimated_cost, processing_duration_seconds,
  error_type, sanitized_error, created_at, updated_at, completed_items, total_items, current_item`;

export interface CreateSynthesisRunInput {
  courseId: number;
  sourceAnalysisHash: string;
  sourceAnalysisIds: number[];
  model: string;
  synthesisPromptVersion: string;
  synthesisSchemaVersion: string;
  synthesizerVersion: string;
}

export async function createSynthesisRun(db: Queryable, input: CreateSynthesisRunInput): Promise<SynthesisRun> {
  const result = await db.query(
    `INSERT INTO synthesis_runs (
       course_id, source_analysis_hash, source_analysis_ids, model,
       synthesis_prompt_version, synthesis_schema_version, synthesizer_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      input.courseId,
      input.sourceAnalysisHash,
      input.sourceAnalysisIds,
      input.model,
      input.synthesisPromptVersion,
      input.synthesisSchemaVersion,
      input.synthesizerVersion,
    ],
  );
  return mapRow(result.rows[0] as SynthesisRunRow);
}

export async function getSynthesisRun(db: Queryable, runId: string): Promise<SynthesisRun | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM synthesis_runs WHERE run_id = $1`, [runId]);
  return result.rows[0] ? mapRow(result.rows[0] as SynthesisRunRow) : null;
}

/** The latest COMPLETED run for a course — the "current" synthesis shown in Course Intelligence. */
export async function getLatestCompletedRun(db: Queryable, courseId: number): Promise<SynthesisRun | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM synthesis_runs WHERE course_id = $1 AND status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1`,
    [courseId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as SynthesisRunRow) : null;
}

/** The most recent run of any status — used to show "synthesis in progress" / "last attempt failed" state. */
export async function getLatestRun(db: Queryable, courseId: number): Promise<SynthesisRun | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM synthesis_runs WHERE course_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [courseId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as SynthesisRunRow) : null;
}

const LEASE_DURATION = "5 minutes";

/**
 * Atomically claims either a due QUEUED run or a nonterminal run whose lease
 * has expired (a crashed/killed worker execution never released it) —
 * exactly analysisJobsRepo.claimNextEligibleJob's shape, scoped to
 * synthesis_runs. A longer lease than analysis_jobs (5 vs 2 minutes) since a
 * single synthesis stage — one Gemini call over a whole cluster or the full
 * playbook — can itself take longer than one lesson-analysis stage.
 */
export async function claimNextEligibleSynthesisRun(db: Queryable, leaseOwner: string): Promise<SynthesisRun | null> {
  const result = await db.query(
    `UPDATE synthesis_runs
     SET status = 'RUNNING',
         lease_owner = $1,
         lease_expires_at = now() + interval '${LEASE_DURATION}',
         started_at = COALESCE(started_at, now()),
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE run_id = (
       SELECT run_id FROM synthesis_runs
       WHERE status = 'QUEUED'
          OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING ${COLUMNS}`,
    [leaseOwner],
  );
  return result.rows[0] ? mapRow(result.rows[0] as SynthesisRunRow) : null;
}

export async function hasEligibleSynthesisWork(db: Queryable): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM synthesis_runs
     WHERE status = 'QUEUED' OR (status = 'RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
     LIMIT 1`,
  );
  return (result.rowCount ?? 0) > 0;
}

/** Renews a held lease and reports stage progress — fenced by lease_owner, exactly like analysisJobsRepo.renewLease. Returns false if this execution has been reclaimed. */
export async function renewSynthesisLease(
  db: Queryable,
  runId: string,
  leaseOwner: string,
  currentStage?: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE synthesis_runs
     SET lease_expires_at = now() + interval '${LEASE_DURATION}',
         last_heartbeat_at = now(),
         current_stage = COALESCE($3, current_stage),
         updated_at = now()
     WHERE run_id = $1 AND lease_owner = $2
     RETURNING run_id`,
    [runId, leaseOwner, currentStage ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface SynthesisProgressUpdate {
  currentStage: string;
  /** Countable-work counters for this stage — pass null/null when the stage is a single indeterminate Gemini call (never fabricate a percentage for those). */
  completedItems: number | null;
  totalItems: number | null;
  /** Short display label only (e.g. a canonical strategy's name) — never prompt content or raw course material. */
  currentItem: string | null;
}

/**
 * Records a real progress event (a stage transition, or a countable-item
 * increment within a stage) and — since this is just another authenticated
 * write against the same row — renews the lease/heartbeat in the same
 * statement, fenced by lease_owner exactly like renewSynthesisLease. Unlike
 * that function's COALESCE-based "leave unspecified fields alone" renewal
 * (used by the plain periodic heartbeat, which has no progress to report),
 * every field here is set unconditionally to the caller's given value —
 * including explicit nulls — because a real progress event always knows
 * the full current state, and a stage transition must be able to clear a
 * previous stage's stale item counts/currentItem rather than leave them
 * COALESCEd forward.
 */
export async function updateSynthesisProgress(
  db: Queryable,
  runId: string,
  leaseOwner: string,
  update: SynthesisProgressUpdate,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE synthesis_runs
     SET lease_expires_at = now() + interval '${LEASE_DURATION}',
         last_heartbeat_at = now(),
         current_stage = $3,
         completed_items = $4,
         total_items = $5,
         current_item = $6,
         updated_at = now()
     WHERE run_id = $1 AND lease_owner = $2
     RETURNING run_id`,
    [runId, leaseOwner, update.currentStage, update.completedItems, update.totalItems, update.currentItem],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface CompleteSynthesisRunInput {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
  processingDurationSeconds: number | null;
}

/** Fenced terminal transition to COMPLETED. Returns false if this execution's lease was reclaimed — caller must not persist derived rows in that case (see worker/synthesisLoop.ts, same pattern as markSucceeded). */
export async function markSynthesisCompleted(
  db: Queryable,
  runId: string,
  leaseOwner: string,
  input: CompleteSynthesisRunInput,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE synthesis_runs
     SET status = 'COMPLETED', completed_at = now(),
         input_tokens = $3, output_tokens = $4, thinking_tokens = $5,
         estimated_cost = $6, processing_duration_seconds = $7,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE run_id = $1 AND lease_owner = $2
     RETURNING run_id`,
    [runId, leaseOwner, input.inputTokens, input.outputTokens, input.thinkingTokens, input.estimatedCost, input.processingDurationSeconds],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markSynthesisFailed(
  db: Queryable,
  runId: string,
  leaseOwner: string,
  errorType: string,
  sanitizedError: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE synthesis_runs
     SET status = 'FAILED', completed_at = now(), error_type = $3, sanitized_error = $4,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE run_id = $1 AND lease_owner = $2
     RETURNING run_id`,
    [runId, leaseOwner, errorType, sanitizedError],
  );
  return (result.rowCount ?? 0) > 0;
}
