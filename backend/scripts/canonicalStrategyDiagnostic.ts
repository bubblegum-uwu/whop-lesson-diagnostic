import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { createGeminiClient, type GeminiClient } from "../src/gemini/client.js";
import { getCourseByWhopId } from "../src/db/coursesRepo.js";
import { listLessons } from "../src/db/lessonsRepo.js";
import { getLatestByLessons } from "../src/db/lessonAnalysesRepo.js";
import { gatherSynthesisInput } from "../src/synthesis/sourceData.js";
import { buildStrategySignature } from "../src/synthesis/normalize.js";
import { clusterStrategyInstances } from "../src/synthesis/cluster.js";
import { synthesizeCanonicalStrategy } from "../src/synthesis/canonicalStrategy.js";
import { SYNTHESIS_MAX_OUTPUT_TOKENS } from "../src/synthesis/limits.js";

/**
 * READ-ONLY diagnostic for exactly ONE canonical-strategy cluster — built
 * for the "canonical strategy invalid JSON" production investigation,
 * where the first real production run failed with:
 *
 *   Gemini did not return valid JSON for stage "canonical_strategy".
 *
 * on the very first cluster ("Key Level and Order Block Break and Retest",
 * 0 of 9 complete). This script reproduces exactly that call — real
 * stored source data, real normalization, real clustering, real Gemini —
 * without running the rest of the pipeline and without writing anything.
 *
 * It calls ONLY read-path functions (getCourseByWhopId, listLessons,
 * getLatestByLessons, gatherSynthesisInput — documented in sourceData.ts
 * as never writing) plus buildStrategySignature/clusterStrategyInstances/
 * synthesizeCanonicalStrategy, none of which touch the database. It NEVER
 * calls createSynthesisRun, createStrategyCluster, createCanonicalStrategy,
 * createCoursePlaybook, markSynthesisCompleted, or markSynthesisFailed —
 * no synthesis_runs/strategy_clusters/canonical_strategies/course_playbooks
 * row is ever created, updated, or deleted by this script.
 *
 * Usage (run from the SAME environment the production API/worker container
 * runs in — e.g. Cloud Shell with the deployment's real env vars sourced,
 * GEMINI_API_KEY pulled from Secret Manager — never paste secrets into
 * chat):
 *
 *   CANONICAL_STRATEGY_DIAGNOSTIC=1 npx tsx scripts/canonicalStrategyDiagnostic.ts
 *
 * By default it targets the FIRST cluster Gemini's own clustering step
 * produces (matching the production failure, which was on cluster 1 of
 * 9). To target a specific cluster by name instead (e.g. to reproduce a
 * LATER failing cluster), set:
 *
 *   TARGET_CLUSTER_NAME="Key Level and Order Block Break and Retest" \
 *     CANONICAL_STRATEGY_DIAGNOSTIC=1 npx tsx scripts/canonicalStrategyDiagnostic.ts
 *
 * Logs only: cluster name/member count, prompt chars, configured
 * max_output_tokens, output chars, interaction status, input/output/
 * thinking tokens, JSON-parse PASS/FAIL, Zod-validation PASS/FAIL — never
 * prompt text, never the raw Gemini response, never course/lesson content,
 * never credentials.
 */
async function main(): Promise<void> {
  if (process.env.CANONICAL_STRATEGY_DIAGNOSTIC !== "1") {
    console.error("Refusing to run: set CANONICAL_STRATEGY_DIAGNOSTIC=1 to confirm this is an intentional, opt-in, read-only diagnostic run.");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const pool = createPool(config.db);

  try {
    const course = await getCourseByWhopId(pool, config.course.courseId);
    if (!course) {
      console.error(`No course found for WHOP_COURSE_ID=${config.course.courseId}. Nothing to diagnose.`);
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
      console.log(`No analyzed lessons found for course "${course.title}" — nothing to diagnose.`);
      return;
    }

    console.log(`Read-only diagnostic starting for course "${course.title}" — no synthesis_runs/strategy_clusters/canonical_strategies/course_playbooks row will be written.`);

    const input = await gatherSynthesisInput(pool, course.title, analysisIds);
    const gemini = createGeminiClient(config.geminiApiKey);
    const deps = { gemini, model: config.geminiModel };

    console.log(`normalizing: ${input.instances.length} strategy instance(s)`);
    const signatures = input.instances.map(buildStrategySignature);

    console.log("clustering (real Gemini call)...");
    const { clusters } = await clusterStrategyInstances(deps, signatures);
    console.log(`clustering produced ${clusters.length} cluster(s): ${clusters.map((c) => c.proposedCanonicalName).join(" | ")}`);

    const targetName = process.env.TARGET_CLUSTER_NAME;
    const targetCluster = targetName ? clusters.find((c) => c.proposedCanonicalName === targetName) : clusters[0];
    if (!targetCluster) {
      console.error(targetName ? `No cluster named "${targetName}" was produced.` : "Clustering produced no clusters at all — nothing to diagnose.");
      process.exitCode = 1;
      return;
    }

    const instancesById = new Map(input.instances.map((i) => [i.strategyInstanceId, i]));
    const members = targetCluster.memberInstanceIds.map((id) => instancesById.get(id)).filter((m) => m != null);
    console.log(`target cluster: "${targetCluster.proposedCanonicalName}" (${members.length} member instance(s))`);

    let promptChars = 0;
    let outputChars: number | null = null;
    let interactionStatus = "unknown";
    const instrumented: GeminiClient = {
      ...gemini,
      generateStructured: async (prompt, model, schema, maxOutputTokens) => {
        promptChars = prompt.length;
        try {
          const result = await gemini.generateStructured(prompt, model, schema, maxOutputTokens);
          outputChars = result.diagnostics?.outputChars ?? result.text.length;
          interactionStatus = result.diagnostics?.interactionStatus ?? "unknown";
          return result;
        } catch (err) {
          const diag = (err as { diagnostics?: { outputChars: number; interactionStatus: string } } | undefined)?.diagnostics;
          if (diag) {
            outputChars = diag.outputChars;
            interactionStatus = diag.interactionStatus;
          }
          throw err;
        }
      },
    };

    console.log(`invoking canonical_strategy generation for "${targetCluster.proposedCanonicalName}" (real Gemini call, configured max_output_tokens=${SYNTHESIS_MAX_OUTPUT_TOKENS.canonical_strategy})...`);
    try {
      const { canonicalStrategy, usage } = await synthesizeCanonicalStrategy({ gemini: instrumented, model: config.geminiModel }, targetCluster, members);
      console.log(
        `RESULT: PASS — prompt_chars=${promptChars} output_chars=${outputChars ?? "?"} interaction_status=${interactionStatus} ` +
          `input_tokens=${usage.inputTokens} output_tokens=${usage.outputTokens} thinking_tokens=${usage.thinkingTokens} ` +
          `json_parse=PASS zod_validation=PASS rule_categories_with_content=${
            [
              canonicalStrategy.marketContext,
              canonicalStrategy.prerequisites,
              canonicalStrategy.setup,
              canonicalStrategy.entryRules,
              canonicalStrategy.confirmationRules,
              canonicalStrategy.stopLossRules,
              canonicalStrategy.profitTargetRules,
              canonicalStrategy.tradeManagementRules,
              canonicalStrategy.invalidationRules,
              canonicalStrategy.noTradeConditions,
              canonicalStrategy.visualDiscretionaryRules,
            ].filter((rules) => rules.length > 0).length
          }/11`,
      );
      console.log("Nothing was persisted to the database.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const jsonParseFailed = message.includes("did not return valid JSON");
      console.log(
        `RESULT: FAIL — prompt_chars=${promptChars} output_chars=${outputChars ?? "?"} interaction_status=${interactionStatus} ` +
          `json_parse=${jsonParseFailed ? "FAIL" : "PASS"} zod_validation=${jsonParseFailed ? "n/a" : "FAIL"}`,
      );
      // The thrown error's own message is already the safe, stage-tagged form (see synthesis/errors.ts) — never prompt content, never the raw response.
      console.log(`safe_error=${message}`);
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
