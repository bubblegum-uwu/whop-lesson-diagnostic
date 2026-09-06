-- Up Migration

CREATE TYPE job_status AS ENUM (
  'QUEUED', 'RETRIEVING', 'PREPARING_VIDEO', 'UPLOADING', 'GEMINI_PROCESSING',
  'ANALYZING', 'VALIDATING', 'COMPLETED', 'NO_STRATEGY', 'FAILED',
  'AUTH_REQUIRED', 'CANCELLED'
);

-- One row per "processing episode" for a lesson. A transient-failure retry
-- reuses the same row (attempt_count++); an explicit force re-analyze
-- creates a brand new row (new job_id) so the old lesson_analyses history is
-- never touched. lease_owner/lease_expires_at implement a crash-recoverable
-- lease: a worker execution claims a job by writing its own identity and a
-- short-lived expiry, renews it via heartbeat while working, and any later
-- worker execution may reclaim the row once the lease has expired — see
-- db/analysisJobsRepo.ts claimNextEligibleJob/renewLease.
CREATE TABLE analysis_jobs (
  job_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id             BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  analysis_fingerprint  TEXT NOT NULL,
  status                job_status NOT NULL DEFAULT 'QUEUED',
  current_stage         TEXT,
  stage_progress        NUMERIC(5,2),
  overall_progress      NUMERIC(5,2),
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  lease_owner           TEXT,
  lease_expires_at      TIMESTAMPTZ,
  queued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  last_heartbeat_at     TIMESTAMPTZ,
  next_retry_at         TIMESTAMPTZ,
  error_type            TEXT,
  sanitized_error       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analysis_jobs_lesson_idx ON analysis_jobs (lesson_id, created_at DESC);
CREATE INDEX analysis_jobs_status_idx ON analysis_jobs (status);
-- Supports the claim query's WHERE clause (queued-and-due OR nonterminal-and-lease-expired).
CREATE INDEX analysis_jobs_claimable_idx ON analysis_jobs (status, next_retry_at, lease_expires_at);

CREATE TABLE job_events (
  event_id    BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES analysis_jobs(job_id) ON DELETE CASCADE,
  stage       TEXT,
  event_type  TEXT NOT NULL,
  progress    NUMERIC(5,2),
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events (job_id, created_at);
CREATE INDEX job_events_created_idx ON job_events (created_at);

-- One row per terminal (successful) analysis. UNIQUE(job_id) is the hard
-- guarantee behind "one successful result per job execution": even if a
-- reclaimed/duplicate worker somehow reaches completion twice for the same
-- job, the second insert fails outright. Uniqueness is deliberately NOT
-- enforced on analysis_fingerprint alone, because an explicit "Re-analyze"
-- must be able to add a second successful row with the same fingerprint —
-- fingerprint-based "skip if already analyzed" is an application-level
-- check at enqueue time, not a DB constraint.
CREATE TABLE lesson_analyses (
  analysis_id                  BIGSERIAL PRIMARY KEY,
  lesson_id                    BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  job_id                       UUID NOT NULL UNIQUE REFERENCES analysis_jobs(job_id),
  status                       TEXT NOT NULL,
  strategy_found               BOOLEAN NOT NULL,
  validated_json               JSONB NOT NULL,
  analysis_summary             TEXT NOT NULL,
  model                        TEXT NOT NULL,
  prompt_version               TEXT NOT NULL,
  extractor_version            TEXT NOT NULL,
  schema_version                TEXT NOT NULL,
  analysis_fingerprint          TEXT NOT NULL,
  started_at                    TIMESTAMPTZ NOT NULL,
  completed_at                  TIMESTAMPTZ NOT NULL,
  processing_duration_seconds   INTEGER,
  input_tokens                  INTEGER,
  output_tokens                 INTEGER,
  thinking_tokens                INTEGER,
  estimated_cost                 NUMERIC(10,4),
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lesson_analyses_lesson_idx ON lesson_analyses (lesson_id, created_at DESC);
CREATE INDEX lesson_analyses_fingerprint_idx ON lesson_analyses (analysis_fingerprint, status);

CREATE TABLE strategy_instances (
  strategy_instance_id      BIGSERIAL PRIMARY KEY,
  analysis_id               BIGINT NOT NULL REFERENCES lesson_analyses(analysis_id) ON DELETE CASCADE,
  lesson_id                 BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  strategy_name             TEXT NOT NULL,
  normalized_name           TEXT NOT NULL,
  validated_strategy_json   JSONB NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX strategy_instances_analysis_idx ON strategy_instances (analysis_id);
CREATE INDEX strategy_instances_normalized_name_idx ON strategy_instances (normalized_name);

CREATE TABLE usage_records (
  usage_id                     BIGSERIAL PRIMARY KEY,
  analysis_id                  BIGINT NOT NULL REFERENCES lesson_analyses(analysis_id) ON DELETE CASCADE,
  model                        TEXT NOT NULL,
  input_tokens                 INTEGER,
  output_tokens                INTEGER,
  thinking_tokens              INTEGER,
  video_duration_seconds       INTEGER,
  estimated_cost               NUMERIC(10,4),
  pricing_version              TEXT NOT NULL,
  processing_duration_seconds  INTEGER,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_analysis_idx ON usage_records (analysis_id);

-- Down Migration

DROP TABLE usage_records;
DROP TABLE strategy_instances;
DROP TABLE lesson_analyses;
DROP TABLE job_events;
DROP TABLE analysis_jobs;
DROP TYPE job_status;
