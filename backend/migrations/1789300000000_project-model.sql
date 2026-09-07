-- Up Migration

-- Phase 4B: introduces a real Project entity above courses, and associates
-- the existing course with a seeded "MasterMind" project. Purely additive —
-- no existing table/column is dropped, renamed, or backfilled destructively,
-- and no lesson/analysis/synthesis row is touched.
--
-- courses.project_id is nullable and stays that way: this deployment is
-- still single-course/single-operator (see config.ts ScarfaceCourseConfig),
-- and coursesRepo.upsertCourse's INSERT/ON CONFLICT column list does not set
-- project_id, so it is never cleared or fought over by a routine course
-- sync. Tightening to NOT NULL is deferred until every course-creation path
-- can safely supply a project_id.

CREATE TYPE project_type AS ENUM ('TRADING_STRATEGIES', 'GENERAL_KNOWLEDGE');

CREATE TABLE projects (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  project_type  project_type NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE courses ADD COLUMN project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;

-- Seed the one project this deployment has today, and backfill it onto the
-- existing course row. This system has at most one `courses` row (single
-- Whop course per deployment) and the specific whop_course_id varies by
-- environment (and is random per test) — matching on "every course without
-- a project yet" is the stable-identity-preserving equivalent of "the
-- configured course" without hardcoding a whop_course_id or a numeric id.
-- It is a no-op on a fresh/empty database (no course row exists to update),
-- and idempotent (a second run finds no project_id IS NULL rows left).
INSERT INTO projects (name, project_type) VALUES ('MasterMind', 'TRADING_STRATEGIES');

UPDATE courses
SET project_id = (SELECT id FROM projects WHERE name = 'MasterMind')
WHERE project_id IS NULL;

-- Down Migration

ALTER TABLE courses DROP COLUMN project_id;
DROP TABLE projects;
DROP TYPE project_type;
