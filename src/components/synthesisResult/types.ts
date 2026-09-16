/**
 * Phase 4M follow-up — Run History's output shapes, confirmed against
 * backend/src/http/routes/synthesisSetRuns.ts's getSynthesisSetRunOutput
 * handler and backend/src/synthesis/runSynthesis.ts's SynthesisResult:
 *
 *   LEGACY_WHOP result ≈ { title, coreFramework, playbook, decisionFramework }
 *   NATIVE result       ≈ { clusters: [{cluster, canonicalStrategy}], coreFramework, playbook, decisionFramework }
 *
 * coreFramework/playbook/decisionFramework are the exact same shared
 * synthesis types either run kind ever produces (see synthesisApi.ts) — the
 * only real divergence is `title` (legacy only) and `clusters` (native
 * only). `getSynthesisSetRunOutput` types `result` as `unknown` since the
 * backend never distinguishes it further; normalizeRunResult below is the
 * one place that turns it into something renderable, defensively, without
 * fabricating any field neither run kind actually returned.
 */
import type { CanonicalStrategy, CoreFramework, CoursePlaybook, DecisionFramework } from "../../lib/synthesisApi";

export interface RunClusterStrategy {
  canonicalStrategy: CanonicalStrategy;
}

export interface NormalizedRunResult {
  coreFramework: CoreFramework | null;
  playbook: CoursePlaybook | null;
  decisionFramework: DecisionFramework | null;
  /** NATIVE only — null for LEGACY_WHOP or when the field is absent/empty. */
  clusters: RunClusterStrategy[] | null;
}

function isRunClusterStrategy(value: unknown): value is RunClusterStrategy {
  return typeof value === "object" && value !== null && "canonicalStrategy" in value;
}

export function normalizeRunResult(raw: unknown): NormalizedRunResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawClusters = obj.clusters;
  return {
    coreFramework: (obj.coreFramework as CoreFramework | undefined) ?? null,
    playbook: (obj.playbook as CoursePlaybook | undefined) ?? null,
    decisionFramework: (obj.decisionFramework as DecisionFramework | undefined) ?? null,
    clusters: Array.isArray(rawClusters) && rawClusters.every(isRunClusterStrategy) && rawClusters.length > 0 ? (rawClusters as RunClusterStrategy[]) : null,
  };
}
