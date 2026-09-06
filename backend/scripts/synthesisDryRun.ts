import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { createGeminiClient, type GeminiClient } from "../src/gemini/client.js";
import { getCourseByWhopId } from "../src/db/coursesRepo.js";
import { listLessons } from "../src/db/lessonsRepo.js";
import { getLatestByLessons } from "../src/db/lessonAnalysesRepo.js";
import { gatherSynthesisInput } from "../src/synthesis/sourceData.js";
import { runSynthesis } from "../src/synthesis/runSynthesis.js";
import {
  CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
  RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  PLAYBOOK_RESPONSE_JSON_SCHEMA,
  DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
} from "../src/synthesis/schema.js";

/**
 * READ-ONLY diagnostic dry-run — opt-in only, never invoked automatically,
 * never part of `npm test`/CI. Exercises the real six-stage synthesis
 * pipeline against the REAL, already-stored source analyses for the one
 * course this deployment targets (config.course), calling the REAL Gemini
 * API — but stops before any persistence step.
 *
 * It calls ONLY read-path functions (getCourseByWhopId, listLessons,
 * getLatestByLessons, gatherSynthesisInput — the last is documented in
 * sourceData.ts as never writing to lesson_analyses/strategy_instances) and
 * runSynthesis() itself, which never touches the database. It NEVER calls
 * createSynthesisRun, createStrategyCluster, createCanonicalStrategy,
 * createCoursePlaybook, markSynthesisCompleted, or markSynthesisFailed —
 * no synthesis_runs/strategy_clusters/canonical_strategies/course_playbooks
 * row is created, updated, or deleted by this script, ever.
 *
 * Exists to answer a question the schema-only smoke test
 * (synthesisRealApiSmoke.test.ts) cannot: that test proves whether Gemini
 * accepts each schema shape with a tiny synthetic prompt; this script
 * additionally exercises the REAL current course data's actual size/shape,
 * in case the production failure depends on real prompt content/size
 * rather than the schema alone.
 *
 * Usage (run from the SAME environment the production API/worker container
 * runs in — e.g. Cloud Shell with the deployment's real env vars sourced,
 * GEMINI_API_KEY pulled from Secret Manager — see the PR description for
 * the exact command; never paste secrets into chat):
 *
 *   SYNTHESIS_DRY_RUN=1 npx tsx scripts/synthesisDryRun.ts
 *
 * SYNTHESIS_DRY_RUN=1 is a deliberate, separate confirmation flag (on top
 * of requiring real GEMINI_API_KEY/DB credentials already being present in
 * the environment) so this can never run by accident.
 *
 * Logs only: call index, pipeline stage, a schema identifier, prompt
 * character count, and pass/fail — never prompt text, never lesson/course
 * content, never credentials.
 */
async function main(): Promise<void> {
  if (process.env.SYNTHESIS_DRY_RUN !== "1") {
    console.error("Refusing to run: set SYNTHESIS_DRY_RUN=1 to confirm this is an intentional, opt-in, read-only diagnostic run.");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const pool = createPool(config.db);

  try {
    const course = await getCourseByWhopId(pool, config.course.courseId);
    if (!course) {
      console.error(`No course found for WHOP_COURSE_ID=${config.course.courseId}. Nothing to dry-run.`);
      process.exitCode = 1;
      return;
    }

    const lessons = await listLessons(pool, course.id);
    const latestByLesson = await getLatestByLessons(pool, lessons.map((l) => l.id));

    const analysisIds: number[] = [];
    for (const lesson of lessons) {
      const analysis = latestByLesson.get(lesson.id);
      if (analysis && (analysis.status === "completed" || analysis.status === "no_strategy")) {
        analysisIds.push(analysis.analysisId);
      }
    }

    if (analysisIds.length === 0) {
      console.log(`No analyzed lessons found for course "${course.title}" — nothing to dry-run.`);
      return;
    }

    console.log(
      `Dry-run starting: ${analysisIds.length} source analyses for course "${course.title}". ` +
        `Read-only — no synthesis_runs/strategy_clusters/canonical_strategies/course_playbooks row will be written.`,
    );

    const input = await gatherSynthesisInput(pool, course.title, analysisIds);
    const gemini = createGeminiClient(config.geminiApiKey);

    // Cluster-batch and cluster-merge share the exact same schema object
    // (see schema.ts: CLUSTER_MERGE_RESPONSE_JSON_SCHEMA = CLUSTER_BATCH_RESPONSE_JSON_SCHEMA),
    // so they can't be told apart by schema identity alone — both are
    // labeled together here; the stage log line still distinguishes which
    // pipeline stage ("clustering") each call happened during.
    const schemaLabelByRef = new Map<object, string>([
      [CLUSTER_BATCH_RESPONSE_JSON_SCHEMA, "cluster_chunk_or_merge"],
      [RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA, "canonical_strategy"],
      [CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA, "core_framework"],
      [PLAYBOOK_RESPONSE_JSON_SCHEMA, "playbook"],
      [DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA, "decision_framework"],
    ]);

    let currentStage = "normalizing";
    let callIndex = 0;
    const instrumentedGemini: GeminiClient = {
      ...gemini,
      generateStructured: async (prompt, model, schema) => {
        callIndex++;
        const thisCall = callIndex;
        const schemaLabel = schemaLabelByRef.get(schema) ?? "unknown";
        const promptChars = prompt.length;
        try {
          const result = await gemini.generateStructured(prompt, model, schema);
          console.log(`call=${thisCall} stage=${currentStage} schema=${schemaLabel} prompt_chars=${promptChars} result=PASS`);
          return result;
        } catch (err) {
          // Deliberately does not log err.message here — the raw underlying
          // SDK error is not yet wrapped in SynthesisGeminiCallError's safe
          // form at this point in the call stack. Log only that it failed;
          // the safe, stage-tagged message is printed once below, from the
          // error that propagates up through callGeminiForStage.
          console.log(`call=${thisCall} stage=${currentStage} schema=${schemaLabel} prompt_chars=${promptChars} result=FAIL`);
          throw err;
        }
      },
    };

    try {
      const result = await runSynthesis({ gemini: instrumentedGemini, model: config.geminiModel }, input, (event) => {
        currentStage = event.stage;
        console.log(
          `-- stage=${event.stage} completed_items=${event.completedItems ?? "n/a"} total_items=${event.totalItems ?? "n/a"} --`,
        );
      });
      console.log(
        `Dry-run completed successfully: ${result.clusters.length} cluster(s) synthesized. Nothing was persisted to the database.`,
      );
    } catch (err) {
      // A SynthesisGeminiCallError's message is already the safe
      // stage=...schema=...model=...prompt_chars=...error=... form — never
      // prompt content, never credentials.
      console.error(`Dry-run failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
