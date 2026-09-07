import { describe, it } from "vitest";
import { callGeminiForStage } from "../src/synthesis/geminiStage.js";
import { createGeminiClient } from "../src/gemini/client.js";
import {
  CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
  CLUSTER_MERGE_RESPONSE_JSON_SCHEMA,
  RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  PLAYBOOK_RESPONSE_JSON_SCHEMA,
  RAW_DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
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
    schema: RAW_DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
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

// ---------------------------------------------------------------------------
// Bisection ladder — canonical_strategy specifically
// ---------------------------------------------------------------------------
//
// A real-API run confirmed the canonical_strategy schema above (the v2
// wire shape, 11 sibling arrays of deeply nested rule/source objects) IS
// rejected with a 400 by the real Gemini API, even with a tiny 224-char
// prompt — i.e. it's the SCHEMA being rejected, not prompt size. schema.ts
// was then restructured (v3: a single `sections` array instead of 11
// sibling arrays) as the most likely fix given that finding, but that
// restructuring has NOT itself been verified against the real API in this
// environment (no Gemini API key available here).
//
// This ladder builds up from a trivial, near-certainly-accepted schema to
// the full v3 schema one structural feature at a time, so a run of this
// file tells you exactly which rung introduces a failure — confirming (or
// ruling out) each of: nested rule objects, a nested `sources` array, a
// second nested `conflictSources` array, enums, 11x sibling-array
// duplication (L7 — this is the OLD v2 shape, already known to FAIL, kept
// here as a same-run baseline for comparison), the `sections` collapse
// (L8/L9), the exact full v3 production schema (L10), and additionalProperties
// (L11). Run this file with the same command as the main smoke test above.

const RULE_CATEGORIES = [
  "marketContext",
  "prerequisites",
  "setup",
  "entryRules",
  "confirmationRules",
  "stopLossRules",
  "profitTargetRules",
  "tradeManagementRules",
  "invalidationRules",
  "noTradeConditions",
  "visualDiscretionaryRules",
];

const sourceRefTrivial = {
  type: "object",
  properties: {
    lessonId: { type: "number" },
    startTimestamp: { type: "string" },
    endTimestamp: { type: "string" },
    evidence: { type: "string" },
  },
  required: ["lessonId", "evidence"],
};

function ruleShape(depth: "trivial" | "withSupport" | "withSources" | "withConflictSources"): object {
  const properties: Record<string, object> = {
    description: { type: "string" },
    classification: { type: "string", enum: ["explicit", "inferred", "visual", "synthesized"] },
  };
  const required = ["description", "classification"];
  if (depth === "trivial") return { type: "object", properties, required };

  properties.supportLevel = { type: "string", enum: ["SINGLE_SOURCE", "MULTI_SOURCE", "REPEATED_EXPLICIT", "VARIANT", "CONFLICTING", "INFERRED"] };
  properties.supportCount = { type: "integer" };
  required.push("supportLevel", "supportCount");
  if (depth === "withSupport") return { type: "object", properties, required };

  properties.sources = { type: "array", items: sourceRefTrivial };
  required.push("sources");
  if (depth === "withSources") return { type: "object", properties, required };

  properties.conflictSources = { type: "array", items: sourceRefTrivial };
  required.push("conflictSources");
  return { type: "object", properties, required };
}

/** Recursively adds `additionalProperties: false` to every object-type schema node — used only by L11 to isolate that one dimension. */
function withAdditionalPropertiesFalse(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withAdditionalPropertiesFalse);
  if (schema === null || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = withAdditionalPropertiesFalse(v);
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

const scalarProperties = {
  name: { type: "string" },
  purpose: { type: "string" },
  markets: { type: "array", items: { type: "string" } },
  timeframes: { type: "array", items: { type: "string" } },
};
const scalarRequired = ["name", "purpose", "markets", "timeframes"];

const BISECTION_RUNGS: Array<{ label: string; describe: string; schema: object }> = [
  {
    label: "L1_trivial",
    describe: "just {name}",
    schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    label: "L2_scalars",
    describe: "+ purpose/markets/timeframes (scalars + string arrays)",
    schema: { type: "object", properties: scalarProperties, required: scalarRequired },
  },
  {
    label: "L3_single_rule_array_trivial",
    describe: "+ one array (entryRules) of {description, classification enum}",
    schema: {
      type: "object",
      properties: { ...scalarProperties, entryRules: { type: "array", items: ruleShape("trivial") } },
      required: [...scalarRequired, "entryRules"],
    },
  },
  {
    label: "L4_rule_with_supportlevel",
    describe: "+ rule gains supportLevel (6-value enum) + supportCount",
    schema: {
      type: "object",
      properties: { ...scalarProperties, entryRules: { type: "array", items: ruleShape("withSupport") } },
      required: [...scalarRequired, "entryRules"],
    },
  },
  {
    label: "L5_rule_with_sources",
    describe: "+ rule gains a nested `sources` array (1 level of nesting)",
    schema: {
      type: "object",
      properties: { ...scalarProperties, entryRules: { type: "array", items: ruleShape("withSources") } },
      required: [...scalarRequired, "entryRules"],
    },
  },
  {
    label: "L6_rule_with_conflictSources",
    describe: "+ rule gains a SECOND nested array `conflictSources` (matches production rule shape exactly)",
    schema: {
      type: "object",
      properties: { ...scalarProperties, entryRules: { type: "array", items: ruleShape("withConflictSources") } },
      required: [...scalarRequired, "entryRules"],
    },
  },
  {
    label: "L7_eleven_sibling_arrays_OLD_V2_SHAPE",
    describe: "the OLD v2 shape: 11 separate sibling arrays, each the full L6 rule shape — ALREADY CONFIRMED to FAIL; included here as a same-run baseline",
    schema: {
      type: "object",
      properties: {
        ...scalarProperties,
        ...Object.fromEntries(RULE_CATEGORIES.map((c) => [c, { type: "array", items: ruleShape("withConflictSources") }])),
      },
      required: [...scalarRequired, ...RULE_CATEGORIES],
    },
  },
  (() => {
    const sectionsProperty = {
      type: "array",
      items: {
        type: "object",
        properties: { category: { type: "string", enum: RULE_CATEGORIES }, rules: { type: "array", items: ruleShape("withConflictSources") } },
        required: ["category", "rules"],
      },
    };
    return {
      label: "L8_collapsed_sections",
      describe: "the NEW v3 structural change: ONE `sections` array (category enum + nested rules array) instead of 11 siblings, same L6 rule shape",
      schema: {
        type: "object",
        properties: { ...scalarProperties, sections: sectionsProperty },
        required: [...scalarRequired, "sections"],
      },
    };
  })(),
  (() => {
    const sectionsProperty = {
      type: "array",
      items: {
        type: "object",
        properties: { category: { type: "string", enum: RULE_CATEGORIES }, rules: { type: "array", items: ruleShape("withConflictSources") } },
        required: ["category", "rules"],
      },
    };
    const conflictsProperty = {
      type: "array",
      items: {
        type: "object",
        properties: { description: { type: "string" }, sources: { type: "array", items: sourceRefTrivial } },
        required: ["description", "sources"],
      },
    };
    return {
      label: "L9_collapsed_sections_plus_conflicts",
      describe: "L8 + a top-level `conflicts` array (description + sources)",
      schema: {
        type: "object",
        properties: { ...scalarProperties, sections: sectionsProperty, conflicts: conflictsProperty },
        required: [...scalarRequired, "sections", "conflicts"],
      },
    };
  })(),
  {
    label: "L10_full_v3_production_schema",
    describe: "the EXACT full v3 schema canonicalStrategy.ts sends today (RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA)",
    schema: RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  },
  {
    label: "L11_full_v3_with_additionalProperties_false",
    describe: "L10 with additionalProperties:false added to every object node — isolates that one dimension",
    schema: withAdditionalPropertiesFalse(RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA) as object,
  },
];

describe.skipIf(!REAL_API_ENABLED)("real Gemini API — canonical_strategy bisection ladder", () => {
  const gemini = createGeminiClient(process.env.GEMINI_API_KEY ?? "");

  for (const { label, describe: rungDescribe, schema } of BISECTION_RUNGS) {
    it(
      `${label}: ${rungDescribe}`,
      async () => {
        const prompt = "Respond with a minimal example matching the required schema, using empty arrays wherever optional and short placeholder text elsewhere.";
        try {
          const { rawText } = await callGeminiForStage({ gemini, model: MODEL }, `canonical_strategy_bisect_${label}`, prompt, schema);
          JSON.parse(rawText);
          // eslint-disable-next-line no-console
          console.log(`${label.padEnd(40)}PASS`);
        } catch (err) {
          const safeMessage = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.log(`${label.padEnd(40)}FAIL  ${safeMessage}`);
          throw err;
        }
      },
      30_000,
    );
  }
});
