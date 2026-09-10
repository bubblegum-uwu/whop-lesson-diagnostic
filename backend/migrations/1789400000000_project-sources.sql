-- Up Migration

-- Phase 4H-A: the first non-Whop project source. Purely additive — no
-- existing table (courses, lessons, analysis_jobs, lesson_analyses,
-- synthesis_runs, usage_records) is altered, and no existing row is
-- touched. MasterMind's Whop course keeps exactly its current
-- representation (see 1789300000000_project-model.sql); project_sources is
-- a second, independent ownership path that references `projects` directly
-- instead of through `courses` — see db/projectSourcesRepo.ts.
--
-- `provider` is deliberately plain TEXT, not an ENUM/CHECK restricted to
-- 'YOUTUBE': a CHECK/ENUM naming every supported provider would force
-- another migration the day Discord (Phase 4I) is added, for a constraint
-- whose only real job today is documentation. The actual allow-listing of
-- supported providers is enforced in application code — see
-- projectSourcesRepo.ts's SUPPORTED_PROJECT_SOURCE_PROVIDERS and
-- createYouTubeSource, the only writer this phase ships (it always inserts
-- the literal 'YOUTUBE', never a caller-supplied provider string). That is
-- both the more precise place to enforce it (URL shape/validation already
-- lives in application code, see lib/youtubeUrl.ts) and trivially
-- changeable without a migration when Discord is added.
--
-- `status` is deliberately source-record readiness, NOT analysis
-- readiness — Phase 4H-A never runs an analysis, so every row this phase
-- ever creates is 'READY' (meaning "this source record itself is stored
-- and complete") the moment it's inserted. A future FAILED here would mean
-- a source-level failure (e.g. metadata acquisition), never an analysis
-- failure — analysis state, once it exists (Phase 4H-B), belongs on its
-- own table, never overloaded onto this column.
--
-- Identity is (project_id, provider, external_id), never the raw URL —
-- the UNIQUE constraint below is the actual, race-safe duplicate guarantee
-- (see createYouTubeSource's ON CONFLICT), not an application-level
-- check-then-insert. The same video is allowed once per project and
-- allowed again in a different project — project_id is part of the key.
CREATE TABLE project_sources (
  id                BIGSERIAL PRIMARY KEY,
  project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  title             TEXT,
  duration_seconds  INTEGER,
  status            TEXT NOT NULL DEFAULT 'READY',
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider, external_id)
);
CREATE INDEX project_sources_project_idx ON project_sources (project_id, created_at DESC);

-- Down Migration

DROP TABLE project_sources;
