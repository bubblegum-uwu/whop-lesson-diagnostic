/**
 * Phase 4K follow-up — shared course-dashboard shaping logic. Extracted
 * verbatim from http/routes/courseLessons.ts's per-lesson job/analysis
 * merge, http/routes/analysisSummary.ts's dashboard-counters math, and
 * http/routes/projectSources.ts's buildWhopProjectSource summary math, so
 * the legacy single-course routes, the multi-course sources list, and the
 * new per-course rich dashboard endpoint (http/routes/whopCourses.ts's
 * createGetWhopCourseDashboardHandler) all compute these numbers from one
 * place — never re-derived ad hoc, never requiring a second round of
 * queries against rows the caller already fetched.
 */
import type { LessonRow } from "../db/lessonsRepo.js";
import type { AnalysisJob, JobSummaryCounts } from "../db/analysisJobsRepo.js";
import type { LessonAnalysis, CourseSpendSummary } from "../db/lessonAnalysesRepo.js";
import type { CourseRow } from "../db/coursesRepo.js";
import { ruleCounts, aggregateConfidence, extractedStrategiesLabel, knowledgeItemCounts, hasSupportingKnowledge } from "./analysisSummary.js";

/** Mirrors courseLessons.ts's per-lesson job/analysis merge — the one source of this shaping logic. */
export function buildCourseLessonSummaries(lessons: LessonRow[], jobsByLesson: Map<number, AnalysisJob>, analysesByLesson: Map<number, LessonAnalysis>) {
  return lessons.map((l) => {
    const job = jobsByLesson.get(l.id) ?? null;
    const analysis = analysesByLesson.get(l.id) ?? null;

    return {
      id: l.id,
      title: l.title,
      chapterTitle: l.chapterTitle,
      chapterOrder: l.chapterOrder,
      courseOrder: l.courseOrder,
      durationSeconds: l.durationSeconds,
      videoAvailable: l.videoAvailable,
      sourceUrl: l.sourceUrl,
      lastSyncedAt: l.lastSyncedAt,
      job: job
        ? {
            jobId: job.jobId,
            status: job.status,
            currentStage: job.currentStage,
            stageProgress: job.stageProgress,
            overallProgress: job.overallProgress,
            lastHeartbeatAt: job.lastHeartbeatAt,
            leaseExpiresAt: job.leaseExpiresAt,
            attemptCount: job.attemptCount,
            sanitizedError: job.sanitizedError,
            errorType: job.errorType,
          }
        : { jobId: null, status: "NOT_ANALYZED" as const },
      analysis: analysis
        ? {
            analysisId: analysis.analysisId,
            strategyFound: analysis.strategyFound,
            extractedStrategiesLabel: extractedStrategiesLabel(analysis.validatedJson),
            ruleCounts: ruleCounts(analysis.validatedJson),
            confidence: aggregateConfidence(analysis.validatedJson),
            summary: analysis.analysisSummary,
            // Phase 3.5: a lesson can have strategyFound=false while still
            // carrying real supporting knowledge (risk management, sizing,
            // psychology, ...) — lets the Course table show that distinctly
            // from a lesson with genuinely nothing extracted.
            hasSupportingKnowledge: hasSupportingKnowledge(analysis.validatedJson),
            knowledgeItemCounts: knowledgeItemCounts(analysis.validatedJson),
            schemaVersion: analysis.schemaVersion,
            estimatedCost: analysis.estimatedCost,
            processingDurationSeconds: analysis.processingDurationSeconds,
            completedAt: analysis.completedAt,
          }
        : null,
    };
  });
}

/** Mirrors analysisSummary.ts's dashboard-counters computation — the one source of this math. */
export function buildCourseAnalysisSummary(totalLessons: number, counts: JobSummaryCounts, spend: CourseSpendSummary) {
  const analyzed = counts.completed + counts.noStrategy;
  const accountedFor = analyzed + counts.processing + counts.queued + counts.failed + counts.authRequired + counts.cancelled;

  return {
    totalLessons,
    analyzed,
    strategyLessons: counts.completed,
    noStrategy: counts.noStrategy,
    processing: counts.processing,
    queued: counts.queued,
    failed: counts.failed,
    authRequired: counts.authRequired,
    remaining: Math.max(0, totalLessons - accountedFor),
    totalCost: spend.totalCost,
    averageCostPerLesson: spend.averageCostPerLesson,
    averageProcessingSeconds: spend.averageProcessingSeconds,
  };
}

/** Mirrors projectSources.ts's buildWhopProjectSource summary math — the one source of this shaping logic. */
export function buildWhopCourseSummaryFields(course: CourseRow, totalLessons: number, counts: JobSummaryCounts, spend: CourseSpendSummary) {
  const analyzedLessonCount = counts.completed + counts.noStrategy;
  const accountedFor = analyzedLessonCount + counts.processing + counts.queued + counts.failed + counts.authRequired + counts.cancelled;

  return {
    provider: "WHOP" as const,
    sourceType: "COURSE" as const,
    courseId: course.id,
    externalId: course.whopCourseId,
    name: course.title,
    lessonCount: totalLessons,
    analyzedLessonCount,
    queuedCount: counts.queued,
    processingCount: counts.processing,
    failedCount: counts.failed,
    remainingCount: Math.max(0, totalLessons - accountedFor),
    lastSyncedAt: course.lastSyncedAt,
    totalCost: spend.totalCost,
  };
}
