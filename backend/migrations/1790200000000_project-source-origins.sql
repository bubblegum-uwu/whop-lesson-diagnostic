-- Up Migration

-- Phase 4K-C: provenance/origin records for project_sources — decoupled
-- from project_sources itself because one YouTube video can have MANY
-- origins (a manual add, plus one or more distinct Discord channel
-- postings, plus reposts of the same link in the same channel). Identity
-- of the underlying source stays exactly what it already was
-- (project_sources' own UNIQUE(project_id, provider, external_id)) — this
-- table only ever adds provenance ROWS on top of an existing
-- project_sources row, never a second source-identity concept.
--
-- `origin_type` is plain TEXT + CHECK, not an ENUM, deliberately mirroring
-- project_sources.provider's own reasoning (1789400000000_project-sources.sql):
-- a future origin type (e.g. a different channel-based provider) should
-- never require an ALTER TYPE migration just to be recognized here — the
-- actual allow-listing lives in application code
-- (projectSourceOriginsRepo.ts).
--
-- The Discord-specific columns are nullable at the table level (a MANUAL
-- origin has none of them) but the CHECK constraint below still pins each
-- origin_type to an exact, unambiguous set of populated/NULL columns — so
-- "MANUAL row with a stray discord_message_id" or "DISCORD_CHANNEL row
-- with no posted_at" can never be inserted, not even by a future bug.
--
-- discord_posted_at is the DISCORD MESSAGE's timestamp — never YouTube's
-- publish date, never this row's own created_at (import time), never an
-- analysis timestamp. It is TIMESTAMPTZ (stored UTC by Postgres
-- convention here, same as every other timestamptz column in this schema)
-- — the frontend renders it in the viewer's local timezone, this table
-- never stores a display-formatted string.
CREATE TABLE project_source_origins (
  id                   BIGSERIAL PRIMARY KEY,
  project_source_id    BIGINT NOT NULL REFERENCES project_sources(id) ON DELETE CASCADE,
  origin_type          TEXT NOT NULL CHECK (origin_type IN ('MANUAL', 'DISCORD_CHANNEL')),
  discord_guild_id     TEXT,
  discord_channel_id   TEXT,
  discord_channel_name TEXT,
  discord_message_id   TEXT,
  discord_message_url  TEXT,
  discord_posted_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_source_origins_fields_match_type CHECK (
    (
      origin_type = 'MANUAL'
      AND discord_guild_id IS NULL AND discord_channel_id IS NULL AND discord_channel_name IS NULL
      AND discord_message_id IS NULL AND discord_message_url IS NULL AND discord_posted_at IS NULL
    )
    OR
    (
      origin_type = 'DISCORD_CHANNEL'
      AND discord_guild_id IS NOT NULL AND discord_channel_id IS NOT NULL
      AND discord_message_id IS NOT NULL AND discord_posted_at IS NOT NULL
      -- discord_channel_name and discord_message_url are the two fields the
      -- spec itself marks optional ("if available" / "if derivable safely")
      -- — everything else identifying WHERE and WHEN is mandatory.
    )
  )
);
CREATE INDEX project_source_origins_source_idx ON project_source_origins (project_source_id);

-- Idempotency guarantee #1: at most one MANUAL origin per source — a
-- second manual "Add YouTube Video" of an already-known video must gain no
-- new row (see http/routes/projectSources.ts's createAddYouTubeSourceHandler).
CREATE UNIQUE INDEX project_source_origins_manual_unique
  ON project_source_origins (project_source_id)
  WHERE origin_type = 'MANUAL';

-- Idempotency guarantee #2: at most one row per (source, channel, Discord
-- message) — re-scanning the same channel must never duplicate an
-- already-recorded occurrence (spec test case D), while a genuinely
-- different message (a repost, test case C) or a different channel (test
-- case B) each get their own row since discord_channel_id/discord_message_id
-- differ.
CREATE UNIQUE INDEX project_source_origins_discord_message_unique
  ON project_source_origins (project_source_id, discord_channel_id, discord_message_id)
  WHERE origin_type = 'DISCORD_CHANNEL';

-- Down Migration

DROP TABLE project_source_origins;
