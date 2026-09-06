import { writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { buildWorkerLoopDeps } from "../src/workerDeps.js";
import { getCourseByWhopId } from "../src/db/coursesRepo.js";
import { listLessons, getLessonById } from "../src/db/lessonsRepo.js";
import { getValidAccessToken, AuthRequiredError } from "../src/whop/sessionService.js";
import { analyzeLesson, PipelineError, SchemaValidationError } from "../src/pipeline/analyzeLesson.js";
import { LESSON_ANALYSIS_MAX_OUTPUT_TOKENS } from "../src/pipeline/limits.js";
import { PROMPT_VERSION, SCHEMA_VERSION, EXTRACTOR_VERSION } from "../src/pipeline/analysisVersion.js";
import {
  knowledgeItemCounts,
  classificationCounts,
  scopedKnowledgeItemCount,
  knowledgeItemsWithExceptionsCount,
  numericalValueCounts,
} from "../src/pipeline/analysisSummary.js";
import { estimateCost } from "../src/pricing/geminiPricing.js";
import { createSecretRedactor } from "../src/lib/redact.js";
import { createSafeLogger } from "../src/lib/logger.js";
import type { GeminiClient, GeminiCompletionDiagnostics } from "../src/gemini/client.js";

/**
 * READ-ONLY diagnostic for exactly ONE lesson, run against the real
 * production analyzeVideo() call + STRATEGY_RESPONSE_JSON_SCHEMA + the
 * real Whop video for that lesson — built for Phase 3.5A's pre-merge
 * real-data validation on PR #12. Reproduces the EXACT production
 * pipeline (analyzeLesson.ts, unmodified) end to end: Whop lesson lookup
 * -> signed Mux URL -> ffmpeg remux -> Gemini upload -> analyze -> Zod
 * validate — without ever calling the functions that persist a result.
 *
 * This script NEVER calls createLessonAnalysis, createStrategyInstances,
 * createJob, or any other write to analysis_jobs/lesson_analyses/
 * strategy_instances/usage_records. It also never passes onProgress or
 * onDurationDiscovered to analyzeLesson — those are the only two hooks in
 * the real pipeline capable of writing anything (lease-renewal heartbeats,
 * backfilling lessons.duration_seconds), and simply omitting them (both
 * optional) means analyzeLesson.ts performs zero database writes here, by
 * construction — not by best effort.
 *
 * The ONE unavoidable side effect: getValidAccessToken() — the same
 * function the real worker calls before every job — may rotate the
 * stored Whop OAuth token if it's near expiry, writing only to
 * auth_sessions (never to any lesson/analysis table). This is the normal
 * authorized data path in this codebase; there is no way to fetch a real
 * lesson's signed video URL without it. If you want a hard guarantee of
 * zero writes of any kind, run this only when you know the stored session
 * has a long remaining lifetime (check auth_sessions.access_token_expires_at).
 *
 * It also never touches Cloud Run, the worker Job, or the Scheduler — this
 * is a plain Node script you run yourself.
 *
 * Usage (run from the SAME environment the production API/worker container
 * runs in — e.g. Cloud Shell with the deployment's real env vars sourced,
 * GEMINI_API_KEY/WHOP secrets pulled from Secret Manager — never paste
 * secrets into chat):
 *
 *   TARGET_LESSON_TITLE="Sizing & Scaling Trades" \
 *     LESSON_ANALYSIS_DIAGNOSTIC=1 npx tsx scripts/lessonAnalysisDiagnostic.ts
 *
 * Select by internal numeric lesson id instead (more stable than title
 * text, e.g. across a title edit) if you already know it:
 *
 *   TARGET_LESSON_ID=42 \
 *     LESSON_ANALYSIS_DIAGNOSTIC=1 npx tsx scripts/lessonAnalysisDiagnostic.ts
 *
 * TARGET_LESSON_ID takes precedence if both are set. Title matching is
 * exact (case-sensitive) against the lesson title as synced from Whop; on
 * no match, every synced lesson title for the configured course is printed
 * (titles are already shown in the product UI — not sensitive) so you can
 * copy the exact string.
 *
 * Optionally write the full validated analysis JSON to a LOCAL file for
 * inspection (never uploaded anywhere by this script):
 *
 *   LESSON_ANALYSIS_DIAGNOSTIC_OUTPUT_FILE=lesson-analysis-diagnostic.json \
 *     TARGET_LESSON_TITLE="Sizing & Scaling Trades" \
 *     LESSON_ANALYSIS_DIAGNOSTIC=1 npx tsx scripts/lessonAnalysisDiagnostic.ts
 *
 * Logs only: lesson title/duration, model, prompt/schema/extractor
 * versions, configured max_output_tokens, pipeline stage transitions,
 * interaction_status, input/output/thinking tokens, an estimated cost
 * (src/pricing/geminiPricing.ts, computed only from token counts Gemini
 * itself reports), JSON-parse PASS/FAIL, Zod-validation PASS/FAIL,
 * strategy_found/strategy_count, and knowledge-item/example/conflict
 * counts + which knowledge categories were populated — never the video
 * transcript, never the full prompt, never raw Gemini output, never
 * credentials.
 */
async function main(): Promise<void> {
  if (process.env.LESSON_ANALYSIS_DIAGNOSTIC !== "1") {
    console.error("Refusing to run: set LESSON_ANALYSIS_DIAGNOSTIC=1 to confirm this is an intentional, opt-in, read-only diagnostic run.");
    process.exitCode = 1;
    return;
  }

  const targetTitle = process.env.TARGET_LESSON_TITLE;
  const rawTargetId = process.env.TARGET_LESSON_ID;
  if (!targetTitle && !rawTargetId) {
    console.error("Set TARGET_LESSON_TITLE=\"...\" (or TARGET_LESSON_ID=<numeric internal id>) to select which lesson to diagnose.");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const { pool, oauthClient, refreshTokenEncryptionKey, pipelineDeps } = buildWorkerLoopDeps(config);
  const redactor = createSecretRedactor();
  const logger = createSafeLogger(redactor);

  try {
    const course = await getCourseByWhopId(pool, config.course.courseId);
    if (!course) {
      console.error(`No course found for WHOP_COURSE_ID=${config.course.courseId}. Nothing to diagnose.`);
      process.exitCode = 1;
      return;
    }

    let lesson;
    if (rawTargetId != null) {
      const targetId = Number(rawTargetId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        console.error(`Invalid TARGET_LESSON_ID=${rawTargetId} — must be a positive integer.`);
        process.exitCode = 1;
        return;
      }
      lesson = await getLessonById(pool, targetId);
      if (!lesson || lesson.courseId !== course.id) {
        console.error(`No lesson with internal id ${targetId} found in course "${course.title}".`);
        process.exitCode = 1;
        return;
      }
    } else {
      const lessons = await listLessons(pool, course.id);
      lesson = lessons.find((l) => l.title === targetTitle);
      if (!lesson) {
        console.error(`No lesson titled "${targetTitle}" found in course "${course.title}". Synced lesson titles:`);
        for (const l of lessons) console.error(`  - ${l.title}`);
        process.exitCode = 1;
        return;
      }
    }

    console.log(`Read-only diagnostic starting for lesson "${lesson.title}" (id=${lesson.id}) — no analysis_jobs/lesson_analyses/strategy_instances/usage_records row will be written.`);
    console.log(
      `config: model=${config.geminiModel} processing_mode=${config.geminiVideoProcessingMode} ` +
        `prompt_version=${PROMPT_VERSION} schema_version=${SCHEMA_VERSION} extractor_version=${EXTRACTOR_VERSION} ` +
        `max_output_tokens=${LESSON_ANALYSIS_MAX_OUTPUT_TOKENS}`,
    );

    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(pool, oauthClient, refreshTokenEncryptionKey);
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        console.error(`No usable Whop session: ${err.message} — reconnect Whop for this deployment before running this diagnostic.`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    redactor.register(accessToken);

    let interactionStatus = "unknown";
    let outputChars: number | null = null;
    const instrumentedGemini: GeminiClient = {
      ...pipelineDeps.gemini,
      analyzeVideo: async (file, model, processingMode, maxOutputTokens) => {
        try {
          const result = await pipelineDeps.gemini.analyzeVideo(file, model, processingMode, maxOutputTokens);
          const diag: GeminiCompletionDiagnostics | undefined = result.diagnostics;
          interactionStatus = diag?.interactionStatus ?? "unknown";
          outputChars = diag?.outputChars ?? result.text.length;
          return result;
        } catch (err) {
          const diag = (err as { diagnostics?: GeminiCompletionDiagnostics } | undefined)?.diagnostics;
          if (diag) {
            interactionStatus = diag.interactionStatus;
            outputChars = diag.outputChars;
          }
          throw err;
        }
      },
    };

    try {
      const result = await analyzeLesson(
        lesson.sourceUrl,
        accessToken,
        { ...pipelineDeps, gemini: instrumentedGemini, redactor, logger },
        (stage) => console.log(`stage: ${stage}`),
      );

      const { analysis, usage } = result;
      const estimatedCostUsd = estimateCost(usage);
      const categoryCounts = knowledgeItemCounts(analysis);
      const classCounts = classificationCounts(analysis);
      const numCounts = numericalValueCounts(analysis);

      console.log("RESULT: PASS");
      console.log(`  lesson_title=${JSON.stringify(analysis.lesson.title)}`);
      console.log(`  duration_seconds=${analysis.lesson.duration_seconds ?? "unknown"}`);
      console.log(`  model=${config.geminiModel}`);
      console.log(`  prompt_version=${PROMPT_VERSION} schema_version=${SCHEMA_VERSION} extractor_version=${EXTRACTOR_VERSION}`);
      console.log(`  max_output_tokens=${LESSON_ANALYSIS_MAX_OUTPUT_TOKENS}`);
      console.log(`  interaction_status=${interactionStatus}`);
      console.log(`  input_tokens=${usage.inputTokens ?? "?"} output_tokens=${usage.outputTokens ?? "?"} thinking_tokens=${usage.thinkingTokens ?? "?"}`);
      console.log(`  estimated_cost_usd=${estimatedCostUsd ?? "unknown"}`);
      console.log(`  output_chars=${outputChars ?? "?"}`);
      console.log(`  json_parse=PASS zod_validation=PASS`);
      console.log(`  strategy_found=${analysis.strategy_found} strategy_count=${analysis.strategies.length}`);
      console.log(`  knowledge_item_count=${analysis.knowledge.knowledgeItems.length}`);
      console.log(`  knowledge_categories_found=${categoryCounts.length > 0 ? categoryCounts.map((c) => `${c.label}:${c.count}`).join(", ") : "(none)"}`);
      console.log(`  example_count=${analysis.knowledge.examples.length}`);
      console.log(`  conflict_count=${analysis.knowledge.conflictsAndAmbiguities.length}`);
      console.log(`  explicit_knowledge_count=${classCounts.explicit} inferred_knowledge_count=${classCounts.inferred} visual_knowledge_count=${classCounts.visual}`);
      console.log(`  scoped_knowledge_count=${scopedKnowledgeItemCount(analysis)}`);
      console.log(`  knowledge_items_with_exceptions=${knowledgeItemsWithExceptionsCount(analysis)}`);
      console.log(`  numerical_value_count=${numCounts.total}`);
      console.log(`  numerical_rule_threshold_count=${numCounts.ruleThreshold}`);
      console.log(`  numerical_example_count=${numCounts.example} (derived_example=${numCounts.derivedExample} guideline=${numCounts.guideline} reference=${numCounts.reference})`);
      console.log("Nothing was persisted to analysis_jobs/lesson_analyses/strategy_instances/usage_records.");

      const outputFile = process.env.LESSON_ANALYSIS_DIAGNOSTIC_OUTPUT_FILE;
      if (outputFile) {
        await writeFile(outputFile, JSON.stringify(analysis, null, 2), "utf8");
        console.log(`Wrote full validated analysis JSON to local file: ${outputFile} (local only — never uploaded to production storage).`);
      }
    } catch (err) {
      if (err instanceof PipelineError) {
        console.log(`RESULT: FAIL — stage=${err.stage}`);
        console.log(`  interaction_status=${interactionStatus} output_chars=${outputChars ?? "?"}`);
        console.log(`  safe_error=${redactor.redact(err.message)}`);
      } else if (err instanceof SchemaValidationError) {
        const jsonParseFailed = err.message.includes("did not return valid JSON");
        console.log(`RESULT: FAIL — stage=validating_result`);
        console.log(`  interaction_status=${interactionStatus} output_chars=${outputChars ?? "?"}`);
        console.log(`  json_parse=${jsonParseFailed ? "FAIL" : "PASS"} zod_validation=${jsonParseFailed ? "n/a" : "FAIL"}`);
        console.log(`  safe_error=${redactor.redact(err.message)}`);
      } else {
        console.log("RESULT: FAIL — unexpected error");
        console.log(`  safe_error=${err instanceof Error ? redactor.redact(err.message) : String(err)}`);
      }
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
