import { describe, it, expect, vi, afterAll } from "vitest";
import { syncCourse } from "../src/pipeline/courseSync.js";
import { getCourseByWhopId } from "../src/db/coursesRepo.js";
import { listLessons } from "../src/db/lessonsRepo.js";
import type { WhopCourseClient } from "../src/whop/courseClient.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

function makeConfig(courseId: string) {
  return { courseId, experienceId: "exp_gdmood6JIzSsE7", slug: "scarface-trades-mastermind" };
}

function makeCourseClient(overrides: Partial<WhopCourseClient> = {}): WhopCourseClient {
  return {
    fetchCourse: vi.fn(),
    fetchCourseLessonsPage: vi.fn(),
    ...overrides,
  };
}

describe("syncCourse", () => {
  it("joins the lesson list to chapter metadata from the course tree, and persists a working source_url", async () => {
    const courseId = randomId("cors");
    const config = makeConfig(courseId);

    const client = makeCourseClient({
      fetchCourse: vi.fn(async () => ({
        id: courseId,
        title: "Scarface Trades Mastermind",
        chapters: [
          { id: "chap_1", title: "Foundations", order: 1, lessons: [{ id: "lesn_a", order: 1 }] },
          { id: "chap_2", title: "Advanced Setups", order: 2, lessons: [{ id: "lesn_b", order: 1 }] },
        ],
      })),
      fetchCourseLessonsPage: vi.fn(async () => ({
        data: [
          {
            id: "lesn_a",
            title: "Intro to Accelerator",
            order: 1,
            lesson_type: "video",
            visibility: "visible",
            video_asset: { duration_seconds: 1620, status: "ready" },
          },
          {
            id: "lesn_b",
            title: "Support & Resistance",
            order: 1,
            lesson_type: "video",
            visibility: "visible",
            video_asset: { duration_seconds: 2640, status: "ready" },
          },
        ],
        page_info: { end_cursor: null, has_next_page: false },
      })),
    });

    const result = await syncCourse(pool, client, "tok_abc", config);
    expect(result).toEqual({ courseTitle: "Scarface Trades Mastermind", upserted: 2, archived: 0 });

    const course = await getCourseByWhopId(pool, courseId);
    const lessons = await listLessons(pool, course!.id);
    expect(lessons.map((l) => l.title)).toEqual(["Intro to Accelerator", "Support & Resistance"]);

    const lessonA = lessons.find((l) => l.whopLessonId === "lesn_a")!;
    expect(lessonA.chapterTitle).toBe("Foundations");
    expect(lessonA.chapterOrder).toBe(1);
    expect(lessonA.durationSeconds).toBe(1620);
    expect(lessonA.videoAvailable).toBe(true);
    expect(lessonA.sourceUrl).toBe(
      `https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/${courseId}/lessons/lesn_a/`,
    );

    const lessonB = lessons.find((l) => l.whopLessonId === "lesn_b")!;
    expect(lessonB.chapterTitle).toBe("Advanced Setups");
  });

  it("leaves chapter fields null for a lesson the course tree doesn't mention", async () => {
    const courseId = randomId("cors");
    const config = makeConfig(courseId);

    const client = makeCourseClient({
      fetchCourse: vi.fn(async () => ({ id: courseId, title: "Course", chapters: [] })),
      fetchCourseLessonsPage: vi.fn(async () => ({
        data: [
          {
            id: "lesn_orphan",
            title: "Orphan Lesson",
            order: 1,
            lesson_type: "video",
            visibility: "visible",
            video_asset: null,
          },
        ],
        page_info: { end_cursor: null, has_next_page: false },
      })),
    });

    await syncCourse(pool, client, "tok", config);
    const course = await getCourseByWhopId(pool, courseId);
    const lessons = await listLessons(pool, course!.id);
    expect(lessons[0].chapterTitle).toBeNull();
    expect(lessons[0].chapterOrder).toBeNull();
    expect(lessons[0].durationSeconds).toBeNull();
    expect(lessons[0].videoAvailable).toBe(false);
  });

  it("follows pagination across multiple pages of course_lessons", async () => {
    const courseId = randomId("cors");
    const config = makeConfig(courseId);

    const client = makeCourseClient({
      fetchCourse: vi.fn(async () => ({ id: courseId, title: "Course", chapters: [] })),
      fetchCourseLessonsPage: vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: "lesn_1", title: "One", order: 1, lesson_type: "video", visibility: "visible", video_asset: null }],
          page_info: { end_cursor: "cursor_1", has_next_page: true },
        })
        .mockResolvedValueOnce({
          data: [{ id: "lesn_2", title: "Two", order: 2, lesson_type: "video", visibility: "visible", video_asset: null }],
          page_info: { end_cursor: null, has_next_page: false },
        }),
    });

    const result = await syncCourse(pool, client, "tok", config);
    expect(result.upserted).toBe(2);
    const course = await getCourseByWhopId(pool, courseId);
    const lessons = await listLessons(pool, course!.id);
    expect(lessons.map((l) => l.title)).toEqual(["One", "Two"]);
  });
});
