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

/**
 * A digits-only fake Discord snowflake, unique per call — for tests that
 * paste a Discord attachment URL through the real parser (lib/discordUrl.ts's
 * SNOWFLAKE_PATTERN requires `/^[0-9]{1,20}$/`, so randomId's alphanumeric
 * output can't be used in a URL path segment). Combines the current time
 * with a random suffix so it's also unique across repeated test RUNS, not
 * just within one run — content_assets/project_sources rows created by a
 * previous run of the same test (e.g. one using the real, fixed
 * "knovera-operator" identity, which can't itself be randomized) persist
 * in the shared test database and would otherwise collide with a
 * hardcoded literal.
 */
export function randomSnowflake(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
}
