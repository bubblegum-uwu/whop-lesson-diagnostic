import type { GeminiUsage } from "../gemini/client.js";
import { callGeminiForStage, parseStageJson, validateStageData, type SynthesisStageDeps } from "./geminiStage.js";
import { buildSynthesisSourcePool, resolveSourcePoolKeys, combineScopeBasis, type SourcePoolEntry } from "./synthesisSourcePool.js";
import {
  RAW_PLAYBOOK_RESPONSE_JSON_SCHEMA,
  RawPlaybookSchema,
  PlaybookSchema,
  type ApplicabilityPolicyValue,
  type CanonicalStrategy,
  type CoreFramework,
  type Playbook,
  type PlaybookSection,
  type RawPlaybookSection,
} from "./schema.js";

const STAGE = "playbook";

/**
 * Stage 5 — comprehensive course playbook. Grounded ONLY in the canonical
 * strategies and core framework already synthesized (Stages 3-4) — never
 * supplemented with outside trading knowledge, enforced simply by never
 * giving the model anything else to draw on. Produces the Gemini-authored
 * sections below; several deterministic sections (Canonical Strategy
 * Library, Coverage Notes, Source Index, Master Trading Checklist, and —
 * when applicable — Unmatched Strategy-Scoped Knowledge) are generated in
 * code by the orchestrator (runSynthesis.ts) and spliced in afterward,
 * never asked of Gemini.
 *
 * Real-audit fix (Phase 3.5B): "canonical_strategy_library" was previously
 * one of THESE Gemini-authored sections. A real 28-lesson dry run showed
 * Gemini's own prose miscounting and omitting a canonical strategy. The
 * library is now built deterministically from `canonicalStrategies`
 * directly (see runSynthesis.ts), guaranteeing exact 1:1 coverage by
 * construction. Gemini is no longer asked to produce this section at all.
 *
 * Real-audit fix (Phase 3.5B v3/v4, Blocker B): a SECOND and THIRD real dry
 * run found "master_trading_checklist" claiming to apply to "every trading
 * session" while actually containing intraday/equities/options-only
 * material, and — separately — an ordinary prose section
 * (risk_management-shaped) paraphrasing a scoped 2R rule as applying "on
 * every planned execution".
 *
 * Real-audit fix (Phase 3.5B v5) — the FOURTH real dry run found the v4
 * fix (a single "universal-labeled section leaked scoped vocabulary" check)
 * was simultaneously too broad — it fired on "scoped_execution_checklists",
 * "conflicts_and_ambiguities", and "strategy_variants", sections that are
 * SUPPOSED to discuss scoped or conflicting material — and still not
 * targeted enough to be trustworthy. This is fixed with structured,
 * per-section provenance instead of a single text-only gate:
 *
 *   - "master_trading_checklist" is REMOVED from Gemini's own output
 *     entirely (like canonical_strategy_library) and built deterministically
 *     in runSynthesis.ts from ONLY VERIFIED_GLOBAL CoreFramework rules —
 *     Gemini is never even shown scoped/unverified material in the same
 *     generation context for this section, so cross-contamination is
 *     structurally impossible, not merely policed after the fact.
 *   - Every REMAINING section now cites `sourceKeys` into the same pooled
 *     CoreFramework/canonical-strategy material decisionFramework.ts uses
 *     (see synthesisSourcePool.ts) — its own `scope`/`scopeBasis` is then
 *     DERIVED from those citations in code, never self-reported.
 *   - Each section is assigned a fixed `applicabilityPolicy` (see
 *     SECTION_POLICY below) that decides how playbookApplicabilityAudit.ts
 *     validates it — "scoped_execution_checklists" and
 *     "conflicts_and_ambiguities" are no longer flagged merely for
 *     discussing scoped/conflicting material, while a real broadening in
 *     an ordinary prose section is still caught.
 */
const SECTION_POLICY = {
  course_philosophy: "DESCRIPTIVE_MIXED",
  pre_market_preparation: "DESCRIPTIVE_MIXED",
  higher_timeframe_framework: "DESCRIPTIVE_MIXED",
  market_context_regime: "DESCRIPTIVE_MIXED",
  key_levels: "DESCRIPTIVE_MIXED",
  setup_selection: "DESCRIPTIVE_MIXED",
  entry_framework: "DESCRIPTIVE_MIXED",
  confirmation_framework: "DESCRIPTIVE_MIXED",
  risk_management: "DESCRIPTIVE_MIXED",
  stop_placement: "DESCRIPTIVE_MIXED",
  target_selection: "DESCRIPTIVE_MIXED",
  trade_management: "DESCRIPTIVE_MIXED",
  no_trade_conditions: "DESCRIPTIVE_MIXED",
  strategy_variants: "DESCRIPTIVE_MIXED",
  common_mistakes_warnings: "DESCRIPTIVE_MIXED",
  conflicts_and_ambiguities: "CONFLICT_DOCUMENTATION",
  scoped_execution_checklists: "SCOPED",
} as const satisfies Record<string, ApplicabilityPolicyValue>;
// "master_trading_checklist" is deliberately absent — it's built
// deterministically by runSynthesis.ts (policy VERIFIED_GLOBAL_ONLY),
// never asked of Gemini. See buildMasterTradingChecklistSection there.

const REQUIRED_SECTION_KEYS = Object.keys(SECTION_POLICY) as (keyof typeof SECTION_POLICY)[];

export async function synthesizePlaybook(
  deps: SynthesisStageDeps,
  courseTitle: string,
  canonicalStrategies: CanonicalStrategy[],
  coreFramework: CoreFramework,
): Promise<{ playbook: Playbook; usage: GeminiUsage }> {
  const { poolEntries, byKey } = buildSynthesisSourcePool(canonicalStrategies, coreFramework);
  const prompt = buildPrompt(courseTitle, canonicalStrategies, coreFramework, poolEntries);
  const { rawText, usage, diagnostics } = await callGeminiForStage(deps, STAGE, prompt, RAW_PLAYBOOK_RESPONSE_JSON_SCHEMA);
  const parsed = parseStageJson(STAGE, rawText, diagnostics);
  const raw = validateStageData(STAGE, parsed, RawPlaybookSchema);

  const sections: PlaybookSection[] = raw.sections.map((s) => enrichSection(s, byKey));
  const playbook = validateStageData(STAGE, { title: raw.title, sections, conflictsAndAmbiguities: raw.conflictsAndAmbiguities }, PlaybookSchema);
  return { playbook, usage };
}

/**
 * Real-audit fix (Phase 3.5B v5) — derives a section's scope/scopeBasis
 * from its OWN cited sourceKeys (never trusted from Gemini directly — see
 * synthesisSourcePool.ts's combineScopeBasis) and assigns its
 * applicabilityPolicy deterministically from its key. A section whose key
 * isn't in SECTION_POLICY (should not happen given the prompt, but never
 * trusted) defaults to the strictest ordinary-prose policy,
 * DESCRIPTIVE_MIXED, rather than silently going unaudited.
 */
function enrichSection(raw: RawPlaybookSection, byKey: Map<string, SourcePoolEntry>): PlaybookSection {
  const resolved = resolveSourcePoolKeys(raw.sourceKeys, byKey);
  const { scope, scopeBasis } = combineScopeBasis(resolved);
  const applicabilityPolicy: ApplicabilityPolicyValue = (SECTION_POLICY as Record<string, ApplicabilityPolicyValue>)[raw.key] ?? "DESCRIPTIVE_MIXED";
  // Real-audit fix (v7) — see PlaybookSectionSchema's own doc comment: additional
  // information about this SAME citation list, alongside (never instead of) the
  // aggregate scope/scopeBasis above.
  const hasIndependentGlobalEvidence = resolved.some((entry) => entry.scopeBasis === "VERIFIED_GLOBAL");
  return {
    key: raw.key,
    title: raw.title,
    content: raw.content,
    sourceKeys: resolved.map((e) => e.key),
    scope,
    scopeBasis,
    applicabilityPolicy,
    hasIndependentGlobalEvidence,
  };
}

function buildPrompt(courseTitle: string, canonicalStrategies: CanonicalStrategy[], coreFramework: CoreFramework, poolEntries: SourcePoolEntry[]): string {
  return `You are writing "${courseTitle} — Comprehensive Trading Playbook" — a single, readable trading-system document — grounded ONLY in the synthesized material below. Do not add trading knowledge, terminology, or rules from outside this material.

Canonical strategies (source material — the actual strategy library section of the final document is generated separately and deterministically, not by you):
${JSON.stringify(canonicalStrategies, null, 2)}

Core trading framework (cross-strategy principles):
${JSON.stringify(coreFramework, null, 2)}

Every entry below is the SAME pooled material above, tagged with a stable reference "key" (e.g. "k7") plus its own "scopeBasis" ("VERIFIED_GLOBAL" | "SCOPED" | "UNVERIFIED" — see scopeBasis.ts) and, when scoped, its "scope" restriction:
${JSON.stringify(poolEntries, null, 2)}

Produce readable markdown-style prose (not raw JSON dumps) for exactly these sections, using these keys: ${REQUIRED_SECTION_KEYS.join(", ")}. A separate, deterministically-generated "Canonical Strategy Library" section (listing every canonical strategy by name, guaranteed complete) AND a separate, deterministically-generated "Master Trading Checklist" section (built ONLY from VERIFIED_GLOBAL pooled material, never written by you) are both appended to this document automatically — you do not need to enumerate every strategy anywhere, and "master_trading_checklist" is NOT one of the section keys you produce; do not attempt to write a universal/master checklist yourself under any other section either.

CRITICAL — CITE YOUR SOURCES for every section (real-audit fix, Phase 3.5B v5): set "sourceKeys" to the pool key(s) above that section's content is actually grounded in. Do NOT invent a key. This is what lets each section's true applicability be verified after the fact instead of trusted from your own wording — a section's own derived scope becomes the union of whatever it cites, so citing a scoped/unverified key means that section is no longer treated as purely global, regardless of how you worded the prose.

- "course_philosophy": the trading principles/mindset evident across the material.
- "pre_market_preparation" / "higher_timeframe_framework" / "market_context_regime" / "key_levels": draw from the core framework's relevant sections.
- "setup_selection" / "entry_framework" / "confirmation_framework" / "strategy_variants": summarize the canonical strategies, naming each one and when it applies. "strategy_variants" is NOT a universal section — a variant is by definition specific to the strategy/strategies it belongs to; never describe one variant's mechanics as if they applied to every strategy in the course.
- "risk_management" / "stop_placement" / "target_selection" / "trade_management" / "no_trade_conditions": draw from both the core framework and any strategy-specific rules that matter — including each canonical strategy's own riskManagementRules/positionSizingRules/scalingInRules/scalingOutRules/runnerManagementRules where present. Do not duplicate a course-wide (core framework) rule into every individual strategy's section; reference the shared rule once and note only what a given strategy adds or overrides.
- "common_mistakes_warnings": drawn from no-trade conditions, invalidation rules, each canonical strategy's own "warnings" array, and ambiguities actually present in the material — never invented.
- "conflicts_and_ambiguities": explicitly surface every CONFLICTING-support rule and notable ambiguity from the material — do not hide disagreements to make the playbook look cleaner. You may freely quote/compare conflicting SCOPED rules side by side here; this section is exempt from the "does this sound too universal" check below, since documenting a genuine disagreement (not asserting a universal rule) is its entire purpose.
- "scoped_execution_checklists": build this from the SCOPED/UNVERIFIED pool entries — each carries (or, if UNVERIFIED, lacks) a real, named restriction (instrument/timeframe/session/trader-profile). Organize it as one or more clearly labeled sub-checklists (e.g. "Intraday Equities/Options Checklist", "Daily/Weekly Swing Checklist") and explicitly STATE each sub-checklist's applicability in its own prose (not just in the citation) — a trader following a strategy this does NOT apply to (e.g. futures, forex, or a daily/weekly setup) must be able to tell from reading it that they should skip it. Also draw content from each canonical strategy's own execution-relevant rules (entryRules, confirmationRules, tradeManagementRules, scalingInRules, scalingOutRules, runnerManagementRules) where they add session/timeframe/instrument-specific mechanics — label which strategy/strategies each step applies to.

CRITICAL — do not state a rule as universal ("all strategies", "every setup", "the fundamental rule across the Accelerator") unless it is a course_framework-level GLOBAL rule (unscoped) or you can verify EVERY SINGLE canonical strategy above actually shares it. If even one canonical strategy's own rules (entryRules, setup, variants, etc.) contradict or carve out an exception to what looks like a universal pattern (e.g. one strategy explicitly permits a resting stop-order entry while most others require waiting for a retest), you MUST say so explicitly (name the exception) rather than describing the majority pattern as if it applies to all strategies without qualification. Prefer precise framing: "most strategies in this course..." / "strategy X differs by..." / "as a course-wide default, unless a specific strategy's own rules say otherwise...".

CRITICAL — THIS APPLIES TO EVERY SECTION EXCEPT "conflicts_and_ambiguities" (real-audit fix, Phase 3.5B v4/v5): look at each pooled entry's own "scopeBasis" field above before you describe it. An entry is safe to describe with absolute language (words like "all", "every", "always", "universal(ly)", "without exception", "regardless of", "no matter the/what") ONLY when its scopeBasis is "VERIFIED_GLOBAL". An entry with scopeBasis "SCOPED" carries a real, named restriction that you MUST state explicitly when you describe it. An entry with scopeBasis "UNVERIFIED" has NO confirmed restriction but ALSO no confirmed global applicability — word it as a general default ("as a baseline...", "typically...") rather than an absolute claim. A real past failure: a pooled entry carrying marketsOrInstruments: ["options"], traderProfiles: ["beginner"] (a minimum 2:1 reward-to-risk rule) was paraphrased in a "risk_management"-type section as applying "on every planned execution" — the word "options" never even appeared in that sentence, so the restriction was silently erased. Never do this: if you use "every"/"all"/"always"/etc. anywhere near a paraphrase of a SCOPED or UNVERIFIED entry's substance, you have broadened it incorrectly — name the actual condition instead, or drop the absolute wording.

Also populate "conflictsAndAmbiguities" as a separate structured list (description + sources) mirroring what you wrote in the conflicts_and_ambiguities section, for programmatic display.

Respond ONLY with JSON matching the required schema.`;
}
