-- Up Migration

-- Phase 4K-B — authenticated Discord collections. A Discord "connection" is
-- deployment-wide (one shared bot identity — see config.ts's
-- discordClientId/discordBotToken doc comment), exactly mirroring how
-- Whop's operator OAuth session (auth_sessions) already works in this
-- single-operator deployment: connecting a guild is NOT a per-project
-- action, and multiple projects may independently import channels from the
-- SAME connected guild (spec section 27/47) — project isolation is
-- entirely handled by the existing, unmodified source_collections
-- project-scoping (see 1789800000000_source-collections.sql), not by this
-- table.
--
-- No OAuth token/secret lives in this table at all: unlike Whop (a
-- refreshable per-operator user access/refresh token pair, encrypted in
-- auth_sessions), Discord's bot-install flow issues no per-guild
-- credential to store — every API call after connect uses the ONE static
-- bot token configured via DISCORD_BOT_TOKEN. This table is therefore
-- pure metadata, safe to return from an API response in full.
CREATE TYPE discord_guild_status AS ENUM ('CONNECTED', 'DISCONNECTED');

CREATE TABLE discord_guilds (
  id                BIGSERIAL PRIMARY KEY,
  -- Discord's own stable snowflake id for the guild/server — never inferred
  -- from a user-typed value, always the guild_id Discord itself returned on
  -- the bot-install OAuth callback (http/routes/discordConnections.ts).
  guild_id          TEXT NOT NULL UNIQUE,
  guild_name        TEXT NOT NULL,
  status            discord_guild_status NOT NULL DEFAULT 'CONNECTED',
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 4K-B — which connected guild an imported Discord channel collection
-- belongs to. Nullable (meaningless for YOUTUBE collections), ON DELETE
-- SET NULL is safe here (unlike the project_sources.collection_id
-- composite FK) because this is a single-column FK with no sibling
-- NOT NULL column in the same constraint — disconnecting/removing a guild
-- row never blocks or corrupts an existing channel collection, it just
-- loses the (purely informational) guild backlink; the collection's own
-- project_id/provider/external_id/discovery_cursor are untouched.
ALTER TABLE source_collections ADD COLUMN discord_guild_id BIGINT REFERENCES discord_guilds(id) ON DELETE SET NULL;

-- Down Migration

ALTER TABLE source_collections DROP COLUMN discord_guild_id;
DROP TABLE discord_guilds;
DROP TYPE discord_guild_status;
