import { describe, it, expect, afterAll } from "vitest";
import { acquireWorkerLock } from "../src/worker/advisoryLock.js";
import { createTestPool } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

describe("acquireWorkerLock", () => {
  it("only one of two concurrent callers acquires the lock", async () => {
    const first = await acquireWorkerLock(pool);
    const second = await acquireWorkerLock(pool);

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);

    await first.release();
    await second.release();
  });

  it("releasing frees the lock for the next acquirer (graceful release)", async () => {
    const first = await acquireWorkerLock(pool);
    expect(first.acquired).toBe(true);
    await first.release();

    const second = await acquireWorkerLock(pool);
    expect(second.acquired).toBe(true);
    await second.release();
  });

  it("a crashed holder's lock releases automatically when its connection closes, without an explicit release()", async () => {
    // Use a second, independent pool to simulate a genuinely different
    // process's connection dying, rather than this test's own pool.
    const crashedProcessPool = createTestPool();
    const held = await acquireWorkerLock(crashedProcessPool);
    expect(held.acquired).toBe(true);

    // Simulate a hard crash (never calling held.release()) by forcibly
    // terminating the backend connection that holds the lock at the
    // Postgres level — Pool.end() would instead wait for a graceful
    // release, which a genuine crash never provides.
    const { rows } = await pool.query<{ pid: number }>(`SELECT pid FROM pg_locks WHERE locktype = 'advisory'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      await pool.query(`SELECT pg_terminate_backend($1)`, [row.pid]);
    }
    crashedProcessPool.end().catch(() => undefined);

    const next = await acquireWorkerLock(pool);
    expect(next.acquired).toBe(true);
    await next.release();
  });
});
