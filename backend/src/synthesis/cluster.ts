import type { GeminiUsage } from "../gemini/client.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import { chunkSignatures, type StrategySignature } from "./normalize.js";
import { CLUSTER_BATCH_RESPONSE_JSON_SCHEMA, CLUSTER_MERGE_RESPONSE_JSON_SCHEMA, ClusterBatchResultSchema, type ClusterProposal } from "./schema.js";

/**
 * Stage 2 — clustering. Map-reduce: one Gemini call per chunk of strategy
 * signatures (never splitting one instance across chunks — see
 * normalize.ts chunkSignatures), then, only if there was more than one
 * chunk, a single reduce call reconciling the per-chunk proposals into one
 * final cluster set. A single-chunk course (the common case) skips the
 * reduce call entirely — nothing to merge.
 *
 * Compares actual structured attributes (markets, timeframes, indicators,
 * rule-category shape), never strategy name alone, and is explicitly
 * instructed to prefer splitting an uncertain group over merging unrelated
 * strategies. Any instance Gemini fails to place in a cluster (should be
 * rare) falls back to its own singleton cluster in code — no strategy
 * instance is ever silently dropped from the result.
 */
export async function clusterStrategyInstances(
  deps: SynthesisStageDeps,
  signatures: StrategySignature[],
  /** Test-only override — production always uses chunkSignatures' default budget. */
  maxEstimatedTokensPerChunk?: number,
): Promise<{ clusters: ClusterProposal[]; usages: GeminiUsage[] }> {
  if (signatures.length === 0) return { clusters: [], usages: [] };

  const chunks = chunkSignatures(signatures, maxEstimatedTokensPerChunk);
  const usages: GeminiUsage[] = [];
  const chunkResults: ClusterProposal[][] = [];

  for (const chunk of chunks) {
    const prompt = buildChunkClusterPrompt(chunk);
    const { data, usage } = await callStructuredStage(
      deps,
      "cluster_chunk",
      prompt,
      CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
      ClusterBatchResultSchema,
    );
    usages.push(usage);
    chunkResults.push(data.clusters);
  }

  let clusters: ClusterProposal[];
  if (chunkResults.length <= 1) {
    clusters = chunkResults[0] ?? [];
  } else {
    const prompt = buildMergePrompt(signatures, chunkResults.flat());
    const { data, usage } = await callStructuredStage(
      deps,
      "cluster_merge",
      prompt,
      CLUSTER_MERGE_RESPONSE_JSON_SCHEMA,
      ClusterBatchResultSchema,
    );
    usages.push(usage);
    clusters = data.clusters;
  }

  return { clusters: fillOrphans(clusters, signatures), usages };
}

function buildChunkClusterPrompt(chunk: StrategySignature[]): string {
  return `You are clustering trading-strategy instances extracted from different lesson videos in the same course into groups that teach the SAME underlying strategy (allowing for naming differences and minor variations).

Compare the actual structured attributes below (markets, timeframes, indicators, entry-rule summary, rule-category counts) — NEVER the strategy name alone. Two instances with similar names but materially different setups are NOT the same cluster. Prefer creating more, smaller, uncertain clusters over forcing unrelated strategies together — splitting is always safer than over-merging.

Every "memberInstanceIds" value must be one of the strategyInstanceId values below. Every instance below must appear in exactly one cluster.

Strategy instances:
${JSON.stringify(chunk, null, 2)}

Respond ONLY with JSON matching the required schema.`;
}

function buildMergePrompt(allSignatures: StrategySignature[], chunkProposals: ClusterProposal[]): string {
  return `You previously clustered trading-strategy instances in separate batches. Some batches may have created separate clusters for what is actually the same underlying strategy (or, conversely, may have already correctly kept different strategies apart). Merge and reconcile these into ONE final, non-overlapping cluster list.

Use the original instance attributes below to verify any merge is actually justified by shared structural attributes, not just similar names. Prefer keeping clusters split when genuinely uncertain.

Every "memberInstanceIds" value must be one of the strategyInstanceId values below. Every instance below must appear in exactly one final cluster.

Original strategy instances:
${JSON.stringify(allSignatures, null, 2)}

Per-batch cluster proposals to merge:
${JSON.stringify(chunkProposals, null, 2)}

Respond ONLY with JSON matching the required schema.`;
}

/** Any instance Gemini didn't place anywhere becomes its own singleton cluster — never silently dropped. */
function fillOrphans(clusters: ClusterProposal[], signatures: StrategySignature[]): ClusterProposal[] {
  const placed = new Set(clusters.flatMap((c) => c.memberInstanceIds));
  const orphans = signatures.filter((s) => !placed.has(s.strategyInstanceId));
  if (orphans.length === 0) return clusters;

  const orphanClusters: ClusterProposal[] = orphans.map((s) => ({
    clusterKey: s.normalizedName.replace(/\s+/g, "-"),
    proposedCanonicalName: s.originalName,
    memberInstanceIds: [s.strategyInstanceId],
    similarityRationale: "Single instance — no similar strategy was clustered with it elsewhere in the course.",
    differencesNotes: "",
  }));
  return [...clusters, ...orphanClusters];
}
