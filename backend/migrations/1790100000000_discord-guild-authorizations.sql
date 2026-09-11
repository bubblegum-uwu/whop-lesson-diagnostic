-- Up Migration

-- Phase 4K-B review fix — the bot being installed in a guild
-- (discord_guilds, deployment-wide) is a PROVIDER CAPABILITY, never by
-- itself an AUTHORIZATION for any given Knovera identity to browse/import
-- that guild. This table is the missing middle layer the original 4K-B
-- pass conflated away:
--
--   Discord bot installation           -> provider capability (discord_guilds)
--   Knovera identity <-> Discord guild -> who may use it (THIS table)
--   Project <-> Discord channel        -> where imported content belongs
--                                          (source_collections, unchanged)
--
-- `knovera_identity` is the authenticated Knovera session's JWT subject
-- (req.knoveraOperator — see http/middleware/knoveraAuth.ts), NOT a new
-- accounts table: this deployment has exactly one hardcoded operator
-- identity today ("knovera-operator" — see lib/knoveraToken.ts), so in
-- production every row here currently shares that same identity value.
-- The column is still the correct fix: it replaces "the bot is installed
-- somewhere, so any authenticated session may use it" (implicit, global)
-- with "an explicit grant exists for THIS identity" (explicit, checked on
-- every read) — which is what actually closes the gap, and costs nothing
-- extra today while being correct the moment a second identity ever exists.
--
-- A guild may have MORE than one authorized identity (an explicitly
-- supported sharing model — never implicit): the UNIQUE constraint below
-- only prevents an identity from being granted the same guild twice, it
-- does not cap how many identities may share one guild.
CREATE TABLE discord_guild_authorizations (
  id                 BIGSERIAL PRIMARY KEY,
  discord_guild_id   BIGINT NOT NULL REFERENCES discord_guilds(id) ON DELETE CASCADE,
  knovera_identity   TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Structurally prevents an ambiguous/duplicate grant row for the same
  -- (guild, identity) pair — the DB, not just application code, guarantees
  -- one identity's authorization for one guild is exactly one row.
  UNIQUE (discord_guild_id, knovera_identity)
);

CREATE INDEX discord_guild_authorizations_identity_idx ON discord_guild_authorizations (knovera_identity);

-- Phase 4K-B review fix — single-use enforcement for the Discord
-- bot-install OAuth "connect state" (lib/discordOAuthState.ts). The state
-- JWT already carries a random `jti`; this table is the smallest possible
-- persistence needed to make that jti single-use: the callback handler
-- attempts one INSERT before doing anything else, and a unique-violation
-- means "already used" (replay), rejected exactly like an invalid state.
-- Deliberately NOT a general session/token store — one column, one index,
-- no relation to any other table.
CREATE TABLE discord_oauth_state_uses (
  jti        TEXT PRIMARY KEY,
  used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE discord_oauth_state_uses;
DROP TABLE discord_guild_authorizations;
