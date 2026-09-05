import { describe, it, expect, afterAll } from "vitest";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons, type SyncLessonInput } from "../src/db/lessonsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeCourse() {
  return upsertCourse(pool, {
    whopCourseId: randomId("cors"),
    whopExperienceId: "exp_gdmood6JIzSsE7",
    slug: "scarface-trades-mastermind",
    title: "Scarface Trades Mastermind",
  });
}

function lesson(overrides: Partial<SyncLessonInput> = {}): SyncLessonInput {
  return {
    whopLessonId: randomId("lesn"),
    title: "Support & Resistance",
    lessonType: "video",
    visibility: "visible",
    chapterWhopId: "chap_1",
    chapterTitle: "Foundations",
    chapterOrder: 1,
    courseOrder: 1,
    durationSeconds: 2640,
    videoAssetStatus: "ready",
    videoAvailable: true,
    sourceUrl:
      "https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_x/lessons/lesn_x/",
    ...overrides,
  };
}

describe("lessonsRepo", () => {
  it("syncs a fresh set of lessons for a course", async () => {
    const course = await makeCourse();
    const a = lesson({ title: "Intro", courseOrder: 1 });
    const b = lesson({ title: "Support & Resistance", courseOrder: 2 });

    const result = await syncLessons(pool, course.id, [a, b]);
    expect(result).toEqual({ upserted: 2, archived: 0 });

    const rows = await listLessons(pool, course.id);
    expect(rows.map((r) => r.title)).toEqual(["Intro", "Support & Resistance"]);
    expect(rows[0].sourceUrl).toBe(a.sourceUrl);
  });

  it("updates an existing lesson's metadata on a repeat sync instead of duplicating it", async () => {
    const course = await makeCourse();
    const original = lesson({ title: "Order Blocks", courseOrder: 1 });
    await syncLessons(pool, course.id, [original]);

    const updated = { ...original, title: "Order Blocks (Updated)", durationSeconds: 3000 };
    const result = await syncLessons(pool, course.id, [updated]);
    expect(result.upserted).toBe(1);

    const rows = await listLessons(pool, course.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Order Blocks (Updated)");
    expect(rows[0].durationSeconds).toBe(3000);
  });

  it("soft-archives a lesson that disappears from a later sync, rather than deleting it", async () => {
    const course = await makeCourse();
    const stays = lesson({ title: "Stays", courseOrder: 1 });
    const disappears = lesson({ title: "Disappears", courseOrder: 2 });
    await syncLessons(pool, course.id, [stays, disappears]);

    const result = await syncLessons(pool, course.id, [stays]);
    expect(result).toEqual({ upserted: 1, archived: 1 });

    const visible = await listLessons(pool, course.id);
    expect(visible.map((r) => r.title)).toEqual(["Stays"]);
  });

  it("un-archives a lesson that reappears in a later sync", async () => {
    const course = await makeCourse();
    const flappy = lesson({ title: "Flappy", courseOrder: 1 });
    await syncLessons(pool, course.id, [flappy]);
    await syncLessons(pool, course.id, []); // disappears
    expect(await listLessons(pool, course.id)).toHaveLength(0);

    await syncLessons(pool, course.id, [flappy]); // reappears
    const rows = await listLessons(pool, course.id);
    expect(rows.map((r) => r.title)).toEqual(["Flappy"]);
    expect(rows[0].archivedAt).toBeNull();
  });

  it("orders lessons by chapter then course order", async () => {
    const course = await makeCourse();
    const c2l1 = lesson({ title: "Ch2-L1", chapterOrder: 2, courseOrder: 1 });
    const c1l2 = lesson({ title: "Ch1-L2", chapterOrder: 1, courseOrder: 2 });
    const c1l1 = lesson({ title: "Ch1-L1", chapterOrder: 1, courseOrder: 1 });
    await syncLessons(pool, course.id, [c2l1, c1l2, c1l1]);

    const rows = await listLessons(pool, course.id);
    expect(rows.map((r) => r.title)).toEqual(["Ch1-L1", "Ch1-L2", "Ch2-L1"]);
  });
});
