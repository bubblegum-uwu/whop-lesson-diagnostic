import type { ClusterProposal } from "./schema.js";
import type { StrategySignature } from "./normalize.js";

/**
 * Real-audit fix (Phase 3.5B v5, Blocker 1) — a real dry run showed
 * clustering is NOT stable across identical input: Gemini merged
 * strategyInstanceId 11 (a foundational horizontal Break & Retest) and 19
 * (a Top-Down Multi-Timeframe Break & Retest) into one cluster in one run,
 * producing 15 canonical strategies where a previous, otherwise-identical
 * run kept them separate and produced 16. This is a genuine, semantically
 * arguable model judgment call — but canonical identity must never depend
 * on a single Gemini call's mood over unchanged source data.
 *
 * This is a deterministic, structural SAFETY NET applied AFTER Gemini's
 * own clustering (never instead of it — Gemini's semantic read is still
 * what forms clusters in the first place; this only ever reverses an
 * over-merge, never invents a merge Gemini didn't already propose —
 * under-merging into more, smaller clusters is a far safer failure mode
 * than silently collapsing two materially different setups into one).
 *
 * A cluster's members are split apart the moment a pair among them shows
 * BOTH of the following, each itself deterministic from the already-known
 * StrategySignature (never from prose/names):
 *
 *   (a) a TIMEFRAME-HIERARCHY mismatch — one member trades a single
 *   timeframe while the other explicitly layers multiple (e.g. a Top-Down
 *   variant adding mandatory HTF context on top of an LTF execution
 *   timeframe). A single-timeframe substitution (1-minute vs. 5-minute)
 *   never triggers this on its own.
 *
 *   (b) a RULE-SHAPE divergence — their rule-category counts (setup,
 *   entry, confirmation, stop, invalidation, etc.) differ materially
 *   across at least two distinct categories, not merely a single
 *   off-by-one count (ordinary lesson-to-lesson wording variance, not a
 *   different strategy).
 *
 * Requiring BOTH signals at once is deliberate: either alone is common,
 * harmless variation (a faster ORB timeframe; one extra confirmation rule
 * one instructor happened to mention) — see the regression cases below.
 * Neither this file nor its caller ever hard-codes an expected cluster
 * count; the guard is purely a function of structural signatures.
 *
 * Regression cases this is built to get right:
 *   - 1-minute ORB vs. a 5-minute "systematic" ORB variant: both trade a
 *     SINGLE timeframe (signal (a) never fires) and share essentially the
 *     same rule shape -> stays merged.
 *   - Foundational horizontal Break & Retest vs. Top-Down Multi-Timeframe
 *     Break & Retest: the latter genuinely adds a multi-timeframe
 *     hierarchy AND a materially different rule shape (more mandatory
 *     context/confirmation steps) -> split apart even if Gemini merged
 *     them.
 *
 * Real-audit fix (v7) — a SIXTH real dry run showed the rule-shape signal
 * above missed the EXACT case it was built for: the real production
 * foundational-B&R/Top-Down-B&R pair (strategyInstanceIds 11/19) merged
 * again, producing 15 clusters instead of 16, because their real rule-count
 * differences are spread THINLY across several categories (a Top-Down
 * variant's extra mandatory steps land as +1 each in setup/confirmation/
 * market-context/trade-management, say) rather than CONCENTRATED as a
 * >=2-count jump in two categories the way the original synthetic test
 * fixture modeled it. `hasRuleShapeDivergence` required BOTH "a category
 * differs by >=2" AND "at least 2 such categories" simultaneously — a
 * single combined bar tuned to the concentrated case, with no way to
 * recognize a genuinely different rule shape whose evidence is distributed
 * instead of concentrated.
 *
 * Fix: OR in a second, independent way to detect divergence — unchanged
 * concentrated-jump detection (still catches the original case exactly as
 * before, so nothing already correct regresses) PLUS a normalized
 * total-divergence-ratio check requiring BOTH breadth (rule counts moved in
 * several distinct categories, not just one off-by-one outlier — the
 * original design's own stated tolerance for isolated noise is preserved)
 * AND a minimum total-magnitude-relative-to-total-rule-volume ratio (so two
 * strategies with a large total rule count and one stray +1 somewhere don't
 * false-positive). Still purely a function of the already-known
 * StrategySignature's ruleCounts — no new data, no text/prose, no
 * hard-coded IDs, names, or counts.
 */

const RULE_COUNT_CATEGORIES = [
  "setup_conditions",
  "entry_rules",
  "confirmation_rules",
  "stop_loss_rules",
  "profit_target_rules",
  "trade_management_rules",
  "invalidation_rules",
  "no_trade_conditions",
  "market_context_rules",
  "visual_discretionary_rules",
] as const;

/** A rule-category count difference below this is ordinary lesson-to-lesson noise, not a different rule shape (CONCENTRATED divergence branch). */
const MATERIAL_COUNT_DIFFERENCE = 2;
/** How many distinct rule categories must clear that bar before the pair's OVERALL shape (not just one category) counts as materially different (CONCENTRATED divergence branch). */
const MIN_DIVERGENT_CATEGORIES = 2;
/** How many distinct rule categories must move AT ALL before smaller, thinly-spread differences count as a real shape change (DISTRIBUTED divergence branch) — kept higher than MIN_DIVERGENT_CATEGORIES since each individual category's move no longer has to clear MATERIAL_COUNT_DIFFERENCE on its own, so more of them must move to rule out isolated single-category noise. */
const MIN_DISTRIBUTED_CATEGORIES = 3;
/** Total |diff| across all categories, as a fraction of total rule volume (both instances' counts summed), required before distributed movement counts as material — guards against a large-rule-count pair flagged by a handful of unrelated +1s that are proportionally still noise. */
const DISTRIBUTED_DIVERGENCE_RATIO = 0.15;

function hasTimeframeHierarchyMismatch(a: StrategySignature, b: StrategySignature): boolean {
  const aIsHierarchy = a.timeframes.length >= 2;
  const bIsHierarchy = b.timeframes.length >= 2;
  return aIsHierarchy !== bIsHierarchy;
}

function hasRuleShapeDivergence(a: StrategySignature, b: StrategySignature): boolean {
  let concentratedCategories = 0;
  let movedCategories = 0;
  let totalDiff = 0;
  let totalVolume = 0;
  for (const category of RULE_COUNT_CATEGORIES) {
    const countA = a.ruleCounts[category] ?? 0;
    const countB = b.ruleCounts[category] ?? 0;
    const diff = Math.abs(countA - countB);
    totalDiff += diff;
    totalVolume += countA + countB;
    if (diff >= MATERIAL_COUNT_DIFFERENCE) concentratedCategories++;
    if (diff > 0) movedCategories++;
  }

  const concentratedDivergence = concentratedCategories >= MIN_DIVERGENT_CATEGORIES;
  const distributedDivergence = totalVolume > 0 && movedCategories >= MIN_DISTRIBUTED_CATEGORIES && totalDiff / totalVolume >= DISTRIBUTED_DIVERGENCE_RATIO;
  return concentratedDivergence || distributedDivergence;
}

function isMateriallyDifferent(a: StrategySignature, b: StrategySignature): boolean {
  return hasTimeframeHierarchyMismatch(a, b) && hasRuleShapeDivergence(a, b);
}

/**
 * Union-find over one cluster's members: two members start unioned apart
 * and are only merged back together when they are NOT materially
 * different (single-linkage — deliberately conservative, matching this
 * codebase's stated preference for splitting over over-merging whenever
 * uncertain). A missing signature never blocks a union — the guard only
 * acts on data it actually has.
 */
function partitionByStructure(memberIds: number[], byId: Map<number, StrategySignature>): number[][] {
  const parent = new Map<number, number>(memberIds.map((id) => [id, id]));
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = id;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < memberIds.length; i++) {
    for (let j = i + 1; j < memberIds.length; j++) {
      const sigA = byId.get(memberIds[i]);
      const sigB = byId.get(memberIds[j]);
      if (!sigA || !sigB) continue;
      if (!isMateriallyDifferent(sigA, sigB)) union(memberIds[i], memberIds[j]);
    }
  }

  const groups = new Map<number, number[]>();
  for (const id of memberIds) {
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }
  return [...groups.values()];
}

export function applyClusterMergeGuard(clusters: ClusterProposal[], signatures: StrategySignature[]): ClusterProposal[] {
  const byId = new Map(signatures.map((s) => [s.strategyInstanceId, s]));
  const result: ClusterProposal[] = [];

  for (const cluster of clusters) {
    if (cluster.memberInstanceIds.length <= 1) {
      result.push(cluster);
      continue;
    }

    const groups = partitionByStructure(cluster.memberInstanceIds, byId);
    if (groups.length === 1) {
      result.push(cluster); // no over-merge detected — pass through unchanged
      continue;
    }

    groups.forEach((group, index) => {
      const singletonName = group.length === 1 ? byId.get(group[0])?.originalName : undefined;
      result.push({
        clusterKey: `${cluster.clusterKey}-split-${index + 1}`,
        proposedCanonicalName: singletonName ?? cluster.proposedCanonicalName,
        memberInstanceIds: group,
        similarityRationale:
          group.length > 1
            ? cluster.similarityRationale
            : `Deterministic post-clustering merge guard split this instance out of "${cluster.proposedCanonicalName}" — its timeframe hierarchy and rule shape diverge materially from the rest of that cluster, so canonical identity cannot depend on a single Gemini call's judgment.`,
        differencesNotes: cluster.differencesNotes,
      });
    });
  }

  return result;
}
