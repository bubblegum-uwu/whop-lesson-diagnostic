import { describe, it, expect, afterAll } from "vitest";
import {
  authorizeDiscordGuildForIdentity,
  isDiscordGuildAuthorizedForIdentity,
  listAuthorizedDiscordGuildIds,
  countDiscordGuildAuthorizations,
  revokeDiscordGuildAuthorization,
} from "../src/db/discordGuildAuthorizationsRepo.js";
import { markDiscordOAuthStateUsed } from "../src/db/discordOAuthStateUsesRepo.js";
import { upsertDiscordGuild } from "../src/db/discordGuildsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

describe("discord_guild_authorizations (Phase 4K-B review fix)", () => {
  it("a guild starts with zero authorizations — installed is not the same as authorized", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Fresh Install");
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, "identity-a")).toBe(false);
    expect(await countDiscordGuildAuthorizations(pool, guild.id)).toBe(0);
  });

  it("authorizing grants exactly that identity, no others", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Guild");
    await authorizeDiscordGuildForIdentity(pool, guild.id, "identity-a");
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, "identity-a")).toBe(true);
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, "identity-b")).toBe(false);
  });

  it("authorizing the same (guild, identity) pair twice is idempotent — one grant, not an error", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Guild");
    await authorizeDiscordGuildForIdentity(pool, guild.id, "identity-a");
    await authorizeDiscordGuildForIdentity(pool, guild.id, "identity-a");
    expect(await countDiscordGuildAuthorizations(pool, guild.id)).toBe(1);
  });

  it("a guild may be authorized to more than one identity — an explicit sharing model, never implicit", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Shared Guild");
    await authorizeDiscordGuildForIdentity(pool, guild.id, "identity-a");
    await authorizeDiscordGuildForIdentity(pool, guild.id, "identity-b");
    expect(await countDiscordGuildAuthorizations(pool, guild.id)).toBe(2);
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, "identity-a")).toBe(true);
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, "identity-b")).toBe(true);
  });

  it("listAuthorizedDiscordGuildIds returns only this identity's guilds", async () => {
    // Fresh, randomId-suffixed identities here (unlike elsewhere in this
    // file) — this is the one assertion that checks the EXACT set
    // returned, so it must not collide with the literal "identity-a"/"-b"
    // used across other Discord test files sharing this same test
    // database (whose rows persist across runs; other assertions in this
    // file only check containment, which those leftovers can't break).
    const identityA = randomId("identity");
    const identityB = randomId("identity");
    const guildA = await upsertDiscordGuild(pool, randomId("guild"), "A's Guild");
    const guildB = await upsertDiscordGuild(pool, randomId("guild"), "B's Guild");
    await authorizeDiscordGuildForIdentity(pool, guildA.id, identityA);
    await authorizeDiscordGuildForIdentity(pool, guildB.id, identityB);
    expect(await listAuthorizedDiscordGuildIds(pool, identityA)).toEqual([guildA.id]);
    expect(await listAuthorizedDiscordGuildIds(pool, identityB)).toEqual([guildB.id]);
  });

  it("revoking removes ONLY that identity's grant — a shared guild's other authorized identity is unaffected", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Shared Guild");
    await authorizeDiscordGuildForIdentity(pool, guild.id, "identity-a");
    await authorizeDiscordGuildForIdentity(pool, guild.id, "identity-b");

    await revokeDiscordGuildAuthorization(pool, guild.id, "identity-a");
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, "identity-a")).toBe(false);
    expect(await isDiscordGuildAuthorizedForIdentity(pool, guild.id, "identity-b")).toBe(true);
    expect(await countDiscordGuildAuthorizations(pool, guild.id)).toBe(1);
  });

  it("revoking a never-granted (guild, identity) pair is a harmless no-op", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Guild");
    await expect(revokeDiscordGuildAuthorization(pool, guild.id, "identity-never-granted")).resolves.toBeUndefined();
  });

  it("the database itself rejects an ambiguous duplicate authorization row (structural, not just application-level, guarantee)", async () => {
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Guild");
    await pool.query(`INSERT INTO discord_guild_authorizations (discord_guild_id, knovera_identity) VALUES ($1, $2)`, [guild.id, "identity-a"]);
    await expect(pool.query(`INSERT INTO discord_guild_authorizations (discord_guild_id, knovera_identity) VALUES ($1, $2)`, [guild.id, "identity-a"])).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    );
  });
});

describe("discord_oauth_state_uses single-use enforcement (Phase 4K-B review fix)", () => {
  it("the first mark for a given jti succeeds", async () => {
    expect(await markDiscordOAuthStateUsed(pool, randomId("jti"))).toBe(true);
  });

  it("a second mark for the SAME jti fails (already used — a replay)", async () => {
    const jti = randomId("jti");
    expect(await markDiscordOAuthStateUsed(pool, jti)).toBe(true);
    expect(await markDiscordOAuthStateUsed(pool, jti)).toBe(false);
  });

  it("different jtis are independent", async () => {
    expect(await markDiscordOAuthStateUsed(pool, randomId("jti"))).toBe(true);
    expect(await markDiscordOAuthStateUsed(pool, randomId("jti"))).toBe(true);
  });
});
