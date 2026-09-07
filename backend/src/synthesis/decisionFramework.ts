import type { GeminiUsage } from "../gemini/client.js";
import type { KnowledgeItemScope } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import { callGeminiForStage, parseStageJson, validateStageData, type SynthesisStageDeps } from "./geminiStage.js";
import { findGlobalGateScopeLeaks } from "./decisionScopeAudit.js";
import { unionScope, effectiveScopeBasis, type ScopeBasis } from "./scopeBasis.js";
import {
  RAW_DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  RawDecisionFrameworkSchema,
  DecisionFrameworkSchema,
  type CanonicalStrategy,
  type CoreFramework,
  type DecisionFramework,
  type DecisionNode,
  type RawDecisionNode,
} from "./schema.js";

const STAGE = "decision_framework";
const EMPTY_SCOPE: KnowledgeItemScope = { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] };

/**
 * Stage 6 — master decision framework. A structured step/decision graph
 * (never a single blended "super strategy") for which canonical strategy
 * applies and how to work through it, given HTF context, market regime,
 * and each strategy's own prerequisites/confirmation/no-trade conditions.
 * Structured as a small node graph (id/type/label/next|branches) so a
 * future flowchart view can render it directly — no diagramming library is
 * introduced here per scope.
 *
 * Real-audit fix (Phase 3.5B v3, Blockers A/C/D): a SECOND real dry run
 * showed the v2 fix (Gemini self-reports each node's `scope`) was itself
 * unreliable — a stock/equity-specific "Is Stock In Play?" gate was placed
 * before strategy selection with EMPTY self-reported scope (a false
 * negative), and a "minimum 2R target" decision node disagreed with the
 * scoped CoreFramework rule it was clearly built from. Root cause: asking
 * Gemini to self-report scope is the same mistake this codebase already
 * fixed once for SynthesizedRule. Fixed the same way: Gemini now cites
 * `sourceKeys` — which pooled rule(s) (see buildDecisionSourcePool) a node
 * is built from — and `scope` is derived deterministically as the union of
 * those rules' own already-known scope. A node citing nothing is no longer
 * assumed global (see decisionScopeAudit.ts's "ungrounded" check).
 */
export async function synthesizeDecisionFramework(
  deps: SynthesisStageDeps,
  canonicalStrategies: CanonicalStrategy[],
  coreFramework: CoreFramework,
): Promise<{ decisionFramework: DecisionFramework; usage: GeminiUsage }> {
  const { promptEntries, byKey } = buildDecisionSourcePool(canonicalStrategies, coreFramework);
  const prompt = buildPrompt(canonicalStrategies, promptEntries);
  const { rawText, usage, diagnostics } = await callGeminiForStage(deps, STAGE, prompt, RAW_DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA);
  const parsed = parseStageJson(STAGE, rawText, diagnostics);
  const raw = validateStageData(STAGE, parsed, RawDecisionFrameworkSchema);

  const nodes: DecisionNode[] = raw.nodes.map((n) => enrichNode(n, byKey));
  const scopeLeaks = findGlobalGateScopeLeaks({ nodes, readableSteps: raw.readableSteps, scopeLeaks: [] });

  const decisionFramework = validateStageData(STAGE, { nodes, readableSteps: raw.readableSteps, scopeLeaks }, DecisionFrameworkSchema);
  return { decisionFramework, usage };
}

interface DecisionSourceEntry {
  key: string;
  description: string;
  scope: KnowledgeItemScope;
  /** Real-audit fix (Phase 3.5B v4) — see scopeBasis.ts. Read from the CoreFramework/canonical-strategy rule's own already-computed scopeBasis (via effectiveScopeBasis, so a rule that predates this field still falls back to the old null-scope-means-global convention). */
  scopeBasis: ScopeBasis;
}

/** Every canonical-strategy rule category a decision node could plausibly be built from. Deliberately excludes `marketContext` (course-wide, already pooled via coreFramework) to avoid double-keying the same conceptual rule twice under two different pools. Exported so frameworkScopeSplit.ts's collectNonGlobalRuleDescriptions can iterate the exact same set without a second, potentially-drifting copy. */
export const STRATEGY_RULE_CATEGORIES = [
  "prerequisites",
  "setup",
  "entryRules",
  "confirmationRules",
  "stopLossRules",
  "profitTargetRules",
  "tradeManagementRules",
  "invalidationRules",
  "noTradeConditions",
  "visualDiscretionaryRules",
  "riskManagementRules",
  "positionSizingRules",
  "scalingInRules",
  "scalingOutRules",
  "runnerManagementRules",
  "warnings",
] as const satisfies readonly (keyof CanonicalStrategy)[];

/**
 * Real-audit fix (Phase 3.5B v3) — every rule a decision node could
 * conceivably be built from, each assigned a stable "k"-prefixed key. This
 * is what lets a node's applicability be validated deterministically from
 * data lineage (which rule(s) it actually cites) instead of trusting
 * Gemini's own self-reported scope, which a real audit showed can silently
 * disagree with (or simply omit) the underlying rule's true scope.
 */
function buildDecisionSourcePool(
  canonicalStrategies: CanonicalStrategy[],
  coreFramework: CoreFramework,
): { promptEntries: DecisionSourceEntry[]; byKey: Map<string, DecisionSourceEntry> } {
  const byKey = new Map<string, DecisionSourceEntry>();
  let counter = 0;
  const add = (description: string, scope: KnowledgeItemScope | null, scopeBasis: ScopeBasis | undefined) => {
    const key = `k${++counter}`;
    byKey.set(key, { key, description, scope: scope ?? EMPTY_SCOPE, scopeBasis: effectiveScopeBasis({ scope, scopeBasis }) });
  };

  for (const section of coreFramework.sections) {
    for (const rule of section.rules) add(rule.description, rule.scope, rule.scopeBasis);
  }
  for (const strategy of canonicalStrategies) {
    for (const category of STRATEGY_RULE_CATEGORIES) {
      for (const rule of strategy[category]) add(`[${strategy.name}] ${rule.description}`, rule.scope, rule.scopeBasis);
    }
  }

  return { promptEntries: [...byKey.values()], byKey };
}

/**
 * Real-audit fix (Phase 3.5B v4) — combines a node's cited entries'
 * scope/scopeBasis with the SAME priority scopeBasis.ts's aggregateScopeBasis
 * uses one layer downstream: a SCOPED citation dominates (its concrete
 * restriction is real and must survive); failing that, an UNVERIFIED
 * citation means the node's true applicability is NOT justified as global
 * even though the literal scope union is empty (this is what stops the
 * "Is Stock In Play?"-style false negative from resurfacing via an
 * UNVERIFIED CoreFramework rule instead of a self-reported one); only when
 * every citation is VERIFIED_GLOBAL does the node itself count as verified
 * global.
 */
function combineScopeBasis(entries: DecisionSourceEntry[]): { scope: KnowledgeItemScope; scopeBasis: ScopeBasis } {
  let scope = EMPTY_SCOPE;
  let sawUnverified = false;
  for (const entry of entries) {
    if (entry.scopeBasis === "SCOPED") {
      scope = unionScope(scope, entry.scope);
    } else if (entry.scopeBasis === "UNVERIFIED") {
      sawUnverified = true;
    }
  }
  if (isKnowledgeItemScoped(scope)) return { scope, scopeBasis: "SCOPED" };
  if (sawUnverified) return { scope, scopeBasis: "UNVERIFIED" };
  if (entries.length > 0) return { scope, scopeBasis: "VERIFIED_GLOBAL" };
  return { scope, scopeBasis: "UNVERIFIED" }; // zero valid citations — decisionScopeAudit's "ungrounded" check is what actually flags this case.
}

/**
 * Resolves a node's citations back to a validated key list (unknown/
 * invented keys dropped, never fabricated) and derives its scope/scopeBasis
 * as the combination of every cited rule's own scope/scopeBasis — this is
 * what makes a decision node's applicability provably consistent with the
 * structured rules it came from, closing the exact fidelity gap a real
 * audit found between a CoreFramework rule's scope and the decision node
 * built from it.
 */
function enrichNode(raw: RawDecisionNode, byKey: Map<string, DecisionSourceEntry>): DecisionNode {
  const validEntries: DecisionSourceEntry[] = [];
  for (const key of raw.sourceKeys) {
    const entry = byKey.get(key);
    if (entry) validEntries.push(entry);
  }
  const { scope, scopeBasis } = combineScopeBasis(validEntries);
  return {
    id: raw.id,
    type: raw.type,
    label: raw.label,
    description: raw.description,
    next: raw.next,
    branches: raw.branches,
    sourceKeys: validEntries.map((e) => e.key),
    scope,
    scopeBasis,
  };
}

function buildPrompt(canonicalStrategies: CanonicalStrategy[], promptEntries: DecisionSourceEntry[]): string {
  const strategyNames = canonicalStrategies.map((s) => s.name);
  const globalEntries = promptEntries.filter((e) => e.scopeBasis === "VERIFIED_GLOBAL").map(({ key, description }) => ({ key, description }));
  const scopedEntries = promptEntries.filter((e) => e.scopeBasis === "SCOPED").map(({ key, description, scope }) => ({ key, description, scope }));
  const unverifiedEntries = promptEntries.filter((e) => e.scopeBasis === "UNVERIFIED").map(({ key, description }) => ({ key, description }));

  return `You are building a master trade-decision framework for a course that teaches ${canonicalStrategies.length} distinct canonical strategies: ${strategyNames.join(", ")}.

Represent the decision process a trader follows: determine HTF context -> identify key levels -> determine market regime -> is a valid setup present -> which canonical strategy applies -> check prerequisites -> check confirmation -> check no-trade conditions -> define entry -> define invalidation/stop -> define target -> manage trade -> exit.

GENUINELY GLOBAL rules — VERIFIED to hold for every strategy/instrument/timeframe/session/trader-profile in this course; these are the ONLY rules that may be built into an unconditional gate placed before strategy selection:
${JSON.stringify(globalEntries, null, 2)}

SCOPED rules — each carries a real, known restriction (instrument/timeframe/session/trader-profile/strategy). Real, useful rules, but NEVER usable as an unconditional pre-strategy-selection gate:
${JSON.stringify(scopedEntries, null, 2)}

UNVERIFIED rules — we cannot confirm these hold for every strategy/instrument/session in this course (their source material was never scope-tagged, e.g. older per-lesson market-context notes) even though no specific restriction is known either. Treat these EXACTLY like SCOPED rules for gate-placement purposes — NEVER build one into an unconditional pre-strategy-selection gate, even though nothing here names a specific instrument/session:
${JSON.stringify(unverifiedEntries, null, 2)}

CRITICAL — CITE YOUR SOURCES, DO NOT SELF-REPORT APPLICABILITY (this replaces a prior approach that asked you to state a node's own "scope" directly — a real audit found that produced results disagreeing with the very rules a node was built from). Every node you create MUST set "sourceKeys": the EXACT key value(s) from the pools above it is actually built from. Do NOT invent a key. A node's true applicability is then computed automatically FROM those citations — you do not report it yourself, and an inaccurate or missing citation will be caught by a deterministic check afterward.
- "start"/"end" nodes, and a "decision" node that purely presents a branching question (its own branches, not the actions reachable after them), may have an empty "sourceKeys" array — they aren't asserting a rule.
- EVERY OTHER node — an unconditional action/gate reachable via "next" with no "branches" of its own — MUST cite at least one key. A node with NO citation will be treated as an UNPROVEN global claim, not a legitimate one — citing nothing is not evidence of being global. A real past failure: a node asserting a stock/equity-specific "Is Stock In Play?" qualification (checking for a liquid, in-play stock with clear levels/volume/catalysts) was placed as an unconditional global gate with no citation, which has no meaning for a futures, forex, or daily/weekly strategy in this same course. Never repeat this: if a gate is only meaningful for certain strategies/instruments, cite the SCOPED source(s) it actually comes from and place it only within the relevant strategy's/context's own path (e.g. behind a branch like "Is this an intraday equities/options trade?"), never before strategy selection.
- If you cite ANY scoped OR unverified key for a node, that node loses its "genuinely global" status automatically, and it can then never be treated as an unconditional global gate — even if you also cited a global key alongside it. Do not blend a scoped/unverified and a genuinely global source into one node when that would misrepresent the restriction as removable; prefer separate nodes when your sources genuinely disagree in scope (e.g. one course-wide 2R guideline that truly applies to everyone vs. a DIFFERENT, options-only 2R rule for beginners — these are two different nodes, not one).

CRITICAL: do NOT blend the strategies into one unified entry rule. The graph must branch to a distinct node/path per canonical strategy at the "which canonical strategy applies" decision point, each following that strategy's own prerequisites/confirmation/no-trade conditions. Only collapse to a single path if the material genuinely shows the instructor teaches one unified setup.

Produce a small node graph: each node has a unique "id", a "type" (start/decision/action/end), a "label", an optional "description", "sourceKeys" (see above), and either "next" (ordered array of next node ids) or "branches" (array of {label, next} for decision nodes) — leave the unused one as an empty array. Also produce "readableSteps": a plain-text, numbered walkthrough of the same process as a fallback for when the graph isn't rendered visually.

Respond ONLY with JSON matching the required schema.`;
}
