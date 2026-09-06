import { describe, it, expect } from "vitest";
import { createGeminiClient } from "../src/gemini/client.js";
import {
  CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
  CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  PLAYBOOK_RESPONSE_JSON_SCHEMA,
  DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
} from "../src/synthesis/schema.js";

/**
 * OPT-IN ONLY — never runs in normal `npm test`/CI. Our fake-Gemini unit
 * tests prove our own code handles a given response correctly, but they
 * cannot prove the real Gemini API accepts a given response_format schema in
 * the first place (that's exactly the gap that let the production 400
 * through undetected). This file closes that gap with real, tiny,
 * negligible-cost calls against each schema we hand to Gemini for course
 * synthesis — the actual bug surface from the production incident.
 *
 * Enable explicitly:
 *   SYNTHESIS_REAL_API_SMOKE_TEST=1 GEMINI_API_KEY=... npx vitest run tests/synthesisRealApiSmoke.test.ts
 *
 * Both env vars must be set. Without SYNTHESIS_REAL_API_SMOKE_TEST=1, every
 * test below is skipped — vitest reports them as skipped, not passed, so a
 * missing key never masquerades as a verified schema. This file must never
 * be the thing that makes `npm test` reach out to a real external API.
 */
const REAL_API_ENABLED = process.env.SYNTHESIS_REAL_API_SMOKE_TEST === "1" && !!process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

describe.skipIf(!REAL_API_ENABLED)("real Gemini API — response_format schema acceptance smoke test", () => {
  const gemini = createGeminiClient(process.env.GEMINI_API_KEY ?? "");

  const cases: Array<{ name: string; schema: object; prompt: string }> = [
    {
      name: "CLUSTER_BATCH_RESPONSE_JSON_SCHEMA",
      schema: CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
      prompt: "Respond with a single minimal example cluster, using placeholder values, matching the required schema.",
    },
    {
      name: "CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA",
      schema: CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
      prompt:
        "Respond with a minimal example canonical trading strategy, using empty arrays wherever optional and placeholder text elsewhere, matching the required schema.",
    },
    {
      name: "RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA",
      schema: RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
      prompt:
        "Respond with a minimal example canonical trading strategy, using empty arrays wherever optional and placeholder text elsewhere, matching the required schema. This is the highest-risk schema in the suite (most deeply nested) — this call is specifically checking Gemini accepts it at all.",
    },
    {
      name: "CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA",
      schema: CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
      prompt: "Respond with a single minimal example framework section, using placeholder values, matching the required schema.",
    },
    {
      name: "PLAYBOOK_RESPONSE_JSON_SCHEMA",
      schema: PLAYBOOK_RESPONSE_JSON_SCHEMA,
      prompt: "Respond with a minimal example playbook, using one placeholder section and an empty conflicts list, matching the required schema.",
    },
    {
      name: "DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA",
      schema: DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
      prompt: "Respond with a minimal example decision framework, a single start node and one readable step, matching the required schema.",
    },
  ];

  for (const { name, schema, prompt } of cases) {
    it(
      `${name} is accepted by the real Gemini structured-generation API (no 400)`,
      async () => {
        const result = await gemini.generateStructured(prompt, MODEL, schema);
        expect(() => JSON.parse(result.text)).not.toThrow();
      },
      30_000,
    );
  }
});
