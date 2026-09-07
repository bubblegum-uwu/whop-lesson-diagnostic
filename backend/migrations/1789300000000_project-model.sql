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

-- Seed the one project this deployment has today, and backfill it onto
-- *only* the configured Trading Accelerator course — matched by its stable
-- Whop course identity (whop_course_id), the same identifier this
-- deployment is configured with via WHOP_COURSE_ID (see config.ts /
-- backend/README.md's deploy commands). Deliberately NOT "every course
-- without a project yet": a database can contain other, unrelated course
-- rows (e.g. leftover test fixtures), and those must never be silently
-- claimed by MasterMind. On a fresh/empty database, or any environment
-- where this whop_course_id hasn't been synced yet, the UPDATE matches
-- zero rows and the migration still succeeds — MasterMind is still
-- created, ready to be associated once/if that course is synced.
INSERT INTO projects (name, project_type) VALUES ('MasterMind', 'TRADING_STRATEGIES');

UPDATE courses
SET project_id = (SELECT id FROM projects WHERE name = 'MasterMind')
WHERE whop_course_id = 'cors_4lb7N3oassoZwHJvrufOYy';

-- Down Migration

ALTER TABLE courses DROP COLUMN project_id;
DROP TABLE projects;
DROP TYPE project_type;
