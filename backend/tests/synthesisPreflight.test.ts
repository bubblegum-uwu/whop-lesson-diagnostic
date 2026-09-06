import { describe, it, expect } from "vitest";
import { computeSynthesisPreflight, type PreflightLessonInput } from "../src/synthesis/preflight.js";
import { computeAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
import type { LessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";

const MODEL = "gemini-3.8-flash";

function makeAnalysis(overrides: Partial<LessonAnalysis> = {}): LessonAnalysis {
  return {
    analysisId: 1,
    lessonId: 10,
    jobId: "job-1",
    status: "completed",
    strategyFound: true,
    validatedJson: { lesson: { title: "L", duration_seconds: 60 }, strategy_found: true, strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE },
    analysisSummary: "s",
    model: MODEL,
    promptVersion: "v1",
    extractorVersion: "v1",
    schemaVersion: "v1",
    analysisFingerprint: "stale-fingerprint",
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 10,
    inputTokens: 10,
    outputTokens: 10,
    thinkingTokens: 0,
    estimatedCost: 0.01,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("synthesis/preflight", () => {
  it("reports every count as zero and ready=false for a course with no lessons at all", () => {
    const result = computeSynthesisPreflight([], new Map(), MODEL);
    expect(result).toMatchObject({ lessonCount: 0, latestSuccessfulAnalysisCount: 0, currentAnalysisCount: 0, staleAnalysisCount: 0, missingAnalysisCount: 0, ready: false });
  });

  it("counts a lesson with no analysis at all as missing", () => {
    const lessons: PreflightLessonInput[] = [{ id: 10, whopLessonId: "wl-10", title: "Lesson 10" }];
    const result = computeSynthesisPreflight(lessons, new Map(), MODEL);
    expect(result.missingAnalysisCount).toBe(1);
    expect(result.missingLessonIds).toEqual([10]);
    expect(result.missingLessonTitles).toEqual(["Lesson 10"]);
    expect(result.latestSuccessfulAnalysisCount).toBe(0);
    expect(result.ready).toBe(false);
  });

  it("counts a lesson whose latest job is only FAILED (no completed/no_strategy row) as missing, not stale", () => {
    const lessons: PreflightLessonInput[] = [{ id: 10, whopLessonId: "wl-10", title: "Lesson 10" }];
    // No entry in latestByLesson at all represents "no successful analysis exists" — the same situation a FAILED-only job history produces (lessonAnalysesRepo has no row for a job that only ever failed).
    const result = computeSynthesisPreflight(lessons, new Map(), MODEL);
    expect(result.missingAnalysisCount).toBe(1);
    expect(result.staleAnalysisCount).toBe(0);
  });

  it("counts a completed analysis with a stale (non-current) fingerprint as stale", () => {
    const lessons: PreflightLessonInput[] = [{ id: 10, whopLessonId: "wl-10", title: "Lesson 10" }];
    const latestByLesson = new Map([[10, makeAnalysis({ lessonId: 10, analysisFingerprint: "definitely-not-current" })]]);
    const result = computeSynthesisPreflight(lessons, latestByLesson, MODEL);
    expect(result.latestSuccessfulAnalysisCount).toBe(1);
    expect(result.staleAnalysisCount).toBe(1);
    expect(result.staleLessonIds).toEqual([10]);
    expect(result.currentAnalysisCount).toBe(0);
    expect(result.ready).toBe(false);
  });

  it("counts a no_strategy analysis with a CURRENT fingerprint as current, not stale or missing", () => {
    const lessons: PreflightLessonInput[] = [{ id: 10, whopLessonId: "wl-10", title: "Lesson 10" }];
    const currentFingerprint = computeAnalysisFingerprint({ whopLessonId: "wl-10", geminiModel: MODEL });
    const latestByLesson = new Map([[10, makeAnalysis({ lessonId: 10, status: "no_strategy", strategyFound: false, analysisFingerprint: currentFingerprint })]]);
    const result = computeSynthesisPreflight(lessons, latestByLesson, MODEL);
    expect(result.currentAnalysisCount).toBe(1);
    expect(result.staleAnalysisCount).toBe(0);
    expect(result.missingAnalysisCount).toBe(0);
    expect(result.ready).toBe(true);
  });

  it("ready is true only when EVERY lesson has a current analysis — one stale lesson among many current ones is enough to fail readiness", () => {
    const lessons: PreflightLessonInput[] = [
      { id: 10, whopLessonId: "wl-10", title: "Lesson 10" },
      { id: 11, whopLessonId: "wl-11", title: "Lesson 11" },
    ];
    const currentFingerprint10 = computeAnalysisFingerprint({ whopLessonId: "wl-10", geminiModel: MODEL });
    const latestByLesson = new Map([
      [10, makeAnalysis({ lessonId: 10, analysisFingerprint: currentFingerprint10 })],
      [11, makeAnalysis({ lessonId: 11, analysisFingerprint: "stale" })],
    ]);
    const result = computeSynthesisPreflight(lessons, latestByLesson, MODEL);
    expect(result.currentAnalysisCount).toBe(1);
    expect(result.staleAnalysisCount).toBe(1);
    expect(result.ready).toBe(false);
  });

  it("28/28 current lessons is exactly what production readiness looks like — a realistic full-course check", () => {
    const lessons: PreflightLessonInput[] = Array.from({ length: 28 }, (_, i) => ({ id: i + 1, whopLessonId: `wl-${i + 1}`, title: `Lesson ${i + 1}` }));
    const latestByLesson = new Map(
      lessons.map((l) => [l.id, makeAnalysis({ lessonId: l.id, analysisFingerprint: computeAnalysisFingerprint({ whopLessonId: l.whopLessonId, geminiModel: MODEL }) })]),
    );
    const result = computeSynthesisPreflight(lessons, latestByLesson, MODEL);
    expect(result.lessonCount).toBe(28);
    expect(result.currentAnalysisCount).toBe(28);
    expect(result.staleAnalysisCount).toBe(0);
    expect(result.missingAnalysisCount).toBe(0);
    expect(result.ready).toBe(true);
  });
});
