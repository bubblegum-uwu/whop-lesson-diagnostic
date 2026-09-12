-- Up Migration

-- Phase 4K-B (revised) — Discord USER_INSTALL context-menu capture
-- ("Save to Knovera"), the "Discord Knowledge" permanent inbox, and a
-- shared durable-content-asset layer so the same captured video can be
-- added to more than one project without duplicating bytes.
--
-- SCOPE NOTE (spec section 38): this shared-asset abstraction is
-- introduced for DISCORD/binary content ONLY in this phase. Whop
-- (Mux-streamed, re-resolved live on every analysis) and YouTube (a
-- public, never-expiring watch URL reconstructed from external_id alone)
-- have no durable-byte-storage step at all today — see
-- worker/projectSourceAnalysisLoop.ts's runRawTwoPassForSource — so there
-- is nothing for them to migrate onto this table, and this migration does
-- not touch them.

-- content_assets / content_asset_media — the shared durable-content layer.
-- Mirrors the existing project_sources / project_source_media split
-- (metadata table kept small and hot; bytes isolated in their own table so
-- ordinary list/lookup queries never scan BYTEA columns) at ONE LEVEL UP:
-- an asset is owned by a Knovera identity (never globally deduped across
-- identities — spec section 37), not by a single project, so many
-- project_sources rows (one per project it's been added to) can reference
-- the same asset and therefore the same durably-stored bytes.
CREATE TABLE content_assets (
  id                BIGSERIAL PRIMARY KEY,
  owner_identity    TEXT NOT NULL,
  provider          TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  title             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The actual identity/dedup guarantee (spec section 37): scoped by
  -- owner_identity, not merely (provider, external_id) — the same Discord
  -- attachment captured by two different Knovera identities must never
  -- resolve to one shared row.
  UNIQUE (owner_identity, provider, external_id)
);

CREATE TABLE content_asset_media (
  content_asset_id  BIGINT PRIMARY KEY REFERENCES content_assets(id) ON DELETE CASCADE,
  content           BYTEA NOT NULL,
  content_type      TEXT NOT NULL,
  byte_size         BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- project_sources gains an optional backlink to the shared asset it was
-- created from. Nullable and purely additive: every project_sources row
-- created before this migration (YouTube, Whop-unrelated — Whop never
-- used this table — and any pre-existing Discord à-la-carte row) simply
-- has NULL here and keeps working exactly as before, reading its own
-- legacy project_source_media row (see projectSourceAnalysisLoop.ts's
-- fallback). Only Discord sources created FROM THIS PHASE ONWARD
-- (à-la-carte URL paste, bulk import, and Save-to-Knovera captures alike)
-- populate it, which is what makes the two capture paths dedupe against
-- each other (spec section 49).
ALTER TABLE project_sources ADD COLUMN content_asset_id BIGINT REFERENCES content_assets(id) ON DELETE RESTRICT;

-- Phase 4K-B (revised) — which Discord user (by stable snowflake id, never
-- username/display name — spec section 10) is linked to which Knovera
-- identity. One Discord account links to exactly one Knovera identity at a
-- time (re-linking overwrites, never duplicates); the same Knovera
-- identity could in principle be linked from multiple Discord accounts
-- (no uniqueness constraint on knovera_identity), which is harmless and
-- not restricted.
CREATE TABLE discord_user_links (
  discord_user_id   TEXT PRIMARY KEY,
  knovera_identity  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX discord_user_links_identity_idx ON discord_user_links (knovera_identity);

-- Phase 4K-B (revised) — the one-time account-linking token (spec section
-- 12/13). Stores a HASH of the token, never the plaintext (spec section
-- 13's "prefer storing a token hash"), bound to the ONE Discord user id
-- that triggered its issuance server-side (never trusted from the
-- browser). single-use is enforced by the `consumed_at` column: a
-- consume attempt is one atomic
-- `UPDATE ... SET consumed_at = now() WHERE token_hash = $1 AND consumed_at
-- IS NULL AND expires_at > now() RETURNING discord_user_id` — a second
-- attempt (replay) matches zero rows.
CREATE TABLE discord_link_tokens (
  token_hash        TEXT PRIMARY KEY,
  discord_user_id   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ
);
CREATE INDEX discord_link_tokens_discord_user_idx ON discord_link_tokens (discord_user_id);

-- Phase 4K-B (revised) — one row per (Knovera identity, project type) the
-- deployment has ever auto-created a fixed default inbox for. Today only
-- ever created with project_type = 'GENERAL_KNOWLEDGE' (the "Discord
-- Knowledge" inbox — spec section 8), but the table itself is not named
-- "discord_inboxes" so a future second auto-managed default project
-- (should one ever exist) does not require a parallel table. Identified
-- structurally (spec section 8: "do not identify the special project by
-- name alone") via this row's own project_id, never by matching
-- projects.name = 'Discord Knowledge' at read time.
CREATE TABLE default_project_inboxes (
  id                BIGSERIAL PRIMARY KEY,
  knovera_identity  TEXT NOT NULL,
  purpose           TEXT NOT NULL,
  project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (knovera_identity, purpose)
);

-- Phase 4K-B (revised) — the async capture job a "Save to Knovera"
-- interaction enqueues (spec section 24/25): the interaction handler only
-- ever inserts this row and responds immediately; a worker (see
-- worker/discordCaptureLoop.ts) performs the actual durable download.
-- `interaction_id` is UNIQUE so a redelivered/duplicated interaction can
-- never enqueue a second job for the same Discord interaction (spec
-- section 56) — paired with `attachment_id`, since ONE interaction with
-- multiple supported video attachments enqueues multiple rows (spec
-- section 19), one per attachment.
CREATE TYPE discord_capture_job_status AS ENUM ('QUEUED', 'CAPTURING', 'COMPLETED', 'FAILED');

CREATE TABLE discord_capture_jobs (
  id                 BIGSERIAL PRIMARY KEY,
  owner_identity     TEXT NOT NULL,
  discord_user_id    TEXT NOT NULL,
  project_id         BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The (organizational-only, never-refreshed — spec section 29) per-channel
  -- source_collections row inside Discord Knowledge that the resulting
  -- project_source is grouped under (spec section 28) — resolved
  -- synchronously by the interactions handler (a cheap, idempotent
  -- metadata upsert, not a download) before this job is even created.
  collection_id      BIGINT REFERENCES source_collections(id) ON DELETE SET NULL,
  interaction_id     TEXT NOT NULL,
  message_id         TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  guild_id           TEXT,
  channel_label      TEXT,
  attachment_id      TEXT NOT NULL,
  attachment_url     TEXT NOT NULL,
  filename           TEXT NOT NULL,
  content_type       TEXT,
  byte_size          BIGINT,
  status             discord_capture_job_status NOT NULL DEFAULT 'QUEUED',
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  lease_owner        TEXT,
  lease_expires_at   TIMESTAMPTZ,
  project_source_id  BIGINT REFERENCES project_sources(id) ON DELETE SET NULL,
  sanitized_error    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (interaction_id, attachment_id)
);
CREATE INDEX discord_capture_jobs_claim_idx ON discord_capture_jobs (status, lease_expires_at);

-- Down Migration

DROP TABLE discord_capture_jobs;
DROP TYPE discord_capture_job_status;
DROP TABLE default_project_inboxes;
DROP TABLE discord_link_tokens;
DROP TABLE discord_user_links;
ALTER TABLE project_sources DROP COLUMN content_asset_id;
DROP TABLE content_asset_media;
DROP TABLE content_assets;
