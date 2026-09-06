import type { Rule } from "../gemini/schema.js";
import type { GeminiThinkingLevel, GeminiUsage } from "../gemini/client.js";
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
  type RawSynthesizedRule,
  type RuleCategoryKey,
  type Conflict,
  type SourceRef,
  type SynthesizedRule,
} from "./schema.js";

const STAGE = "canonical_strategy";

interface KeyedSource {
  lessonId: number;
  strategyInstanceId: number;
  startTimestamp: string | null;
  endTimestamp: string | null;
  evidence: string;
}

/**
 * Assigns a short, stable reference key ("s1", "s2", ...) to every
 * individual original (Stage-1) rule across all of this cluster's members,
 * and returns both a prompt-ready copy of each member (every rule
 * decorated with its "key", nothing else removed — Gemini still needs to
 * READ each rule's own evidence/timestamps to reason well; only the
 * OUTPUT wire format stops asking it to restate them) and a lookup from
 * key back to the exact provenance fields already known before the Gemini
 * call. See schema.ts's v4 changelog for why this exists.
 *
 * Deliberately a pure function of `members` alone (same input always
 * yields the same key assignment) so buildPrompt and enrichCanonicalStrategy
 * can each call it independently and get identical keys, without having to
 * thread a shared map through synthesizeCanonicalStrategy's return path.
 *
 * Keys every rule across the 10 original Stage-1 rule-category fields
 * (gemini/schema.ts's Strategy) — distinct from RULE_CATEGORY_KEYS
 * (schema.ts), which are the 11 SYNTHESIZED categories Gemini groups its
 * output into. There is no original category corresponding to
 * "prerequisites" — a synthesized prerequisite rule may legitimately cite
 * zero source keys.
 */
function keySourceData(members: StrategyInstanceRecord[]): {
  promptMembers: unknown[];
  sourceKeyMap: Map<string, KeyedSource>;
} {
  const sourceKeyMap = new Map<string, KeyedSource>();
  let counter = 0;

  const keyRules = (member: StrategyInstanceRecord, rules: Rule[]): (Rule & { key: string })[] =>
    rules.map((r) => {
      counter++;
      const key = `s${counter}`;
      sourceKeyMap.set(key, {
        lessonId: member.lessonId,
        strategyInstanceId: member.strategyInstanceId,
        startTimestamp: r.start_timestamp,
        endTimestamp: r.end_timestamp,
        evidence: r.evidence,
      });
      return { key, ...r };
    });

  const promptMembers = members.map((m) => ({
    strategyInstanceId: m.strategyInstanceId,
    lessonId: m.lessonId,
    lessonTitle: m.lessonTitle,
    originalStrategyName: m.strategyName,
    strategy: {
      market_or_instrument: m.strategy.market_or_instrument,
      timeframes: m.strategy.timeframes,
      indicators: m.strategy.indicators,
      market_context_rules: keyRules(m, m.strategy.market_context_rules),
      setup_conditions: keyRules(m, m.strategy.setup_conditions),
      entry_rules: keyRules(m, m.strategy.entry_rules),
      confirmation_rules: keyRules(m, m.strategy.confirmation_rules),
      stop_loss_rules: keyRules(m, m.strategy.stop_loss_rules),
      profit_target_rules: keyRules(m, m.strategy.profit_target_rules),
      trade_management_rules: keyRules(m, m.strategy.trade_management_rules),
      invalidation_rules: keyRules(m, m.strategy.invalidation_rules),
      no_trade_conditions: keyRules(m, m.strategy.no_trade_conditions),
      visual_discretionary_rules: keyRules(m, m.strategy.visual_discretionary_rules),
      examples_shown: m.strategy.examples_shown,
      ambiguities: m.strategy.ambiguities,
    },
  }));

  return { promptMembers, sourceKeyMap };
}

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
 * (RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA) — see schema.ts's v4
 * changelog for the full history (v2's 11-sibling-array shape rejected
 * with a 400; v3's `sections` collapse; v4's current `sourceKeys`
 * compaction, which stopped a real, measured output-amplification problem
 * where Gemini was re-emitting evidence text it had already been shown in
 * the prompt). The final validated/persisted CanonicalStrategy is
 * byte-for-byte the same rich shape as before across all four versions;
 * only how Gemini's own output cites its sources changed.
 *
 * `options.thinkingLevel`, when provided, is passed through to Gemini's
 * `generation_config.thinking_level` for this call only — see
 * GeminiThinkingLevel's doc comment (gemini/client.ts). Omitted by
 * runSynthesis.ts's normal pipeline call, so production behavior is
 * unchanged; exists for scripts/canonicalStrategyDiagnostic.ts's
 * experimental low-thinking variant.
 */
export async function synthesizeCanonicalStrategy(
  deps: SynthesisStageDeps,
  cluster: ClusterProposal,
  members: StrategyInstanceRecord[],
  options: { thinkingLevel?: GeminiThinkingLevel } = {},
): Promise<{ canonicalStrategy: CanonicalStrategy; usage: GeminiUsage }> {
  const prompt = buildPrompt(cluster, members);
  const { rawText, usage, diagnostics } = await callGeminiForStage(
    deps,
    STAGE,
    prompt,
    RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
    options.thinkingLevel,
  );
  const parsed = parseStageJson(STAGE, rawText, diagnostics);
  const raw = validateStageData(STAGE, parsed, RawCanonicalStrategySchema);

  const enriched = enrichCanonicalStrategy(raw, members);
  // Defense in depth: the enrichment above should always produce a valid
  // CanonicalStrategy by construction, but this final check against the
  // exact same rich schema used everywhere else guarantees a bug in
  // enrichCanonicalStrategy can never persist a malformed strategy.
  const canonicalStrategy = validateStageData(STAGE, enriched, CanonicalStrategySchema);

  return { canonicalStrategy, usage };
}

/**
 * Resolves a source key (e.g. "s7") Gemini cited back to the full,
 * already-known SourceRef — never re-derived or fabricated from Gemini's
 * own output. A key that doesn't exist in the map (Gemini invented or
 * mistyped one) is dropped rather than guessed at; this can never happen
 * for a key that genuinely came from the prompt's own data.
 */
function resolveSourceKeys(keys: string[], sourceKeyMap: Map<string, KeyedSource>, lessonTitleById: Map<number, string>): SourceRef[] {
  const sources: SourceRef[] = [];
  for (const key of keys) {
    const found = sourceKeyMap.get(key);
    if (!found) continue;
    sources.push({
      lessonId: found.lessonId,
      lessonTitle: lessonTitleById.get(found.lessonId) ?? `Lesson ${found.lessonId}`,
      strategyInstanceId: found.strategyInstanceId,
      startTimestamp: found.startTimestamp,
      endTimestamp: found.endTimestamp,
      evidence: found.evidence,
    });
  }
  return sources;
}

function enrichRule(raw: RawSynthesizedRule, sourceKeyMap: Map<string, KeyedSource>, lessonTitleById: Map<number, string>): SynthesizedRule {
  return {
    description: raw.description,
    classification: raw.classification,
    supportLevel: raw.supportLevel,
    supportCount: raw.supportCount,
    sources: resolveSourceKeys(raw.sourceKeys, sourceKeyMap, lessonTitleById),
    conflictSources: resolveSourceKeys(raw.conflictSourceKeys, sourceKeyMap, lessonTitleById),
  };
}

function enrichConflict(raw: RawConflict, sourceKeyMap: Map<string, KeyedSource>, lessonTitleById: Map<number, string>): Conflict {
  return { description: raw.description, sources: resolveSourceKeys(raw.sourceKeys, sourceKeyMap, lessonTitleById) };
}

function emptyCategoryMap(): Record<RuleCategoryKey, RawSynthesizedRule[]> {
  const map = {} as Record<RuleCategoryKey, RawSynthesizedRule[]>;
  for (const key of RULE_CATEGORY_KEYS) map[key] = [];
  return map;
}

/**
 * Resolves every "sourceKeys"/"conflictSourceKeys" reference Gemini
 * returned back to the full SourceRef shape (lessonId/lessonTitle/
 * strategyInstanceId/timestamps/evidence), using only data already known
 * from `members` before the Gemini call — never inferred or fabricated.
 * Because each key points at one specific instance's one specific
 * original rule, strategyInstanceId is now ALWAYS resolved exactly, even
 * when a lesson contributed more than one instance to the cluster (v2/v3
 * had to leave it null in that case, since a bare lessonId was ambiguous
 * between that lesson's instances — a rule-level key has no such
 * ambiguity).
 *
 * Also un-flattens `raw.sections` (Gemini's single wire-format array — see
 * schema.ts's v3 comment for why it's collapsed this way) back into the 11
 * named category arrays the persisted CanonicalStrategy shape requires. A
 * category Gemini never mentions defaults to `[]` — never fabricated; a
 * category Gemini names more than once has its rules concatenated rather
 * than one occurrence silently overwriting another.
 */
export function enrichCanonicalStrategy(raw: RawCanonicalStrategy, members: StrategyInstanceRecord[]): CanonicalStrategy {
  const { sourceKeyMap } = keySourceData(members);
  const lessonTitleById = new Map(members.map((m) => [m.lessonId, m.lessonTitle]));

  const rule = (r: RawSynthesizedRule) => enrichRule(r, sourceKeyMap, lessonTitleById);

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
    conflicts: raw.conflicts.map((c) => enrichConflict(c, sourceKeyMap, lessonTitleById)),
    sourceLessonIds: raw.sourceLessonIds,
  };
}

function buildPrompt(cluster: ClusterProposal, members: StrategyInstanceRecord[]): string {
  const { promptMembers } = keySourceData(members);

  return `You are synthesizing ONE canonical trading strategy from multiple lesson instances of the same underlying strategy, previously clustered together as "${cluster.proposedCanonicalName}" (cluster rationale: ${cluster.similarityRationale}${cluster.differencesNotes ? `; noted differences: ${cluster.differencesNotes}` : ""}).

Put every synthesized rule into "sections": one entry per rule category you have rules for, each shaped as { "category": <one of ${RULE_CATEGORY_KEYS.join(", ")}>, "rules": [...] }. Omit a category entirely if you have no rules for it — never include an entry with an empty "rules" array, and never include more than one entry for the same category (put all of that category's rules in the one entry).

Every individual rule in the source data below is tagged with a short reference "key" (e.g. "s7"). Every synthesized rule MUST carry provenance via "sourceKeys": an array of the EXACT key values from the source rules that support it. Do NOT restate lessonId, timestamps, or evidence text yourself — that provenance is already known from the source data and will be attached automatically from the key alone. Use ONLY keys that actually appear in the source data below; never invent a key. Set "supportLevel" based on how many independent lessons actually support the rule (SINGLE_SOURCE, MULTI_SOURCE, REPEATED_EXPLICIT, VARIANT, CONFLICTING, or INFERRED) and "supportCount" to the number of supporting lessons — never invent a numeric confidence score.

CRITICAL — do not silently resolve contradictions. If one source says "enter immediately on retest" and another says "wait for candle confirmation", record this as EITHER a variant (variants[]), a conditional rule (a rule whose description states the condition), or an unresolved conflict (conflicts[], with supportLevel CONFLICTING on the relevant rule and both sides' keys listed in "conflictSourceKeys") — depending on what the evidence actually shows. Never fabricate a compromise rule that blends the two. Each conflicts[] entry needs its own "description" and "sourceKeys" naming both sides.

Preserve every member's original strategy name somewhere in the output (purpose text or variants). List every contributing lesson id in sourceLessonIds.

Source strategy instances (every individual rule is tagged with its reference "key" — cite these keys in "sourceKeys"/"conflictSourceKeys", never the underlying lessonId/timestamp/evidence fields directly):
${JSON.stringify(promptMembers, null, 2)}

Respond ONLY with JSON matching the required schema.`;
}
