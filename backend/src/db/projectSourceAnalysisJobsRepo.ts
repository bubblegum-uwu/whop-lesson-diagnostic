import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

/**
 * Phase 4H-B — deliberately its OWN small enum, not a reuse of
 * analysis_jobs' `job_status` (see the migration's comment): this job type
 * has no RETRIEVING/PREPARING_VIDEO/UPLOADING stage (YouTube acquisition is
 * a synchronous, in-process URL reconstruction — see
 * youtube/acquireYouTubeVideo.ts) and no AUTH_REQUIRED state (YouTube
 * analysis never touches Whop OAuth).
 */
export type ProjectSourceAnalysisJobStatus = "QUEUED" | "ANALYZING" | "VALIDATING" | "COMPLETED" | "NO_STRATEGY" | "FAILED" | "CANCELLED";

export const PROJECT_SOURCE_ANALYSIS_TERMINAL_STATUSES: ProjectSourceAnalysisJobStatus[] = ["COMPLETED", "NO_STRATEGY", "FAILED", "CANCELLED"];

export interface ProjectSourceAnalysisJob {
  jobId: string;
  projectSourceId: number;
  analysisFingerprint: string;
  status: ProjectSourceAnalysisJobStatus;
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
  project_source_id: string;
  analysis_fingerprint: string;
  status: ProjectSourceAnalysisJobStatus;
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

function mapRow(row: JobRow): ProjectSourceAnalysisJob {
  return {
    jobId: row.job_id,
    projectSourceId: Number(row.project_source_id),
    analysisFingerprint: row.analysis_fingerprint,
    status: row.status,
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

const JOB_COLUMNS = `job_id, project_source_id, analysis_fingerprint, status, attempt_count,
  lease_owner, lease_expires_at, queued_at, started_at, completed_at, last_heartbeat_at,
  next_retry_at, error_type, sanitized_error`;

/** Creates a fresh QUEUED job for a project source. One row = one processing episode — same convention as analysis_jobs. */
export async function createJob(db: Queryable, projectSourceId: number, analysisFingerprint: string): Promise<ProjectSourceAnalysisJob> {
  const result = await db.query(
    `INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status)
     VALUES ($1, $2, 'QUEUED')
     RETURNING ${JOB_COLUMNS}`,
    [projectSourceId, analysisFingerprint],
  );
  return mapRow(result.rows[0] as JobRow);
}

export async function getJob(db: Queryable, jobId: string): Promise<ProjectSourceAnalysisJob | null> {
  const result = await db.query(`SELECT ${JOB_COLUMNS} FROM project_source_analysis_jobs WHERE job_id = $1`, [jobId]);
  return result.rows[0] ? mapRow(result.rows[0] as JobRow) : null;
}

export async function getLatestJobForProjectSource(db: Queryable, projectSourceId: number): Promise<ProjectSourceAnalysisJob | null> {
  const result = await db.query(
    `SELECT ${JOB_COLUMNS} FROM project_source_analysis_jobs WHERE project_source_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [projectSourceId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as JobRow) : null;
}

const LEASE_DURATION = "2 minutes";

/** Atomically claims either a due QUEUED job or a nonterminal job whose lease has expired — identical shape to analysisJobsRepo.claimNextEligibleJob, applied to this table. */
export async function claimNextEligibleJob(db: Queryable, leaseOwner: string): Promise<ProjectSourceAnalysisJob | null> {
  const result = await db.query(
    `UPDATE project_source_analysis_jobs
     SET status = 'ANALYZING',
         lease_owner = $1,
         lease_expires_at = now() + interval '${LEASE_DURATION}',
         started_at = COALESCE(started_at, now()),
         attempt_count = attempt_count + 1,
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE job_id = (
       SELECT job_id FROM project_source_analysis_jobs
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

/**
 * Renews a held lease and reports a coarse status transition — but only if
 * `leaseOwner` still matches the row (the fencing check), same as
 * analysisJobsRepo.renewLease. Returns false if this execution has been
 * reclaimed, in which case the caller MUST stop working on this job.
 */
export async function renewLease(
  db: Queryable,
  jobId: string,
  leaseOwner: string,
  update: { status?: ProjectSourceAnalysisJobStatus },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE project_source_analysis_jobs
     SET lease_expires_at = now() + interval '${LEASE_DURATION}',
         last_heartbeat_at = now(),
         status = COALESCE($3, status),
         updated_at = now()
     WHERE job_id = $1 AND lease_owner = $2
     RETURNING job_id`,
    [jobId, leaseOwner, update.status ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Fenced terminal transition to COMPLETED/NO_STRATEGY — mirrors analysisJobsRepo.markSucceeded exactly. */
export async function markSucceeded(
  db: Queryable,
  jobId: string,
  leaseOwner: string,
  status: "COMPLETED" | "NO_STRATEGY",
): Promise<boolean> {
  const result = await db.query(
    `UPDATE project_source_analysis_jobs
     SET status = $3, completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
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
    `UPDATE project_source_analysis_jobs
     SET status = 'QUEUED', next_retry_at = $3, error_type = $4, sanitized_error = $5,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE job_id = $1 AND lease_owner = $2
     RETURNING job_id`,
    [jobId, leaseOwner, nextRetryAt, errorType, sanitizedError],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Permanent failure: terminal, lease released. */
export async function markFailed(db: Queryable, jobId: string, leaseOwner: string, errorType: string, sanitizedError: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE project_source_analysis_jobs
     SET status = 'FAILED', completed_at = now(), error_type = $3, sanitized_error = $4,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE job_id = $1 AND lease_owner = $2
     RETURNING job_id`,
    [jobId, leaseOwner, errorType, sanitizedError],
  );
  return (result.rowCount ?? 0) > 0;
}

/** [ Retry ] on FAILED only — same job_id, same episode, re-enters the claim queue. Mirrors analysisJobsRepo.resetForManualRetry. */
export async function resetForManualRetry(db: Queryable, jobId: string): Promise<ProjectSourceAnalysisJob | null> {
  const result = await db.query(
    `UPDATE project_source_analysis_jobs
     SET status = 'QUEUED', next_retry_at = NULL, error_type = NULL, sanitized_error = NULL,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE job_id = $1 AND status = 'FAILED'
     RETURNING ${JOB_COLUMNS}`,
    [jobId],
  );
  return result.rows[0] ? mapRow(result.rows[0] as JobRow) : null;
}
