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
 */
export const SYNTHESIS_PROMPT_VERSION = "v2";
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
 * Across all three versions, the final persisted CanonicalStrategy
 * shape/Zod validation (CanonicalStrategySchema) is unchanged; only what
 * Gemini itself is asked to produce, and how that's grouped, changed.
 */
export const SYNTHESIS_SCHEMA_VERSION = "v3";
export const SYNTHESIZER_VERSION = "v1";
