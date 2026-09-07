import type { LessonAnalysis } from "../db/lessonAnalysesRepo.js";
import { computeAnalysisFingerprint } from "../pipeline/fingerprint.js";

/**
 * Phase 3.5B — reports exactly what the spec asks for before a production
 * synthesis run: how many lessons exist, how many have a usable latest
 * analysis (completed or no_strategy), how many of those are CURRENT (their
 * fingerprint matches what analyzing that lesson today, with today's
 * prompt/schema/extractor version, would produce — see pipeline/fingerprint.ts,
 * the SAME mechanism the lesson-analysis "already analyzed, skip" check
 * uses), and how many lessons have no usable analysis at all. Never
 * hardcodes "v2" — computeAnalysisFingerprint always uses whatever
 * pipeline/analysisVersion.ts currently defines, so this stays correct
 * across future version bumps without editing this file.
 */
export interface PreflightLessonInput {
  id: number;
  whopLessonId: string;
  title: string;
}

export interface SynthesisPreflightResult {
  lessonCount: number;
  /** Lessons whose latest analysis is completed or no_strategy — a usable synthesis source, regardless of whether it's current. */
  latestSuccessfulAnalysisCount: number;
  /** Of those, how many match today's fingerprint (current prompt/schema/extractor version + model). */
  currentAnalysisCount: number;
  /** Of those, how many do NOT (stale — analyzed under an older version, e.g. pre-Phase-3.5A v1). */
  staleAnalysisCount: number;
  /** Lessons with no completed/no_strategy analysis at all (never analyzed, still processing, or only failed attempts). */
  missingAnalysisCount: number;
  staleLessonIds: number[];
  staleLessonTitles: string[];
  missingLessonIds: number[];
  missingLessonTitles: string[];
  /** True only when EVERY lesson has a current latest-successful analysis — nothing missing, nothing stale. */
  ready: boolean;
}

export function computeSynthesisPreflight(
  lessons: PreflightLessonInput[],
  latestByLesson: Map<number, LessonAnalysis>,
  geminiModel: string,
): SynthesisPreflightResult {
  let latestSuccessfulAnalysisCount = 0;
  let currentAnalysisCount = 0;
  const staleLessons: PreflightLessonInput[] = [];
  const missingLessons: PreflightLessonInput[] = [];

  for (const lesson of lessons) {
    const analysis = latestByLesson.get(lesson.id);
    if (!analysis || (analysis.status !== "completed" && analysis.status !== "no_strategy")) {
      missingLessons.push(lesson);
      continue;
    }
    latestSuccessfulAnalysisCount++;
    const currentFingerprint = computeAnalysisFingerprint({ whopLessonId: lesson.whopLessonId, geminiModel });
    if (analysis.analysisFingerprint === currentFingerprint) {
      currentAnalysisCount++;
    } else {
      staleLessons.push(lesson);
    }
  }

  return {
    lessonCount: lessons.length,
    latestSuccessfulAnalysisCount,
    currentAnalysisCount,
    staleAnalysisCount: staleLessons.length,
    missingAnalysisCount: missingLessons.length,
    staleLessonIds: staleLessons.map((l) => l.id),
    staleLessonTitles: staleLessons.map((l) => l.title),
    missingLessonIds: missingLessons.map((l) => l.id),
    missingLessonTitles: missingLessons.map((l) => l.title),
    ready: missingLessons.length === 0 && staleLessons.length === 0 && lessons.length > 0,
  };
}
