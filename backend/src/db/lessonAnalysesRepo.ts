import type { Pool, PoolClient } from "pg";
import type { LessonStrategyAnalysis } from "../gemini/schema.js";

export type Queryable = Pool | PoolClient;

export interface CreateLessonAnalysisInput {
  lessonId: number;
  jobId: string;
  status: "completed" | "no_strategy";
  strategyFound: boolean;
  validatedJson: LessonStrategyAnalysis;
  analysisSummary: string;
  model: string;
  promptVersion: string;
  extractorVersion: string;
  schemaVersion: string;
  analysisFingerprint: string;
  startedAt: Date;
  completedAt: Date;
  processingDurationSeconds: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
}

export interface LessonAnalysis extends CreateLessonAnalysisInput {
  analysisId: number;
  createdAt: Date;
}

interface LessonAnalysisRow {
  analysis_id: string;
  lesson_id: string;
  job_id: string;
  status: "completed" | "no_strategy";
  strategy_found: boolean;
  validated_json: LessonStrategyAnalysis;
  analysis_summary: string;
  model: string;
  prompt_version: string;
  extractor_version: string;
  schema_version: string;
  analysis_fingerprint: string;
  started_at: Date;
  completed_at: Date;
  processing_duration_seconds: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  estimated_cost: string | null;
  created_at: Date;
}

function mapRow(row: LessonAnalysisRow): LessonAnalysis {
  return {
    analysisId: Number(row.analysis_id),
    lessonId: Number(row.lesson_id),
    jobId: row.job_id,
    status: row.status,
    strategyFound: row.strategy_found,
    validatedJson: row.validated_json,
    analysisSummary: row.analysis_summary,
    model: row.model,
    promptVersion: row.prompt_version,
    extractorVersion: row.extractor_version,
    schemaVersion: row.schema_version,
    analysisFingerprint: row.analysis_fingerprint,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    processingDurationSeconds: row.processing_duration_seconds,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    thinkingTokens: row.thinking_tokens,
    estimatedCost: row.estimated_cost == null ? null : Number(row.estimated_cost),
    createdAt: row.created_at,
  };
}

const COLUMNS = `analysis_id, lesson_id, job_id, status, strategy_found, validated_json, analysis_summary,
  model, prompt_version, extractor_version, schema_version, analysis_fingerprint, started_at, completed_at,
  processing_duration_seconds, input_tokens, output_tokens, thinking_tokens, estimated_cost, created_at`;

/**
 * Insert only — a lesson_analyses row is never updated after creation. The
 * `UNIQUE (job_id)` constraint (see the PR2 migration) is the hard guarantee
 * that a job can produce at most one of these; callers must run this inside
 * the same transaction as the job's fenced completion check (see
 * worker/mainLoop.ts) so a reclaimed/duplicate worker can never insert one.
 */
export async function createLessonAnalysis(db: Queryable, input: CreateLessonAnalysisInput): Promise<LessonAnalysis> {
  const result = await db.query(
    `INSERT INTO lesson_analyses (
       lesson_id, job_id, status, strategy_found, validated_json, analysis_summary,
       model, prompt_version, extractor_version, schema_version, analysis_fingerprint,
       started_at, completed_at, processing_duration_seconds, input_tokens, output_tokens,
       thinking_tokens, estimated_cost
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING ${COLUMNS}`,
    [
      input.lessonId,
      input.jobId,
      input.status,
      input.strategyFound,
      JSON.stringify(input.validatedJson),
      input.analysisSummary,
      input.model,
      input.promptVersion,
      input.extractorVersion,
      input.schemaVersion,
      input.analysisFingerprint,
      input.startedAt,
      input.completedAt,
      input.processingDurationSeconds,
      input.inputTokens,
      input.outputTokens,
      input.thinkingTokens,
      input.estimatedCost,
    ],
  );
  return mapRow(result.rows[0] as LessonAnalysisRow);
}

/** Used for the "skip if already successfully analyzed" idempotency check at enqueue time and at claim time. */
export async function findLatestByFingerprint(db: Queryable, analysisFingerprint: string): Promise<LessonAnalysis | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM lesson_analyses WHERE analysis_fingerprint = $1 ORDER BY completed_at DESC LIMIT 1`,
    [analysisFingerprint],
  );
  return result.rows[0] ? mapRow(result.rows[0] as LessonAnalysisRow) : null;
}

export async function getLatestByLesson(db: Queryable, lessonId: number): Promise<LessonAnalysis | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM lesson_analyses WHERE lesson_id = $1 ORDER BY completed_at DESC LIMIT 1`,
    [lessonId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as LessonAnalysisRow) : null;
}

export async function getLatestByLessons(db: Queryable, lessonIds: number[]): Promise<Map<number, LessonAnalysis>> {
  if (lessonIds.length === 0) return new Map();
  const result = await db.query(
    `SELECT DISTINCT ON (lesson_id) ${COLUMNS}
     FROM lesson_analyses WHERE lesson_id = ANY($1::bigint[])
     ORDER BY lesson_id, completed_at DESC`,
    [lessonIds],
  );
  const map = new Map<number, LessonAnalysis>();
  for (const row of result.rows as LessonAnalysisRow[]) {
    const analysis = mapRow(row);
    map.set(analysis.lessonId, analysis);
  }
  return map;
}

/**
 * Fetches an EXACT, already-frozen set of analyses by id — used by course
 * synthesis (Phase 3.4), which fixes its source analysis_ids at run-creation
 * time (see synthesisRunsRepo.createSynthesisRun) rather than re-resolving
 * "latest per lesson" again when the worker later picks the run up, so a
 * lesson re-analyzed while a run sits QUEUED can never change what that run
 * actually synthesizes from.
 */
export async function getByAnalysisIds(db: Queryable, analysisIds: number[]): Promise<LessonAnalysis[]> {
  if (analysisIds.length === 0) return [];
  const result = await db.query(`SELECT ${COLUMNS} FROM lesson_analyses WHERE analysis_id = ANY($1::bigint[])`, [analysisIds]);
  return (result.rows as LessonAnalysisRow[]).map(mapRow);
}

export async function getByJobId(db: Queryable, jobId: string): Promise<LessonAnalysis | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM lesson_analyses WHERE job_id = $1`, [jobId]);
  return result.rows[0] ? mapRow(result.rows[0] as LessonAnalysisRow) : null;
}

export interface CourseSpendSummary {
  totalCost: number | null;
  averageCostPerLesson: number | null;
  averageProcessingSeconds: number | null;
}

export async function getCourseSpendSummary(db: Queryable, lessonIds: number[]): Promise<CourseSpendSummary> {
  if (lessonIds.length === 0) return { totalCost: null, averageCostPerLesson: null, averageProcessingSeconds: null };
  const result = await db.query(
    `SELECT SUM(estimated_cost) AS total_cost, AVG(estimated_cost) AS avg_cost,
            AVG(processing_duration_seconds) AS avg_seconds
     FROM lesson_analyses WHERE lesson_id = ANY($1::bigint[])`,
    [lessonIds],
  );
  const row = result.rows[0] as { total_cost: string | null; avg_cost: string | null; avg_seconds: string | null };
  return {
    totalCost: row.total_cost == null ? null : Number(row.total_cost),
    averageCostPerLesson: row.avg_cost == null ? null : Number(row.avg_cost),
    averageProcessingSeconds: row.avg_seconds == null ? null : Number(row.avg_seconds),
  };
}
