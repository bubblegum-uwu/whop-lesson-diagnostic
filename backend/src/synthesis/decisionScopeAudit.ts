import type { DecisionFramework, DecisionNodeScopeLeak, DecisionReadableStepLeak } from "./schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import { effectiveScopeBasis } from "./scopeBasis.js";
import type { TaggedNonGlobalRule } from "./frameworkScopeSplit.js";
import { significantWords, bestOverlapMatch } from "./playbookApplicabilityAudit.js";

/**
 * Real-audit fix (Phase 3.5B, Blockers A/C/D) — a deterministic safety net
 * on TOP OF (never instead of) the prompt/input fix in decisionFramework.ts.
 *
 * v2 (superseded — see v3 below): flagged a node reachable on the
 * unconditional "global spine" (via `next` alone, never through a
 * `branches` fork) whose SELF-REPORTED `scope` was non-empty. A SECOND
 * real 28-lesson dry run showed this has a false-negative hole: Gemini
 * placed a stock/equity-specific "Is Stock In Play?" gate before strategy
 * selection while reporting EMPTY scope arrays — v2's check saw nothing
 * wrong because it only ever trusted what Gemini itself claimed.
 *
 * v3 — decisionFramework.ts no longer asks Gemini to self-report `scope`
 * at all. Every node instead cites `sourceKeys` (which pooled
 * CoreFramework/canonical-strategy rule(s) it's built from), and `scope`
 * is derived deterministically as the union of those rules' own
 * already-known scope (see buildDecisionSourcePool/deriveScopeFromKeys).
 *
 * v4 (current) — a THIRD real 28-lesson dry run showed v3 still had a
 * hole: a CoreFramework/canonical-strategy rule can itself be UNVERIFIED
 * (see scopeBasis.ts) — built only from scope-blind legacy citations, so
 * its OWN `scope` union comes out empty even though we have no actual
 * evidence it's course-wide. A node citing such a rule inherited that same
 * false confidence. This function now flags THREE distinct failure modes
 * on the spine:
 *
 *   "ungrounded" — a substantive node (not start/end, not a pure
 *   branching question) cites ZERO sources. Citing nothing is not
 *   evidence of being global — it's an absence of evidence, which v2
 *   wrongly treated as global by default. This is the exact fix for the
 *   "Is Stock In Play?" false negative.
 *
 *   "unverified_source" — the node cites real source(s), but its combined
 *   scopeBasis is UNVERIFIED: none of its citations are known-scoped, but
 *   at least one carries no scope-aware evidence at all. Global
 *   applicability is not justified by "we found no restriction" when we
 *   never had the means to find one in the first place.
 *
 *   "scoped_source" — the node's derived scope (from its real citations)
 *   is non-empty. Since scope is now always derived, not self-reported,
 *   this can only happen when the node is HONESTLY built from scoped
 *   material — which still must not sit on the unconditional path before
 *   strategy selection.
 *
 * A `branches`-bearing node itself is never flagged (it's a fork/question
 * establishing context, not an unconditional assertion) — only nodes
 * reachable strictly via `next` are checked.
 */
export function findGlobalGateScopeLeaks(decisionFramework: DecisionFramework): DecisionNodeScopeLeak[] {
  const byId = new Map(decisionFramework.nodes.map((n) => [n.id, n]));
  const startNodes = decisionFramework.nodes.filter((n) => n.type === "start");

  const visited = new Set<string>();
  const spine: string[] = [];
  const queue = [...startNodes.map((n) => n.id)];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (!node) continue;
    spine.push(id);
    // Only follow `next` — a `branches` fork is the conditional point where
    // context (strategy/instrument/timeframe/session/profile) is decided,
    // so nodes reachable ONLY through a branch are not on the unconditional
    // spine and are correctly allowed to be scoped/ungrounded-as-a-question.
    if (node.branches.length === 0) {
      for (const nextId of node.next) queue.push(nextId);
    }
  }

  const leaks: DecisionNodeScopeLeak[] = [];
  for (const id of spine) {
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === "start" || node.type === "end") continue;
    if (node.branches.length > 0) continue; // a pure branching question, not an unconditional assertion — nothing to ground.

    if (node.sourceKeys.length === 0) {
      leaks.push({ nodeId: node.id, label: node.label, reason: "ungrounded", scope: node.scope });
      continue;
    }
    if (isKnowledgeItemScoped(node.scope)) {
      leaks.push({ nodeId: node.id, label: node.label, reason: "scoped_source", scope: node.scope });
      continue;
    }
    if (effectiveScopeBasis(node) === "UNVERIFIED") {
      leaks.push({ nodeId: node.id, label: node.label, reason: "unverified_source", scope: node.scope });
    }
  }
  return leaks;
}

/**
 * Real-audit fix (v9, Part 3) — `readableSteps` are a plain-text, numbered
 * fallback walkthrough of the SAME unconditional process the node graph
 * represents (see decisionFramework.ts's prompt), but until now carried NO
 * audited scope metadata at all: `findGlobalGateScopeLeaks` above only ever
 * looks at `nodes`. A TENTH real dry run found `decisionFramework.scopeLeaks`
 * reading 0 while a step still baked in real, strategy-specific mechanics as
 * if every canonical strategy required them — e.g. "verify boundary break
 * and displacement, require a clean pullback/retest of flipped structure,
 * confirm...candle body closures, and verify relative strength" (retest
 * entry + candle-close confirmation + relative-strength confirmation are
 * NOT universal — several canonical strategies use direct entry, no retest,
 * no candle-close wait), and "Scale out partial profits at the initial
 * structural target (such as HOD/LOD or pre-market extremes) and trail
 * runners" (HOD/LOD-target scaling + trailing runners are real but scoped
 * intraday/momentum trade-management mechanics, not universal exit
 * behavior).
 *
 * Unlike playbookApplicabilityAudit.ts's DESCRIPTIVE_MIXED sections (which
 * legitimately mix several independently-qualified claims), EVERY
 * readableSteps entry is presented as one flat, unconditional walkthrough —
 * there is no per-step "policy" or "scope" to consult, so there is no
 * absolute-claim-language gate here the way there is for playbook prose
 * (mechanism A there requires "always"/"must"/etc.; a readable step asserts
 * its instruction unconditionally by its very presence in the list, with no
 * such marker word needed). A step is safe in exactly one of two ways: (1)
 * it doesn't significantly overlap any KNOWN SCOPED/UNVERIFIED rule at all
 * (it only ever describes genuinely global mechanics), or (2) it explicitly
 * DEFERS to the selected canonical strategy's own rules (DEFERRAL_PATTERN —
 * "the selected/chosen strategy's own...", "...only where that strategy
 * specifies them") rather than asserting a specific mechanic as if it held
 * for every strategy. Reuses the exact same lexical-overlap technique
 * (significantWords/bestOverlapMatch, OVERLAP_THRESHOLD=0.5) already proven
 * out in playbookApplicabilityAudit.ts, against the SAME
 * collectNonGlobalRuleDescriptions pool decisionFramework.ts already builds
 * for its prompt — no new NLP, no new data source, no decision-graph
 * redesign.
 */
const DEFERRAL_PATTERN =
  /\b(?:the\s+)?(?:selected|chosen)\s+(?:canonical\s+)?strateg\w*'?s?\s+own\b|\bthat\s+strategy\s+specifies\b|\baccording\s+to\s+the\s+(?:selected|chosen)\s+strategy\b/i;

export function findReadableStepScopeLeaks(readableSteps: string[], nonGlobalRules: TaggedNonGlobalRule[]): DecisionReadableStepLeak[] {
  const scopedRules = nonGlobalRules.filter((r) => r.basis === "SCOPED").map((r) => ({ description: r.description, words: significantWords(r.description) }));
  const unverifiedRules = nonGlobalRules.filter((r) => r.basis === "UNVERIFIED").map((r) => ({ description: r.description, words: significantWords(r.description) }));

  const leaks: DecisionReadableStepLeak[] = [];
  readableSteps.forEach((step, stepIndex) => {
    if (DEFERRAL_PATTERN.test(step)) return; // explicitly defers to the selected strategy's own rules — safe regardless of what it names.

    const stepWords = significantWords(step);
    const scopedMatch = bestOverlapMatch(stepWords, scopedRules);
    if (scopedMatch) {
      leaks.push({ stepIndex, step, reason: "scoped_mechanic", matchedNonGlobalRules: [scopedMatch.description] });
      return;
    }
    const unverifiedMatch = bestOverlapMatch(stepWords, unverifiedRules);
    if (unverifiedMatch) {
      leaks.push({ stepIndex, step, reason: "unverified_mechanic", matchedNonGlobalRules: [unverifiedMatch.description] });
    }
  });
  return leaks;
}
