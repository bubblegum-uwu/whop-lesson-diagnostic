-- Up Migration

-- Phase 4K follow-up — fixes a product-semantic bug: the original
-- à-la-carte Whop lesson import piggybacked on syncCourse and then claimed
-- the ENTIRE course to the requesting project via courses.project_id,
-- silently making every OTHER lesson in that course visible too (a user
-- pasting one lesson URL from a 20-lesson course saw all 20 show up as
-- connected/importable). This table is the fix: a real, project-scoped
-- membership row that distinguishes
--   "this Whop course is fully connected to a project" (courses.project_id
--   — unchanged, see 1789300000000_project-model.sql)
-- from
--   "this ONE Whop lesson was explicitly imported à-la-carte into a
--   project's catalog" (this table).
--
-- syncCourse may still fetch/upsert EVERY lesson of a course into the
-- shared `lessons` table when resolving a single à-la-carte URL (Whop's
-- API can only resolve a lesson in the context of its course lesson-list
-- endpoint) — that is provider metadata only, not project-catalog
-- membership. A lesson is only visible in a project's catalog if EITHER
-- its course is fully connected to that project OR it has a row here.
--
-- lesson_id is the PRIMARY KEY (not part of a composite unique pair) —
-- deliberately: a lesson can be à-la-carted into AT MOST ONE project,
-- ever, full stop. This mirrors the existing single-owner invariant
-- courses.project_id already establishes at the course level (one project
-- at a time), extended down to the lesson level, and is what keeps
-- lesson_analyses (keyed by lesson_id alone, with no project scoping of
-- its own — see 1788641918641_init-schema.sql) safely single-project: two
-- different projects can never simultaneously see (or share) the same
-- lesson's analysis through this table. Real foreign keys throughout, no
-- polymorphic (type, id) pair — lesson_id and project_id are each a
-- genuine FK to an existing table.
CREATE TABLE project_whop_lesson_imports (
  lesson_id   BIGINT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_whop_lesson_imports_project_idx ON project_whop_lesson_imports (project_id, created_at ASC);

-- Down Migration

DROP TABLE project_whop_lesson_imports;
