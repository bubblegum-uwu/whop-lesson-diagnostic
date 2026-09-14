import type { Pool } from "pg";
import { getProjectByName, type Project, type ProjectType } from "../db/projectsRepo.js";
import { getCourseByWhopId, type CourseRow } from "../db/coursesRepo.js";
import { getLatestCompletedRun, listRunsByCourseId, type SynthesisRun } from "../db/synthesisRunsRepo.js";
import { getByAnalysisIds } from "../db/lessonAnalysesRepo.js";
import { getLessonsByIds } from "../db/lessonsRepo.js";
import { getCoursePlaybookByRun } from "../db/coursePlaybooksRepo.js";
import { createSynthesisSet, listSynthesisSetsByProjectId, type SynthesisSetRow } from "../db/synthesisSetsRepo.js";
import { listLessonIdsForSynthesisSet, bulkAddLessonsToSynthesisSet } from "../db/synthesisSetLessonsRepo.js";
import { listLegacyRunIdsForSynthesisSet, attachLegacyRunToSynthesisSet } from "../db/synthesisSetLegacyRunsRepo.js";

/**
 * Pre-4M — the importable core of scripts/recoverLegacyWhopSynthesis.ts,
 * split out so it can be exercised directly by backend tests (no
 * subprocess/CLI spawning) while the script itself stays a thin
 * argv-parsing/console-printing wrapper around plan()/apply() below. See
 * that script's own doc comment for the full algorithm rationale.
 */
export interface LegacyRecoveryArgs {
  projectName: string;
  projectType: ProjectType;
  courseWhopId: string;
  setName: string;
}

export class RecoveryStopError extends Error {}

export interface LegacyRecoveryPlan {
  project: Project;
  course: CourseRow;
  allRuns: SynthesisRun[];
  latestCompletedRun: SynthesisRun;
  distinctLessonIds: number[];
  playbookFound: boolean;
  existingSet: SynthesisSetRow | null;
  newLessonCount: number;
  newRunCount: number;
}

/**
 * Pure-read validation pass — never writes anything. Throws
 * RecoveryStopError (never a raw Error) on any structural problem so the
 * caller (the CLI script, or a test) can distinguish "recovery cannot
 * proceed, here's why" from a genuine bug/connection failure.
 */
export async function planLegacyWhopSynthesisRecovery(pool: Pool, args: LegacyRecoveryArgs): Promise<LegacyRecoveryPlan> {
  const project = await getProjectByName(pool, args.projectName, args.projectType);
  if (!project) throw new RecoveryStopError(`Project not found: name="${args.projectName}" type=${args.projectType}.`);

  const course = await getCourseByWhopId(pool, args.courseWhopId);
  if (!course) throw new RecoveryStopError(`Course not found: whop_course_id="${args.courseWhopId}".`);
  if (course.projectId !== project.id) {
    throw new RecoveryStopError(
      `Course "${course.title}" is not connected to project "${project.name}" (courses.project_id=${course.projectId ?? "null"}, expected ${project.id}). This script recovers synthesis for an already-connected course; it does not connect one.`,
    );
  }

  const allRuns = await listRunsByCourseId(pool, course.id);
  const latestCompletedRun = await getLatestCompletedRun(pool, course.id);
  if (!latestCompletedRun) throw new RecoveryStopError(`No COMPLETED synthesis run found for course "${course.title}" — nothing to recover.`);

  const analyses = await getByAnalysisIds(pool, latestCompletedRun.sourceAnalysisIds);
  if (analyses.length !== latestCompletedRun.sourceAnalysisIds.length) {
    throw new RecoveryStopError(
      `Latest completed run ${latestCompletedRun.runId} references ${latestCompletedRun.sourceAnalysisIds.length} analysis id(s) but only ${analyses.length} exist in lesson_analyses — data integrity issue.`,
    );
  }

  const distinctLessonIds = [...new Set(analyses.map((a) => a.lessonId))].sort((a, b) => a - b);

  const lessons = await getLessonsByIds(pool, distinctLessonIds);
  if (lessons.length !== distinctLessonIds.length) {
    throw new RecoveryStopError(`Some lesson ids referenced by the latest completed run's analyses no longer exist in lessons.`);
  }
  const foreignLessons = lessons.filter((l) => l.courseId !== course.id);
  if (foreignLessons.length > 0) {
    throw new RecoveryStopError(
      `Some analyses in the latest completed run reference lessons that do NOT belong to course "${course.title}" (lesson ids: ${foreignLessons.map((l) => l.id).join(", ")}) — data integrity issue.`,
    );
  }

  const playbook = await getCoursePlaybookByRun(pool, latestCompletedRun.runId);
  if (!playbook) throw new RecoveryStopError(`No course_playbooks row exists for run ${latestCompletedRun.runId} — cannot recover a "latest completed" result with no playbook.`);

  const existingSets = await listSynthesisSetsByProjectId(pool, project.id);
  const existingSet = existingSets.find((s) => s.name === args.setName) ?? null;

  const currentLessonIds = existingSet ? new Set(await listLessonIdsForSynthesisSet(pool, existingSet.id)) : new Set<number>();
  const newLessonCount = distinctLessonIds.filter((id) => !currentLessonIds.has(id)).length;

  const currentRunIds = existingSet ? new Set(await listLegacyRunIdsForSynthesisSet(pool, existingSet.id)) : new Set<string>();
  const newRunCount = allRuns.filter((r) => !currentRunIds.has(r.runId)).length;

  return { project, course, allRuns, latestCompletedRun, distinctLessonIds, playbookFound: playbook !== null, existingSet, newLessonCount, newRunCount };
}

export interface LegacyRecoveryApplyResult {
  synthesisSetId: number;
  createdSet: boolean;
  lessonsAttached: number;
  lessonsTotal: number;
  runsAttached: number;
  runsTotal: number;
}

/**
 * The ONLY function that writes. Runs entirely inside one transaction:
 * find-or-create the target Synthesis Set, bulk-attach the recovered
 * lesson set, attach every historical run. Never calls Gemini, never
 * enqueues analysis_jobs or synthesis_runs — every write here targets
 * synthesis_sets/synthesis_set_lessons/synthesis_set_legacy_runs only.
 */
export async function applyLegacyWhopSynthesisRecovery(pool: Pool, plan: LegacyRecoveryPlan, args: LegacyRecoveryArgs): Promise<LegacyRecoveryApplyResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let targetSet = plan.existingSet;
    let createdSet = false;
    if (!targetSet) {
      targetSet = await createSynthesisSet(client, { projectId: plan.project.id, name: args.setName, description: "Recovered from legacy Whop course synthesis — see Pre-4M recovery bridge." });
      createdSet = true;
    }

    const { addedCount: lessonsAttached } = await bulkAddLessonsToSynthesisSet(client, targetSet.id, plan.project.id, plan.distinctLessonIds);

    let runsAttached = 0;
    for (const run of plan.allRuns) {
      const { created } = await attachLegacyRunToSynthesisSet(client, targetSet.id, run.runId, plan.project.id);
      if (created) runsAttached++;
    }

    await client.query("COMMIT");
    return {
      synthesisSetId: targetSet.id,
      createdSet,
      lessonsAttached,
      lessonsTotal: plan.distinctLessonIds.length,
      runsAttached,
      runsTotal: plan.allRuns.length,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
