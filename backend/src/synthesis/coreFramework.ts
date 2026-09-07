import type { GeminiUsage } from "../gemini/client.js";
import type { KnowledgeItem } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import { callGeminiForStage, parseStageJson, validateStageData, type SynthesisStageDeps } from "./geminiStage.js";
import type { StrategyInstanceRecord } from "./normalize.js";
import type { KnowledgeItemRecord } from "./knowledgeNormalize.js";
import { resolveKeys, type CitableFact } from "./sourceRegistry.js";
import { aggregateScopeBasis, finalizeScopeBasis } from "./scopeBasis.js";
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
      rules: section.rules.flatMap((r) => enrichAndPartitionRule(r, keyMap, factMap)),
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

type EvidenceClass = "VERIFIED_GLOBAL" | "SCOPED" | "UNVERIFIED";

/** Classifies a single citation key by what kind of evidence backs it — never by anything Gemini claims. Mirrors scopeBasis.ts's per-citation logic, exposed per-key here because partitioning (below) needs to know EACH citation's own class, not just their combined result. */
function classifyKey(key: string, keyMap: Map<string, KeyedEntry>): EvidenceClass | null {
  const entry = keyMap.get(key);
  if (!entry) return null; // invented/unknown key — dropped, contributes no evidence
  if (!entry.knowledgeItem) return "UNVERIFIED"; // a real, known citation into the scope-blind legacy pool
  return isKnowledgeItemScoped(entry.knowledgeItem.scope) ? "SCOPED" : "VERIFIED_GLOBAL";
}

function buildRuleFromKeys(
  raw: RawSynthesizedRule,
  sourceKeys: string[],
  conflictSourceKeys: string[],
  keyMap: Map<string, KeyedEntry>,
  factMap: Map<string, CitableFact>,
): SynthesizedRule {
  const { scope, scopeBasis, numericalValues, exceptions } = aggregateScopeBasis([...sourceKeys, ...conflictSourceKeys], (key) => {
    const entry = keyMap.get(key);
    if (!entry) return undefined;
    return { item: entry.knowledgeItem };
  });
  const sources = resolveKeys(sourceKeys, factMap);
  const conflictSources = resolveKeys(conflictSourceKeys, factMap);
  const isFullRule = sourceKeys.length === raw.sourceKeys.length && conflictSourceKeys.length === raw.conflictSourceKeys.length;

  return {
    description: raw.description,
    classification: raw.classification,
    supportLevel: raw.supportLevel,
    // A partitioned (split) rule's supportCount can no longer honestly be Gemini's original
    // count (that counted lessons across ALL evidence classes) — recompute from the distinct
    // lessons this specific split actually carries. An unsplit rule keeps Gemini's own count.
    supportCount: isFullRule ? raw.supportCount : new Set(sources.map((s) => s.lessonId)).size,
    sources,
    conflictSources,
    exceptions,
    numericalValues,
    scope,
    // Real-audit fix (v6) — the final VERIFIED_GLOBAL eligibility gate: never
    // promotes, only ever downgrades to UNVERIFIED when the rule's own text
    // names a restriction the citations' structured scope missed, or when
    // the rule documents a genuine methodological conflict — see
    // scopeBasis.ts's finalizeScopeBasis.
    //
    // The description-text check is gated on isFullRule: `raw.description`
    // is Gemini's ONE merged description, shared verbatim across every
    // partition of a split rule (see enrichAndPartitionRule above) — so for
    // a split partition it can name a restriction that belongs entirely to
    // a DIFFERENT partition's evidence (e.g. "Confirm QQQ/SPY alignment and
    // always define your risk" splitting into a QQQ/SPY-scoped partition
    // and an independently-global "define your risk" partition). Applying
    // the merged text to every partition would falsely downgrade the
    // genuinely-global one — exactly the dilution v5's partitioning fix
    // exists to prevent. Each partition's OWN citations are still checked
    // (see aggregateScopeBasis's citation loop), so this only skips the
    // whole-description re-check when it would attribute someone else's
    // restriction to this partition; the CONFLICTING check is unaffected
    // (CONFLICTING rules are never partitioned to begin with).
    scopeBasis: finalizeScopeBasis(scopeBasis, isFullRule ? raw.description : "", raw.supportLevel),
  };
}

/**
 * Real-audit fix (Phase 3.5B v4) — see scopeBasis.ts's doc comment for the
 * full history. Critically, a citation resolving to a KeyedEntry with NO
 * `knowledgeItem` (a pooled per-lesson Strategy-schema rule from
 * CROSS_STRATEGY_CATEGORIES — never scope-tagged, unlike a Phase 3.5A
 * KnowledgeItem) is passed through as `{ item: undefined }` — a REAL,
 * known citation whose true-world scope we simply cannot verify — rather
 * than being silently skipped as if it contributed no evidence at all. A
 * rule built entirely (or partly) from such citations can never be
 * certified "VERIFIED_GLOBAL" by aggregateScopeBasis, even when every
 * knowledge-item citation it also carries happens to be global.
 *
 * Real-audit fix (Phase 3.5B v5) — a THIRD real dry run showed this still
 * wasn't enough: Gemini is free to cite BOTH genuinely-global evidence
 * (e.g. general futures/expectancy teaching, an unscoped "at least a two R
 * multiple" trade-management rule) AND scoped corroborating evidence (an
 * options-specific, beginner-targeted example of the same principle) on
 * ONE consolidated rule — and the old union-based aggregation let the
 * mere PRESENCE of that scoped citation narrow the ENTIRE rule down to
 * "options, beginner", discarding the independently-sufficient global
 * evidence. This is the exact 2R real-audit failure.
 *
 * Fix: partition evidence BEFORE final consolidation, not after. When a
 * rule's own `sourceKeys` span more than one evidence class
 * (VERIFIED_GLOBAL / SCOPED / UNVERIFIED), split it into one output rule
 * PER class actually present — e.g. a genuinely global "target at least a
 * 2:1 reward-to-risk ratio" rule AND a separate, still-SCOPED
 * "options/beginner" corroborating rule, both surviving with the SAME
 * description (the underlying principle is the same; only WHICH evidence
 * backs each copy differs) — never one rule silently narrowed by the
 * other's presence. A CONFLICTING rule (recording a genuine two-sided
 * disagreement via `conflictSourceKeys`) is deliberately EXEMPT from this
 * partitioning — splitting would break apart the very contradiction the
 * rule exists to document.
 */
function enrichAndPartitionRule(raw: RawSynthesizedRule, keyMap: Map<string, KeyedEntry>, factMap: Map<string, CitableFact>): SynthesizedRule[] {
  if (raw.supportLevel === "CONFLICTING" || raw.conflictSourceKeys.length > 0) {
    return [buildRuleFromKeys(raw, raw.sourceKeys, raw.conflictSourceKeys, keyMap, factMap)];
  }

  const groups = new Map<EvidenceClass, string[]>();
  for (const key of raw.sourceKeys) {
    const cls = classifyKey(key, keyMap);
    if (!cls) continue;
    const group = groups.get(cls) ?? [];
    group.push(key);
    groups.set(cls, group);
  }

  if (groups.size <= 1) {
    return [buildRuleFromKeys(raw, raw.sourceKeys, [], keyMap, factMap)];
  }

  const classOrder: EvidenceClass[] = ["VERIFIED_GLOBAL", "SCOPED", "UNVERIFIED"];
  const rules: SynthesizedRule[] = [];
  for (const cls of classOrder) {
    const keys = groups.get(cls);
    if (keys && keys.length > 0) rules.push(buildRuleFromKeys(raw, keys, [], keyMap, factMap));
  }
  return rules;
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

IMPORTANT — some pooled entries carry an explicit "scope" object (the knowledge-derived ones); others (the ones tagged with a category like "market_context_rules"/"confirmation_rules"/etc.) carry NO scope field at all, because that older per-lesson data was never scope-tagged. Do NOT treat the absence of a "scope" field as proof an entry is universal — it may still describe something instrument/session/timeframe-specific (e.g. "QQQ/SPY relative strength", "intraday fundamentals", a specific session window). If an entry's own wording is clearly specific to one instrument/session/timeframe/trader-type even though it carries no "scope" field, preserve that specificity in your rule's own "description" text rather than writing it as if it were a universal principle — our system independently verifies applicability from your citations and will never treat a consolidated rule as safely global unless EVERY citation behind it is itself scope-tagged and empty, but a precise description still helps readers and avoids compounding the ambiguity.

CRITICAL — do not let scoped corroboration narrow away independently-sufficient global evidence (real-audit fix, Phase 3.5B v5): a real past failure combined general futures teaching, an unscoped "always target at least a two R multiple" trade-management rule, and general expectancy teaching (all genuinely global) with an options-specific, beginner-targeted example of the SAME principle into ONE consolidated rule — our system then had to treat the whole thing as options/beginner-only, discarding the independently-sufficient global evidence that was sitting right next to it. Prefer citing genuinely global keys for a rule whenever the global evidence alone already supports it, and citing scoped/unverified keys for a SEPARATE rule (same or similar description is fine) to preserve the scoped material as its own corroborating variant — do not blend a global-evidence citation and a scoped-evidence citation into the exact same rule when the global evidence stands on its own. (If you do mix them, our system will automatically split them back into separate rules by evidence class — but citing them separately in the first place produces a cleaner result.)

Respond ONLY with JSON matching the required schema.`;
}
