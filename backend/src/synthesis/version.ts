/**
 * Bump whichever of these actually changed whenever a synthesis prompt, the
 * synthesis Zod/JSON schemas, or the stage pipeline logic changes in a way
 * that could produce a materially different result for the same source
 * analyses. These, the model, and the source analysis ids are the only
 * inputs to the source-analysis hash (see fingerprint.ts) — bumping any of
 * them here makes an existing "current" synthesis eligible to be treated as
 * out of date even though no new lesson was analyzed.
 */
export const SYNTHESIS_PROMPT_VERSION = "v1";
/**
 * v2: in response to a production 400 whose root cause was masked by
 * insufficient error handling (see SynthesisGeminiCallError), made two
 * precautionary changes to the response_format schemas — NEITHER confirmed
 * as the actual cause, both kept as harmless hardening validated by the
 * opt-in real-API smoke test (tests/synthesisRealApiSmoke.test.ts):
 *   - simplified nullable fields from `type: ["string", "null"]` to plain
 *     `type: "string"` with the field omitted from `required` — Google's
 *     structured-output docs list the array form as supported, so this is
 *     NOT a documented incompatibility fix, just a simpler, semantically
 *     equivalent representation;
 *   - reduced canonical_strategy's wire complexity by having Gemini emit a
 *     smaller per-source shape that gets deterministically enriched with
 *     lessonTitle/strategyInstanceId in code afterward (see
 *     canonicalStrategy.ts) — schema-complexity rejection is documented as
 *     *possible* for large/deep schemas, but was not confirmed to be what
 *     happened in production.
 * The final persisted CanonicalStrategy shape/Zod validation is unchanged;
 * only what Gemini itself is asked to produce changed.
 */
export const SYNTHESIS_SCHEMA_VERSION = "v2";
export const SYNTHESIZER_VERSION = "v1";
