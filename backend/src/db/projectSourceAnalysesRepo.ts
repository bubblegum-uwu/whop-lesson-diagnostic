import type { Pool, PoolClient } from "pg";
import type { LessonStrategyAnalysis } from "../gemini/schema.js";

export type Queryable = Pool | PoolClient;

export interface CreateProjectSourceAnalysisInput {
  projectSourceId: number;
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

export interface ProjectSourceAnalysis extends CreateProjectSourceAnalysisInput {
  analysisId: number;
  createdAt: Date;
}

interface ProjectSourceAnalysisRow {
  analysis_id: string;
  project_source_id: string;
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

function mapRow(row: ProjectSourceAnalysisRow): ProjectSourceAnalysis {
  return {
    analysisId: Number(row.analysis_id),
    projectSourceId: Number(row.project_source_id),
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

const COLUMNS = `analysis_id, project_source_id, job_id, status, strategy_found, validated_json, analysis_summary,
  model, prompt_version, extractor_version, schema_version, analysis_fingerprint, started_at, completed_at,
  processing_duration_seconds, input_tokens, output_tokens, thinking_tokens, estimated_cost, created_at`;

/**
 * Insert only — never updated after creation, same convention as
 * lesson_analyses. The UNIQUE(job_id) constraint (see the migration) is
 * the hard guarantee that a job produces at most one of these; callers
 * must run this inside the same transaction as the job's fenced completion
 * check (see worker/projectSourceAnalysisLoop.ts) so a reclaimed/duplicate
 * worker can never insert one.
 */
export async function createProjectSourceAnalysis(db: Queryable, input: CreateProjectSourceAnalysisInput): Promise<ProjectSourceAnalysis> {
  const result = await db.query(
    `INSERT INTO project_source_analyses (
       project_source_id, job_id, status, strategy_found, validated_json, analysis_summary,
       model, prompt_version, extractor_version, schema_version, analysis_fingerprint,
       started_at, completed_at, processing_duration_seconds, input_tokens, output_tokens,
       thinking_tokens, estimated_cost
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING ${COLUMNS}`,
    [
      input.projectSourceId,
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
  return mapRow(result.rows[0] as ProjectSourceAnalysisRow);
}

/** Used for the "skip if already successfully analyzed" idempotency check at enqueue/claim time — mirrors lessonAnalysesRepo.findLatestByFingerprint. */
export async function findLatestByFingerprint(db: Queryable, analysisFingerprint: string): Promise<ProjectSourceAnalysis | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM project_source_analyses WHERE analysis_fingerprint = $1 ORDER BY completed_at DESC LIMIT 1`,
    [analysisFingerprint],
  );
  return result.rows[0] ? mapRow(result.rows[0] as ProjectSourceAnalysisRow) : null;
}

export async function getLatestByProjectSource(db: Queryable, projectSourceId: number): Promise<ProjectSourceAnalysis | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM project_source_analyses WHERE project_source_id = $1 ORDER BY completed_at DESC LIMIT 1`,
    [projectSourceId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as ProjectSourceAnalysisRow) : null;
}

export async function getByJobId(db: Queryable, jobId: string): Promise<ProjectSourceAnalysis | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM project_source_analyses WHERE job_id = $1`, [jobId]);
  return result.rows[0] ? mapRow(result.rows[0] as ProjectSourceAnalysisRow) : null;
}
