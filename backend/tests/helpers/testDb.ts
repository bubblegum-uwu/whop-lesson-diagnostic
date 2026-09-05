import type { Pool } from "pg";
import { createPool } from "../../src/db/pool.js";

/**
 * A real local Postgres, not a mock — these are integration tests for the
 * SQL itself. Point `TEST_DATABASE_HOST`/etc at a disposable database;
 * defaults match the local `whop_lesson_test` database used in dev/CI.
 */
export function createTestPool(): Pool {
  return createPool({
    host: process.env.TEST_DATABASE_HOST || "localhost",
    port: process.env.TEST_DATABASE_PORT ? Number(process.env.TEST_DATABASE_PORT) : 5432,
    user: process.env.TEST_DATABASE_USER || "postgres",
    password: process.env.TEST_DATABASE_PASSWORD || "postgres",
    database: process.env.TEST_DATABASE_NAME || "whop_lesson_test",
  });
}

export function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}
