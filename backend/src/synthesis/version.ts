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
export const SYNTHESIS_SCHEMA_VERSION = "v1";
export const SYNTHESIZER_VERSION = "v1";
