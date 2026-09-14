-- Up Migration

-- Pre-4M — the Whop Synthesis Set bridge. Purely additive: no existing
-- table (courses, lessons, lesson_analyses, synthesis_runs, course_playbooks,
-- synthesis_sets, synthesis_set_sources, project_whop_lesson_imports) is
-- altered, and no existing row is touched.
--
-- The 1789700000000_synthesis-sets.sql migration deliberately kept
-- synthesis_set_sources scoped to `project_sources` alone, and explicitly
-- anticipated this exact follow-up: "a future phase that needs to let a
-- Synthesis Set reference a Whop lesson can decide deliberately how to
-- extend this (e.g. a parallel synthesis_set_lessons table...) once that
-- requirement is concrete." This is that phase.
--
-- WHY NOT a composite (id, project_id) FK like synthesis_set_sources uses
-- against project_sources: `lessons` has no `project_id` column at all — a
-- lesson's project is reached only transitively, via EITHER
-- `courses.project_id = P` (a fully-connected course) OR a row in
-- `project_whop_lesson_imports` keyed by lesson_id (an à-la-carte import;
-- see 1789900000000_whop-ala-carte-lessons.sql, which deliberately made
-- lesson_id its PRIMARY KEY so a lesson can be à-la-carted into at most one
-- project, ever). Because that "OR" can't be expressed as a single FK
-- target, cross-project membership here is validated in application code
-- (see backend/src/db/lessonProjectAccessRepo.ts), the same OR-rule
-- whopCourses.ts/whopLessons.ts already enforce for course-connect and
-- à-la-carte import — never a new/different ownership rule. `lesson_id`
-- still carries a real FK to `lessons(id)` for referential integrity, and
-- `(synthesis_set_id, project_id)` still carries a real composite FK to
-- synthesis_sets — only the "does this lesson truly belong to this
-- project" half is an application-level check rather than a database one.
CREATE TABLE synthesis_set_lessons (
  synthesis_set_id  BIGINT NOT NULL,
  lesson_id         BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  project_id        BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (synthesis_set_id, lesson_id),
  FOREIGN KEY (synthesis_set_id, project_id) REFERENCES synthesis_sets (id, project_id) ON DELETE CASCADE
);
-- Supports "which sets is this lesson a member of" without a sequential scan — same shape as synthesis_set_sources_source_idx.
CREATE INDEX synthesis_set_lessons_lesson_idx ON synthesis_set_lessons (lesson_id);

-- A small compatibility relation attaching a recovered/historical, course-
-- scoped synthesis_runs row to a Synthesis Set. This is NOT the Phase 4M
-- run/execution model — it references the existing immutable
-- synthesis_runs/course_playbooks rows read-only; it never mutates
-- synthesis_runs.course_id, never rewrites a run into a new execution
-- format, and never copies course_playbooks. A future Phase 4M may later
-- unify/generalize execution history; this bridge stays small and explicit
-- on purpose.
--
-- `run_id` is the PRIMARY KEY (not part of a composite unique pair) —
-- deliberately: a legacy synthesis_runs row attaches to AT MOST ONE
-- recovered Synthesis Set, ever. Reasoning: a run already belongs to
-- exactly one course (synthesis_runs.course_id, immutable), and nothing in
-- the product requires the same historical run to be "current" under two
-- different sets at once — allowing that would only create ambiguity about
-- which set is the run's canonical home with no offsetting benefit. This
-- mirrors project_whop_lesson_imports' own single-owner precedent
-- (lesson_id PRIMARY KEY) at the run level instead of the lesson level.
CREATE TABLE synthesis_set_legacy_runs (
  run_id            UUID NOT NULL PRIMARY KEY REFERENCES synthesis_runs(run_id) ON DELETE CASCADE,
  synthesis_set_id  BIGINT NOT NULL,
  project_id        BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (synthesis_set_id, project_id) REFERENCES synthesis_sets (id, project_id) ON DELETE CASCADE
);
CREATE INDEX synthesis_set_legacy_runs_set_idx ON synthesis_set_legacy_runs (synthesis_set_id, created_at DESC);

-- Down Migration

DROP TABLE synthesis_set_legacy_runs;
DROP TABLE synthesis_set_lessons;
