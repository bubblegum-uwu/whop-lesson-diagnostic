/**
 * Bump whichever of these actually changed whenever a synthesis prompt, the
 * synthesis Zod/JSON schemas, or the stage pipeline logic changes in a way
 * that could produce a materially different result for the same source
 * analyses. These, the model, and the source analysis ids are the only
 * inputs to the source-analysis hash (see fingerprint.ts) — bumping any of
 * them here makes an existing "current" synthesis eligible to be treated as
 * out of date even though no new lesson was analyzed.
 */
/**
 * v2 (canonicalStrategy.ts's buildPrompt): updated to describe the v3
 * `sections`-grouped wire format below instead of the 11 named
 * top-level array fields it replaced.
 *
 * v3: updated again for the v4 wire-format change below — every source
 * rule in the prompt's input is now tagged with a short reference "key",
 * and the prompt instructs Gemini to cite those keys via
 * "sourceKeys"/"conflictSourceKeys" instead of restating
 * lessonId/timestamps/evidence text per source citation.
 */
export const SYNTHESIS_PROMPT_VERSION = "v3";
/**
 * v2: in response to a production 400 whose root cause was masked by
 * insufficient error handling (see SynthesisGeminiCallError), made two
 * precautionary changes to the response_format schemas — NEITHER confirmed
 * as the actual cause at the time, both kept as harmless hardening:
 *   - simplified nullable fields from `type: ["string", "null"]` to plain
 *     `type: "string"` with the field omitted from `required` — Google's
 *     structured-output docs list the array form as supported, so this was
 *     NOT a documented incompatibility fix, just a simpler, semantically
 *     equivalent representation;
 *   - reduced canonical_strategy's wire complexity by having Gemini emit a
 *     smaller per-source shape that gets deterministically enriched with
 *     lessonTitle/strategyInstanceId in code afterward (see
 *     canonicalStrategy.ts).
 *
 * v3: a real Gemini API smoke test (tests/synthesisRealApiSmoke.test.ts)
 * run against v2's canonical_strategy schema CONFIRMED it is rejected by
 * the real API with a 400 (tiny 224-char synthetic prompt — this is a
 * schema-shape rejection, not a prompt-size issue). v2's schema still
 * asked for 11 separate sibling arrays (one per rule category), each
 * containing a full copy of the same deeply nested rule/source shape —
 * since JSON Schema has no way to share a sub-schema by reference on the
 * wire, that's ~11 independent copies of the same nested structure. v3
 * collapses them into ONE `sections` array, each entry tagged with which
 * category it belongs to (schema.ts's RULE_CATEGORY_KEYS/RawRuleSectionSchema),
 * so the nested rule shape appears once instead of eleven times.
 * canonicalStrategy.ts's enrichCanonicalStrategy un-flattens `sections`
 * back into the 11 named categories the persisted shape requires — no
 * category is ever fabricated, and duplicate mentions of one category are
 * concatenated rather than overwritten. This restructuring has NOT itself
 * been re-verified against the real API in this environment (no Gemini API
 * key available here); see the PR for the exact command to confirm it, and
 * synthesisRealApiSmoke.test.ts's bisection ladder for isolating exactly
 * which structural factor (11x duplication vs. nested depth vs. something
 * else) was actually responsible, independent of whether v3 turns out to
 * fully resolve it.
 *
 * v4 (current): CONFIRMED via a real diagnostic run against the actual
 * first production cluster ("Break and Retest (B&R) with Key Levels and
 * Order Blocks", a ONE-MEMBER cluster) that v3's schema was itself
 * producing abnormally large output — output_tokens=31032,
 * thinking_tokens=17222 against a 32768-token budget, for a single
 * lesson's already-known rules. Root cause: v3 still asked Gemini to
 * RESTATE each source citation's lessonId + timestamps + evidence text
 * (a quoted sentence, potentially tens of tokens), even though every one
 * of those fields was ALREADY present verbatim in the prompt's own input
 * (gemini/schema.ts's RuleSchema — every original Stage-1 rule already
 * carries lessonId/timestamps/evidence). v4 assigns each original rule a
 * short reference "key" in the prompt and has Gemini cite
 * "sourceKeys"/"conflictSourceKeys" (short string arrays) instead —
 * application code resolves each key back to the full provenance using
 * data already known before the Gemini call. See schema.ts's v4 comment
 * for the full mechanism and canonicalStrategy.ts's keySourceData.
 *
 * Across all four versions, the final persisted CanonicalStrategy
 * shape/Zod validation (CanonicalStrategySchema) is unchanged; only what
 * Gemini itself is asked to produce, and how that's grouped/cited, changed.
 */
export const SYNTHESIS_SCHEMA_VERSION = "v4";
export const SYNTHESIZER_VERSION = "v1";
