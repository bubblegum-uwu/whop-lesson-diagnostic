import { describe, it, expect } from "vitest";
import { callGeminiForStage } from "../src/synthesis/geminiStage.js";
import { createGeminiClient } from "../src/gemini/client.js";
import {
  CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
  CLUSTER_MERGE_RESPONSE_JSON_SCHEMA,
  RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  PLAYBOOK_RESPONSE_JSON_SCHEMA,
  DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
} from "../src/synthesis/schema.js";

/**
 * OPT-IN ONLY — never runs in normal `npm test`/CI. Our fake-Gemini unit
 * tests prove our own code handles a given response correctly, but they
 * cannot prove the real Gemini API accepts a given response_format schema
 * in the first place. That gap is real but its relevance to the production
 * 400 is UNCONFIRMED — the original error handling lost which of the six
 * stages even failed, so schema acceptance is one candidate to rule in or
 * out, not an established cause. This file tests, individually, the exact
 * schema each production stage actually sends to Gemini (see the STAGES
 * table below, which mirrors cluster.ts/canonicalStrategy.ts/
 * coreFramework.ts/playbook.ts/decisionFramework.ts's real call sites) with
 * a tiny synthetic prompt — negligible token cost, no course/lesson data,
 * no database access, no Whop/video access.
 *
 * Enable explicitly (never paste GEMINI_API_KEY into chat — run this
 * locally or in Cloud Shell; see the exact command in the PR description):
 *   SYNTHESIS_REAL_API_SMOKE_TEST=1 GEMINI_API_KEY=... npx vitest run tests/synthesisRealApiSmoke.test.ts
 *
 * Both env vars must be set. Without SYNTHESIS_REAL_API_SMOKE_TEST=1, every
 * test below is skipped — vitest reports them as skipped, not passed, so a
 * missing key never masquerades as a verified schema.
 *
 * Each stage prints one PASS/FAIL summary line (stage name + result only —
 * never prompt content, never the API key) so a run's output reads as a
 * simple per-stage table.
 */
const REAL_API_ENABLED = process.env.SYNTHESIS_REAL_API_SMOKE_TEST === "1" && !!process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

// Mirrors the exact schema each production stage sends to Gemini today —
// see cluster.ts ("cluster_chunk"/"cluster_merge"), canonicalStrategy.ts
// ("canonical_strategy" — the RAW/reduced wire schema, since that's what's
// actually on the wire, not the richer CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA
// used only for internal Zod validation), coreFramework.ts, playbook.ts,
// and decisionFramework.ts.
const STAGES: Array<{ stage: string; schema: object; prompt: string }> = [
  {
    stage: "cluster_chunk",
    schema: CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
    prompt: "Respond with a single minimal example cluster, using placeholder values, matching the required schema.",
  },
  {
    stage: "cluster_merge",
    schema: CLUSTER_MERGE_RESPONSE_JSON_SCHEMA,
    prompt: "Respond with a single minimal example merged cluster, using placeholder values, matching the required schema.",
  },
  {
    stage: "canonical_strategy",
    schema: RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
    prompt:
      "Respond with a minimal example canonical trading strategy, using empty arrays wherever optional and placeholder text elsewhere, matching the required schema. This is the highest-risk schema in the suite (most deeply nested).",
  },
  {
    stage: "core_framework",
    schema: CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
    prompt: "Respond with a single minimal example framework section, using placeholder values, matching the required schema.",
  },
  {
    stage: "playbook",
    schema: PLAYBOOK_RESPONSE_JSON_SCHEMA,
    prompt: "Respond with a minimal example playbook, using one placeholder section and an empty conflicts list, matching the required schema.",
  },
  {
    stage: "decision_framework",
    schema: DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
    prompt: "Respond with a minimal example decision framework, a single start node and one readable step, matching the required schema.",
  },
];

describe.skipIf(!REAL_API_ENABLED)("real Gemini API — per-stage response_format schema acceptance", () => {
  const gemini = createGeminiClient(process.env.GEMINI_API_KEY ?? "");

  for (const { stage, schema, prompt } of STAGES) {
    it(
      `${stage} schema is accepted by the real Gemini structured-generation API`,
      async () => {
        try {
          const { rawText } = await callGeminiForStage({ gemini, model: MODEL }, stage, prompt, schema);
          JSON.parse(rawText); // confirms Gemini returned well-formed JSON, not just a 2xx
          // eslint-disable-next-line no-console
          console.log(`${stage.padEnd(28)}PASS`);
        } catch (err) {
          // SynthesisGeminiCallError's message is already the safe
          // stage=...schema=...model=...prompt_chars=...error=... form —
          // never prompt content, never credentials.
          const safeMessage = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.log(`${stage.padEnd(28)}FAIL  ${safeMessage}`);
          throw err;
        }
      },
      30_000,
    );
  }
});
