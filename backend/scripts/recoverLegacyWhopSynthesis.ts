/**
 * Pre-4M — legacy Whop synthesis recovery bridge (CLI entrypoint).
 *
 * Recovers a project's HISTORICAL, already-completed Whop course synthesis
 * (the Phase 3.4 course-wide engine's synthesis_runs/course_playbooks rows)
 * into the new Synthesis Set model, WITHOUT re-analysis, WITHOUT
 * re-synthesis, and WITHOUT fabricating duplicate project_sources or
 * project_source_analyses rows. See ../src/whop/legacySynthesisRecovery.ts
 * for the full algorithm and its rationale (this file is deliberately just
 * argv parsing + console output around that module's plan()/apply(), so
 * backend tests can exercise the real recovery logic directly without
 * spawning this CLI).
 *
 * This script NEVER touches lessons, lesson_analyses, synthesis_runs, or
 * course_playbooks — it only reads them, and only ever writes to
 * synthesis_sets / synthesis_set_lessons / synthesis_set_legacy_runs. It
 * never calls Gemini, never enqueues an analysis_jobs row, never enqueues a
 * synthesis_runs row.
 *
 * Usage (defaults to dry-run — pass --apply to actually write):
 *   npm run recover:legacy-whop-synthesis -- \
 *     --course-whop-id=cors_4lb7N3oassoZwHJvrufOYy \
 *     [--project-name=MasterMind] [--project-type=TRADING_STRATEGIES] \
 *     [--set-name=Strategies] [--apply]
 *
 * `--course-whop-id` is required — every other flag has a sensible default
 * for this deployment's single MasterMind/Trading-Accelerator scenario, but
 * is never hardcoded into the recovery logic itself (stable identifiers
 * only, never a raw database primary key).
 *
 * Idempotent: running this twice (with --apply both times) produces no
 * duplicate rows and no changed counts on the second run.
 */
import { createPool } from "../src/db/pool.js";
import type { ProjectType } from "../src/db/projectsRepo.js";
import { planLegacyWhopSynthesisRecovery, applyLegacyWhopSynthesisRecovery, RecoveryStopError, type LegacyRecoveryArgs } from "../src/whop/legacySynthesisRecovery.js";

interface CliArgs extends LegacyRecoveryArgs {
  apply: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { projectName: "MasterMind", projectType: "TRADING_STRATEGIES", courseWhopId: "", setName: "Strategies", apply: false };
  for (const raw of argv) {
    if (raw === "--apply") {
      args.apply = true;
      continue;
    }
    const match = raw.match(/^--([a-z-]+)=(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "project-name") args.projectName = value;
    else if (key === "project-type") args.projectType = (value === "GENERAL_KNOWLEDGE" ? "GENERAL_KNOWLEDGE" : "TRADING_STRATEGIES") satisfies ProjectType;
    else if (key === "course-whop-id") args.courseWhopId = value;
    else if (key === "set-name") args.setName = value;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.courseWhopId) {
    console.error(
      "Usage: npm run recover:legacy-whop-synthesis -- --course-whop-id=<whop_course_id> [--project-name=MasterMind] [--project-type=TRADING_STRATEGIES] [--set-name=Strategies] [--apply]",
    );
    process.exitCode = 1;
    return;
  }

  const pool = createPool({
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
    database: process.env.DB_NAME || "whop_lesson_test",
  });

  try {
    const plan = await planLegacyWhopSynthesisRecovery(pool, args);
    console.log(`Project: ${plan.project.name} (${plan.project.id})`);
    console.log(`Course: ${plan.course.title} (${plan.course.id})`);
    console.log(`Historical runs found: ${plan.allRuns.length}`);
    console.log(`Latest completed run: ${plan.latestCompletedRun.runId}`);
    console.log(`Analyses referenced: ${plan.latestCompletedRun.sourceAnalysisIds.length}`);
    console.log(`Distinct lessons in latest run: ${plan.distinctLessonIds.length}`);
    console.log(`Playbook found: ${plan.playbookFound ? "yes" : "no"}`);
    console.log(`Target set: ${args.setName}`);
    console.log(`Would create set: ${plan.existingSet ? "no (already exists)" : "yes"}`);
    console.log(`Would attach lessons: ${plan.distinctLessonIds.length} (${plan.newLessonCount} new, ${plan.distinctLessonIds.length - plan.newLessonCount} already attached)`);
    console.log(`Would attach legacy runs: ${plan.allRuns.length} (${plan.newRunCount} new, ${plan.allRuns.length - plan.newRunCount} already attached)`);
    console.log("No analysis or synthesis will run.");

    if (!args.apply) {
      console.log("\nDry run only — no changes written. Re-run with --apply to write.");
      return;
    }

    const result = await applyLegacyWhopSynthesisRecovery(pool, plan, args);
    console.log(result.createdSet ? `\nCreated Synthesis Set "${args.setName}" (${result.synthesisSetId}).` : `\nUsing existing Synthesis Set "${args.setName}" (${result.synthesisSetId}).`);
    console.log(`Attached ${result.lessonsAttached} new lesson(s) (${result.lessonsTotal} total in the recovered set).`);
    console.log(`Attached ${result.runsAttached} new legacy run(s) (${result.runsTotal} total in scope).`);
    console.log("\nApply complete. No analysis or synthesis was run; lesson_analyses/synthesis_runs/course_playbooks were not modified.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  if (err instanceof RecoveryStopError) {
    console.error(`\nSTOP: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  console.error(err);
  process.exitCode = 1;
});
