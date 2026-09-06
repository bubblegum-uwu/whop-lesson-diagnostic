import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

export type JobStatus =
  | "QUEUED"
  | "RETRIEVING"
  | "PREPARING_VIDEO"
  | "UPLOADING"
  | "GEMINI_PROCESSING"
  | "ANALYZING"
  | "VALIDATING"
  | "COMPLETED"
  | "NO_STRATEGY"
  | "FAILED"
  | "AUTH_REQUIRED"
  | "CANCELLED";

export const TERMINAL_STATUSES: JobStatus[] = ["COMPLETED", "NO_STRATEGY", "FAILED", "CANCELLED"];

export interface AnalysisJob {
  jobId: string;
  lessonId: number;
  analysisFingerprint: string;
  status: JobStatus;
  currentStage: string | null;
  stageProgress: number | null;
  overallProgress: number | null;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  lastHeartbeatAt: Date | null;
  nextRetryAt: Date | null;
  errorType: string | null;
  sanitizedError: string | null;
}

interface JobRow {
  job_id: string;
  lesson_id: string;
  analysis_fingerprint: string;
  status: JobStatus;
  current_stage: string | null;
  stage_progress: string | null;
  overall_progress: string | null;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  queued_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  last_heartbeat_at: Date | null;
  next_retry_at: Date | null;
  error_type: string | null;
  sanitized_error: string | null;
}

function mapRow(row: JobRow): AnalysisJob {
  return {
    jobId: row.job_id,
    lessonId: Number(row.lesson_id),
    analysisFingerprint: row.analysis_fingerprint,
    status: row.status,
    currentStage: row.current_stage,
    stageProgress: row.stage_progress == null ? null : Number(row.stage_progress),
    overallProgress: row.overall_progress == null ? null : Number(row.overall_progress),
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    nextRetryAt: row.next_retry_at,
    errorType: row.error_type,
    sanitizedError: row.sanitized_error,
  };
}

const JOB_COLUMNS = `job_id, lesson_id, analysis_fingerprint, status, current_stage, stage_progress,
  overall_progress, attempt_count, lease_owner, lease_expires_at, queued_at, started_at,
  completed_at, last_heartbeat_at, next_retry_at, error_type, sanitized_error`;

/** Creates a fresh QUEUED job for a lesson. One row = one processing episode. */
export async function createJob(
  db: Queryable,
  lessonId: number,
  analysisFingerprint: string,
): Promise<AnalysisJob> {
  const result = await db.query(
    `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status)
     VALUES ($1, $2, 'QUEUED')
     RETURNING ${JOB_COLUMNS}`,
    [lessonId, analysisFingerprint],
  );
  return mapRow(result.rows[0] as JobRow);
}

export async function getJob(db: Queryable, jobId: string): Promise<AnalysisJob | null> {
  const result = await db.query(`SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE job_id = $1`, [jobId]);
  return result.rows[0] ? mapRow(result.rows[0] as JobRow) : null;
}

export async function getLatestJobForLesson(db: Queryable, lessonId: number): Promise<AnalysisJob | null> {
  const result = await db.query(
    `SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE lesson_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [lessonId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as JobRow) : null;
}

const LEASE_DURATION = "2 minutes";

/**
 * Atomically claims either a due QUEUED job or a nonterminal job whose lease
 * has expired (a crashed/killed worker execution never released it). See
 * migration comment on analysis_jobs and PR2 plan §4/§6 for the design.
 */
export async function claimNextEligibleJob(db: Queryable, leaseOwner: string): Promise<AnalysisJob | null> {
  const result = await db.query(
    `UPDATE analysis_jobs
     SET status = 'RETRIEVING',
         lease_owner = $1,
         lease_expires_at = now() + interval '${LEASE_DURATION}',
         started_at = COALESCE(started_at, now()),
         attempt_count = attempt_count + 1,
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE job_id = (
       SELECT job_id FROM analysis_jobs
       WHERE (status = 'QUEUED' AND (next_retry_at IS NULL OR next_retry_at <= now()))
          OR (status NOT IN ('COMPLETED','NO_STRATEGY','FAILED','CANCELLED') AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
       ORDER BY queued_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING ${JOB_COLUMNS}`,
    [leaseOwner],
  );
  return result.rows[0] ? mapRow(result.rows[0] as JobRow) : null;
}

/** True if there's anything a worker execution could usefully claim right now. */
export async function hasEligibleWork(db: Queryable): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM analysis_jobs
     WHERE (status = 'QUEUED' AND (next_retry_at IS NULL OR next_retry_at <= now()))
        OR (status NOT IN ('COMPLETED','NO_STRATEGY','FAILED','CANCELLED') AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
     LIMIT 1`,
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Renews a held lease and reports progress — but only if `leaseOwner` still
 * matches the row (the fencing check). Returns false if this execution has
 * been reclaimed by someone else, in which case the caller MUST stop working
 * on this job and never persist a result for it.
 */
export async function renewLease(
  db: Queryable,
  jobId: string,
  leaseOwner: string,
  update: { status?: JobStatus; currentStage?: string; stageProgress?: number | null; overallProgress?: number | null },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE analysis_jobs
     SET lease_expires_at = now() + interval '${LEASE_DURATION}',
         last_heartbeat_at = now(),
         status = COALESCE($3, status),
         current_stage = COALESCE($4, current_stage),
         stage_progress = COALESCE($5, stage_progress),
         overall_progress = COALESCE($6, overall_progress),
         updated_at = now()
     WHERE job_id = $1 AND lease_owner = $2
     RETURNING job_id`,
    [jobId, leaseOwner, update.status ?? null, update.currentStage ?? null, update.stageProgress ?? null, update.overallProgress ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Fenced terminal transition to COMPLETED/NO_STRATEGY. Returns false (and
 * changes nothing) if this execution's lease was reclaimed — the caller must
 * not have already persisted a lesson_analyses row in that case (see
 * worker/mainLoop.ts, which checks this INSIDE the same transaction as the
 * lesson_analyses insert).
 */
export async function markSucceeded(
  db: Queryable,
  jobId: string,
  leaseOwner: string,
  status: "COMPLETED" | "NO_STRATEGY",
): Promise<boolean> {
  const result = await db.query(
    `UPDATE analysis_jobs
     SET status = $3, completed_at = now(), overall_progress = 100,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE job_id = $1 AND lease_owner = $2
     RETURNING job_id`,
    [jobId, leaseOwner, status],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Transient failure: back to QUEUED with a bounded-backoff next_retry_at, lease released. */
export async function markForRetry(
  db: Queryable,
  jobId: string,
  leaseOwner: string,
  nextRetryAt: Date,
  errorType: string,
  sanitizedError: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE analysis_jobs
     SET status = 'QUEUED', next_retry_at = $3, error_type = $4, sanitized_error = $5,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE job_id = $1 AND lease_owner = $2
     RETURNING job_id`,
    [jobId, leaseOwner, nextRetryAt, errorType, sanitizedError],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Permanent failure: terminal, lease released. */
export async function markFailed(
  db: Queryable,
  jobId: string,
  leaseOwner: string,
  errorType: string,
  sanitizedError: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE analysis_jobs
     SET status = 'FAILED', completed_at = now(), error_type = $3, sanitized_error = $4,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE job_id = $1 AND lease_owner = $2
     RETURNING job_id`,
    [jobId, leaseOwner, errorType, sanitizedError],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Whop authorization is unrecoverable right now — parked, not counted as a normal retry. */
export async function markAuthRequired(db: Queryable, jobId: string, leaseOwner: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE analysis_jobs
     SET status = 'AUTH_REQUIRED', error_type = 'auth_required',
         sanitized_error = 'Whop authorization expired — reconnect to resume.',
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE job_id = $1 AND lease_owner = $2
     RETURNING job_id`,
    [jobId, leaseOwner],
  );
  return (result.rowCount ?? 0) > 0;
}

/** [ Retry ] on FAILED/AUTH_REQUIRED — same job_id, same episode, re-enters the claim queue. */
export async function resetForManualRetry(db: Queryable, jobId: string): Promise<AnalysisJob | null> {
  const result = await db.query(
    `UPDATE analysis_jobs
     SET status = 'QUEUED', next_retry_at = NULL, error_type = NULL, sanitized_error = NULL,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE job_id = $1 AND status IN ('FAILED', 'AUTH_REQUIRED')
     RETURNING ${JOB_COLUMNS}`,
    [jobId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as JobRow) : null;
}

/** Only while QUEUED, per the approved cancellation limitation. */
export async function cancelIfQueued(db: Queryable, jobId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE analysis_jobs SET status = 'CANCELLED', completed_at = now(), updated_at = now()
     WHERE job_id = $1 AND status = 'QUEUED'
     RETURNING job_id`,
    [jobId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Every AUTH_REQUIRED job becomes eligible again after a successful Whop
 * reconnect — called from POST /api/auth/session, never by the Scheduler
 * safety net (which must never do this on its own — see http/routes/internal).
 */
export async function resumeAllAuthRequiredJobs(db: Queryable): Promise<number> {
  const result = await db.query(
    `UPDATE analysis_jobs SET status = 'QUEUED', next_retry_at = NULL, updated_at = now()
     WHERE status = 'AUTH_REQUIRED'`,
  );
  return result.rowCount ?? 0;
}

export interface JobSummaryCounts {
  queued: number;
  processing: number;
  completed: number;
  noStrategy: number;
  failed: number;
  authRequired: number;
  cancelled: number;
}

const PROCESSING_STATUSES: JobStatus[] = [
  "RETRIEVING",
  "PREPARING_VIDEO",
  "UPLOADING",
  "GEMINI_PROCESSING",
  "ANALYZING",
  "VALIDATING",
];

export async function getLatestJobsByLesson(db: Queryable, lessonIds: number[]): Promise<Map<number, AnalysisJob>> {
  if (lessonIds.length === 0) return new Map();
  const result = await db.query(
    `SELECT DISTINCT ON (lesson_id) ${JOB_COLUMNS}
     FROM analysis_jobs
     WHERE lesson_id = ANY($1::bigint[])
     ORDER BY lesson_id, created_at DESC`,
    [lessonIds],
  );
  const map = new Map<number, AnalysisJob>();
  for (const row of result.rows as JobRow[]) {
    const job = mapRow(row);
    map.set(job.lessonId, job);
  }
  return map;
}

export async function getSummaryCounts(db: Queryable, lessonIds: number[]): Promise<JobSummaryCounts> {
  const jobs = await getLatestJobsByLesson(db, lessonIds);
  const counts: JobSummaryCounts = {
    queued: 0,
    processing: 0,
    completed: 0,
    noStrategy: 0,
    failed: 0,
    authRequired: 0,
    cancelled: 0,
  };
  for (const job of jobs.values()) {
    if (job.status === "QUEUED") counts.queued++;
    else if (PROCESSING_STATUSES.includes(job.status)) counts.processing++;
    else if (job.status === "COMPLETED") counts.completed++;
    else if (job.status === "NO_STRATEGY") counts.noStrategy++;
    else if (job.status === "FAILED") counts.failed++;
    else if (job.status === "AUTH_REQUIRED") counts.authRequired++;
    else if (job.status === "CANCELLED") counts.cancelled++;
  }
  return counts;
}
