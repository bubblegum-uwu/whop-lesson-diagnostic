/**
 * Explicit `max_output_tokens` budgets for lesson analysis's two
 * independent Gemini calls (`gemini/client.ts`'s `analyzeVideo`, called
 * twice per lesson — see pipeline/analyzeLesson.ts's two-pass
 * architecture). Previously ONE combined call and ONE combined budget
 * (`LESSON_ANALYSIS_MAX_OUTPUT_TOKENS`); split into two constants when
 * strategy extraction and knowledge extraction became two separate Gemini
 * calls (see gemini/schema.ts's two-pass changelog) — each pass now gets
 * its own explicit budget rather than sharing one.
 *
 * Both are REASONED ESTIMATES, not measurements — unlike synthesis/
 * limits.ts's canonical_strategy value (which was revised three times
 * against real diagnostic data from scripts/canonicalStrategyDiagnostic.ts),
 * there is no equivalent real-API per-pass lesson-analysis diagnostic data
 * yet. Both are set to gemini-3.8-flash's documented output-token ceiling
 * (verified against ai.google.dev and cross-checked against independent
 * sources — see synthesis/limits.ts's own changelog for the same
 * verification) for the same reason the original combined budget was: this
 * is a new, unmeasured extraction shape (now two of them), and any smaller
 * number would be just as much of a guess while adding real truncation
 * risk. Each pass's own task is narrower than the old combined call's, so
 * each will very likely be safely lowerable once real per-pass diagnostic
 * data exists (see scripts/lessonAnalysisDiagnostic.ts, which now reports
 * STRATEGY_PASS/KNOWLEDGE_PASS token usage separately) — do not lower
 * either on intuition alone, and do not raise them further without
 * evidence either. The deliberate near-term tradeoff (per the task that
 * introduced the two-pass split): reliability/fidelity first, cost
 * optimization only after the source layer is stable and measured.
 */
export const STRATEGY_ANALYSIS_MAX_OUTPUT_TOKENS = 65536;
export const KNOWLEDGE_ANALYSIS_MAX_OUTPUT_TOKENS = 65536;
