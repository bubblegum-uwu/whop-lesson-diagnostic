/**
 * Bump whichever of these actually changed whenever the extraction prompt,
 * the Zod/JSON schema, or the pipeline's extraction logic changes in a way
 * that could produce a materially different result for the same lesson.
 * These three plus the Gemini model and lesson id are the only inputs to
 * the analysis fingerprint (see fingerprint.ts) — bumping any of them here
 * makes previously-"already analyzed" lessons eligible for analysis again.
 */
export const PROMPT_VERSION = "v1";
export const SCHEMA_VERSION = "v1";
export const EXTRACTOR_VERSION = "v1";
