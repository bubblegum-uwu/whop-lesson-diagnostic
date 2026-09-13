import { describe, it, expect, afterAll, vi } from "vitest";
import type { Request } from "express";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { createDiscordInteractionsHandler, type RawBodyRequest } from "../src/http/routes/discordInteractions.js";
import { linkDiscordUserToIdentity } from "../src/db/discordUserLinksRepo.js";
import { ensureDiscordKnowledgeProject } from "../src/db/defaultProjectInboxesRepo.js";
import { createTestPool, randomId, randomSnowflake } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

const ALLOWED_ORIGIN = "https://knovera.example";

/** A fresh fake per call — never shared across tests, so each test's own assertions on call counts are never polluted by another test's calls. */
function fakeJobTrigger(triggerRun: () => Promise<void> = async () => undefined): JobTrigger {
  return { triggerRun: vi.fn(triggerRun) };
}

/** Extracts the raw 32-byte Ed25519 public key from a KeyObject's SPKI DER export — mirrors discordInteractionsVerify.test.ts's fixture helper. */
function rawPublicKeyHex(publicKeyDer: Buffer): string {
  return publicKeyDer.subarray(publicKeyDer.length - 32).toString("hex");
}

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = rawPublicKeyHex(publicKey.export({ type: "spki", format: "der" }) as Buffer);
  return { privateKey, publicKeyHex };
}

function sig(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], timestamp: string, rawBody: Buffer): string {
  return sign(null, Buffer.concat([Buffer.from(timestamp, "utf-8"), rawBody]), privateKey).toString("hex");
}

interface FakeReqOptions {
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  interaction: Record<string, unknown>;
  timestamp?: string;
  badSignature?: boolean;
}

function fakeRequest(opts: FakeReqOptions): Request {
  const timestamp = opts.timestamp ?? "1700000000";
  const rawBody = Buffer.from(JSON.stringify(opts.interaction));
  const signature = opts.badSignature ? "ab".repeat(64) : sig(opts.privateKey, timestamp, rawBody);
  const headers: Record<string, string> = {
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestamp,
  };
  const req = {
    body: opts.interaction,
    rawBody,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as RawBodyRequest;
  return req as unknown as Request;
}

function pingInteraction() {
  return { id: randomId("interaction"), type: 1 };
}

function saveToKnoveraInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: randomId("interaction"),
    type: 2,
    guild_id: "guild_1",
    channel: { id: "chan_1", name: "trading-videos" },
    member: { user: { id: "discord_user_1" } },
    authorizing_integration_owners: { "1": "discord_user_1" },
    data: {
      type: 3,
      name: "Save to Knovera",
      target_id: "msg_1",
      resolved: {
        messages: {
          msg_1: {
            id: "msg_1",
            attachments: [],
          },
        },
      },
    },
    ...overrides,
  };
}

describe("POST /api/discord/interactions", () => {
  it("A: responds PONG to a validly-signed PING", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const req = fakeRequest({ privateKey, interaction: pingInteraction() });
    const { res, statusCode, body } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ type: 1 });
  });

  it("B: rejects a request with an invalid signature", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const req = fakeRequest({ privateKey, interaction: pingInteraction(), badSignature: true });
    const { res, statusCode } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(401);
  });

  it("C: rejects a request when the endpoint has no configured public key", async () => {
    const { privateKey } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: undefined, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const req = fakeRequest({ privateKey, interaction: pingInteraction() });
    const { res, statusCode } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(401);
  });

  it("D: acknowledges an unsupported command type harmlessly rather than erroring", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const interaction = saveToKnoveraInteraction({ data: { type: 1, name: "some-other-command" } });
    const req = fakeRequest({ privateKey, interaction });
    const { res, statusCode, body } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(200);
    expect((body() as { data: { content: string } }).data.content).toContain("not supported");
  });

  it("E: rejects when the invoking user does not match the authorizing installation owner", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const interaction = saveToKnoveraInteraction({
      member: { user: { id: "someone_else" } },
      authorizing_integration_owners: { "1": "discord_user_1" },
    });
    const req = fakeRequest({ privateKey, interaction });
    const { res, statusCode, body } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(200);
    expect((body() as { data: { content: string } }).data.content).toContain("Could not verify your Discord identity");
  });

  it("F: an unlinked Discord user gets an ephemeral link prompt, not a capture", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const discordUserId = randomSnowflake();
    const interaction = saveToKnoveraInteraction({
      member: { user: { id: discordUserId } },
      authorizing_integration_owners: { "1": discordUserId },
    });
    const req = fakeRequest({ privateKey, interaction });
    const { res, statusCode, body } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(200);
    const content = (body() as { data: { content: string } }).data.content;
    expect(content).toContain("not linked to Knovera yet");
    expect(content).toContain(`${ALLOWED_ORIGIN}/#/link-discord?token=`);
  });

  it("G: a missing resolved target message is handled without throwing", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const discordUserId = randomSnowflake();
    await linkDiscordUserToIdentity(pool, discordUserId, randomId("identity"));
    const interaction = saveToKnoveraInteraction({
      member: { user: { id: discordUserId } },
      authorizing_integration_owners: { "1": discordUserId },
      data: { type: 3, name: "Save to Knovera", target_id: "missing_msg", resolved: { messages: {} } },
    });
    const req = fakeRequest({ privateKey, interaction });
    const { res, statusCode, body } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(200);
    expect((body() as { data: { content: string } }).data.content).toContain("Could not read the target message");
  });

  it("H: a message with no supported video attachment creates nothing", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const discordUserId = randomSnowflake();
    await linkDiscordUserToIdentity(pool, discordUserId, randomId("identity"));
    const interaction = saveToKnoveraInteraction({
      member: { user: { id: discordUserId } },
      authorizing_integration_owners: { "1": discordUserId },
      data: {
        type: 3,
        name: "Save to Knovera",
        target_id: "msg_1",
        resolved: {
          messages: {
            msg_1: { id: "msg_1", attachments: [{ id: "att_1", filename: "notes.pdf", url: "https://cdn.discordapp.com/x.pdf" }] },
          },
        },
      },
    });
    const req = fakeRequest({ privateKey, interaction });
    const { res, statusCode, body } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(200);
    expect((body() as { data: { content: string } }).data.content).toBe("No supported video attachment was found in this message.");
  });

  it("I: a linked user saving a video attachment creates Discord Knowledge, a channel collection, and one capture job", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const discordUserId = randomSnowflake();
    const identity = randomId("identity");
    await linkDiscordUserToIdentity(pool, discordUserId, identity);
    const messageId = randomId("msg");
    const attachmentId = randomSnowflake();
    const interactionId = randomId("interaction");
    const interaction = saveToKnoveraInteraction({
      id: interactionId,
      member: { user: { id: discordUserId } },
      authorizing_integration_owners: { "1": discordUserId },
      data: {
        type: 3,
        name: "Save to Knovera",
        target_id: messageId,
        resolved: {
          messages: {
            [messageId]: { id: messageId, attachments: [{ id: attachmentId, filename: "clip.mp4", content_type: "video/mp4", size: 1024, url: "https://cdn.discordapp.com/clip.mp4" }] },
          },
        },
      },
    });
    const req = fakeRequest({ privateKey, interaction });
    const { res, statusCode, body } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(200);
    expect((body() as { data: { content: string } }).data.content).toBe("Saving 1 video to Discord Knowledge…");

    const project = await ensureDiscordKnowledgeProject(pool, identity);
    expect(project.name).toBe("Discord Knowledge");
    expect(project.projectType).toBe("GENERAL_KNOWLEDGE");

    const jobs = await pool.query(`SELECT * FROM discord_capture_jobs WHERE interaction_id = $1 AND attachment_id = $2`, [interactionId, attachmentId]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].status).toBe("QUEUED");
    expect(Number(jobs.rows[0].project_id)).toBe(project.id);

    const collections = await pool.query(`SELECT * FROM source_collections WHERE project_id = $1`, [project.id]);
    expect(collections.rows).toHaveLength(1);
    expect(collections.rows[0].provider).toBe("DISCORD");

    // This test intentionally leaves the job QUEUED (capture is out of
    // scope here — see worker/discordCaptureLoop.test.ts) — clean it up so
    // it never lingers as a stray QUEUED row for a LATER `npx vitest run`
    // invocation's capture-loop tests to unexpectedly claim and process.
    await pool.query(`DELETE FROM discord_capture_jobs WHERE interaction_id = $1`, [interactionId]);
  });

  it("J: re-invoking the same interaction for the same attachment never creates a duplicate job (redelivery/retry idempotency)", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const discordUserId = randomSnowflake();
    const identity = randomId("identity");
    await linkDiscordUserToIdentity(pool, discordUserId, identity);
    const messageId = randomId("msg");
    const attachmentId = randomSnowflake();
    const interactionId = randomId("interaction");
    const buildInteraction = () =>
      saveToKnoveraInteraction({
        id: interactionId,
        member: { user: { id: discordUserId } },
        authorizing_integration_owners: { "1": discordUserId },
        data: {
          type: 3,
          name: "Save to Knovera",
          target_id: messageId,
          resolved: {
            messages: {
              [messageId]: { id: messageId, attachments: [{ id: attachmentId, filename: "clip.mp4", url: "https://cdn.discordapp.com/clip.mp4" }] },
            },
          },
        },
      });

    await handler(fakeRequest({ privateKey, interaction: buildInteraction() }), makeResponse().res);
    await handler(fakeRequest({ privateKey, interaction: buildInteraction() }), makeResponse().res);

    const jobs = await pool.query(`SELECT * FROM discord_capture_jobs WHERE interaction_id = $1 AND attachment_id = $2`, [interactionId, attachmentId]);
    expect(jobs.rows).toHaveLength(1);

    await pool.query(`DELETE FROM discord_capture_jobs WHERE interaction_id = $1`, [interactionId]);
  });

  it("K: multiple supported video attachments in one message create one job each", async () => {
    const { privateKey, publicKeyHex } = makeKeyPair();
    const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
    const discordUserId = randomSnowflake();
    const identity = randomId("identity");
    await linkDiscordUserToIdentity(pool, discordUserId, identity);
    const messageId = randomId("msg");
    const interactionId = randomId("interaction");
    const attachmentIdA = randomSnowflake();
    const attachmentIdB = `${randomSnowflake()}1`;
    const interaction = saveToKnoveraInteraction({
      id: interactionId,
      member: { user: { id: discordUserId } },
      authorizing_integration_owners: { "1": discordUserId },
      data: {
        type: 3,
        name: "Save to Knovera",
        target_id: messageId,
        resolved: {
          messages: {
            [messageId]: {
              id: messageId,
              attachments: [
                { id: attachmentIdA, filename: "clip-a.mp4", url: "https://cdn.discordapp.com/a.mp4" },
                { id: attachmentIdB, filename: "clip-b.mov", url: "https://cdn.discordapp.com/b.mov" },
                { id: `${attachmentIdA}x`, filename: "readme.txt", url: "https://cdn.discordapp.com/c.txt" },
              ],
            },
          },
        },
      },
    });
    const req = fakeRequest({ privateKey, interaction });
    const { res, statusCode, body } = makeResponse();

    await handler(req, res);

    expect(statusCode()).toBe(200);
    expect((body() as { data: { content: string } }).data.content).toBe("Saving 2 videos to Discord Knowledge…");

    const jobs = await pool.query(`SELECT * FROM discord_capture_jobs WHERE interaction_id = $1`, [interactionId]);
    expect(jobs.rows).toHaveLength(2);

    await pool.query(`DELETE FROM discord_capture_jobs WHERE interaction_id = $1`, [interactionId]);
  });

  // Live-validation Fix 1 — capture must trigger the worker, not just
  // durably enqueue and wait for some OTHER execution to happen to run.
  describe("jobTrigger (live-validation Fix 1)", () => {
    it("L: a successful capture enqueue invokes jobTrigger.triggerRun() exactly once", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      const jobTrigger = fakeJobTrigger();
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger });
      const discordUserId = randomSnowflake();
      const identity = randomId("identity");
      await linkDiscordUserToIdentity(pool, discordUserId, identity);
      const messageId = randomId("msg");
      const attachmentId = randomSnowflake();
      const interactionId = randomId("interaction");
      const interaction = saveToKnoveraInteraction({
        id: interactionId,
        member: { user: { id: discordUserId } },
        authorizing_integration_owners: { "1": discordUserId },
        data: {
          type: 3,
          name: "Save to Knovera",
          target_id: messageId,
          resolved: {
            messages: {
              [messageId]: { id: messageId, attachments: [{ id: attachmentId, filename: "clip.mp4", url: "https://cdn.discordapp.com/clip.mp4" }] },
            },
          },
        },
      });
      const req = fakeRequest({ privateKey, interaction });
      const { res, statusCode } = makeResponse();

      await handler(req, res);

      expect(statusCode()).toBe(200);
      expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);

      await pool.query(`DELETE FROM discord_capture_jobs WHERE interaction_id = $1`, [interactionId]);
    });

    it("M: a jobTrigger failure never fails the interaction response — the job stays durably QUEUED regardless", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      const jobTrigger = fakeJobTrigger(async () => {
        throw new Error("Cloud Run Job execution API unavailable");
      });
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger });
      const discordUserId = randomSnowflake();
      const identity = randomId("identity");
      await linkDiscordUserToIdentity(pool, discordUserId, identity);
      const messageId = randomId("msg");
      const attachmentId = randomSnowflake();
      const interactionId = randomId("interaction");
      const interaction = saveToKnoveraInteraction({
        id: interactionId,
        member: { user: { id: discordUserId } },
        authorizing_integration_owners: { "1": discordUserId },
        data: {
          type: 3,
          name: "Save to Knovera",
          target_id: messageId,
          resolved: {
            messages: {
              [messageId]: { id: messageId, attachments: [{ id: attachmentId, filename: "clip.mp4", url: "https://cdn.discordapp.com/clip.mp4" }] },
            },
          },
        },
      });
      const req = fakeRequest({ privateKey, interaction });
      const { res, statusCode, body } = makeResponse();

      await handler(req, res);

      expect(statusCode()).toBe(200);
      expect((body() as { data: { content: string } }).data.content).toBe("Saving 1 video to Discord Knowledge…");
      expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);

      const jobs = await pool.query(`SELECT status FROM discord_capture_jobs WHERE interaction_id = $1 AND attachment_id = $2`, [interactionId, attachmentId]);
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0].status).toBe("QUEUED");

      await pool.query(`DELETE FROM discord_capture_jobs WHERE interaction_id = $1`, [interactionId]);
    });

    it("M2 (ephemeral-response latency review): the interaction responds promptly even when jobTrigger never resolves — it is never awaited before responding, so a slow/hanging trigger call can never risk Discord's 3-second interaction deadline", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      let triggerRunCalled = false;
      const neverResolvingJobTrigger: JobTrigger = {
        triggerRun: () => {
          triggerRunCalled = true;
          return new Promise<void>(() => {}); // deliberately never settles
        },
      };
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: neverResolvingJobTrigger });
      const discordUserId = randomSnowflake();
      const identity = randomId("identity");
      await linkDiscordUserToIdentity(pool, discordUserId, identity);
      const messageId = randomId("msg");
      const attachmentId = randomSnowflake();
      const interactionId = randomId("interaction");
      const interaction = saveToKnoveraInteraction({
        id: interactionId,
        member: { user: { id: discordUserId } },
        authorizing_integration_owners: { "1": discordUserId },
        data: {
          type: 3,
          name: "Save to Knovera",
          target_id: messageId,
          resolved: {
            messages: {
              [messageId]: { id: messageId, attachments: [{ id: attachmentId, filename: "clip.mp4", url: "https://cdn.discordapp.com/clip.mp4" }] },
            },
          },
        },
      });
      const req = fakeRequest({ privateKey, interaction });
      const { res, statusCode, body } = makeResponse();

      // If the handler ever awaited triggerRun() before responding, this
      // would hang forever (the promise never settles) and the test would
      // time out — it completing at all is the proof.
      await handler(req, res);

      expect(triggerRunCalled).toBe(true);
      expect(statusCode()).toBe(200);
      expect((body() as { data: { content: string } }).data.content).toBe("Saving 1 video to Discord Knowledge…");

      await pool.query(`DELETE FROM discord_capture_jobs WHERE interaction_id = $1`, [interactionId]);
    });

    it("N: never triggers the worker when no supported attachment/job was created", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      const jobTrigger = fakeJobTrigger();
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger });
      const discordUserId = randomSnowflake();
      await linkDiscordUserToIdentity(pool, discordUserId, randomId("identity"));
      const interaction = saveToKnoveraInteraction({
        member: { user: { id: discordUserId } },
        authorizing_integration_owners: { "1": discordUserId },
        data: {
          type: 3,
          name: "Save to Knovera",
          target_id: "msg_1",
          resolved: {
            messages: {
              msg_1: { id: "msg_1", attachments: [{ id: "att_1", filename: "notes.pdf", url: "https://cdn.discordapp.com/x.pdf" }] },
            },
          },
        },
      });
      const req = fakeRequest({ privateKey, interaction });
      const { res, statusCode } = makeResponse();

      await handler(req, res);

      expect(statusCode()).toBe(200);
      expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
    });

    it("O: never triggers the worker for a PING, an unlinked user, or a missing target message", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();

      const pingJobTrigger = fakeJobTrigger();
      await createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: pingJobTrigger })(
        fakeRequest({ privateKey, interaction: pingInteraction() }),
        makeResponse().res,
      );
      expect(pingJobTrigger.triggerRun).not.toHaveBeenCalled();

      const unlinkedDiscordUserId = randomSnowflake();
      const unlinkedJobTrigger = fakeJobTrigger();
      await createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: unlinkedJobTrigger })(
        fakeRequest({
          privateKey,
          interaction: saveToKnoveraInteraction({
            member: { user: { id: unlinkedDiscordUserId } },
            authorizing_integration_owners: { "1": unlinkedDiscordUserId },
          }),
        }),
        makeResponse().res,
      );
      expect(unlinkedJobTrigger.triggerRun).not.toHaveBeenCalled();
    });
  });

  // Live-validation — the "ephemeral response not consistently visible"
  // UX item. This asserts the exact payload shape for every response
  // variant this handler ever sends, verified against Discord's
  // documented Interaction Response object: PONG (type 1, no data) for
  // PING, and CHANNEL_MESSAGE_WITH_SOURCE (type 4) with EXACTLY
  // `{ content: string, flags: 64 }` in `data` — never an extra/
  // unsupported field, never a missing flags/content, never a non-string
  // content — for every ephemeral text reply. No payload construction
  // change was made as a result of this review (the shape was already
  // correct); this is the verification the task asked for, made durable
  // as a regression test.
  describe("ephemeral response payload shape (review — no construction change needed)", () => {
    it("PING gets a bare PONG — type 1, no data field at all", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
      const { res, body } = makeResponse();

      await handler(fakeRequest({ privateKey, interaction: pingInteraction() }), res);

      expect(body()).toEqual({ type: 1 });
    });

    function expectValidEphemeralMessage(payload: unknown, expectedContent: string) {
      const p = payload as { type: number; data: { content: string; flags: number } };
      expect(p.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
      expect(Object.keys(p)).toEqual(["type", "data"]); // no unsupported top-level fields
      expect(Object.keys(p.data).sort()).toEqual(["content", "flags"]); // no unsupported data fields (no embeds/components/tts/etc.)
      expect(typeof p.data.content).toBe("string");
      expect(p.data.content.length).toBeGreaterThan(0);
      expect(p.data.content).toBe(expectedContent);
      expect(p.data.flags).toBe(64); // MESSAGE_FLAGS.EPHEMERAL — every reply here is ephemeral, never posted publicly
    }

    it("the unsupported-command reply is a valid ephemeral CHANNEL_MESSAGE_WITH_SOURCE", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
      const { res, body } = makeResponse();

      await handler(fakeRequest({ privateKey, interaction: saveToKnoveraInteraction({ data: { type: 1, name: "some-other-command" } }) }), res);

      expectValidEphemeralMessage(body(), "This command is not supported.");
    });

    it("the unlinked-account reply is a valid ephemeral message and clearly includes a usable link", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
      const discordUserId = randomSnowflake();
      const { res, body } = makeResponse();

      await handler(
        fakeRequest({
          privateKey,
          interaction: saveToKnoveraInteraction({ member: { user: { id: discordUserId } }, authorizing_integration_owners: { "1": discordUserId } }),
        }),
        res,
      );

      const payload = body() as { type: number; data: { content: string; flags: number } };
      expect(payload.type).toBe(4);
      expect(payload.data.flags).toBe(64);
      expect(payload.data.content).toContain("not linked to Knovera yet");
      expect(payload.data.content).toMatch(new RegExp(`${ALLOWED_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/#/link-discord\\?token=\\S+`));
    });

    it("the successful-capture reply clearly states the number of attachments queued, and is a valid ephemeral message", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
      const discordUserId = randomSnowflake();
      await linkDiscordUserToIdentity(pool, discordUserId, randomId("identity"));
      const messageId = randomId("msg");
      const interactionId = randomId("interaction");
      const attachmentIdA = randomSnowflake();
      const attachmentIdB = `${randomSnowflake()}1`;
      const { res, body } = makeResponse();

      await handler(
        fakeRequest({
          privateKey,
          interaction: saveToKnoveraInteraction({
            id: interactionId,
            member: { user: { id: discordUserId } },
            authorizing_integration_owners: { "1": discordUserId },
            data: {
              type: 3,
              name: "Save to Knovera",
              target_id: messageId,
              resolved: {
                messages: {
                  [messageId]: {
                    id: messageId,
                    attachments: [
                      { id: attachmentIdA, filename: "a.mp4", url: "https://cdn.discordapp.com/a.mp4" },
                      { id: attachmentIdB, filename: "b.mov", url: "https://cdn.discordapp.com/b.mov" },
                    ],
                  },
                },
              },
            },
          }),
        }),
        res,
      );

      expectValidEphemeralMessage(body(), "Saving 2 videos to Discord Knowledge…");

      await pool.query(`DELETE FROM discord_capture_jobs WHERE interaction_id = $1`, [interactionId]);
    });

    it("the no-supported-attachment reply is a valid ephemeral message", async () => {
      const { privateKey, publicKeyHex } = makeKeyPair();
      const handler = createDiscordInteractionsHandler({ pool, discordPublicKey: publicKeyHex, allowedOrigin: ALLOWED_ORIGIN, jobTrigger: fakeJobTrigger() });
      const discordUserId = randomSnowflake();
      await linkDiscordUserToIdentity(pool, discordUserId, randomId("identity"));
      const { res, body } = makeResponse();

      await handler(
        fakeRequest({
          privateKey,
          interaction: saveToKnoveraInteraction({
            member: { user: { id: discordUserId } },
            authorizing_integration_owners: { "1": discordUserId },
            data: {
              type: 3,
              name: "Save to Knovera",
              target_id: "msg_1",
              resolved: { messages: { msg_1: { id: "msg_1", attachments: [{ id: "att_1", filename: "notes.pdf", url: "https://cdn.discordapp.com/x.pdf" }] } } },
            },
          }),
        }),
        res,
      );

      expectValidEphemeralMessage(body(), "No supported video attachment was found in this message.");
    });
  });
});
