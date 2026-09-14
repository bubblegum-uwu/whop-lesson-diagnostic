import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

/**
 * Phase 4M — the generalized IMMUTABLE Run model. See
 * 1790400000000_synthesis-set-runs.sql's doc comment for the full
 * reasoning. A Run's snapshot rows (synthesisSetRunSourcesRepo-shaped data
 * below) are written ONCE, inside the same transaction as the Run row
 * itself (see createSynthesisSetRun), and never updated afterward — the
 * only mutations this file exposes past creation are status-lifecycle
 * transitions (QUEUED -> RUNNING -> COMPLETED/FAILED), never a rewrite of
 * which sources/lessons/analyses the Run captured.
 */
export type SynthesisSetRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface SynthesisSetRunRow {
  runId: string;
  synthesisSetId: number;
  projectId: number;
  status: SynthesisSetRunStatus;
  model: string | null;
  promptVersion: string | null;
  sourceCount: number;
  readyCount: number;
  skippedNotReadyCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
  processingDurationSeconds: number | null;
  errorType: string | null;
  sanitizedError: string | null;
  resultJson: unknown;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface RunDbRow {
  run_id: string;
  synthesis_set_id: string;
  project_id: string;
  status: SynthesisSetRunStatus;
  model: string | null;
  prompt_version: string | null;
  source_count: number;
  ready_count: number;
  skipped_not_ready_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  estimated_cost: string | null;
  processing_duration_seconds: number | null;
  error_type: string | null;
  sanitized_error: string | null;
  result_json: unknown;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

function mapRow(row: RunDbRow): SynthesisSetRunRow {
  return {
    runId: row.run_id,
    synthesisSetId: Number(row.synthesis_set_id),
    projectId: Number(row.project_id),
    status: row.status,
    model: row.model,
    promptVersion: row.prompt_version,
    sourceCount: row.source_count,
    readyCount: row.ready_count,
    skippedNotReadyCount: row.skipped_not_ready_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    thinkingTokens: row.thinking_tokens,
    estimatedCost: row.estimated_cost == null ? null : Number(row.estimated_cost),
    processingDurationSeconds: row.processing_duration_seconds,
    errorType: row.error_type,
    sanitizedError: row.sanitized_error,
    resultJson: row.result_json,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

const COLUMNS = `run_id, synthesis_set_id, project_id, status, model, prompt_version,
  source_count, ready_count, skipped_not_ready_count,
  input_tokens, output_tokens, thinking_tokens, estimated_cost, processing_duration_seconds,
  error_type, sanitized_error, result_json, created_at, started_at, completed_at`;

export interface CreateSynthesisSetRunInput {
  synthesisSetId: number;
  projectId: number;
  model: string | null;
  promptVersion: string | null;
  /** [{ projectSourceId, projectSourceAnalysisId }] — the exact snapshot, already resolved by the caller (see http/routes/synthesisSetRuns.ts). */
  sources: { projectSourceId: number; projectSourceAnalysisId: number }[];
  /** [{ lessonId, lessonAnalysisId }] */
  lessons: { lessonId: number; lessonAnalysisId: number }[];
  skippedNotReadyCount: number;
}

/**
 * Creates the Run row AND both snapshot tables in ONE transaction — a Run
 * is never observable in a partially-snapshotted state. `sourceCount` /
 * `readyCount` are derived here from the caller-supplied, already-resolved
 * sources+lessons lists, never recomputed later — this row is the
 * permanent record of what was ready and what was skipped at creation time.
 */
export async function createSynthesisSetRun(pool: Pool, input: CreateSynthesisSetRunInput): Promise<SynthesisSetRunRow> {
  const readyCount = input.sources.length + input.lessons.length;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<RunDbRow>(
      `INSERT INTO synthesis_set_runs (synthesis_set_id, project_id, model, prompt_version, source_count, ready_count, skipped_not_ready_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [input.synthesisSetId, input.projectId, input.model, input.promptVersion, readyCount + input.skippedNotReadyCount, readyCount, input.skippedNotReadyCount],
    );
    const run = mapRow(result.rows[0]);

    if (input.sources.length > 0) {
      await client.query(
        `INSERT INTO synthesis_set_run_sources (run_id, project_source_id, project_source_analysis_id)
         SELECT $1, unnest($2::bigint[]), unnest($3::bigint[])`,
        [run.runId, input.sources.map((s) => s.projectSourceId), input.sources.map((s) => s.projectSourceAnalysisId)],
      );
    }
    if (input.lessons.length > 0) {
      await client.query(
        `INSERT INTO synthesis_set_run_lessons (run_id, lesson_id, lesson_analysis_id)
         SELECT $1, unnest($2::bigint[]), unnest($3::bigint[])`,
        [run.runId, input.lessons.map((l) => l.lessonId), input.lessons.map((l) => l.lessonAnalysisId)],
      );
    }

    await client.query("COMMIT");
    return run;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getSynthesisSetRunById(db: Queryable, runId: string): Promise<SynthesisSetRunRow | null> {
  const result = await db.query<RunDbRow>(`SELECT ${COLUMNS} FROM synthesis_set_runs WHERE run_id = $1`, [runId]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Every native Run for a set, newest first. */
export async function listSynthesisSetRuns(db: Queryable, synthesisSetId: number): Promise<SynthesisSetRunRow[]> {
  const result = await db.query<RunDbRow>(`SELECT ${COLUMNS} FROM synthesis_set_runs WHERE synthesis_set_id = $1 ORDER BY created_at DESC`, [synthesisSetId]);
  return result.rows.map(mapRow);
}

export interface SynthesisSetRunSourceInput {
  projectSourceId: number;
  title: string | null;
  sourceUrl: string;
  provider: string;
  analysisId: number;
}

/** The frozen generic-source snapshot for one Run, joined with enough project_sources metadata to render a provenance row without a second round trip per item. */
export async function listRunSourceInputs(db: Queryable, runId: string): Promise<SynthesisSetRunSourceInput[]> {
  const result = await db.query<{ project_source_id: string; title: string | null; source_url: string; provider: string; analysis_id: string }>(
    `SELECT ps.id AS project_source_id, ps.title, ps.source_url, ps.provider, rs.project_source_analysis_id AS analysis_id
     FROM synthesis_set_run_sources rs
     JOIN project_sources ps ON ps.id = rs.project_source_id
     WHERE rs.run_id = $1
     ORDER BY ps.id ASC`,
    [runId],
  );
  return result.rows.map((r) => ({
    projectSourceId: Number(r.project_source_id),
    title: r.title,
    sourceUrl: r.source_url,
    provider: r.provider,
    analysisId: Number(r.analysis_id),
  }));
}

export interface SynthesisSetRunLessonInput {
  lessonId: number;
  title: string;
  courseId: number;
  courseTitle: string;
  analysisId: number;
}

/** The frozen Whop-lesson snapshot for one Run, joined with lesson+course metadata. */
export async function listRunLessonInputs(db: Queryable, runId: string): Promise<SynthesisSetRunLessonInput[]> {
  const result = await db.query<{ lesson_id: string; title: string; course_id: string; course_title: string; analysis_id: string }>(
    `SELECT l.id AS lesson_id, l.title, c.id AS course_id, c.title AS course_title, rl.lesson_analysis_id AS analysis_id
     FROM synthesis_set_run_lessons rl
     JOIN lessons l ON l.id = rl.lesson_id
     JOIN courses c ON c.id = l.course_id
     WHERE rl.run_id = $1
     ORDER BY l.id ASC`,
    [runId],
  );
  return result.rows.map((r) => ({
    lessonId: Number(r.lesson_id),
    title: r.title,
    courseId: Number(r.course_id),
    courseTitle: r.course_title,
    analysisId: Number(r.analysis_id),
  }));
}

/** Fenced only by run_id (no lease/claim mechanics — see the migration's doc comment on why Phase 4M ships the Run model without also shipping an execution worker). Never called automatically today; ready for a future execution stage. */
export async function markSynthesisSetRunStarted(db: Queryable, runId: string): Promise<boolean> {
  const result = await db.query(`UPDATE synthesis_set_runs SET status = 'RUNNING', started_at = now() WHERE run_id = $1 AND status = 'QUEUED' RETURNING run_id`, [runId]);
  return (result.rowCount ?? 0) > 0;
}

export interface CompleteSynthesisSetRunInput {
  model: string;
  promptVersion: string;
  resultJson: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
  processingDurationSeconds: number | null;
}

export async function markSynthesisSetRunCompleted(db: Queryable, runId: string, input: CompleteSynthesisSetRunInput): Promise<boolean> {
  const result = await db.query(
    `UPDATE synthesis_set_runs
     SET status = 'COMPLETED', completed_at = now(), model = $2, prompt_version = $3, result_json = $4,
         input_tokens = $5, output_tokens = $6, thinking_tokens = $7, estimated_cost = $8, processing_duration_seconds = $9
     WHERE run_id = $1
     RETURNING run_id`,
    [runId, input.model, input.promptVersion, JSON.stringify(input.resultJson), input.inputTokens, input.outputTokens, input.thinkingTokens, input.estimatedCost, input.processingDurationSeconds],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markSynthesisSetRunFailed(db: Queryable, runId: string, errorType: string, sanitizedError: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE synthesis_set_runs SET status = 'FAILED', completed_at = now(), error_type = $2, sanitized_error = $3 WHERE run_id = $1 RETURNING run_id`,
    [runId, errorType, sanitizedError],
  );
  return (result.rowCount ?? 0) > 0;
}
