/**
 * Explicit `max_output_tokens` budgets for each synthesis stage's Gemini
 * call — previously UNSET everywhere (see gemini/client.ts's
 * generateStructured, which never passed `generation_config` at all), so
 * every stage ran against whichever server-side default the Interactions
 * API applies.
 *
 * v1 (initial estimates, now known wrong for cluster_chunk): sized purely
 * from each schema's own field count — cluster_chunk/cluster_merge got
 * 4096, reasoned as "compact: clusterKey/name/rationale strings + arrays
 * of instance ids." That reasoning ignored a real, documented Gemini
 * behavior:
 *
 * v2 (current) — CONFIRMED by a real read-only diagnostic run
 * (scripts/canonicalStrategyDiagnostic.ts) against the actual production
 * course's 10 strategy instances:
 *
 *   stage=cluster_chunk prompt_chars=11319 max_output_tokens=4096
 *   interaction_status=incomplete output_chars=1990
 *   starts_with_brace=true ends_with_brace=false
 *
 * A response that starts with `{` but never closes it, at only 1990
 * characters (roughly 500 tokens) into a 4096-token budget, is truncation
 * — but 500 tokens of visible JSON is nowhere near 4096 tokens' worth of
 * room on its own. The explanation: Gemini's "thinking" models bill
 * thinking tokens as output, and thinking SHARES the same
 * max_output_tokens budget as the visible response (confirmed for this
 * model family — the model can spend most or all of an explicit budget on
 * internal reasoning before producing any of the actual answer, especially
 * for a comparison-heavy task like clustering 10 items against each
 * other). The v1 budgets never accounted for this at all — they were
 * sized only for the visible JSON's own footprint.
 *
 * This also explains why removing the explicit cap entirely (going back
 * to v1's baseline of "unset") is NOT what these numbers do: production's
 * synthesis run *before* this file existed successfully completed
 * clustering, meaning the server-side default (whatever it is) already
 * accommodates real thinking-token usage for this task. v2's numbers are
 * deliberately set well above the v1 estimates — not because the visible
 * JSON got bigger, but because thinking token consumption needs its own
 * headroom within the same shared budget, and we now have direct
 * (if singular) evidence that headroom needs to be in the tens of
 * thousands, not single-digit thousands.
 *
 * These are still reasoned estimates, not measurements from every stage —
 * only cluster_chunk has a real production-scale data point so far.
 * tests/synthesisCanonicalLoadTest.test.ts and
 * scripts/canonicalStrategyDiagnostic.ts (both opt-in, real API) exist
 * specifically to keep calibrating these; re-run them after any change
 * here. Bumping any of these is a visible, deliberate cost decision —
 * never silently uncapped.
 */
export const SYNTHESIS_MAX_OUTPUT_TOKENS = {
  /**
   * CONFIRMED insufficient at 4096 against real data (see changelog
   * above) — raised substantially. Clustering is comparison-heavy (10+
   * instances compared pairwise for similarity), plausibly the most
   * thinking-intensive stage of the six despite having the smallest
   * visible output, which is exactly the profile that gets hurt most by
   * an undersized shared budget.
   */
  cluster_chunk: 32768,
  /** Same shape/reasoning as cluster_chunk — the reduce step reasons over already-summarized proposals, same order of magnitude of comparison work. */
  cluster_merge: 32768,
  /**
   * By far the richest VISIBLE output of the six stages (up to 11 rule
   * categories, each an array of rules with provenance — see schema.ts's
   * v3 `sections` format) and also a synthesis/reasoning-heavy task
   * (resolving conflicts across sources, deciding support levels) —
   * raised in proportion to cluster_chunk's confirmed need, since nothing
   * suggests canonical_strategy's thinking-token consumption would be
   * smaller. Not yet confirmed against real production data (clustering
   * itself failed first) — recalibrate once scripts/canonicalStrategyDiagnostic.ts
   * actually reaches this stage.
   */
  canonical_strategy: 32768,
  /** Pooled cross-strategy rule categories — less comparison-heavy than clustering (pooling already-canonicalized rules, not raw pairwise comparison), but raised from v1's estimate for the same shared-budget reason. */
  core_framework: 16384,
  /** Prose sections — often the single largest PROMPT of any stage (see canonicalStrategy.ts's neighboring comments), given the same generous ceiling as canonical_strategy since long-form synthesis is plausibly just as thinking-heavy. */
  playbook: 32768,
  /** Decision nodes + a readable-steps array — raised from v1's estimate for the same shared-budget reason, kept below the three heaviest stages absent evidence it needs more. */
  decision_framework: 16384,
} as const;

export type SynthesisStageForLimits = keyof typeof SYNTHESIS_MAX_OUTPUT_TOKENS;
