import type { Pool, PoolClient } from "pg";

/**
 * Global single-worker guard. This is a SESSION-level advisory lock (not
 * `pg_advisory_xact_lock`), held on one dedicated connection for the entire
 * lifetime of a Cloud Run Job execution: if the execution crashes or is
 * force-killed at its task timeout, Postgres itself releases the lock the
 * instant that connection closes — no manual expiry bookkeeping needed for
 * this layer (contrast with the per-job lease in analysisJobsRepo, which
 * does need an explicit expiry because it isn't tied to a live connection).
 *
 * A second execution that can't acquire the lock exits immediately and
 * cheaply — per the approved plan, this is an acceptable occasional extra
 * cold start, not something worth building distributed coordination for.
 */
const WORKER_LOCK_KEY = 5_902_331_004;

export interface WorkerLock {
  acquired: boolean;
  release(): Promise<void>;
}

export async function acquireWorkerLock(pool: Pool): Promise<WorkerLock> {
  const client: PoolClient = await pool.connect();
  // A checked-out client's connection errors are the caller's responsibility
  // to handle (pg.Pool only manages idle clients) — an unhandled 'error'
  // event on it would otherwise crash the process. If the connection drops
  // for any reason, Postgres has already released the session-level lock on
  // its end; there is nothing more to do here than not crash.
  client.on("error", () => undefined);
  const result = await client.query<{ pg_try_advisory_lock: boolean }>(
    "SELECT pg_try_advisory_lock($1)",
    [WORKER_LOCK_KEY],
  );
  const acquired = result.rows[0]?.pg_try_advisory_lock === true;

  if (!acquired) {
    client.release();
    return { acquired: false, release: async () => undefined };
  }

  let released = false;
  return {
    acquired: true,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_KEY]);
      } finally {
        client.release();
      }
    },
  };
}
