import type { GeminiUsage } from "../gemini/client.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import type { StrategyInstanceRecord } from "./normalize.js";
import { CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA, CanonicalStrategySchema, type CanonicalStrategy, type ClusterProposal } from "./schema.js";

/**
 * Stage 3 — canonical strategy synthesis. One Gemini call per cluster,
 * given the FULL structured strategy_instance JSON for that cluster's
 * members (clusters are typically small, so this stays well within token
 * budget even though it's the richest input of any stage). Required to
 * preserve every original strategy name, record contradictions as a
 * variant/conditional rule/unresolved conflict rather than silently
 * resolving them, and never fabricate a compromise rule.
 */
export async function synthesizeCanonicalStrategy(
  deps: SynthesisStageDeps,
  cluster: ClusterProposal,
  members: StrategyInstanceRecord[],
): Promise<{ canonicalStrategy: CanonicalStrategy; usage: GeminiUsage }> {
  const prompt = buildPrompt(cluster, members);
  const { data, usage } = await callStructuredStage(
    deps,
    "canonical_strategy",
    prompt,
    CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
    CanonicalStrategySchema,
  );
  return { canonicalStrategy: data, usage };
}

function buildPrompt(cluster: ClusterProposal, members: StrategyInstanceRecord[]): string {
  const memberPayload = members.map((m) => ({
    strategyInstanceId: m.strategyInstanceId,
    lessonId: m.lessonId,
    lessonTitle: m.lessonTitle,
    originalStrategyName: m.strategyName,
    strategy: m.strategy,
  }));

  return `You are synthesizing ONE canonical trading strategy from multiple lesson instances of the same underlying strategy, previously clustered together as "${cluster.proposedCanonicalName}" (cluster rationale: ${cluster.similarityRationale}${cluster.differencesNotes ? `; noted differences: ${cluster.differencesNotes}` : ""}).

Every synthesized rule (in marketContext, prerequisites, setup, entryRules, confirmationRules, stopLossRules, profitTargetRules, tradeManagementRules, invalidationRules, noTradeConditions, visualDiscretionaryRules) MUST carry provenance: which lesson(s)/strategy instance(s) it comes from, via "sources" entries with lessonId/lessonTitle/strategyInstanceId/timestamps/evidence copied or adapted from the source rules below. Set "supportLevel" based on how many independent lessons actually support the rule (SINGLE_SOURCE, MULTI_SOURCE, REPEATED_EXPLICIT, VARIANT, CONFLICTING, or INFERRED) and "supportCount" to the number of supporting lessons — never invent a numeric confidence score.

CRITICAL — do not silently resolve contradictions. If one source says "enter immediately on retest" and another says "wait for candle confirmation", record this as EITHER a variant (variants[]), a conditional rule (a rule whose description states the condition), or an unresolved conflict (conflicts[], with supportLevel CONFLICTING on the relevant rule and both sides listed in conflictSources) — depending on what the evidence actually shows. Never fabricate a compromise rule that blends the two.

Preserve every member's original strategy name somewhere in the output (purpose text or variants). List every contributing lesson id in sourceLessonIds.

Source strategy instances:
${JSON.stringify(memberPayload, null, 2)}

Respond ONLY with JSON matching the required schema.`;
}
