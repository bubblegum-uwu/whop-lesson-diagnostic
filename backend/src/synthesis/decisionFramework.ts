import type { GeminiUsage } from "../gemini/client.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import { DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA, DecisionFrameworkSchema, type CanonicalStrategy, type CoreFramework, type DecisionFramework } from "./schema.js";

/**
 * Stage 6 — master decision framework. A structured step/decision graph
 * (never a single blended "super strategy") for which canonical strategy
 * applies and how to work through it, given HTF context, market regime,
 * and each strategy's own prerequisites/confirmation/no-trade conditions.
 * Structured as a small node graph (id/type/label/next|branches) so a
 * future flowchart view can render it directly — no diagramming library is
 * introduced here per scope.
 */
export async function synthesizeDecisionFramework(
  deps: SynthesisStageDeps,
  canonicalStrategies: CanonicalStrategy[],
  coreFramework: CoreFramework,
): Promise<{ decisionFramework: DecisionFramework; usage: GeminiUsage }> {
  const prompt = buildPrompt(canonicalStrategies, coreFramework);
  const { data, usage } = await callStructuredStage(
    deps,
    "decision_framework",
    prompt,
    DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
    DecisionFrameworkSchema,
  );
  return { decisionFramework: data, usage };
}

function buildPrompt(canonicalStrategies: CanonicalStrategy[], coreFramework: CoreFramework): string {
  const condensedStrategies = canonicalStrategies.map((s) => ({
    name: s.name,
    prerequisites: s.prerequisites.map((r) => r.description),
    confirmationRules: s.confirmationRules.map((r) => r.description),
    noTradeConditions: s.noTradeConditions.map((r) => r.description),
    riskManagementRules: s.riskManagementRules.map((r) => r.description),
    warnings: s.warnings.map((r) => r.description),
  }));

  return `You are building a master trade-decision framework for a course that teaches ${canonicalStrategies.length} distinct canonical strategies. Represent the decision process a trader follows: determine HTF context -> identify key levels -> determine market regime -> is a valid setup present -> which canonical strategy applies -> check prerequisites -> check confirmation -> check no-trade conditions -> define entry -> define invalidation/stop -> define target -> manage trade -> exit.

Canonical strategies (condensed):
${JSON.stringify(condensedStrategies, null, 2)}

Core framework sections:
${JSON.stringify(coreFramework, null, 2)}

CRITICAL: do NOT blend the strategies into one unified entry rule. The graph must branch to a distinct node/path per canonical strategy at the "which canonical strategy applies" decision point, each following that strategy's own prerequisites/confirmation/no-trade conditions from above. Only collapse to a single path if the material genuinely shows the instructor teaches one unified setup.

Produce a small node graph: each node has a unique "id", a "type" (start/decision/action/end), a "label", an optional "description", and either "next" (ordered array of next node ids for start/action nodes) or "branches" (array of {label, next} for decision nodes) — leave the unused one as an empty array. Also produce "readableSteps": a plain-text, numbered walkthrough of the same process as a fallback for when the graph isn't rendered visually.

Respond ONLY with JSON matching the required schema.`;
}
