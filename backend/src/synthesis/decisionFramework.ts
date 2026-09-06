import type { GeminiUsage } from "../gemini/client.js";
import type { KnowledgeItemScope } from "../gemini/schema.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import { findGlobalGateScopeLeaks } from "./decisionScopeAudit.js";
import { DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA, DecisionFrameworkSchema, type CanonicalStrategy, type CoreFramework, type DecisionFramework } from "./schema.js";

/**
 * Stage 6 — master decision framework. A structured step/decision graph
 * (never a single blended "super strategy") for which canonical strategy
 * applies and how to work through it, given HTF context, market regime,
 * and each strategy's own prerequisites/confirmation/no-trade conditions.
 * Structured as a small node graph (id/type/label/next|branches) so a
 * future flowchart view can render it directly — no diagramming library is
 * introduced here per scope.
 *
 * Real-audit fix (Phase 3.5B, Blockers 4/5): a real 28-lesson dry run
 * showed genuinely SCOPED core-framework rules (e.g. a 9:30-11am
 * intraday/options-only execution window; scaling/runner-management
 * percentages that were never universal) turned into unconditional GLOBAL
 * gates and mandatory trade-management nodes for every canonical strategy
 * — incorrectly constraining daily/weekly Fibonacci and swing Inside-Bar
 * strategies to rules that never applied to them. Fixed at the root:
 * global (scope===null) and scoped (scope!==null) core-framework rules are
 * now sent to Gemini as two EXPLICITLY LABELED, separate pools (never one
 * blended `coreFramework` dump), with the prompt making clear that ONLY
 * the global pool may become an unconditional gate. A deterministic
 * post-check (decisionScopeAudit.ts) then verifies the returned graph
 * never places a scoped node on the unconditional path before strategy
 * selection.
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
  // Deterministic, computed AFTER validation — never asked of or trusted
  // from Gemini (see schema.ts's DecisionFrameworkSchema doc comment).
  const decisionFramework: DecisionFramework = { ...data, scopeLeaks: findGlobalGateScopeLeaks(data) };
  return { decisionFramework, usage };
}

interface CondensedRule {
  description: string;
  scope: KnowledgeItemScope | null;
}

interface ScopedFrameworkSection {
  title: string;
  rules: CondensedRule[];
}

/**
 * Splits coreFramework's pooled rules into two disjoint pools by their
 * already-known, deterministically-attached `scope` (see
 * canonicalStrategy.ts/coreFramework.ts's enrichment — scope is NEVER
 * asked of Gemini for a SynthesizedRule, only derived from cited sources).
 * This split itself is 100% deterministic; only how Gemini USES the two
 * pools in the prompt below is left to the model.
 */
function splitFrameworkByScope(coreFramework: CoreFramework): { global: ScopedFrameworkSection[]; scoped: ScopedFrameworkSection[] } {
  const global: ScopedFrameworkSection[] = [];
  const scoped: ScopedFrameworkSection[] = [];
  for (const section of coreFramework.sections) {
    const globalRules = section.rules.filter((r) => r.scope == null).map((r): CondensedRule => ({ description: r.description, scope: null }));
    const scopedRules = section.rules.filter((r) => r.scope != null).map((r): CondensedRule => ({ description: r.description, scope: r.scope }));
    if (globalRules.length > 0) global.push({ title: section.title, rules: globalRules });
    if (scopedRules.length > 0) scoped.push({ title: section.title, rules: scopedRules });
  }
  return { global, scoped };
}

function buildPrompt(canonicalStrategies: CanonicalStrategy[], coreFramework: CoreFramework): string {
  const condensedStrategies = canonicalStrategies.map((s) => ({
    name: s.name,
    // Real-audit fix: scope is preserved (never stripped to a bare
    // description string) so Gemini can tell a strategy-wide rule apart
    // from one that's further restricted (e.g. a sizing rule that only
    // applies to "beginner" trader profiles within this one strategy) —
    // the same conditional-application principle applies WITHIN a
    // strategy's own rules, not just across strategies.
    prerequisites: s.prerequisites.map((r): CondensedRule => ({ description: r.description, scope: r.scope })),
    confirmationRules: s.confirmationRules.map((r): CondensedRule => ({ description: r.description, scope: r.scope })),
    noTradeConditions: s.noTradeConditions.map((r): CondensedRule => ({ description: r.description, scope: r.scope })),
    riskManagementRules: s.riskManagementRules.map((r): CondensedRule => ({ description: r.description, scope: r.scope })),
    scalingInRules: s.scalingInRules.map((r): CondensedRule => ({ description: r.description, scope: r.scope })),
    scalingOutRules: s.scalingOutRules.map((r): CondensedRule => ({ description: r.description, scope: r.scope })),
    runnerManagementRules: s.runnerManagementRules.map((r): CondensedRule => ({ description: r.description, scope: r.scope })),
    warnings: s.warnings.map((r): CondensedRule => ({ description: r.description, scope: r.scope })),
  }));

  const { global: globalFrameworkRules, scoped: scopedFrameworkRules } = splitFrameworkByScope(coreFramework);

  return `You are building a master trade-decision framework for a course that teaches ${canonicalStrategies.length} distinct canonical strategies. Represent the decision process a trader follows: determine HTF context -> identify key levels -> determine market regime -> is a valid setup present -> which canonical strategy applies -> check prerequisites -> check confirmation -> check no-trade conditions -> define entry -> define invalidation/stop -> define target -> manage trade -> exit.

Canonical strategies (condensed) — each rule below carries its own "scope": null means it applies to every trader/context using this strategy; a non-null scope (e.g. {"traderProfiles": ["beginner"]}) means it applies ONLY within that restriction, even though it's listed under this one strategy:
${JSON.stringify(condensedStrategies, null, 2)}

GLOBAL course-wide framework rules — "scope" is always null here; these are the ONLY rules that may become an unconditional global gate applied before strategy selection:
${JSON.stringify(globalFrameworkRules, null, 2)}

SCOPED course-wide framework rules — each one carries a non-null "scope" (instrument/timeframe/session/trader-profile/strategy restriction). These are real, useful rules, but they are NEVER globally applicable — a rule scoped to {"sessions": ["market-open"], "marketsOrInstruments": ["options"]} applies ONLY within that specific context, never to every strategy or every session:
${JSON.stringify(scopedFrameworkRules, null, 2)}

CRITICAL — GLOBAL GATES vs SCOPED RULES (this is the most important instruction in this prompt): A "global gate" is any node placed on the unconditional path BEFORE the "which canonical strategy applies" decision point (i.e. reachable via "next" alone, with no "branches" fork in between). Global gates may be built ONLY from the GLOBAL framework rules above. A rule from the SCOPED pool (or a strategy's own scoped sub-rule) must NEVER become a global gate — it may only appear on a decision path AFTER the point where its specific instrument/timeframe/session/trader-profile/strategy context has actually been established (e.g. inside a specific strategy's own branch, or behind an explicit branch node like "Is this a 0-DTE options trade?"). For EVERY node you create, set its own "scope" object (strategies/marketsOrInstruments/timeframes/sessions/traderProfiles, each an array — ALL EMPTY for a genuinely global rule/gate, populated with the actual restriction otherwise) reflecting the scope of the rule it is built from — this is validated afterward, so an inaccurate scope tag will be caught. A real past failure: a rule scoped to "9:30-11:00 AM, intraday, options only" was incorrectly turned into an unconditional global gate, which would have wrongly blocked an unrelated daily/weekly Fibonacci strategy or a swing Inside-Bar strategy that has nothing to do with that session/instrument/timeframe. Do not repeat that mistake with scaling percentages, runner-management rules, order-block trailing rules, or any other scoped material — these belong inside the specific strategy path(s) they actually apply to, conditioned on their scope, never as a mandatory step for every strategy.

CRITICAL: do NOT blend the strategies into one unified entry rule. The graph must branch to a distinct node/path per canonical strategy at the "which canonical strategy applies" decision point, each following that strategy's own prerequisites/confirmation/no-trade conditions from above. Only collapse to a single path if the material genuinely shows the instructor teaches one unified setup.

Produce a small node graph: each node has a unique "id", a "type" (start/decision/action/end), a "label", an optional "description", a required "scope" object (see above — all arrays empty for global, populated for a conditioned node), and either "next" (ordered array of next node ids for start/action nodes) or "branches" (array of {label, next} for decision nodes) — leave the unused one as an empty array. Also produce "readableSteps": a plain-text, numbered walkthrough of the same process as a fallback for when the graph isn't rendered visually.

Respond ONLY with JSON matching the required schema.`;
}
