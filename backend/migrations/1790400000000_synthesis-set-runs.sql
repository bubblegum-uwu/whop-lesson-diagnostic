-- Up Migration

-- Phase 4M: the generalized IMMUTABLE Run model underneath a Synthesis Set.
-- Purely additive — no existing table (synthesis_sets, synthesis_set_sources,
-- synthesis_set_lessons, synthesis_set_legacy_runs, synthesis_runs,
-- course_playbooks, project_sources, project_source_analyses, lessons,
-- lesson_analyses) is altered, and no existing row is touched. The 7
-- recovered legacy Whop runs (synthesis_set_legacy_runs) are NEVER rewritten
-- into this shape — they stay exactly what they are (a reference to an
-- existing, immutable synthesis_runs row) and are presented alongside
-- native runs at the API layer only (see http/routes/synthesisSetRuns.ts),
-- never migrated/copied into these new tables.
--
-- Product hierarchy this enforces: Project -> Synthesis Set -> Run. A
-- Synthesis Set (synthesis_sets, Phase 4J) is the named, MUTABLE, current
-- curated selection (synthesis_set_sources / synthesis_set_lessons, Phase
-- 4J/pre-4M). A Run is an IMMUTABLE execution snapshot taken from that
-- selection at one explicit moment — never re-derived from current
-- membership after creation. Deselecting a source, re-analyzing it into a
-- newer analysis row, or changing the collection grouping must never alter
-- an already-created Run's snapshot; that is the entire reason the snapshot
-- rows below reference a specific project_source_analyses/lesson_analyses
-- ROW (analysis_id), not "the current analysis of this source" (which would
-- silently drift as new analyses are created).
CREATE TYPE synthesis_set_run_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- One row per Run. `run_id` is a UUID (matches synthesis_runs' own PK shape,
-- Phase 3.4 precedent) rather than a BIGSERIAL, so a Run's identity never
-- collides with, or needs disambiguating from, a legacy synthesis_runs.run_id
-- in any URL/response the two ever share.
--
-- `source_count`/`ready_count`/`skipped_not_ready_count` are the permanent
-- provenance answer to "what happened to selected-but-not-yet-analyzed
-- items at the moment this Run was created" (spec's "28 selected / 26
-- ready / 2 need analysis" requirement) — a Run only ever snapshots the
-- READY subset (see synthesis_set_run_sources/synthesis_set_run_lessons
-- below); these three counters make that decision permanently visible
-- rather than silently reconstructable-or-not from the snapshot rows alone.
--
-- `result_json` is deliberately nullable and only ever populated once a
-- future execution stage actually completes a run (see
-- src/whop/... equivalent for native runs — Phase 4M ships the immutable
-- Run/snapshot/history model; wiring an actual generalized multi-provider
-- Gemini synthesis EXECUTION engine is explicitly out of this migration's
-- scope, same as the Run History placeholder Phase 4L already shipped said
-- — see the PR description). A Run created today is legitimately QUEUED
-- and stays that way until a future phase's worker processes it; nothing
-- here fabricates a result.
CREATE TABLE synthesis_set_runs (
  run_id                    UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  synthesis_set_id          BIGINT NOT NULL,
  project_id                BIGINT NOT NULL,
  status                    synthesis_set_run_status NOT NULL DEFAULT 'QUEUED',
  model                     TEXT,
  prompt_version            TEXT,
  source_count              INTEGER NOT NULL,
  ready_count               INTEGER NOT NULL,
  skipped_not_ready_count   INTEGER NOT NULL,
  input_tokens              INTEGER,
  output_tokens             INTEGER,
  thinking_tokens           INTEGER,
  estimated_cost            NUMERIC(10,4),
  processing_duration_seconds INTEGER,
  error_type                TEXT,
  sanitized_error           TEXT,
  result_json               JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  -- Same composite-FK cross-project-safety technique as synthesis_set_sources
  -- / synthesis_set_lessons: a Run can only ever reference a set that truly
  -- belongs to `project_id`, enforced by the database, not just app code.
  FOREIGN KEY (synthesis_set_id, project_id) REFERENCES synthesis_sets (id, project_id) ON DELETE CASCADE
);
CREATE INDEX synthesis_set_runs_set_idx ON synthesis_set_runs (synthesis_set_id, created_at DESC);

-- The frozen input snapshot, generic-source half. One row per project_source
-- actually included in this Run — deliberately references the EXACT
-- project_source_analyses row used (`project_source_analysis_id`), never
-- just `project_source_id` alone, so the snapshot survives a later
-- re-analysis (which inserts a NEW project_source_analyses row, never
-- updates the old one) without ever silently repointing at the newer
-- analysis. ON DELETE CASCADE from project_source_analyses is intentionally
-- symmetric with every other analysis-row FK in this schema (e.g.
-- synthesis_set_sources' own project_source_id FK) — analyses are
-- insert-only and never deleted in normal operation, so this never fires in
-- practice; it exists only so a manual cleanup of a source can't leave an
-- orphaned snapshot row behind.
CREATE TABLE synthesis_set_run_sources (
  run_id                      UUID NOT NULL REFERENCES synthesis_set_runs(run_id) ON DELETE CASCADE,
  project_source_id           BIGINT NOT NULL REFERENCES project_sources(id) ON DELETE CASCADE,
  project_source_analysis_id  BIGINT NOT NULL REFERENCES project_source_analyses(analysis_id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, project_source_id)
);
CREATE INDEX synthesis_set_run_sources_run_idx ON synthesis_set_run_sources (run_id);

-- The frozen input snapshot, Whop-lesson half — same shape/reasoning as
-- synthesis_set_run_sources above, applied to `lessons`/`lesson_analyses`
-- instead of `project_sources`/`project_source_analyses`. Kept as its own
-- table rather than a polymorphic column, mirroring the exact same
-- (deliberate, documented) precedent as synthesis_set_lessons vs
-- synthesis_set_sources in 1790300000000_whop-synthesis-set-bridge.sql.
CREATE TABLE synthesis_set_run_lessons (
  run_id              UUID NOT NULL REFERENCES synthesis_set_runs(run_id) ON DELETE CASCADE,
  lesson_id           BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  lesson_analysis_id  BIGINT NOT NULL REFERENCES lesson_analyses(analysis_id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, lesson_id)
);
CREATE INDEX synthesis_set_run_lessons_run_idx ON synthesis_set_run_lessons (run_id);

-- Down Migration

DROP TABLE synthesis_set_run_lessons;
DROP TABLE synthesis_set_run_sources;
DROP TABLE synthesis_set_runs;
DROP TYPE synthesis_set_run_status;
