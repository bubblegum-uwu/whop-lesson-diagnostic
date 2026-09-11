import { describe, it, expect, afterAll } from "vitest";
import {
  createWhopLessonImport,
  getWhopLessonImportByLessonId,
  getWhopLessonImportsOwnedByOtherProject,
  listAlaCarteWhopLessonsByProjectId,
} from "../src/db/whopLessonImportsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

async function makeCourseAndLesson(): Promise<{ courseId: number; lessonId: number }> {
  const course = await pool.query<{ id: string }>(
    `INSERT INTO courses (whop_course_id, whop_experience_id, slug, title) VALUES ($1, $2, $3, $4) RETURNING id`,
    [randomId("cors"), "exp_x", "slug-x", "Course X"],
  );
  const courseId = Number(course.rows[0].id);
  const lesson = await pool.query<{ id: string }>(
    `INSERT INTO lessons (course_id, whop_lesson_id, title, lesson_type, source_url) VALUES ($1, $2, $3, 'video', 'https://whop.com/x') RETURNING id`,
    [courseId, randomId("lesn"), "Lesson X"],
  );
  return { courseId, lessonId: Number(lesson.rows[0].id) };
}

describe("createWhopLessonImport", () => {
  it("creates a new membership row on first import", async () => {
    const project = await makeProject();
    const { lessonId } = await makeCourseAndLesson();
    const { importRow, created } = await createWhopLessonImport(pool, project.id, lessonId);
    expect(created).toBe(true);
    expect(importRow).toEqual({ lessonId, projectId: project.id, createdAt: expect.any(Date) });
  });

  it("is idempotent for the same project (created:false, same row returned)", async () => {
    const project = await makeProject();
    const { lessonId } = await makeCourseAndLesson();
    await createWhopLessonImport(pool, project.id, lessonId);
    const { importRow, created } = await createWhopLessonImport(pool, project.id, lessonId);
    expect(created).toBe(false);
    expect(importRow.projectId).toBe(project.id);
  });

  it("CRITICAL — a lesson can be à-la-carted by at most ONE project, enforced at the database level (lesson_id is the primary key), not just app logic", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const { lessonId } = await makeCourseAndLesson();
    await createWhopLessonImport(pool, projectA.id, lessonId);

    // A raw INSERT bypassing createWhopLessonImport's ON CONFLICT DO NOTHING must still be rejected outright.
    await expect(pool.query(`INSERT INTO project_whop_lesson_imports (lesson_id, project_id) VALUES ($1, $2)`, [lessonId, projectB.id])).rejects.toThrow(/duplicate key|unique constraint/i);

    // The application-level helper reports it as "already owned by someone else" rather than silently reassigning.
    const { importRow, created } = await createWhopLessonImport(pool, projectB.id, lessonId);
    expect(created).toBe(false);
    expect(importRow.projectId).toBe(projectA.id);
  });
});

describe("getWhopLessonImportsOwnedByOtherProject", () => {
  it("returns only lessons owned by a DIFFERENT project than the one given", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const lessonOwnedByA = await makeCourseAndLesson();
    const lessonOwnedByB = await makeCourseAndLesson();
    const lessonUnowned = await makeCourseAndLesson();
    await createWhopLessonImport(pool, projectA.id, lessonOwnedByA.lessonId);
    await createWhopLessonImport(pool, projectB.id, lessonOwnedByB.lessonId);

    const conflicts = await getWhopLessonImportsOwnedByOtherProject(pool, [lessonOwnedByA.lessonId, lessonOwnedByB.lessonId, lessonUnowned.lessonId], projectA.id);
    expect(conflicts.map((c) => c.lessonId)).toEqual([lessonOwnedByB.lessonId]);
  });

  it("returns [] for an empty lessonIds array without querying", async () => {
    const project = await makeProject();
    expect(await getWhopLessonImportsOwnedByOtherProject(pool, [], project.id)).toEqual([]);
  });
});

describe("listAlaCarteWhopLessonsByProjectId", () => {
  it("lists only this project's à-la-carte lessons, excluding ones whose course is fully connected to this SAME project", async () => {
    const project = await makeProject();
    const alaCarteLesson = await makeCourseAndLesson();
    const connectedCourseLesson = await makeCourseAndLesson();
    await createWhopLessonImport(pool, project.id, alaCarteLesson.lessonId);
    await createWhopLessonImport(pool, project.id, connectedCourseLesson.lessonId);
    // Simulate that course later becoming fully connected to this project.
    await pool.query(`UPDATE courses SET project_id = $1 WHERE id = $2`, [project.id, connectedCourseLesson.courseId]);

    const rows = await listAlaCarteWhopLessonsByProjectId(pool, project.id);
    expect(rows.map((r) => r.lessonId)).toEqual([alaCarteLesson.lessonId]);
  });

  it("never returns another project's à-la-carte lessons", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const lessonB = await makeCourseAndLesson();
    await createWhopLessonImport(pool, projectB.id, lessonB.lessonId);

    const rowsForA = await listAlaCarteWhopLessonsByProjectId(pool, projectA.id);
    expect(rowsForA).toEqual([]);
  });
});

describe("getWhopLessonImportByLessonId", () => {
  it("returns null for a lesson never à-la-carted", async () => {
    const { lessonId } = await makeCourseAndLesson();
    expect(await getWhopLessonImportByLessonId(pool, lessonId)).toBeNull();
  });
});
