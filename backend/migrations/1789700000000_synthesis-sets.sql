-- Up Migration

-- Phase 4J: the Synthesis Set configuration layer — a persistent, named
-- grouping of project_sources the user intends to synthesize together, and
-- its many-to-many membership. Purely additive — no existing table
-- (projects, project_sources, project_source_analysis_jobs,
-- project_source_analyses, project_source_media, courses, lessons,
-- analysis_jobs, lesson_analyses, synthesis_runs, strategy_clusters,
-- canonical_strategies, course_playbooks, usage_records) is altered, and
-- no existing row is touched.
--
-- This is DELIBERATELY NOT `project_sources.include_in_synthesis` — a
-- boolean on a source cannot represent membership in several different
-- synthesis configurations at once (a source can belong to zero, one, or
-- many Synthesis Sets). The relationship is Synthesis Set <-> Source, not
-- a global flag on Source.
--
-- This is also DELIBERATELY NOT the existing `synthesis_runs` /
-- `strategy_clusters` / `canonical_strategies` / `course_playbooks`
-- machinery (Phase 3.4's course-wide Whop synthesis engine, course_id
-- -scoped) — that engine is completely untouched by this phase and stays
-- untouched: a Synthesis Set is a NEW, separate configuration concept that
-- does not execute anything. Phase 4K will decide how (or whether) a
-- Synthesis Set eventually drives a synthesis execution; this migration
-- adds no run/execution table of any kind.
--
-- `project_source_id`, not a polymorphic (source_type, source_id) pair:
-- Whop lessons do not currently live in `project_sources` at all (they
-- live in `lessons`, reached via `courses.project_id`) — see
-- 1789400000000_project-sources.sql's own precedent of NOT forcing Whop
-- into this table. A genuine BIGINT FK gives real referential integrity
-- today, for the sources that actually exist in this table (YouTube,
-- Discord). Introducing string-typed polymorphism now, before a second
-- membership shape is ever needed, would trade away that integrity for
-- speculative future flexibility — the smallest correct model wins here;
-- a future phase that needs to let a Synthesis Set reference a Whop lesson
-- can decide deliberately how to extend this (e.g. a parallel
-- `synthesis_set_lessons` table, or a real project_sources-unifying
-- migration) once that requirement is concrete.
-- The `UNIQUE (id, project_id)` below adds no real constraint beyond what
-- already holds (id is already globally unique as the primary key) — its
-- only purpose is to expose the pair as a valid composite-FK target for
-- synthesis_set_sources below, which is how cross-project membership gets
-- rejected at the database layer, not just in application code.
CREATE TABLE synthesis_sets (
  id            BIGSERIAL PRIMARY KEY,
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, project_id)
);
CREATE INDEX synthesis_sets_project_idx ON synthesis_sets (project_id, created_at DESC);

-- project_sources already exists (see 1789400000000_project-sources.sql,
-- already merged) — this ALTER TABLE lives here, in the new migration,
-- rather than editing that already-applied one. Same reasoning as the
-- UNIQUE on synthesis_sets above: id is already project_sources' own
-- primary key (globally unique), so this adds no real constraint beyond
-- what already holds, it only exposes the pair as a composite-FK target.
ALTER TABLE project_sources ADD CONSTRAINT project_sources_id_project_id_key UNIQUE (id, project_id);

-- The many-to-many join. PRIMARY KEY on the pair IS the uniqueness
-- guarantee (adding the same source to the same set twice is a race-safe
-- ON CONFLICT DO NOTHING no-op — see db/synthesisSetSourcesRepo.ts — never
-- a duplicate row or a raw unique-violation error). No surrogate id: this
-- table is a pure membership fact with nothing else to key on.
--
-- Both foreign keys CASCADE from their own side (deleting a synthesis set
-- removes its memberships; deleting a project_source removes its
-- memberships) — but neither of those deletes ever cascades further INTO
-- project_source_analyses/project_source_analysis_jobs/project_sources
-- themselves: this table only ever references those rows, it never owns
-- or deletes them. Deleting a Synthesis Set must never delete a source or
-- its analysis; that is exactly what this FK direction guarantees.
--
-- Cross-project membership (a source from a different project than the
-- synthesis set) cannot be rejected by a plain CHECK constraint in
-- Postgres (a CHECK cannot reference another table's row) — but it CAN be,
-- and is, rejected by relational integrity: `project_id` is stored
-- redundantly on every membership row, and BOTH foreign keys below are
-- composite, referencing (id, project_id) on their respective parent
-- rather than id alone. That forces this row's `project_id` to equal both
-- the referenced synthesis_set's project_id AND the referenced
-- project_source's project_id simultaneously — which is only possible
-- when the set and the source already belong to the same project. A
-- direct SQL INSERT that tries to attach a source from a different
-- project fails with a foreign-key violation, full stop, with no way to
-- route around it. Application code (see
-- synthesisSetSourcesRepo.addSourceToSynthesisSet and
-- http/routes/synthesisSets.ts) still checks this too, ahead of the
-- insert — not because the database can't enforce it, but so a
-- cross-project attempt gets the app's own precise 404 rather than a raw
-- Postgres constraint-violation error. Both layers stay in place
-- deliberately: the app layer for a clean, predictable API response, the
-- database layer as the actual, unbypassable guarantee.
CREATE TABLE synthesis_set_sources (
  synthesis_set_id   BIGINT NOT NULL,
  project_source_id  BIGINT NOT NULL,
  project_id         BIGINT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (synthesis_set_id, project_source_id),
  FOREIGN KEY (synthesis_set_id, project_id) REFERENCES synthesis_sets (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_source_id, project_id) REFERENCES project_sources (id, project_id) ON DELETE CASCADE
);
-- Supports "which sets is this source a member of" (e.g. a future Sources
-- -page "Add to Synthesis" control) without a sequential scan.
CREATE INDEX synthesis_set_sources_source_idx ON synthesis_set_sources (project_source_id);

-- Down Migration

DROP TABLE synthesis_set_sources;
DROP TABLE synthesis_sets;
ALTER TABLE project_sources DROP CONSTRAINT project_sources_id_project_id_key;
