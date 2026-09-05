import { describe, it, expect, afterAll } from "vitest";
import { upsertCourse, getCourseByWhopId } from "../src/db/coursesRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

describe("coursesRepo", () => {
  it("inserts a new course on first sync", async () => {
    const whopCourseId = randomId("cors");
    const course = await upsertCourse(pool, {
      whopCourseId,
      whopExperienceId: "exp_gdmood6JIzSsE7",
      slug: "scarface-trades-mastermind",
      title: "Scarface Trades Mastermind",
    });

    expect(course.whopCourseId).toBe(whopCourseId);
    expect(course.title).toBe("Scarface Trades Mastermind");
    expect(course.lastSyncedAt).not.toBeNull();
  });

  it("updates metadata and last_synced_at on a repeat sync, without creating a duplicate row", async () => {
    const whopCourseId = randomId("cors");
    const first = await upsertCourse(pool, {
      whopCourseId,
      whopExperienceId: "exp_old",
      slug: "old-slug",
      title: "Old Title",
    });

    await new Promise((r) => setTimeout(r, 5));

    const second = await upsertCourse(pool, {
      whopCourseId,
      whopExperienceId: "exp_new",
      slug: "new-slug",
      title: "New Title",
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("New Title");
    expect(second.slug).toBe("new-slug");
    expect(second.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(first.lastSyncedAt!.getTime());
  });

  it("getCourseByWhopId returns null for an unknown course", async () => {
    expect(await getCourseByWhopId(pool, randomId("unknown"))).toBeNull();
  });

  it("getCourseByWhopId finds a previously-synced course", async () => {
    const whopCourseId = randomId("cors");
    await upsertCourse(pool, {
      whopCourseId,
      whopExperienceId: "exp_gdmood6JIzSsE7",
      slug: "scarface-trades-mastermind",
      title: "Scarface Trades Mastermind",
    });

    const found = await getCourseByWhopId(pool, whopCourseId);
    expect(found?.whopCourseId).toBe(whopCourseId);
  });
});
