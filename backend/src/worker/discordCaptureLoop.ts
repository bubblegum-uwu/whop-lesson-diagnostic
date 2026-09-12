import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  claimNextEligibleDiscordCaptureJob,
  markDiscordCaptureJobCompleted,
  markDiscordCaptureJobFailed,
  type DiscordCaptureJobRow,
} from "../db/discordCaptureJobsRepo.js";
import { createDiscordSource, deleteProjectSource } from "../db/projectSourcesRepo.js";
import { saveContentAssetMedia, deleteContentAsset } from "../db/contentAssetsRepo.js";
import {
  downloadDiscordAttachment as defaultDownloadDiscordAttachment,
  DiscordAttachmentDownloadError,
  type DownloadedDiscordAttachment,
} from "../discord/downloadDiscordAttachment.js";
import { globalRedactor, type SecretRedactor } from "../lib/redact.js";
import { logger as defaultLogger, type SafeLogger } from "../lib/logger.js";

export interface DiscordCaptureWorkerDeps {
  pool: Pool;
  redactor?: SecretRedactor;
  logger?: SafeLogger;
  /** Test-only override — production always uses the real downloader. */
  downloadDiscordAttachment?: (sourceUrl: string) => Promise<DownloadedDiscordAttachment>;
}

/**
 * A SEPARATE advisory lock key from every other worker phase's (see
 * worker/advisoryLock.ts's 5_902_331_004, synthesisLoop.ts's
 * 5_902_331_005, projectSourceAnalysisLoop.ts's 5_902_331_006) — this
 * queue can never block, or be blocked by, lesson analysis, course
 * synthesis, or project-source analysis.
 */
const DISCORD_CAPTURE_LOCK_KEY = 5_902_331_007;

interface DiscordCaptureLock {
  acquired: boolean;
  release(): Promise<void>;
}

async function acquireDiscordCaptureLock(pool: Pool): Promise<DiscordCaptureLock> {
  const client: PoolClient = await pool.connect();
  client.on("error", () => undefined);
  const result = await client.query<{ pg_try_advisory_lock: boolean }>("SELECT pg_try_advisory_lock($1)", [DISCORD_CAPTURE_LOCK_KEY]);
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
        await client.query("SELECT pg_advisory_unlock($1)", [DISCORD_CAPTURE_LOCK_KEY]);
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Phase 4K-B (revised) — durable capture is a single bounded operation
 * (downloadDiscordAttachment's own 30s timeout, not a long-running
 * multi-step pipeline), so this deliberately has NO heartbeat/lease-renewal
 * machinery, unlike worker/projectSourceAnalysisLoop.ts's ANALYZING job.
 * A crash mid-capture is recovered the same way any stale lease is (see
 * claimNextEligibleDiscordCaptureJob's doc comment): a later worker
 * execution simply reclaims the expired lease and reprocesses the job —
 * createDiscordSource's upsert makes that always safe to redo.
 *
 * Mirrors createAddDiscordSourceHandler's exact create-then-download-
 * then-compensate shape (see http/routes/projectSources.ts) so the same
 * (owner_identity, provider, external_id) dedup key — the attachment id —
 * converges Save-to-Knovera capture with à-la-carte Discord URL import on
 * one durable asset, regardless of which path touches it first.
 */
async function processOneDiscordCaptureJob(job: DiscordCaptureJobRow, leaseOwner: string, deps: DiscordCaptureWorkerDeps): Promise<void> {
  const redactor = deps.redactor ?? globalRedactor;
  const log = deps.logger ?? defaultLogger;
  const download = deps.downloadDiscordAttachment ?? defaultDownloadDiscordAttachment;

  if (job.collectionId == null) {
    // Should be unreachable — the interaction handler always resolves a
    // channel collection before creating a job (spec section 28). Defensive
    // only: never silently drop a capture into no collection at all.
    await markDiscordCaptureJobFailed(deps.pool, job.id, leaseOwner, "The Discord channel collection for this capture no longer exists.");
    return;
  }

  try {
    const { source, created, assetCreated, contentAssetId } = await createDiscordSource(deps.pool, {
      projectId: job.projectId,
      ownerIdentity: job.ownerIdentity,
      externalId: job.attachmentId,
      sourceUrl: job.attachmentUrl,
      collectionId: job.collectionId,
      title: job.filename,
    });

    if (assetCreated) {
      try {
        const media = await download(job.attachmentUrl);
        await saveContentAssetMedia(deps.pool, { contentAssetId, content: media.content, contentType: media.contentType, byteSize: media.byteSize });
      } catch (err) {
        // Order matters: project_sources.content_asset_id references
        // content_assets ON DELETE RESTRICT, so the referencing row must
        // go first — same rationale as createAddDiscordSourceHandler.
        if (created) await deleteProjectSource(deps.pool, source.id);
        await deleteContentAsset(deps.pool, contentAssetId);
        const message = err instanceof DiscordAttachmentDownloadError ? err.message : "Could not download this Discord attachment.";
        await markDiscordCaptureJobFailed(deps.pool, job.id, leaseOwner, redactor.redact(message));
        return;
      }
    }

    const completed = await markDiscordCaptureJobCompleted(deps.pool, job.id, leaseOwner, source.id);
    if (!completed) {
      log.warn("Discord capture job's lease was reclaimed before it could be marked completed.", { jobId: job.id });
    }
  } catch (err) {
    const sanitizedMessage = redactor.redact(err instanceof Error ? err.message : "Unknown Discord capture worker error.");
    log.error("Discord capture job failed", { jobId: job.id, message: sanitizedMessage });
    await markDiscordCaptureJobFailed(deps.pool, job.id, leaseOwner, sanitizedMessage);
  }
}

/**
 * The Cloud Run Job entrypoint's FOURTH phase — called after
 * runProjectSourceAnalysisLoop has already drained (see server.ts). Claims
 * and durably captures eligible discord_capture_jobs one at a time until
 * none remain. Never calls Gemini and never creates an analysis job —
 * capture and analysis are deliberately separate steps (spec: CAPTURE ≠
 * ANALYZE); a captured source starts "Not analyzed" and is only ever
 * analyzed by an explicit later Analyze action.
 */
export async function runDiscordCaptureLoop(deps: DiscordCaptureWorkerDeps): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const lock = await acquireDiscordCaptureLock(deps.pool);
  if (!lock.acquired) {
    log.info("Another Discord capture worker execution already holds the lock — exiting.", {});
    return;
  }

  const leaseOwner = `${process.env.CLOUD_RUN_EXECUTION ?? "local"}:${process.env.CLOUD_RUN_TASK_INDEX ?? "0"}:${randomUUID()}`;

  try {
    for (;;) {
      const job = await claimNextEligibleDiscordCaptureJob(deps.pool, leaseOwner);
      if (!job) break;
      log.info("Claimed Discord capture job", { jobId: job.id, attachmentId: job.attachmentId });
      await processOneDiscordCaptureJob(job, leaseOwner, deps);
    }
  } finally {
    await lock.release();
  }
}
