import type { GeminiUsage } from "../gemini/client.js";
import type { KnowledgeItem, KnowledgeItemScope } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import { callGeminiForStage, parseStageJson, validateStageData, type SynthesisStageDeps } from "./geminiStage.js";
import type { StrategyInstanceRecord } from "./normalize.js";
import type { KnowledgeItemRecord } from "./knowledgeNormalize.js";
import { resolveKeys, type CitableFact } from "./sourceRegistry.js";
import {
  RAW_CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  RawCoreFrameworkSchema,
  CoreFrameworkSchema,
  type CanonicalStrategy,
  type CoreFramework,
  type RawSynthesizedRule,
  type SynthesizedRule,
} from "./schema.js";

const STAGE = "core_framework";

/**
 * Stage 4 — course-wide principle extraction. Runs AFTER canonical
 * strategies exist, but reasons across them rather than duplicating their
 * content: pools rules from the categories that tend to recur across
 * different strategies regardless of cluster (market context, confirmation,
 * stop-loss, profit-target, trade management, no-trade conditions) from
 * EVERY strategy instance in the course — not just one cluster — plus a
 * condensed view of the canonical strategies for context. Setup/entry/
 * invalidation/visual-discretionary rules are left to the canonical
 * strategies themselves, where they're genuinely strategy-specific.
 *
 * Phase 3.5B: ALSO pools rich KnowledgeItems that are course-wide (GLOBAL —
 * every scope array empty) or scoped only by instrument/timeframe/session/
 * trader-profile (never a specific strategy — those go to canonical
 * strategy enrichment instead, see strategyScopeMapping.ts). This is the
 * fix for the exact gap runSynthesis.ts's old buildCoverageNotesSection
 * documented: a lesson like "Sizing & Scaling Trades" that teaches no
 * standalone setup previously contributed NOTHING to this framework. Uses
 * the same keyed-citation wire format canonical_strategy already proved
 * out (see schema.ts's RawCoreFrameworkSchema doc comment) rather than
 * Gemini restating full source citations per rule, now that input volume
 * roughly doubles/triples.
 */
const CROSS_STRATEGY_CATEGORIES = [
  "market_context_rules",
  "confirmation_rules",
  "stop_loss_rules",
  "profit_target_rules",
  "trade_management_rules",
  "no_trade_conditions",
] as const satisfies readonly (keyof StrategyInstanceRecord["strategy"])[];

interface KeyedEntry {
  fact: CitableFact;
  /** Present only for a knowledge-derived entry — used to deterministically attach numericalValues/exceptions/scope, never asked of Gemini. */
  knowledgeItem?: KnowledgeItem;
}

export async function extractCoreFramework(
  deps: SynthesisStageDeps,
  canonicalStrategies: CanonicalStrategy[],
  allInstances: StrategyInstanceRecord[],
  /** Phase 3.5B — GLOBAL and instrument/timeframe/session/traderProfile-only-scoped KnowledgeItems (never strategy-scoped ones — see knowledgeNormalize.ts). Defaults to [] so every existing call site is unaffected. */
  courseKnowledge: KnowledgeItemRecord[] = [],
): Promise<{ coreFramework: CoreFramework; usage: GeminiUsage }> {
  const { entries, keyMap } = buildKeyedPool(allInstances, courseKnowledge);
  const factMap = new Map<string, CitableFact>();
  for (const [key, entry] of keyMap) factMap.set(key, entry.fact);

  const prompt = buildPrompt(canonicalStrategies, entries);
  const { rawText, usage, diagnostics } = await callGeminiForStage(deps, STAGE, prompt, RAW_CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA);
  const parsed = parseStageJson(STAGE, rawText, diagnostics);
  const raw = validateStageData(STAGE, parsed, RawCoreFrameworkSchema);

  const coreFramework: CoreFramework = {
    sections: raw.sections.map((section) => ({
      key: section.key,
      title: section.title,
      rules: section.rules.map((r) => enrichRule(r, keyMap, factMap)),
    })),
  };
  // Defense in depth, same reasoning as canonicalStrategy.ts's own final check.
  const validated = validateStageData(STAGE, coreFramework, CoreFrameworkSchema);
  return { coreFramework: validated, usage };
}

function buildKeyedPool(
  instances: StrategyInstanceRecord[],
  courseKnowledge: KnowledgeItemRecord[],
): { entries: unknown[]; keyMap: Map<string, KeyedEntry> } {
  const keyMap = new Map<string, KeyedEntry>();
  const entries: unknown[] = [];
  let counter = 0;

  for (const instance of instances) {
    for (const category of CROSS_STRATEGY_CATEGORIES) {
      for (const rule of instance.strategy[category]) {
        counter++;
        const key = `k${counter}`;
        const fact: CitableFact = {
          lessonId: instance.lessonId,
          lessonTitle: instance.lessonTitle,
          strategyInstanceId: instance.strategyInstanceId,
          startTimestamp: rule.start_timestamp,
          endTimestamp: rule.end_timestamp,
          evidence: rule.evidence,
        };
        keyMap.set(key, { fact });
        entries.push({ key, category, lessonId: instance.lessonId, lessonTitle: instance.lessonTitle, description: rule.description, classification: rule.classification });
      }
    }
  }

  for (const record of courseKnowledge) {
    counter++;
    const key = `k${counter}`;
    const fact: CitableFact = {
      lessonId: record.lessonId,
      lessonTitle: record.lessonTitle,
      strategyInstanceId: null,
      startTimestamp: record.item.start_timestamp,
      endTimestamp: record.item.end_timestamp,
      evidence: record.item.evidence,
    };
    keyMap.set(key, { fact, knowledgeItem: record.item });
    entries.push({
      key,
      category: record.item.category,
      lessonId: record.lessonId,
      lessonTitle: record.lessonTitle,
      statement: record.item.statement,
      ruleType: record.item.ruleType,
      classification: record.item.classification,
      conditions: record.item.conditions,
      exceptions: record.item.exceptions,
      scope: record.item.scope,
      numericalValues: record.item.numericalValues,
    });
  }

  return { entries, keyMap };
}

function unionScope(a: KnowledgeItemScope, b: KnowledgeItemScope): KnowledgeItemScope {
  const uniq = (arr: string[]) => [...new Set(arr)];
  return {
    strategies: uniq([...a.strategies, ...b.strategies]),
    marketsOrInstruments: uniq([...a.marketsOrInstruments, ...b.marketsOrInstruments]),
    timeframes: uniq([...a.timeframes, ...b.timeframes]),
    sessions: uniq([...a.sessions, ...b.sessions]),
    traderProfiles: uniq([...a.traderProfiles, ...b.traderProfiles]),
  };
}

function enrichRule(raw: RawSynthesizedRule, keyMap: Map<string, KeyedEntry>, factMap: Map<string, CitableFact>): SynthesizedRule {
  const citedKeys = [...raw.sourceKeys, ...raw.conflictSourceKeys];
  const numericalValues: KnowledgeItem["numericalValues"] = [];
  const exceptionsSet = new Set<string>();
  let scopeUnion: KnowledgeItemScope | null = null;
  for (const key of citedKeys) {
    const knowledgeItem = keyMap.get(key)?.knowledgeItem;
    if (!knowledgeItem) continue;
    numericalValues.push(...knowledgeItem.numericalValues);
    for (const exception of knowledgeItem.exceptions) exceptionsSet.add(exception);
    if (isKnowledgeItemScoped(knowledgeItem.scope)) {
      scopeUnion = scopeUnion ? unionScope(scopeUnion, knowledgeItem.scope) : knowledgeItem.scope;
    }
  }

  return {
    description: raw.description,
    classification: raw.classification,
    supportLevel: raw.supportLevel,
    supportCount: raw.supportCount,
    sources: resolveKeys(raw.sourceKeys, factMap),
    conflictSources: resolveKeys(raw.conflictSourceKeys, factMap),
    exceptions: [...exceptionsSet],
    numericalValues,
    scope: scopeUnion,
  };
}

function buildPrompt(canonicalStrategies: CanonicalStrategy[], entries: unknown[]): string {
  const condensedStrategies = canonicalStrategies.map((s) => ({
    name: s.name,
    purpose: s.purpose,
    markets: s.markets,
    timeframes: s.timeframes,
  }));

  return `You are extracting a course-wide "Core Trading Framework" from a trading course — principles that recur ACROSS multiple strategies or apply to the course as a whole, not the strategies themselves.

The canonical strategies already synthesized for this course (for context only, do not restate their strategy-specific setup/entry rules):
${JSON.stringify(condensedStrategies, null, 2)}

Pooled source material — a mix of (a) rules pooled from every lesson's market-context, confirmation, stop-loss, profit-target, trade-management, and no-trade categories, and (b) course-wide trading knowledge (risk management, position sizing, scaling, execution, higher-timeframe analysis, preparation, psychology, warnings, definitions, etc.) that is NOT specific to any one strategy. Every entry is tagged with a short reference "key" (e.g. "k12"):
${JSON.stringify(entries, null, 2)}

Group these into framework sections such as: Market Preparation, Higher-Timeframe Analysis, Market Regime, Key-Level Identification, Liquidity/Structure, Setup Qualification, Confirmation Framework, Risk Framework, Position Sizing & Scaling, Trade Management Framework, Execution Framework, Psychology & Discipline, No-Trade Framework, Warnings & Common Mistakes, Definitions — only include sections the pooled material actually supports with evidence. Do NOT duplicate a rule into a section it doesn't belong in just to fill every section, and do NOT invent a section with no real supporting material.

Every rule in your output must carry "sourceKeys": an array of the EXACT key values from the pooled material above that support it. Do NOT restate lessonId, timestamps, or evidence text yourself — that provenance is already known and will be attached automatically from the key alone. Use ONLY keys that actually appear above; never invent one. Set "supportLevel" based on how many independent lessons actually support the rule (SINGLE_SOURCE, MULTI_SOURCE, REPEATED_EXPLICIT, VARIANT, CONFLICTING, or INFERRED) and "supportCount" to the number of supporting lessons — never a fabricated confidence score. Record genuine contradictions with supportLevel CONFLICTING and populate "conflictSourceKeys" with both sides, rather than picking a side.

Preserve normative strength exactly as it was originally stated — a HARD_RULE is not the same as a GUIDELINE or a PREFERENCE, and a rule scoped to one instrument/timeframe/session/trader-profile must not be generalized into a universal one; when the pooled material shows a real restriction, keep the resulting framework rule specific rather than broadening it.

Respond ONLY with JSON matching the required schema.`;
}
