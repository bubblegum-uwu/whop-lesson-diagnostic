import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

export type JobEventType = "stage_change" | "progress" | "heartbeat" | "error";

export interface JobEvent {
  eventId: number;
  jobId: string;
  stage: string | null;
  eventType: JobEventType;
  progress: number | null;
  message: string | null;
  createdAt: Date;
}

interface JobEventRow {
  event_id: string;
  job_id: string;
  stage: string | null;
  event_type: JobEventType;
  progress: string | null;
  message: string | null;
  created_at: Date;
}

function mapRow(row: JobEventRow): JobEvent {
  return {
    eventId: Number(row.event_id),
    jobId: row.job_id,
    stage: row.stage,
    eventType: row.event_type,
    progress: row.progress == null ? null : Number(row.progress),
    message: row.message,
    createdAt: row.created_at,
  };
}

export async function recordJobEvent(
  db: Queryable,
  jobId: string,
  event: { stage?: string | null; eventType: JobEventType; progress?: number | null; message?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO job_events (job_id, stage, event_type, progress, message) VALUES ($1, $2, $3, $4, $5)`,
    [jobId, event.stage ?? null, event.eventType, event.progress ?? null, event.message ?? null],
  );
}

export async function listEventsSince(db: Queryable, since: Date): Promise<JobEvent[]> {
  const result = await db.query(
    `SELECT event_id, job_id, stage, event_type, progress, message, created_at
     FROM job_events WHERE created_at > $1 ORDER BY created_at ASC`,
    [since],
  );
  return (result.rows as JobEventRow[]).map(mapRow);
}

export async function listEventsForJob(db: Queryable, jobId: string): Promise<JobEvent[]> {
  const result = await db.query(
    `SELECT event_id, job_id, stage, event_type, progress, message, created_at
     FROM job_events WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId],
  );
  return (result.rows as JobEventRow[]).map(mapRow);
}
