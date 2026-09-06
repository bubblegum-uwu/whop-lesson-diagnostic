-- Up Migration

-- Phase 3.4: course-level strategy synthesis. Purely additive — never reads
-- from or writes to analysis_jobs/lesson_analyses/strategy_instances beyond
-- SELECTing already-persisted lesson_analyses/strategy_instances rows as
-- read-only source evidence (see backend/src/synthesis/).

CREATE TYPE synthesis_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- One row per synthesis attempt ("run"). A plain re-click of "Synthesize
-- Course" that finds an identical source_analysis_hash to the latest
-- COMPLETED run is a no-op (returns that run, no new row); "Re-synthesize"
-- (force) always inserts a new row, preserving every prior version's
-- strategy_clusters/canonical_strategies/course_playbooks untouched — see
-- synthesisRunsRepo.ts. lease_owner/lease_expires_at/last_heartbeat_at
-- mirror analysis_jobs' crash-recoverable lease exactly (see
-- worker/synthesisLoop.ts and worker/heartbeat.ts), since this can run for
-- several minutes across multiple Gemini calls.
CREATE TABLE synthesis_runs (
  run_id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id                    BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status                       synthesis_status NOT NULL DEFAULT 'QUEUED',
  current_stage                TEXT,
  source_analysis_hash         TEXT NOT NULL,
  -- The latest completed/no_strategy lesson_analyses.analysis_id per
  -- contributing lesson, at the moment this run was created — denormalized
  -- for the Sources tab and for debugging; source_analysis_hash is the
  -- actual idempotency/out-of-date key, derived deterministically from this
  -- same set (see synthesis/fingerprint.ts).
  source_analysis_ids          BIGINT[] NOT NULL,
  model                        TEXT NOT NULL,
  synthesis_prompt_version     TEXT NOT NULL,
  synthesis_schema_version     TEXT NOT NULL,
  synthesizer_version          TEXT NOT NULL,
  lease_owner                  TEXT,
  lease_expires_at             TIMESTAMPTZ,
  last_heartbeat_at            TIMESTAMPTZ,
  started_at                   TIMESTAMPTZ,
  completed_at                 TIMESTAMPTZ,
  input_tokens                 INTEGER,
  output_tokens                INTEGER,
  thinking_tokens              INTEGER,
  estimated_cost               NUMERIC(10,4),
  processing_duration_seconds  INTEGER,
  error_type                   TEXT,
  sanitized_error              TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX synthesis_runs_course_idx ON synthesis_runs (course_id, created_at DESC);
-- Supports the claim query's WHERE clause (queued OR nonterminal-and-lease-expired), same shape as analysis_jobs_claimable_idx.
CREATE INDEX synthesis_runs_claimable_idx ON synthesis_runs (status, lease_expires_at);

-- One row per proposed cluster within a run (Stage 2 output). cluster_json
-- holds member instance/lesson ids, original names, similarity rationale,
-- and noted differences/variants — see synthesis/schema.ts ClusterSchema.
CREATE TABLE strategy_clusters (
  cluster_id      BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES synthesis_runs(run_id) ON DELETE CASCADE,
  cluster_key     TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  cluster_json    JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX strategy_clusters_run_idx ON strategy_clusters (run_id);

-- One row per canonical strategy (Stage 3 output, one per cluster).
-- strategy_json holds the full 16-section canonical strategy with
-- per-rule provenance — see synthesis/schema.ts CanonicalStrategySchema.
CREATE TABLE canonical_strategies (
  canonical_strategy_id  BIGSERIAL PRIMARY KEY,
  run_id                 UUID NOT NULL REFERENCES synthesis_runs(run_id) ON DELETE CASCADE,
  cluster_id             BIGINT NOT NULL REFERENCES strategy_clusters(cluster_id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  strategy_json          JSONB NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX canonical_strategies_run_idx ON canonical_strategies (run_id);

-- One row per run: the course-wide artifacts that sit above individual
-- canonical strategies (Stage 4/5/6 output). Kept as one row rather than a
-- 1:1 extension of synthesis_runs so that table stays focused on run
-- bookkeeping rather than large JSON blobs.
CREATE TABLE course_playbooks (
  playbook_id             BIGSERIAL PRIMARY KEY,
  run_id                  UUID NOT NULL UNIQUE REFERENCES synthesis_runs(run_id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  core_framework_json     JSONB NOT NULL,
  playbook_json           JSONB NOT NULL,
  decision_framework_json JSONB NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE course_playbooks;
DROP TABLE canonical_strategies;
DROP TABLE strategy_clusters;
DROP TABLE synthesis_runs;
DROP TYPE synthesis_status;
