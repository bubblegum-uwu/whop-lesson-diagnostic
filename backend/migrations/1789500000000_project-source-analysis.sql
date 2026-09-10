-- Up Migration

-- Phase 4H-B: generic, provider-neutral analysis for project_sources (Phase
-- 4H-A). Purely additive — no existing table (courses, lessons,
-- analysis_jobs, lesson_analyses, strategy_instances, usage_records,
-- synthesis_runs, project_sources) is altered, dropped, or backfilled.
-- MasterMind's Whop analysis path is completely untouched: this is a
-- SECOND, independent path, never a polymorphic extension of the frozen
-- lesson-analysis tables (see the Phase 4H-B PR description's explicit
-- "do not add a nullable project_source_id to analysis_jobs/lesson_analyses"
-- rule).
--
-- Deliberately smaller than analysis_jobs/lesson_analyses, not a blind
-- mirror — see backend/src/db/projectSourceAnalysisJobsRepo.ts and
-- projectSourceAnalysesRepo.ts for what each trimmed field would have been:
--   * No RETRIEVING/PREPARING_VIDEO/UPLOADING/AUTH_REQUIRED stages — a
--     YouTube source's acquisition is a synchronous, in-process URL
--     reconstruction (see youtube/acquireYouTubeVideo.ts), never a Whop
--     fetch, ffmpeg remux, or Gemini Files upload. AUTH_REQUIRED
--     specifically can never apply: YouTube analysis never touches Whop
--     OAuth at all (see the Phase 4H-B PR description's Whop-independence
--     rule).
--   * No `current_stage` column — analysis_jobs carries both a coarse
--     `status` (job_status enum) AND a finer-grained free-text
--     `current_stage`, because several distinct Whop pipeline stages
--     collapse into one status value there. This table's own status enum
--     already has one value per real stage this job type has (no
--     collapsing), so a second column would just duplicate `status`.
--   * No `stage_progress`/`overall_progress` columns — there is no
--     continuous, real sub-stage progress to report for a job this short
--     (no ffmpeg percentage, no multi-minute upload poll); fabricating a
--     percentage here would violate "never fabricate progress." Status
--     transitions alone (QUEUED -> ANALYZING -> VALIDATING -> terminal)
--     are the only real signal.
--   * No project_source_strategy_instances table — the one existing
--     consumer of the equivalent lesson-side table, course-level synthesis
--     (Phase 3.4), is explicitly NOT extended to consume YouTube analyses
--     in Phase 4H-B (see the PR description's synthesis-out-of-scope
--     rule); every extracted strategy already lives inside this table's
--     own `validated_json`, which is sufficient for viewing a single
--     source's own result. Add a normalized table only if/when a future
--     phase actually needs to query strategies across multiple sources.
--   * No project-source-specific usage/cost table — same precedent as
--     `usage_records` vs `lesson_analyses.estimated_cost` (see
--     db/usageRepo.ts's doc comment): `project_source_analyses` IS the
--     source of truth for cost, read directly by usageRepo.ts's extended
--     query. A second, always-identical duplicate row would only risk
--     double counting.
--
-- `status` reuses a NEW enum (project_source_analysis_status), not the
-- existing `job_status` — same precedent as `synthesis_status` already
-- being its own enum distinct from `job_status` for a different job kind
-- with different real stages, rather than reusing job_status and leaving
-- most of its values (RETRIEVING, PREPARING_VIDEO, UPLOADING,
-- AUTH_REQUIRED) permanently unused here.
CREATE TYPE project_source_analysis_status AS ENUM (
  'QUEUED', 'ANALYZING', 'VALIDATING', 'COMPLETED', 'NO_STRATEGY', 'FAILED', 'CANCELLED'
);

-- One row per processing episode for a project_sources row — the exact
-- lease/attempt/retry shape as analysis_jobs (see that migration's
-- comment), applied to a provider-neutral `project_source_id` instead of
-- `lesson_id`. A transient-failure retry reuses the same row
-- (attempt_count++); an explicit force re-analyze creates a brand new row.
CREATE TABLE project_source_analysis_jobs (
  job_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_source_id    BIGINT NOT NULL REFERENCES project_sources(id) ON DELETE CASCADE,
  analysis_fingerprint TEXT NOT NULL,
  status               project_source_analysis_status NOT NULL DEFAULT 'QUEUED',
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  lease_owner          TEXT,
  lease_expires_at     TIMESTAMPTZ,
  queued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  last_heartbeat_at    TIMESTAMPTZ,
  next_retry_at        TIMESTAMPTZ,
  error_type           TEXT,
  sanitized_error      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_source_analysis_jobs_source_idx ON project_source_analysis_jobs (project_source_id, created_at DESC);
CREATE INDEX project_source_analysis_jobs_status_idx ON project_source_analysis_jobs (status);
-- Supports the claim query's WHERE clause, identical shape to analysis_jobs_claimable_idx.
CREATE INDEX project_source_analysis_jobs_claimable_idx ON project_source_analysis_jobs (status, next_retry_at, lease_expires_at);

-- One row per terminal (successful) analysis — same UNIQUE(job_id) hard
-- guarantee as lesson_analyses, same reasoning: even a reclaimed/duplicate
-- worker execution can never insert two rows for one job. `validated_json`
-- is the EXACT SAME LessonStrategyAnalysis shape lesson_analyses.
-- validated_json already stores (gemini/schema.ts, unchanged) — every
-- per-item evidence/timestamp lives inside it already, so no separate
-- provenance columns are needed here beyond project_source_id itself.
CREATE TABLE project_source_analyses (
  analysis_id                  BIGSERIAL PRIMARY KEY,
  project_source_id            BIGINT NOT NULL REFERENCES project_sources(id) ON DELETE CASCADE,
  job_id                       UUID NOT NULL UNIQUE REFERENCES project_source_analysis_jobs(job_id),
  status                       TEXT NOT NULL,
  strategy_found               BOOLEAN NOT NULL,
  validated_json               JSONB NOT NULL,
  analysis_summary             TEXT NOT NULL,
  model                        TEXT NOT NULL,
  prompt_version               TEXT NOT NULL,
  extractor_version             TEXT NOT NULL,
  schema_version                TEXT NOT NULL,
  analysis_fingerprint           TEXT NOT NULL,
  started_at                     TIMESTAMPTZ NOT NULL,
  completed_at                   TIMESTAMPTZ NOT NULL,
  processing_duration_seconds    INTEGER,
  input_tokens                   INTEGER,
  output_tokens                  INTEGER,
  thinking_tokens                 INTEGER,
  estimated_cost                  NUMERIC(10,4),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_source_analyses_source_idx ON project_source_analyses (project_source_id, created_at DESC);
CREATE INDEX project_source_analyses_fingerprint_idx ON project_source_analyses (analysis_fingerprint, status);

-- Down Migration

DROP TABLE project_source_analyses;
DROP TABLE project_source_analysis_jobs;
DROP TYPE project_source_analysis_status;
