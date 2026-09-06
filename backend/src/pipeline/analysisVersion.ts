/**
 * Bump whichever of these actually changed whenever the extraction prompt,
 * the Zod/JSON schema, or the pipeline's extraction logic changes in a way
 * that could produce a materially different result for the same lesson.
 * These three plus the Gemini model and lesson id are the only inputs to
 * the analysis fingerprint (see fingerprint.ts) — bumping any of them here
 * makes previously-"already analyzed" lessons eligible for analysis again.
 *
 * v2 (Phase 3.5 — "rich trading knowledge extraction"): all three bumped
 * together — the prompt changed (now asks for `knowledge` regardless of
 * strategy_found, not just strategies), the schema changed (gemini/
 * schema.ts's new KnowledgeItem/LessonExample/LessonKnowledge shapes), and
 * the extraction behavior changed materially (a lesson with no standalone
 * setup now yields real persisted content instead of an effectively-empty
 * record). This is the ENTIRE mechanism by which existing v1 analyses
 * become eligible for re-analysis: `lesson_analyses` rows persisted under
 * v1 keep their v1 fingerprint forever (never rewritten — inserts only),
 * so a v2 fingerprint for the same lesson+model never matches an existing
 * row, and the "already analyzed, skip" check (findLatestByFingerprint)
 * naturally falls through to "not yet analyzed under this version." No
 * separate "is this stale" flag or migration is needed for this — see the
 * Phase 3.5 PR description for why no DB migration was needed at all. Old
 * v1 rows remain fully readable: `schema_version`/`extractor_version` are
 * already persisted per-row, so a reader can always tell which shape a
 * given `validated_json` blob follows (v1: no `knowledge` field at all;
 * v2: `knowledge` always present) without guessing.
 */
export const PROMPT_VERSION = "v2";
export const SCHEMA_VERSION = "v2";
export const EXTRACTOR_VERSION = "v2";
