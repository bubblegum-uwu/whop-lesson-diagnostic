import type { GeminiThinkingLevel } from "../gemini/client.js";

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
 * behavior (see v2 below).
 *
 * v2 (superseded for canonical_strategy/playbook — see v3): CONFIRMED by a
 * real read-only diagnostic run (scripts/canonicalStrategyDiagnostic.ts)
 * against the actual production course's 10 strategy instances:
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
 * other). v2 raised every stage well above the v1 estimates on that basis.
 * cluster_chunk/cluster_merge are CONFIRMED sufficient at v2's 32768 —
 * real clustering now succeeds — so they stay there.
 *
 * v3 (current) — canonical_strategy and playbook raised again, past v2's
 * 32768, based on a SECOND real diagnostic run that reached
 * canonical_strategy itself for the very first cluster
 * ("Break and Retest (B&R) with Key Levels and Order Blocks"):
 *
 *   stage=canonical_strategy schema=canonical_strategy_v3 model=gemini-3.8-flash
 *   prompt_chars=15596 max_output_tokens=32768
 *   interaction_status=incomplete output_chars=31910 is_empty=false
 *   starts_with_brace=true ends_with_brace=false has_markdown_fence=false
 *   input_tokens=3851 output_tokens=31032 thinking_tokens=17222
 *
 * output_tokens=31032 against a 32768 budget is ~94.7% consumed — this is
 * the same truncation signature as v1's cluster_chunk failure, just at a
 * budget 8x larger: canonical_strategy is at least as thinking-heavy as
 * clustering (it resolves conflicts across sources and assigns support
 * levels across up to 11 rule categories), so 32768 was insufficient for
 * the exact same shared-budget reason v1 was insufficient for
 * cluster_chunk.
 *
 * Verified via the Gemini API's own published limits (ai.google.dev,
 * cross-checked against multiple independent sources): gemini-3.8-flash's
 * documented output-token ceiling is 65536 — the model cannot generate
 * more than that in a single response regardless of what max_output_tokens
 * requests. That's also independently confirmed as the practical ceiling
 * for the whole Gemini 3.x Flash/Pro family. canonical_strategy and
 * playbook are raised to that documented ceiling — not "a bit more than
 * 32768" — because the failure mode (thinking consuming most of the
 * budget before the visible JSON finishes) doesn't have a principled
 * stopping point below the model's actual maximum: any smaller number is
 * just as arbitrary as 32768 was, and this task already has one confirmed
 * case of an "arbitrary but larger" number still failing.
 *
 * Cost note: raising the CONFIGURED ceiling to 65536 does not by itself
 * double cost — billing is by tokens actually generated, not by the
 * configured budget. But per the same Gemini 3 thinking-budget behavior
 * that caused this failure, thinking token usage has been observed to
 * scale roughly linearly with max_output_tokens itself (a larger ceiling
 * can invite proportionally more thinking, not just remove a hard stop) —
 * so canonical_strategy/playbook calls that previously would have been
 * silently truncated may now legitimately consume closer to the full
 * 65536-token budget, at correspondingly higher per-call cost. This is a
 * visible, deliberate tradeoff (correctness over cost) for exactly the two
 * stages with confirmed or suspected truncation risk — not applied to the
 * other four stages, which have no such evidence.
 *
 * cluster_chunk/cluster_merge stay at v2's 32768 (real clustering now
 * succeeds there — no evidence they need more). core_framework/
 * decision_framework stay at v2's 16384 (no evidence yet that they're
 * undersized — pooling/decision-node stages are less comparison-heavy than
 * clustering or canonical_strategy's per-cluster synthesis).
 *
 * v5 (current) — canonical_strategy budget LOWERED, 65536 -> 32768, after
 * the actual fix landed: v4's compact `sourceKeys` wire format (see
 * schema.ts) stopped Gemini from re-emitting already-known provenance text
 * per source citation, which was the real cause of v3's 31032-output-token
 * failure — not an insufficient budget. Two real diagnostic runs under the
 * v4 wire format (one 1-member cluster, one 2-member cluster) both
 * completed successfully at:
 *
 *   1-member: output_tokens=3059 (medium thinking) / 2999 (low thinking)
 *   2-member: output_tokens=3558 (medium thinking) / 3582 (low thinking)
 *
 * 32768 gives roughly 9x headroom over the largest real observation
 * (3582) — generous enough for materially larger real clusters without
 * reintroducing v1/v2's mistake of an undersized cap, while ruling out an
 * accidental extremely-expensive runaway generation that 65536 would
 * still permit. The old 31032-token failure belonged to the OLD
 * provenance-heavy wire format (v2/v3) and is no longer representative of
 * what this stage actually produces — recalibrate again if a future real
 * run approaches this ceiling under normal (non-runaway) conditions.
 * cluster_chunk/cluster_merge are NOT changed by v5 — 4096 was confirmed
 * insufficient there for the same shared thinking/output-budget reason
 * documented in v2, and that finding is independent of canonical_strategy's
 * wire format. playbook/core_framework/decision_framework are also
 * unchanged by v5 — no real usage data exists yet for any of them.
 *
 * tests/synthesisCanonicalLoadTest.test.ts and
 * scripts/canonicalStrategyDiagnostic.ts (both opt-in, real API) exist
 * specifically to keep calibrating these; re-run them after any change
 * here. Bumping any of these is a visible, deliberate cost decision —
 * never silently uncapped.
 */
export const SYNTHESIS_MAX_OUTPUT_TOKENS = {
  /**
   * CONFIRMED sufficient at 32768 (v2) — real clustering against the
   * actual production course now succeeds. Comparison-heavy (10+
   * instances compared pairwise for similarity), plausibly the most
   * thinking-intensive stage of the six despite having the smallest
   * visible output, which is exactly the profile that gets hurt most by
   * an undersized shared budget — but 32768 has now cleared that bar.
   */
  cluster_chunk: 32768,
  /** Same shape/reasoning as cluster_chunk — the reduce step reasons over already-summarized proposals, same order of magnitude of comparison work. Not yet independently confirmed against real data, but shares cluster_chunk's confirmed budget on the same reasoning. */
  cluster_merge: 32768,
  /**
   * v5: LOWERED from 65536 back to 32768 now that the v4 compact
   * `sourceKeys` wire format has confirmed real output stays in the
   * ~3000-3600 token range (see the v5 changelog above) — 65536 was sized
   * for the old provenance-heavy wire format's failure, which the wire
   * format fix (not the budget) actually resolved. 32768 keeps ~9x
   * headroom over the largest real observation while capping the cost of
   * an accidental runaway generation.
   */
  canonical_strategy: 32768,
  /** Pooled cross-strategy rule categories — less comparison-heavy than clustering (pooling already-canonicalized rules, not raw pairwise comparison). Kept at v2's 16384 — no evidence yet it's undersized. */
  core_framework: 16384,
  /**
   * Raised to 65536 alongside canonical_strategy, though NOT yet directly
   * confirmed insufficient at 32768 by a real diagnostic run — this stage
   * hasn't been reached yet (canonical_strategy is earlier in the
   * pipeline and was still failing until this revision). Raised
   * preemptively because playbook is a long-form prose synthesis stage,
   * often the single largest PROMPT of any stage (see
   * canonicalStrategy.ts's neighboring comments), plausibly at least as
   * thinking-heavy as canonical_strategy — waiting for playbook to fail
   * in production the same way canonical_strategy just did would repeat
   * the same mistake v1→v2→v3 already corrected twice. Recalibrate (and
   * potentially lower) once a real diagnostic run reaches this stage with
   * usage data.
   */
  playbook: 65536,
  /** Decision nodes + a readable-steps array. Kept at v2's 16384 — no evidence yet it's undersized, and structurally smaller/less comparison-heavy than canonical_strategy or playbook. */
  decision_framework: 16384,
} as const;

export type SynthesisStageForLimits = keyof typeof SYNTHESIS_MAX_OUTPUT_TOKENS;

/**
 * The production `generation_config.thinking_level` for canonical_strategy
 * ONLY — every other synthesis stage leaves thinking_level unset (server
 * default, observed as "medium") and MUST continue to do so; this constant
 * is deliberately not a stage-keyed map like SYNTHESIS_MAX_OUTPUT_TOKENS
 * above, specifically so adding another stage to it is a visible,
 * intentional code change rather than one line in a table.
 *
 * CONFIRMED via two real A/B/C diagnostic comparisons under the v4 compact
 * `sourceKeys` wire format — one 1-member cluster, one 2-member cluster
 * requiring Gemini to actually reconcile two lesson instances' rules — that
 * "low" produces IDENTICAL correctness to the server default:
 *
 *   1-member:  medium: output=3059 thinking=2301 cost=$0.0146 10/11 categories, completed/PASS/PASS
 *              low:    output=2999 thinking=0    cost=$0.0087 10/11 categories, completed/PASS/PASS
 *   2-member:  medium: output=3558 thinking=2161 cost=$0.0162 10/11 categories, completed/PASS/PASS
 *              low:    output=3582 thinking=0    cost=$0.0108 10/11 categories, completed/PASS/PASS
 *
 * Same interaction_status=completed, same json_parse/zod_validation PASS,
 * same 10/11 rule-category coverage, similar visible output size, in BOTH
 * the single-source and multi-source-reconciliation case — at 33-40% lower
 * cost. canonical_strategy's task (structured consolidation of
 * already-extracted rules: grouping, assigning support levels, recording
 * variants/conflicts explicitly) is bounded structured-output work, not
 * open-ended reasoning, which is consistent with low thinking losing
 * nothing here.
 *
 * NOT applied to any other stage: no comparable real A/B evidence exists
 * yet for cluster_chunk/cluster_merge (comparison-heavy clustering, where
 * v2's changelog already found thinking token consumption matters a great
 * deal), core_framework, playbook (open-ended long-form prose), or
 * decision_framework (constructing a coherent decision tree) — several of
 * which plausibly benefit from more thinking, unlike canonical_strategy's
 * bounded consolidation task. Never extend this to another stage without
 * the same kind of real, measured A/B comparison this constant is based on.
 *
 * scripts/canonicalStrategyDiagnostic.ts's CANONICAL_STRATEGY_THINKING_LEVEL
 * env var independently overrides this for diagnostic runs (bypasses this
 * constant entirely, since the diagnostic script calls
 * synthesizeCanonicalStrategy directly rather than through runSynthesis.ts)
 * — that override capability is preserved unchanged by this constant.
 */
export const CANONICAL_STRATEGY_THINKING_LEVEL: GeminiThinkingLevel = "low";
