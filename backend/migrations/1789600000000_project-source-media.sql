-- Up Migration

-- Phase 4I durability fix. Purely additive — no existing table (project_sources,
-- project_source_analysis_jobs, project_source_analyses, courses, lessons,
-- analysis_jobs, lesson_analyses, synthesis_runs, usage_records) is altered
-- or backfilled, and no existing row is touched.
--
-- WHY THIS TABLE EXISTS: a Discord CDN attachment URL
-- (cdn.discordapp.com / media.discordapp.net) carries signed, time-limited
-- query parameters (`ex`/`is`/`hm`) that Discord itself issues and expires.
-- Unlike Whop (which re-resolves a fresh signed Mux URL from Whop's own API
-- on every single analysis attempt, using the live OAuth connection — see
-- pipeline/analyzeLesson.ts) or YouTube (whose public watch URL has no
-- expiry and is fully reconstructable from external_id alone), Knovera has
-- no ongoing Discord API/bot connection to re-request a fresh signed URL
-- later. The ONLY moment a Discord source's signed URL is guaranteed valid
-- is the moment the user pastes it in. If Knovera relied on that URL for
-- every future acquisition (including Re-analyze, arbitrarily far in the
-- future), analysis would silently start failing once the signature
-- expired — unacceptable for a persistent project_source.
--
-- The fix: at the moment a Discord source is added (while its pasted URL
-- is fresh), the actual video bytes are downloaded once and stored durably
-- here, in the same Postgres instance that is already this application's
-- only durable store (there is no object/blob storage subsystem in this
-- repo, and introducing one — a GCS bucket, an S3 bucket, credentials,
-- lifecycle policies — would be a substantial new storage subsystem for a
-- PoC-scale app that already has a durable store sitting right here).
-- Every subsequent acquisition (the first Analyze AND every Re-analyze)
-- reads these persisted bytes instead of ever touching the original
-- signed URL again — see discord/downloadDiscordAttachment.ts (the
-- one-time capture, at add-time) and worker/projectSourceAnalysisLoop.ts
-- (which now uploads these persisted bytes to Gemini Files at analysis
-- time, mirroring the exact upload/waitUntilActive/deleteFile pattern
-- already used for Whop lessons, rather than ever passing a raw external
-- URL to Gemini for this provider).
--
-- One row per project_source (1:1, PRIMARY KEY IS the FK) — there is
-- nothing to key on beyond the source itself, and ON DELETE CASCADE keeps
-- this row's lifetime tied to its source exactly like every other
-- project-source-owned table in this schema.
--
-- Kept as its own table rather than new columns on project_sources: large
-- binary content on the row that virtually every other query
-- (list/analyze/retry/GET-analysis) already SELECTs from would bloat every
-- one of those unrelated reads. Isolating it here means only the one
-- worker read path that actually needs the bytes ever touches this table.
CREATE TABLE project_source_media (
  project_source_id  BIGINT PRIMARY KEY REFERENCES project_sources(id) ON DELETE CASCADE,
  content             BYTEA NOT NULL,
  content_type        TEXT NOT NULL,
  byte_size           BIGINT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE project_source_media;
