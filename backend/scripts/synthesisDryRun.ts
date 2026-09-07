import { writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { createGeminiClient, type GeminiClient } from "../src/gemini/client.js";
import { getCourseByWhopId } from "../src/db/coursesRepo.js";
import { listLessons } from "../src/db/lessonsRepo.js";
import { getLatestByLessons } from "../src/db/lessonAnalysesRepo.js";
import { gatherSynthesisInput } from "../src/synthesis/sourceData.js";
import { runSynthesis } from "../src/synthesis/runSynthesis.js";
import { computeSynthesisPreflight } from "../src/synthesis/preflight.js";
import { normalizeLessonKnowledge, collectRawStrategyScopeNames } from "../src/synthesis/knowledgeNormalize.js";
import { estimateCost } from "../src/pricing/geminiPricing.js";
import {
  CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
  RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  RAW_CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  PLAYBOOK_RESPONSE_JSON_SCHEMA,
  RAW_DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
} from "../src/synthesis/schema.js";
import { SCOPE_MAPPING_RESPONSE_JSON_SCHEMA } from "../src/synthesis/strategyScopeMapping.js";

/**
 * READ-ONLY diagnostic dry-run — opt-in only, never invoked automatically,
 * never part of `npm test`/CI. Exercises the real seven-stage Phase 3.5B
 * synthesis pipeline (normalizing, clustering, strategy-scope mapping,
 * canonicalizing, core framework, playbook, decision framework) against the
 * REAL, already-stored source analyses for the one course this deployment
 * targets (config.course), calling the REAL Gemini API — but stops before
 * any persistence step.
 *
 * It calls ONLY read-path functions (getCourseByWhopId, listLessons,
 * getLatestByLessons, gatherSynthesisInput — documented in sourceData.ts as
 * never writing to lesson_analyses/strategy_instances) and runSynthesis()
 * itself, which never touches the database. It NEVER calls
 * createSynthesisRun, createStrategyCluster, createCanonicalStrategy,
 * createCoursePlaybook, markSynthesisCompleted, markSynthesisFailed, or any
 * usage_records write — no synthesis_runs/strategy_clusters/
 * canonical_strategies/course_playbooks/usage_records row is created,
 * updated, or deleted by this script, ever. It shares 100% of the
 * production synthesis code path (gatherSynthesisInput + runSynthesis) —
 * there is no separate/duplicated synthesis implementation for this script
 * to drift out of sync with.
 *
 * Phase 3.5B addition: requires the FULL course to be current (every lesson
 * has a current v2/current-fingerprint analysis — see synthesis/preflight.ts)
 * before running at all. Refuses with an unmistakable, explicit failure
 * otherwise, printing exactly which lessons are missing or stale — this is
 * the "reject stale/incomplete production dataset" half of the Phase 3.5B
 * spec; the OTHER half (reporting preflight without refusing) is what GET
 * /api/course/synthesis-status's additive `preflight` field is for.
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
 * Per-call logging: call index, pipeline stage, a schema identifier, prompt
 * character count, and pass/fail — never prompt text, never lesson/course
 * content, never credentials. On success, writes a local JSON file
 * (synthesis-dry-run-<courseId>-<timestamp>.json in the current working
 * directory — download it from Cloud Shell via the three-dot menu ->
 * Download, pasting its full path) containing the preflight report,
 * normalized-knowledge statistics, canonical strategies, course framework,
 * playbook (including its deterministic Coverage Notes / Source Index /
 * Unmatched Strategy-Scoped Knowledge sections), decision framework,
 * frameworkCoverage, and a token/cost usage summary — never secrets.
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

    const preflight = computeSynthesisPreflight(
      lessons.map((l) => ({ id: l.id, whopLessonId: l.whopLessonId, title: l.title })),
      latestByLesson,
      config.geminiModel,
    );
    console.log(
      `Preflight: lessons=${preflight.lessonCount} latest_successful=${preflight.latestSuccessfulAnalysisCount} ` +
        `current=${preflight.currentAnalysisCount} stale=${preflight.staleAnalysisCount} missing=${preflight.missingAnalysisCount} ready=${preflight.ready}`,
    );
    if (!preflight.ready) {
      console.error(
        `Refusing to run: the full course is not current. Missing: ${preflight.missingLessonTitles.join(", ") || "(none)"}. ` +
          `Stale: ${preflight.staleLessonTitles.join(", ") || "(none)"}. Re-analyze these lessons under the current extractor version before running this diagnostic.`,
      );
      process.exitCode = 1;
      return;
    }

    const analysisIds: number[] = [];
    for (const lesson of lessons) {
      const analysis = latestByLesson.get(lesson.id);
      if (analysis && (analysis.status === "completed" || analysis.status === "no_strategy")) {
        analysisIds.push(analysis.analysisId);
      }
    }

    console.log(
      `Dry-run starting: ${analysisIds.length} source analyses for course "${course.title}". ` +
        `Read-only — no synthesis_runs/strategy_clusters/canonical_strategies/course_playbooks/usage_records row will be written.`,
    );

    const input = await gatherSynthesisInput(pool, course.title, analysisIds);
    const normalizedKnowledge = normalizeLessonKnowledge(input.knowledgeSources);
    const knowledgeStats = {
      totalKnowledgeItems: normalizedKnowledge.items.length,
      totalExamples: normalizedKnowledge.examples.length,
      globalItems: normalizedKnowledge.globalItems.length,
      strategyScopedItems: normalizedKnowledge.strategyScopedItems.length,
      otherScopedItems: normalizedKnowledge.otherScopedItems.length,
      distinctRawStrategyScopeNames: collectRawStrategyScopeNames(normalizedKnowledge.strategyScopedItems),
    };
    console.log(
      `Normalized knowledge: ${knowledgeStats.totalKnowledgeItems} item(s), ${knowledgeStats.totalExamples} example(s) — ` +
        `${knowledgeStats.globalItems} global, ${knowledgeStats.strategyScopedItems} strategy-scoped, ${knowledgeStats.otherScopedItems} other-scoped.`,
    );

    const gemini = createGeminiClient(config.geminiApiKey);

    // Cluster-batch/cluster-merge share one schema object (see schema.ts:
    // CLUSTER_MERGE_RESPONSE_JSON_SCHEMA = CLUSTER_BATCH_RESPONSE_JSON_SCHEMA)
    // so they can't be told apart by schema identity alone — both are
    // labeled together; the stage log line still distinguishes which
    // pipeline stage each call happened during.
    const schemaLabelByRef = new Map<object, string>([
      [CLUSTER_BATCH_RESPONSE_JSON_SCHEMA, "cluster_chunk_or_merge"],
      [RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA, "canonical_strategy"],
      [RAW_CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA, "core_framework"],
      [PLAYBOOK_RESPONSE_JSON_SCHEMA, "playbook"],
      [RAW_DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA, "decision_framework"],
      [SCOPE_MAPPING_RESPONSE_JSON_SCHEMA, "strategy_scope_mapping"],
    ]);

    let currentStage = "normalizing";
    let callIndex = 0;
    const instrumentedGemini: GeminiClient = {
      ...gemini,
      generateStructured: async (prompt, model, schema, maxOutputTokens, thinkingLevel) => {
        callIndex++;
        const thisCall = callIndex;
        const schemaLabel = schemaLabelByRef.get(schema) ?? "unknown";
        const promptChars = prompt.length;
        try {
          const result = await gemini.generateStructured(prompt, model, schema, maxOutputTokens, thinkingLevel);
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
        currentStage = event.stage.toLowerCase();
        console.log(
          `-- stage=${event.stage} completed_items=${event.completedItems ?? "n/a"} total_items=${event.totalItems ?? "n/a"} --`,
        );
      });

      const cost = estimateCost(result.usage);
      console.log(
        `Dry-run completed successfully: ${result.clusters.length} cluster(s) synthesized. ` +
          `usage: input=${result.usage.inputTokens ?? "n/a"} output=${result.usage.outputTokens ?? "n/a"} thinking=${result.usage.thinkingTokens ?? "n/a"} ` +
          `estimated_cost=${cost != null ? `$${cost.toFixed(4)}` : "n/a"}. Nothing was persisted to the database.`,
      );

      const unmatchedSection = result.playbook.sections.find((s) => s.key === "unmatched_strategy_scoped_knowledge");

      const output = {
        generatedAt: new Date().toISOString(),
        courseId: course.id,
        courseTitle: course.title,
        model: config.geminiModel,
        preflight,
        knowledgeStats,
        clusters: result.clusters.map((c) => ({ cluster: c.cluster, canonicalStrategy: c.canonicalStrategy })),
        coreFramework: result.coreFramework,
        playbook: result.playbook,
        decisionFramework: result.decisionFramework,
        frameworkCoverage: result.playbook.frameworkCoverage,
        unmatchedStrategyScopedKnowledge: unmatchedSection ?? null,
        usage: result.usage,
        estimatedCost: cost,
      };

      const filename = `synthesis-dry-run-${course.id}-${Date.now()}.json`;
      await writeFile(filename, JSON.stringify(output, null, 2), "utf8");
      console.log(`Wrote local diagnostic output to ${filename}`);
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
