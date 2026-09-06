import type { GeminiUsage } from "../gemini/client.js";
import { callGeminiForStage, parseStageJson, validateStageData, type SynthesisStageDeps } from "./geminiStage.js";
import type { StrategyInstanceRecord } from "./normalize.js";
import {
  RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  RawCanonicalStrategySchema,
  CanonicalStrategySchema,
  RULE_CATEGORY_KEYS,
  type CanonicalStrategy,
  type ClusterProposal,
  type RawCanonicalStrategy,
  type RawConflict,
  type RawSourceRef,
  type RawSynthesizedRule,
  type RuleCategoryKey,
  type Conflict,
  type SourceRef,
  type SynthesizedRule,
} from "./schema.js";

const STAGE = "canonical_strategy";

/**
 * Stage 3 — canonical strategy synthesis. One Gemini call per cluster,
 * given the FULL structured strategy_instance JSON for that cluster's
 * members (clusters are typically small, so this stays well within token
 * budget even though it's the richest input of any stage). Required to
 * preserve every original strategy name, record contradictions as a
 * variant/conditional rule/unresolved conflict rather than silently
 * resolving them, and never fabricate a compromise rule.
 *
 * Gemini is constrained to a REDUCED response schema
 * (RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA) — a real Gemini API smoke
 * test (tests/synthesisRealApiSmoke.test.ts) confirmed the previous (v2)
 * version of this schema, which asked for 11 separate sibling arrays (one
 * per rule category) each containing the full nested rule/source shape,
 * IS rejected by the real API with a 400. v3 (current) collapses those 11
 * arrays into one `sections` array — see schema.ts's v3 comment for why:
 * each of the 11 was a full independent copy on the wire, so this is
 * roughly an 11x reduction in how many times the same nested shape appears
 * in the schema. Every rule's `sources`/`conflictSources` only need to name
 * lessonId + timestamps + evidence; lessonTitle and strategyInstanceId —
 * already known for every member of this cluster — are filled in
 * deterministically by enrichCanonicalStrategy below, which also un-flattens
 * `sections` back into the 11 named categories the persisted
 * CanonicalStrategy shape requires. The final validated/persisted
 * CanonicalStrategy is byte-for-byte the same rich shape as before; only
 * how Gemini's own output is grouped/restated changed.
 */
export async function synthesizeCanonicalStrategy(
  deps: SynthesisStageDeps,
  cluster: ClusterProposal,
  members: StrategyInstanceRecord[],
): Promise<{ canonicalStrategy: CanonicalStrategy; usage: GeminiUsage }> {
  const prompt = buildPrompt(cluster, members);
  const { rawText, usage } = await callGeminiForStage(deps, STAGE, prompt, RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA);
  const parsed = parseStageJson(STAGE, rawText);
  const raw = validateStageData(STAGE, parsed, RawCanonicalStrategySchema);

  const enriched = enrichCanonicalStrategy(raw, members);
  // Defense in depth: the enrichment above should always produce a valid
  // CanonicalStrategy by construction, but this final check against the
  // exact same rich schema used everywhere else guarantees a bug in
  // enrichCanonicalStrategy can never persist a malformed strategy.
  const canonicalStrategy = validateStageData(STAGE, enriched, CanonicalStrategySchema);

  return { canonicalStrategy, usage };
}

function enrichSourceRef(
  raw: RawSourceRef,
  lessonTitleById: Map<number, string>,
  singleInstanceIdByLesson: Map<number, number>,
): SourceRef {
  return {
    lessonId: raw.lessonId,
    lessonTitle: lessonTitleById.get(raw.lessonId) ?? `Lesson ${raw.lessonId}`,
    strategyInstanceId: singleInstanceIdByLesson.get(raw.lessonId) ?? null,
    startTimestamp: raw.startTimestamp,
    endTimestamp: raw.endTimestamp,
    evidence: raw.evidence,
  };
}

function enrichRule(
  raw: RawSynthesizedRule,
  lessonTitleById: Map<number, string>,
  singleInstanceIdByLesson: Map<number, number>,
): SynthesizedRule {
  return {
    ...raw,
    sources: raw.sources.map((s) => enrichSourceRef(s, lessonTitleById, singleInstanceIdByLesson)),
    conflictSources: raw.conflictSources.map((s) => enrichSourceRef(s, lessonTitleById, singleInstanceIdByLesson)),
  };
}

function enrichConflict(
  raw: RawConflict,
  lessonTitleById: Map<number, string>,
  singleInstanceIdByLesson: Map<number, number>,
): Conflict {
  return { description: raw.description, sources: raw.sources.map((s) => enrichSourceRef(s, lessonTitleById, singleInstanceIdByLesson)) };
}

function emptyCategoryMap(): Record<RuleCategoryKey, RawSynthesizedRule[]> {
  const map = {} as Record<RuleCategoryKey, RawSynthesizedRule[]>;
  for (const key of RULE_CATEGORY_KEYS) map[key] = [];
  return map;
}

/**
 * Reattaches lessonTitle/strategyInstanceId to every source Gemini reported
 * by lessonId, using only data we already had before the Gemini call — never
 * inferred or fabricated. strategyInstanceId is only filled in when a
 * lesson contributed exactly one strategy instance to THIS cluster (the
 * common case); when a lesson contributed more than one, which specific
 * instance a piece of evidence came from is genuinely ambiguous from
 * lessonId alone, so it's left null rather than guessed — lessonTitle,
 * timestamps, and evidence still fully identify the source.
 *
 * Also un-flattens `raw.sections` (Gemini's single wire-format array — see
 * schema.ts's v3 comment for why it's collapsed this way) back into the 11
 * named category arrays the persisted CanonicalStrategy shape requires.
 * A category Gemini never mentions defaults to `[]` — never fabricated; a
 * category Gemini names more than once has its rules concatenated rather
 * than one occurrence silently overwriting another.
 */
export function enrichCanonicalStrategy(raw: RawCanonicalStrategy, members: StrategyInstanceRecord[]): CanonicalStrategy {
  const lessonTitleById = new Map(members.map((m) => [m.lessonId, m.lessonTitle]));
  const instanceCountByLesson = new Map<number, number>();
  for (const m of members) instanceCountByLesson.set(m.lessonId, (instanceCountByLesson.get(m.lessonId) ?? 0) + 1);
  const singleInstanceIdByLesson = new Map<number, number>();
  for (const m of members) {
    if (instanceCountByLesson.get(m.lessonId) === 1) singleInstanceIdByLesson.set(m.lessonId, m.strategyInstanceId);
  }

  const rule = (r: RawSynthesizedRule) => enrichRule(r, lessonTitleById, singleInstanceIdByLesson);

  const byCategory = emptyCategoryMap();
  for (const section of raw.sections) {
    byCategory[section.category] = byCategory[section.category].concat(section.rules);
  }

  return {
    name: raw.name,
    purpose: raw.purpose,
    markets: raw.markets,
    timeframes: raw.timeframes,
    marketContext: byCategory.marketContext.map(rule),
    prerequisites: byCategory.prerequisites.map(rule),
    setup: byCategory.setup.map(rule),
    entryRules: byCategory.entryRules.map(rule),
    confirmationRules: byCategory.confirmationRules.map(rule),
    stopLossRules: byCategory.stopLossRules.map(rule),
    profitTargetRules: byCategory.profitTargetRules.map(rule),
    tradeManagementRules: byCategory.tradeManagementRules.map(rule),
    invalidationRules: byCategory.invalidationRules.map(rule),
    noTradeConditions: byCategory.noTradeConditions.map(rule),
    visualDiscretionaryRules: byCategory.visualDiscretionaryRules.map(rule),
    variants: raw.variants,
    examples: raw.examples,
    ambiguities: raw.ambiguities,
    conflicts: raw.conflicts.map((c) => enrichConflict(c, lessonTitleById, singleInstanceIdByLesson)),
    sourceLessonIds: raw.sourceLessonIds,
  };
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

Put every synthesized rule into "sections": one entry per rule category you have rules for, each shaped as { "category": <one of ${RULE_CATEGORY_KEYS.join(", ")}>, "rules": [...] }. Omit a category entirely if you have no rules for it — never include an entry with an empty "rules" array, and never include more than one entry for the same category (put all of that category's rules in the one entry).

Every rule MUST carry provenance via "sources" entries. For each source, give ONLY lessonId, startTimestamp, endTimestamp, and evidence — do NOT restate lessonTitle or strategyInstanceId, those are already known and will be attached automatically. Set "supportLevel" based on how many independent lessons actually support the rule (SINGLE_SOURCE, MULTI_SOURCE, REPEATED_EXPLICIT, VARIANT, CONFLICTING, or INFERRED) and "supportCount" to the number of supporting lessons — never invent a numeric confidence score.

CRITICAL — do not silently resolve contradictions. If one source says "enter immediately on retest" and another says "wait for candle confirmation", record this as EITHER a variant (variants[]), a conditional rule (a rule whose description states the condition), or an unresolved conflict (conflicts[], with supportLevel CONFLICTING on the relevant rule and both sides listed in conflictSources) — depending on what the evidence actually shows. Never fabricate a compromise rule that blends the two.

Preserve every member's original strategy name somewhere in the output (purpose text or variants). List every contributing lesson id in sourceLessonIds.

Source strategy instances:
${JSON.stringify(memberPayload, null, 2)}

Respond ONLY with JSON matching the required schema.`;
}
