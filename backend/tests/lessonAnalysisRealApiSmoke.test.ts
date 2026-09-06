import { describe, it } from "vitest";
import { createGeminiClient } from "../src/gemini/client.js";
import { STRATEGY_ONLY_RESPONSE_JSON_SCHEMA, KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA } from "../src/gemini/schema.js";
import { STRATEGY_ANALYSIS_MAX_OUTPUT_TOKENS, KNOWLEDGE_ANALYSIS_MAX_OUTPUT_TOKENS } from "../src/pipeline/limits.js";

/**
 * OPT-IN ONLY — never runs in normal `npm test`/CI, and never touches
 * production video/course/lesson data. Our fake-Gemini unit tests
 * (geminiSchema.test.ts) prove our OWN code accepts/rejects a given
 * response correctly, but they cannot prove the real Gemini API accepts
 * either of the two-pass lesson-analysis schemas
 * (`STRATEGY_ONLY_RESPONSE_JSON_SCHEMA` / `KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA`
 * — see gemini/schema.ts's two-pass changelog) as a response_format schema
 * in the first place — the exact gap synthesisRealApiSmoke.test.ts exists
 * to close for the synthesis stages, applied here to both lesson-analysis
 * passes individually.
 *
 * This test sends a tiny SYNTHETIC text-only prompt (no video upload, no
 * database access, no Whop access) via generateStructured — the same
 * generic structured-output path analyzeVideo uses internally, so this
 * verifies real API acceptance of each schema shape without needing an
 * actual lesson video.
 *
 * Enable explicitly (never paste GEMINI_API_KEY into chat — run this
 * locally or in Cloud Shell):
 *   LESSON_ANALYSIS_REAL_API_SMOKE_TEST=1 GEMINI_API_KEY=... npx vitest run tests/lessonAnalysisRealApiSmoke.test.ts
 *
 * Both env vars must be set. Without LESSON_ANALYSIS_REAL_API_SMOKE_TEST=1,
 * both tests below are skipped — vitest reports them as skipped, not
 * passed, so a missing key never masquerades as a verified schema.
 */
const REAL_API_ENABLED = process.env.LESSON_ANALYSIS_REAL_API_SMOKE_TEST === "1" && !!process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const STRATEGY_SYNTHETIC_PROMPT = `Respond with a minimal SYNTHETIC example matching the required schema, as if analyzing a short trading-education lesson. Use placeholder/example values only — no real strategy or market claims are required. Set "strategy_found" to true with exactly one minimal example entry in "strategies".`;

const KNOWLEDGE_SYNTHETIC_PROMPT = `Respond with a minimal SYNTHETIC example matching the required schema, as if analyzing a short trading-education lesson. Use placeholder/example values only — no real trading claims are required. Include at least one entry in "knowledge.knowledgeItems" (any category/ruleType).`;

describe.skipIf(!REAL_API_ENABLED)("real Gemini API — two-pass lesson-analysis schema acceptance", () => {
  const gemini = createGeminiClient(process.env.GEMINI_API_KEY ?? "");

  it(
    "the strategy-only pass schema is accepted by the real Gemini structured-generation API",
    async () => {
      try {
        const { text } = await gemini.generateStructured(STRATEGY_SYNTHETIC_PROMPT, MODEL, STRATEGY_ONLY_RESPONSE_JSON_SCHEMA, STRATEGY_ANALYSIS_MAX_OUTPUT_TOKENS);
        JSON.parse(text); // confirms Gemini returned well-formed JSON, not just a 2xx
        // eslint-disable-next-line no-console
        console.log("strategy_only_schema  PASS");
      } catch (err) {
        const safeMessage = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.log(`strategy_only_schema  FAIL  ${safeMessage}`);
        throw err;
      }
    },
    30_000,
  );

  it(
    "the knowledge-only pass schema is accepted by the real Gemini structured-generation API",
    async () => {
      try {
        const { text } = await gemini.generateStructured(KNOWLEDGE_SYNTHETIC_PROMPT, MODEL, KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA, KNOWLEDGE_ANALYSIS_MAX_OUTPUT_TOKENS);
        JSON.parse(text);
        // eslint-disable-next-line no-console
        console.log("knowledge_only_schema  PASS");
      } catch (err) {
        const safeMessage = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.log(`knowledge_only_schema  FAIL  ${safeMessage}`);
        throw err;
      }
    },
    30_000,
  );
});
