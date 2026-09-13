import type { Pool, PoolClient } from "pg";

/**
 * Phase 4K-B (revised) — the async capture job a "Save to Knovera"
 * interaction enqueues (spec section 24/25). Deliberately simpler than
 * project_source_analysis_jobs's full heartbeat/renew machinery: a
 * durable download is a single bounded operation (downloadDiscordAttachment's
 * own 30s timeout), never a long-running multi-step Gemini pipeline, so a
 * fixed lease duration with no mid-flight renewal is sufficient — see
 * worker/discordCaptureLoop.ts.
 */
export type DiscordCaptureJobStatus = "QUEUED" | "CAPTURING" | "COMPLETED" | "FAILED";

export interface DiscordCaptureJobRow {
  id: number;
  ownerIdentity: string;
  discordUserId: string;
  projectId: number;
  /** The per-channel source_collections row inside Discord Knowledge this capture belongs under (spec section 28) — organizational only, never null in practice (resolved before the job is created), but nullable at the DB level (ON DELETE SET NULL) so a since-deleted collection never blocks the job row itself. */
  collectionId: number | null;
  interactionId: string;
  messageId: string;
  channelId: string;
  guildId: string | null;
  channelLabel: string | null;
  attachmentId: string;
  attachmentUrl: string;
  filename: string;
  contentType: string | null;
  byteSize: number | null;
  status: DiscordCaptureJobStatus;
  attemptCount: number;
  projectSourceId: number | null;
  sanitizedError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface JobDbRow {
  id: string;
  owner_identity: string;
  discord_user_id: string;
  project_id: string;
  collection_id: string | null;
  interaction_id: string;
  message_id: string;
  channel_id: string;
  guild_id: string | null;
  channel_label: string | null;
  attachment_id: string;
  attachment_url: string;
  filename: string;
  content_type: string | null;
  byte_size: string | null;
  status: DiscordCaptureJobStatus;
  attempt_count: number;
  project_source_id: string | null;
  sanitized_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: JobDbRow): DiscordCaptureJobRow {
  return {
    id: Number(row.id),
    ownerIdentity: row.owner_identity,
    discordUserId: row.discord_user_id,
    projectId: Number(row.project_id),
    collectionId: row.collection_id == null ? null : Number(row.collection_id),
    interactionId: row.interaction_id,
    messageId: row.message_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    channelLabel: row.channel_label,
    attachmentId: row.attachment_id,
    attachmentUrl: row.attachment_url,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: row.byte_size == null ? null : Number(row.byte_size),
    status: row.status,
    attemptCount: row.attempt_count,
    projectSourceId: row.project_source_id == null ? null : Number(row.project_source_id),
    sanitizedError: row.sanitized_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  "id, owner_identity, discord_user_id, project_id, collection_id, interaction_id, message_id, channel_id, guild_id, channel_label, attachment_id, attachment_url, filename, content_type, byte_size, status, attempt_count, project_source_id, sanitized_error, created_at, updated_at";

export interface CreateDiscordCaptureJobInput {
  ownerIdentity: string;
  discordUserId: string;
  projectId: number;
  collectionId: number;
  interactionId: string;
  messageId: string;
  channelId: string;
  guildId: string | null;
  channelLabel: string | null;
  attachmentId: string;
  attachmentUrl: string;
  filename: string;
  contentType: string | null;
  byteSize: number | null;
}

/** UNIQUE(interaction_id, attachment_id) is the actual duplicate guarantee (spec section 56) — a redelivered/repeated interaction for the same attachment never creates a second job. `created: false` means this exact job already existed (returns the existing row, whatever its current status). */
export async function createDiscordCaptureJob(pool: Pool, input: CreateDiscordCaptureJobInput): Promise<{ job: DiscordCaptureJobRow; created: boolean }> {
  const inserted = await pool.query<JobDbRow>(
    `INSERT INTO discord_capture_jobs (owner_identity, discord_user_id, project_id, collection_id, interaction_id, message_id, channel_id, guild_id, channel_label, attachment_id, attachment_url, filename, content_type, byte_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (interaction_id, attachment_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.ownerIdentity,
      input.discordUserId,
      input.projectId,
      input.collectionId,
      input.interactionId,
      input.messageId,
      input.channelId,
      input.guildId,
      input.channelLabel,
      input.attachmentId,
      input.attachmentUrl,
      input.filename,
      input.contentType,
      input.byteSize,
    ],
  );
  if (inserted.rows[0]) return { job: mapRow(inserted.rows[0]), created: true };
  const existing = await pool.query<JobDbRow>(`SELECT ${COLUMNS} FROM discord_capture_jobs WHERE interaction_id = $1 AND attachment_id = $2`, [
    input.interactionId,
    input.attachmentId,
  ]);
  return { job: mapRow(existing.rows[0]), created: false };
}

const LEASE_DURATION = "2 minutes";

/** Same "due QUEUED or stale-leased" claim shape as project_source_analysis_jobs's claimNextEligibleJob — see that function's doc comment. */
export async function claimNextEligibleDiscordCaptureJob(pool: Pool, leaseOwner: string): Promise<DiscordCaptureJobRow | null> {
  const result = await pool.query<JobDbRow>(
    `UPDATE discord_capture_jobs
     SET status = 'CAPTURING',
         lease_owner = $1,
         lease_expires_at = now() + interval '${LEASE_DURATION}',
         attempt_count = attempt_count + 1,
         updated_at = now()
     WHERE id = (
       SELECT id FROM discord_capture_jobs
       WHERE status = 'QUEUED'
          OR (status = 'CAPTURING' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING ${COLUMNS}`,
    [leaseOwner],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Fenced completion — only succeeds if `leaseOwner` still matches (this execution's lease was never reclaimed). Accepts an optional client so the caller can commit the project_source creation and this status update in the same transaction. */
export async function markDiscordCaptureJobCompleted(db: Pool | PoolClient, jobId: number, leaseOwner: string, projectSourceId: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE discord_capture_jobs SET status = 'COMPLETED', project_source_id = $3, sanitized_error = NULL, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'CAPTURING'`,
    [jobId, leaseOwner, projectSourceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markDiscordCaptureJobFailed(pool: Pool, jobId: number, leaseOwner: string, sanitizedError: string): Promise<void> {
  await pool.query(`UPDATE discord_capture_jobs SET status = 'FAILED', sanitized_error = $3, updated_at = now() WHERE id = $1 AND lease_owner = $2`, [
    jobId,
    leaseOwner,
    sanitizedError,
  ]);
}

export async function getDiscordCaptureJobById(pool: Pool, id: number): Promise<DiscordCaptureJobRow | null> {
  const result = await pool.query<JobDbRow>(`SELECT ${COLUMNS} FROM discord_capture_jobs WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
