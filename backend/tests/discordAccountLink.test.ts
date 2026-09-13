import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import {
  createConsumeDiscordLinkHandler,
  createGetDiscordLinkStatusHandler,
  createUnlinkDiscordHandler,
} from "../src/http/routes/discordAccountLink.js";
import { issueDiscordLinkToken } from "../src/db/discordLinkTokensRepo.js";
import { getKnoveraIdentityForDiscordUser } from "../src/db/discordUserLinksRepo.js";
import { ensureDiscordKnowledgeProject } from "../src/db/defaultProjectInboxesRepo.js";
import { createTestPool, randomId, randomSnowflake } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

function fakeAuthedRequest(knoveraOperator: string, body: unknown = {}): Request {
  return { body, knoveraOperator } as unknown as Request;
}

describe("POST /api/discord/link (consume link token)", () => {
  it("A: a valid, unexpired, unconsumed token links the Discord user to the authenticated Knovera identity and pre-warms Discord Knowledge", async () => {
    const handler = createConsumeDiscordLinkHandler({ pool });
    const discordUserId = randomSnowflake();
    const token = await issueDiscordLinkToken(pool, discordUserId);
    const identity = randomId("identity");
    const { res, statusCode, body } = makeResponse();

    await handler(fakeAuthedRequest(identity, { token }), res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ok: true });

    const link = await getKnoveraIdentityForDiscordUser(pool, discordUserId);
    expect(link?.knoveraIdentity).toBe(identity);

    const project = await ensureDiscordKnowledgeProject(pool, identity);
    expect(project.name).toBe("Discord Knowledge");
  });

  it("B: a missing token body is rejected with 400 before touching the database", async () => {
    const handler = createConsumeDiscordLinkHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler(fakeAuthedRequest(randomId("identity"), {}), res);

    expect(statusCode()).toBe(400);
    expect((body() as { error: { type: string } }).error.type).toBe("invalid_request");
  });

  it("C: an expired token is rejected", async () => {
    const handler = createConsumeDiscordLinkHandler({ pool });
    const discordUserId = randomSnowflake();
    const token = await issueDiscordLinkToken(pool, discordUserId, -10);
    const { res, statusCode, body } = makeResponse();

    await handler(fakeAuthedRequest(randomId("identity"), { token }), res);

    expect(statusCode()).toBe(400);
    expect((body() as { error: { type: string } }).error.type).toBe("invalid_link_token");
    expect(await getKnoveraIdentityForDiscordUser(pool, discordUserId)).toBeNull();
  });

  it("D: a replayed (already-consumed) token is rejected the second time", async () => {
    const handler = createConsumeDiscordLinkHandler({ pool });
    const discordUserId = randomSnowflake();
    const token = await issueDiscordLinkToken(pool, discordUserId);
    const identityA = randomId("identity");
    const identityB = randomId("identity");

    const first = makeResponse();
    await handler(fakeAuthedRequest(identityA, { token }), first.res);
    expect(first.statusCode()).toBe(200);

    const second = makeResponse();
    await handler(fakeAuthedRequest(identityB, { token }), second.res);
    expect(second.statusCode()).toBe(400);

    // Second identity's replay attempt must never hijack the link — spec
    // section 13's "a second identity cannot hijack" cross-identity guard.
    const link = await getKnoveraIdentityForDiscordUser(pool, discordUserId);
    expect(link?.knoveraIdentity).toBe(identityA);
  });

  it("E: a malformed/unknown token is rejected", async () => {
    const handler = createConsumeDiscordLinkHandler({ pool });
    const { res, statusCode } = makeResponse();

    await handler(fakeAuthedRequest(randomId("identity"), { token: "not-a-real-token" }), res);

    expect(statusCode()).toBe(400);
  });
});

describe("GET /api/discord/link (status)", () => {
  it("F: reports linked:false for an identity with no linked Discord account", async () => {
    const handler = createGetDiscordLinkStatusHandler({ pool });
    const { res, statusCode, body } = makeResponse();

    await handler(fakeAuthedRequest(randomId("identity")), res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ linked: false, discordUserIds: [] });
  });

  it("G: reports linked:true with the linked Discord user id after linking", async () => {
    const consumeHandler = createConsumeDiscordLinkHandler({ pool });
    const statusHandler = createGetDiscordLinkStatusHandler({ pool });
    const identity = randomId("identity");
    const discordUserId = randomSnowflake();
    const token = await issueDiscordLinkToken(pool, discordUserId);
    await consumeHandler(fakeAuthedRequest(identity, { token }), makeResponse().res);

    const { res, statusCode, body } = makeResponse();
    await statusHandler(fakeAuthedRequest(identity), res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ linked: true, discordUserIds: [discordUserId] });
  });
});

describe("DELETE /api/discord/link (unlink)", () => {
  it("H: unlinking removes the link but leaves previously-captured content untouched (no content_assets/project_sources touched)", async () => {
    const consumeHandler = createConsumeDiscordLinkHandler({ pool });
    const unlinkHandler = createUnlinkDiscordHandler({ pool });
    const statusHandler = createGetDiscordLinkStatusHandler({ pool });
    const identity = randomId("identity");
    const discordUserId = randomSnowflake();
    const token = await issueDiscordLinkToken(pool, discordUserId);
    await consumeHandler(fakeAuthedRequest(identity, { token }), makeResponse().res);

    const project = await ensureDiscordKnowledgeProject(pool, identity);

    const { res, statusCode, body } = makeResponse();
    await unlinkHandler(fakeAuthedRequest(identity), res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ ok: true });
    expect(await getKnoveraIdentityForDiscordUser(pool, discordUserId)).toBeNull();

    const statusRes = makeResponse();
    await statusHandler(fakeAuthedRequest(identity), statusRes.res);
    expect(statusRes.body()).toEqual({ linked: false, discordUserIds: [] });

    // The project itself (and anything captured into it) is untouched —
    // unlinking affects future captures only (spec section 54).
    const stillThere = await pool.query(`SELECT id FROM projects WHERE id = $1`, [project.id]);
    expect(stillThere.rows).toHaveLength(1);
  });

  it("I: cross-identity isolation — identity B's unlink call never touches identity A's link", async () => {
    const consumeHandler = createConsumeDiscordLinkHandler({ pool });
    const unlinkHandler = createUnlinkDiscordHandler({ pool });
    const identityA = randomId("identity-a");
    const identityB = randomId("identity-b");
    const discordUserA = randomSnowflake();
    const discordUserB = randomSnowflake();
    await consumeHandler(fakeAuthedRequest(identityA, { token: await issueDiscordLinkToken(pool, discordUserA) }), makeResponse().res);
    await consumeHandler(fakeAuthedRequest(identityB, { token: await issueDiscordLinkToken(pool, discordUserB) }), makeResponse().res);

    await unlinkHandler(fakeAuthedRequest(identityB), makeResponse().res);

    // B's own link is gone, but A's is completely untouched.
    expect(await getKnoveraIdentityForDiscordUser(pool, discordUserB)).toBeNull();
    const linkA = await getKnoveraIdentityForDiscordUser(pool, discordUserA);
    expect(linkA?.knoveraIdentity).toBe(identityA);
  });
});
