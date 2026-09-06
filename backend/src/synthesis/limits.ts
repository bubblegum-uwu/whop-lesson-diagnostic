/**
 * Explicit `max_output_tokens` budgets for each synthesis stage's Gemini
 * call — previously UNSET everywhere (see gemini/client.ts's
 * generateStructured, which never passed `generation_config` at all), so
 * every stage ran against whichever server-side default the Interactions
 * API applies. That's a real, demonstrable gap: `canonical_strategy` is
 * asked to produce by far the richest structured output of the six stages
 * (see schema.ts's v3 `sections` format — still up to 11 rule categories,
 * each rule carrying provenance/timestamps/evidence, plus conflicts and
 * variants), and an unset budget on the single richest stage is exactly
 * the kind of gap that would only surface once real production data (not
 * a tiny smoke-test prompt) pushed a real cluster's output close to
 * whatever that unstated default is.
 *
 * These numbers are reasoned estimates, not measurements — deliberately
 * NOT "arbitrarily huge": each is sized from a rough worst-case token
 * count for that stage's own schema (roughly 4 characters per token),
 * with headroom, not an unbounded ceiling. tests/synthesisCanonicalLoadTest.test.ts
 * (opt-in, real API) exists specifically to calibrate these against actual
 * production-scale output and should be run before trusting them blindly.
 *
 * Bumping any of these is a visible, deliberate cost decision — never
 * silently uncapped — and takes effect for every future run, so keep the
 * reasoning here up to date if you change one.
 */
export const SYNTHESIS_MAX_OUTPUT_TOKENS = {
  /**
   * A batch of cluster proposals over one chunk of strategy signatures —
   * compact: clusterKey/name/rationale strings + arrays of instance ids.
   * Even a chunk near the token budget ceiling (see normalize.ts's
   * chunkSignatures) produces maybe 10-20 proposed clusters worth of short
   * text. ~4096 tokens is comfortable headroom over that.
   */
  cluster_chunk: 4096,
  /** The reduce/merge step over already-summarized per-chunk proposals — same shape, same budget as cluster_chunk. */
  cluster_merge: 4096,
  /**
   * By far the richest single stage: up to 11 rule categories, each an
   * array of rules, each rule carrying description/classification/
   * supportLevel/supportCount plus a sources[]/conflictSources[] array of
   * {lessonId, startTimestamp, endTimestamp, evidence} (v3's reduced wire
   * shape — no lessonTitle/strategyInstanceId, see schema.ts). Worst-case
   * estimate: ~40 rules total across all categories x ~150-200 tokens each
   * (description + 1-2 sources with a sentence of evidence) is roughly
   * 6,000-8,000 tokens, plus variants/examples/conflicts/ambiguities. 16384
   * gives real headroom above that estimate without being unbounded.
   */
  canonical_strategy: 16384,
  /** Pooled cross-strategy rule categories — similar per-rule shape to canonical_strategy but pooling, not per-cluster, so typically fewer total rules. */
  core_framework: 8192,
  /**
   * Prose sections (title + content strings), not structured rules — often
   * the single largest PROMPT of any stage (per synthesis/canonicalStrategy.ts's
   * neighboring comments), but its own output is free-form paragraphs
   * rather than deeply nested objects; still given the same generous
   * ceiling as canonical_strategy since it's realistic for prose to run long.
   */
  playbook: 16384,
  /** Decision nodes + a readable-steps string array — moderate, comparable to core_framework. */
  decision_framework: 8192,
} as const;

export type SynthesisStageForLimits = keyof typeof SYNTHESIS_MAX_OUTPUT_TOKENS;
