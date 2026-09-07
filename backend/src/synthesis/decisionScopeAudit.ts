import type { DecisionFramework, DecisionNodeScopeLeak } from "./schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import { effectiveScopeBasis } from "./scopeBasis.js";

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
