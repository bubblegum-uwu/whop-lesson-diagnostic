import type { DecisionFramework } from "./schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";

/**
 * Real-audit fix (Phase 3.5B, Blockers 4/5) — a deterministic safety net on
 * TOP OF (never instead of) the prompt/input fix in decisionFramework.ts.
 * A real 28-lesson dry run showed a genuinely scoped rule (a 9:30-11am
 * intraday/options-only execution window, pooled into the core framework
 * from a subset of lessons) turned into an UNCONDITIONAL global gate before
 * canonical-strategy selection — incorrectly constraining unrelated
 * daily/weekly Fibonacci and swing Inside-Bar strategies to a session they
 * have nothing to do with.
 *
 * This function detects that exact failure mode structurally: it walks the
 * "unconditional global spine" — every node reachable from a "start" node
 * purely via `next` (never through a `branches` fork, since a branch IS the
 * conditional decision point) — and flags any node on that spine whose
 * `scope` is actually restrictive (isKnowledgeItemScoped — the same
 * empty-arrays-means-global derivation used for KnowledgeItem, never a
 * separate GLOBAL/SCOPED label). Such a node is, by construction, binding on every path through `start`,
 * which is exactly what "global gate" means — a scoped rule has no business
 * being unconditionally binding.
 *
 * Deliberately a pure, read-only diagnostic — it does not rewrite or drop
 * the offending node (graph topology repair is not something that can be
 * done safely/generically without risking a different kind of corruption),
 * but its findings are safe to log, test against, and — a natural next
 * step outside this PR's scope — surface to a human reviewer before a
 * decision framework goes live.
 */
export interface GlobalGateScopeLeak {
  nodeId: string;
  label: string;
  scope: DecisionFramework["nodes"][number]["scope"];
}

export function findGlobalGateScopeLeaks(decisionFramework: DecisionFramework): GlobalGateScopeLeak[] {
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
    // spine and are correctly allowed to carry a scope.
    if (node.branches.length === 0) {
      for (const nextId of node.next) queue.push(nextId);
    }
  }

  const leaks: GlobalGateScopeLeak[] = [];
  for (const id of spine) {
    const node = byId.get(id);
    if (!node) continue;
    if (isKnowledgeItemScoped(node.scope)) {
      leaks.push({ nodeId: node.id, label: node.label, scope: node.scope });
    }
  }
  return leaks;
}
