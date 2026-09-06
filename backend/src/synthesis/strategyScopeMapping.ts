import { z } from "zod";
import type { GeminiUsage } from "../gemini/client.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import type { ClusterProposal } from "./schema.js";
import type { StrategyInstanceRecord } from "./normalize.js";

/**
 * Phase 3.5B — maps a raw strategy name referenced by a KnowledgeItem's
 * `scope.strategies` (e.g. "B&R", "Break and Retest", "Premarket Break and
 * Retest") to the canonical strategy CLUSTER it actually belongs to,
 * WITHOUT re-deriving clustering itself: clusters already exist by the time
 * this runs (Stage 2 output). Deterministic normalized/substring matching
 * first — a Gemini call is used ONLY for names deterministic matching could
 * not confidently place, and only once per run (batched), never per item.
 * A name Gemini also can't confidently place is never dropped: it comes
 * back as `unmatchedNames` for the caller to preserve diagnostically (see
 * runSynthesis.ts's unmatched-strategy-scoped-knowledge section) — an
 * uncertain mapping is worse than an honest "could not place this."
 */
export interface ClusterCandidate {
  clusterKey: string;
  proposedCanonicalName: string;
  /** Original (non-normalized) strategy names of every instance in this cluster. */
  memberNames: string[];
}

export function buildClusterCandidates(clusters: ClusterProposal[], instances: StrategyInstanceRecord[]): ClusterCandidate[] {
  const instancesById = new Map(instances.map((i) => [i.strategyInstanceId, i]));
  return clusters.map((cluster) => ({
    clusterKey: cluster.clusterKey,
    proposedCanonicalName: cluster.proposedCanonicalName,
    memberNames: cluster.memberInstanceIds
      .map((id) => instancesById.get(id)?.strategyName)
      .filter((n): n is string => n != null),
  }));
}

/** Lowercase, punctuation-insensitive, whitespace-collapsed — deliberately aggressive so "Break & Retest" / "Break and Retest" / "break-and-retest" all normalize identically. */
function normalizeForMatching(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ScopeMappingResult {
  /** raw scope name -> the clusterKey it was matched to. */
  mapped: Map<string, string>;
  /** raw scope names that could not be confidently matched, deterministically or via Gemini — preserve, never drop. */
  unmatchedNames: string[];
}

/**
 * Tier 1 — deterministic only. Exact normalized-name match against a
 * cluster's proposed canonical name or any member's original strategy name;
 * failing that, a containment match (one normalized string fully contains
 * the other) guarded by a minimum length so short/generic fragments (e.g.
 * "the", "setup") can't spuriously match everything. An initialism like
 * "B&R" will NOT match "Break and Retest" deterministically (there's no
 * reliable general rule for that) — it falls through to the Gemini tier.
 */
export function deterministicMapScopeNames(rawNames: string[], clusters: ClusterCandidate[]): ScopeMappingResult {
  const mapped = new Map<string, string>();
  const unmatched: string[] = [];

  const clustersWithNorm = clusters.map((c) => ({
    clusterKey: c.clusterKey,
    candidates: [c.proposedCanonicalName, ...c.memberNames].map(normalizeForMatching).filter((n) => n.length > 0),
  }));

  for (const raw of rawNames) {
    const norm = normalizeForMatching(raw);
    let matchedKey: string | null = null;
    if (norm.length >= 3) {
      for (const cluster of clustersWithNorm) {
        const isMatch = cluster.candidates.some((c) => c === norm || (c.length >= 4 && (c.includes(norm) || norm.includes(c))));
        if (isMatch) {
          matchedKey = cluster.clusterKey;
          break;
        }
      }
    }
    if (matchedKey) mapped.set(raw, matchedKey);
    else unmatched.push(raw);
  }

  return { mapped, unmatchedNames: unmatched };
}

// ---- Tier 2 — Gemini fallback, only for names Tier 1 could not place -----

export const ScopeMappingProposalSchema = z.object({
  rawName: z.string().min(1),
  /** A clusterKey from the candidate list, or null if this name genuinely does not match any of them. */
  clusterKey: z.string().nullable(),
});

export const ScopeMappingResultSchema = z.object({
  mappings: z.array(ScopeMappingProposalSchema),
});
export type ScopeMappingGeminiResult = z.infer<typeof ScopeMappingResultSchema>;

export const SCOPE_MAPPING_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    mappings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rawName: { type: "string" },
          clusterKey: { type: ["string", "null"] },
        },
        required: ["rawName", "clusterKey"],
      },
    },
  },
  required: ["mappings"],
};

function buildScopeMappingPrompt(unmatchedNames: string[], clusters: ClusterCandidate[]): string {
  const candidateList = clusters.map((c) => ({ clusterKey: c.clusterKey, canonicalName: c.proposedCanonicalName, aliases: c.memberNames }));
  return `You are matching strategy names referenced elsewhere in a trading course (e.g. as an abbreviation, alias, or informal name) to the canonical strategy clusters they actually refer to.

Canonical strategy clusters (match against "canonicalName" or any of "aliases"):
${JSON.stringify(candidateList, null, 2)}

Names to match — each is a strategy name mentioned in course material that a deterministic normalizer could NOT confidently place (e.g. an initialism like "B&R" for "Break and Retest"):
${JSON.stringify(unmatchedNames, null, 2)}

For each name, return its "clusterKey" if it genuinely refers to one of the clusters above, or null if it does not confidently match any of them (a different, unlisted strategy; too vague; or you are not reasonably confident). Do NOT guess a plausible-sounding match — a null is far better than a wrong mapping that would misattribute knowledge to the wrong strategy.

Respond ONLY with JSON matching the required schema.`;
}

/** Tier 2 — one batched Gemini call for every name Tier 1 couldn't place. Skipped entirely (no call) when there's nothing left to resolve. */
export async function mapScopeNamesWithGemini(
  deps: SynthesisStageDeps,
  unmatchedNames: string[],
  clusters: ClusterCandidate[],
): Promise<{ result: ScopeMappingGeminiResult; usage: GeminiUsage } | null> {
  if (unmatchedNames.length === 0 || clusters.length === 0) return null;
  const prompt = buildScopeMappingPrompt(unmatchedNames, clusters);
  const { data, usage } = await callStructuredStage(deps, "strategy_scope_mapping", prompt, SCOPE_MAPPING_RESPONSE_JSON_SCHEMA, ScopeMappingResultSchema);
  return { result: data, usage };
}

/**
 * Full two-tier resolution: deterministic first, Gemini fallback only for
 * what's left, never dropping a name that can't be placed either way.
 * Returns usage=null when the Gemini tier was never invoked (nothing left
 * to resolve after Tier 1, or no clusters exist at all).
 */
export async function resolveStrategyScopeNames(
  deps: SynthesisStageDeps,
  rawNames: string[],
  clusters: ClusterCandidate[],
): Promise<{ result: ScopeMappingResult; usage: GeminiUsage | null }> {
  const tier1 = deterministicMapScopeNames(rawNames, clusters);
  const geminiOutcome = await mapScopeNamesWithGemini(deps, tier1.unmatchedNames, clusters);
  if (!geminiOutcome) return { result: tier1, usage: null };

  const mapped = new Map(tier1.mapped);
  const stillUnmatched: string[] = [];
  const validClusterKeys = new Set(clusters.map((c) => c.clusterKey));
  for (const proposal of geminiOutcome.result.mappings) {
    if (proposal.clusterKey && validClusterKeys.has(proposal.clusterKey)) {
      mapped.set(proposal.rawName, proposal.clusterKey);
    } else {
      stillUnmatched.push(proposal.rawName);
    }
  }
  // Any name Gemini never mentioned at all (should be rare) stays unmatched too — never silently dropped.
  for (const name of tier1.unmatchedNames) {
    if (!mapped.has(name) && !stillUnmatched.includes(name)) stillUnmatched.push(name);
  }

  return { result: { mapped, unmatchedNames: stillUnmatched }, usage: geminiOutcome.usage };
}
