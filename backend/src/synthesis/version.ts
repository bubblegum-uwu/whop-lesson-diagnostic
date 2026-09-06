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
 * v2: fixed a real Gemini API incompatibility — several response_format
 * schemas represented a nullable field as `type: ["string", "null"]`
 * (valid standard JSON Schema, but documented to cause a 400 from the real
 * Gemini API, which expects a single `type` with the field simply omitted
 * from `required` instead) — and reduced canonical_strategy's wire
 * complexity by having Gemini emit a smaller per-source shape that gets
 * deterministically enriched with lessonTitle/strategyInstanceId in code
 * afterward (see canonicalStrategy.ts). The final persisted CanonicalStrategy
 * shape/Zod validation is unchanged; only what Gemini itself is asked to
 * produce changed.
 */
export const SYNTHESIS_SCHEMA_VERSION = "v2";
export const SYNTHESIZER_VERSION = "v1";
