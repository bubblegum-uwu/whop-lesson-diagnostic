/**
 * Explicit `max_output_tokens` budget for lesson analysis's single Gemini
 * call (`gemini/client.ts`'s `analyzeVideo`) — previously UNSET entirely
 * (no `generation_config` was ever passed for this call, unlike synthesis's
 * six stages, which got explicit budgets starting with PR #9's
 * investigation — see synthesis/limits.ts). That gap mattered little
 * against the old strategy-only schema; it matters a great deal against
 * Phase 3.5's richer `knowledge` schema (13 categories collapsed into one
 * `knowledgeItems` array, plus examples/conflicts — see gemini/schema.ts),
 * which can produce substantially more visible output for a lesson with no
 * standalone strategy but a lot of supporting knowledge (e.g. a 64-minute
 * risk/sizing/management lesson).
 *
 * This is a REASONED ESTIMATE, not a measurement — unlike synthesis/
 * limits.ts's canonical_strategy value (which was revised three times
 * against real diagnostic data from scripts/canonicalStrategyDiagnostic.ts),
 * there is no equivalent real-API lesson-analysis diagnostic tooling yet.
 * Set to gemini-3.8-flash's documented output-token ceiling (verified
 * against ai.google.dev and cross-checked against independent sources —
 * see synthesis/limits.ts's own changelog for the same verification) for
 * the same reason canonical_strategy was initially set there: this is a
 * new, unmeasured extraction shape, and any smaller number would be just
 * as much of a guess while adding real truncation risk for a long,
 * knowledge-dense lesson. Also unlike synthesis's canonical_strategy
 * (which was LATER lowered once its real wire-format fix and real usage
 * data existed — see synthesis/limits.ts's v5 changelog), there is no
 * comparable real data here yet to justify a lower number.
 *
 * Recalibrate this once real usage data exists (e.g. via an opt-in
 * diagnostic script analogous to scripts/canonicalStrategyDiagnostic.ts,
 * run against a real course's actual lessons) — do not lower it on
 * intuition alone, and do not raise it further without evidence either.
 */
export const LESSON_ANALYSIS_MAX_OUTPUT_TOKENS = 65536;
