-- Up Migration

-- Phase 4K: a provider-independent COLLECTION layer above project_sources,
-- for providers that have no native grouping entity of their own —
-- YouTube channels and Discord collections/channels. Purely additive — no
-- existing table/row is altered or touched.
--
-- Deliberately NOT used for Whop: Whop already has a real, project-scoped
-- collection concept (`courses`, via the nullable `courses.project_id`
-- introduced in Phase 4B) with its own item table (`lessons`) and its own
-- analysis table (`lesson_analyses`). Introducing a *second*,
-- `source_collections`-shaped row to represent "the same Whop course" would
-- mean keeping two rows in sync for one real-world entity, for no benefit —
-- the catalog API layer (http/routes/whopCourses.ts) projects `courses`
-- rows into the same JSON shape the frontend consumes for YouTube/Discord
-- collections, without a second physical table. See the Phase 4K PR
-- description's "Architecture" section for the full reasoning.
--
-- `project_sources.collection_id` (added below) is a single NULLABLE FK,
-- not a many-to-many join table: a YouTube video has exactly one owning
-- channel and a Discord item has exactly one owning collection in the
-- providers' own data models today, so a single FK is the correct,
-- smallest-necessary shape — not an arbitrary product limitation. It does
-- not foreclose a future many-to-many "user-defined groups" concept later:
-- that would be a genuinely new, purely additive join table sitting
-- alongside this column, not a breaking change to it.
CREATE TYPE source_collection_status AS ENUM ('READY', 'SYNCING', 'SYNC_FAILED');

CREATE TABLE source_collections (
  id              BIGSERIAL PRIMARY KEY,
  project_id      BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('YOUTUBE', 'DISCORD')),
  -- The provider's own stable collection identity (e.g. a YouTube channel
  -- id, "UCxxxxxxxxxxxxxxxxxxxxxx") — never a display name, so a channel
  -- rename can never silently create a duplicate collection or break
  -- re-sync matching.
  external_id     TEXT NOT NULL,
  title           TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  status          source_collection_status NOT NULL DEFAULT 'READY',
  sanitized_error TEXT,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Provider identity uniqueness is project-scoped (section 49): the same
  -- YouTube channel could in principle be added to two different
  -- projects, but never added twice to the SAME project.
  UNIQUE (project_id, provider, external_id),
  -- Parent-side uniqueness Postgres requires for project_sources'
  -- composite FK below — id is already globally unique (the primary key),
  -- this only exposes the pair as a valid composite-FK target (same
  -- technique Phase 4J's own follow-up fix introduced for
  -- synthesis_set_sources).
  UNIQUE (id, project_id)
);
CREATE INDEX source_collections_project_idx ON source_collections (project_id, created_at DESC);

-- Membership: which project_source belongs to which collection (NULL =
-- à-la-carte, added directly, never imported via a collection). A nullable
-- composite FK — Postgres's default MATCH SIMPLE means a row with
-- collection_id IS NULL is exempt from the FK check entirely, so à-la-carte
-- sources need no special-casing here.
--
-- The composite FK (collection_id, project_id) -> source_collections(id,
-- project_id) is what makes "a collection can never contain an item from
-- another project" a database guarantee, not just a route-level check
-- (Phase 4K spec section 48) — same technique as Phase 4J's
-- synthesis_set_sources fix.
--
-- Deliberately NOT "ON DELETE SET NULL": a composite FK's SET NULL nulls
-- EVERY column in the FK's own column list, not just collection_id — that
-- would try to null project_sources.project_id too, which has its own
-- separate NOT NULL constraint from 1789400000000_project-sources.sql,
-- and the delete would fail outright. Instead this is NO ACTION (the
-- default), and the collection-delete route/repo function
-- (sourceCollectionsRepo.deleteSourceCollection) explicitly clears
-- collection_id on every member in the SAME transaction, immediately
-- before deleting the collection row — same end result (association
-- removed, items preserved — Phase 4K spec section 40), just orchestrated
-- in application code instead of relying on an FK action that can't
-- express "null only this one column."
ALTER TABLE project_sources ADD COLUMN collection_id BIGINT;
ALTER TABLE project_sources ADD CONSTRAINT project_sources_collection_project_fkey
  FOREIGN KEY (collection_id, project_id) REFERENCES source_collections (id, project_id);
CREATE INDEX project_sources_collection_idx ON project_sources (collection_id);

-- Down Migration

ALTER TABLE project_sources DROP CONSTRAINT project_sources_collection_project_fkey;
DROP INDEX project_sources_collection_idx;
ALTER TABLE project_sources DROP COLUMN collection_id;
DROP TABLE source_collections;
DROP TYPE source_collection_status;
