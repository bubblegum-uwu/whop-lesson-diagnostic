import type { GeminiUsage } from "../gemini/client.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import { PLAYBOOK_RESPONSE_JSON_SCHEMA, PlaybookSchema, type CanonicalStrategy, type CoreFramework, type Playbook } from "./schema.js";

/**
 * Stage 5 — comprehensive course playbook. Grounded ONLY in the canonical
 * strategies and core framework already synthesized (Stages 3-4) — never
 * supplemented with outside trading knowledge, enforced simply by never
 * giving the model anything else to draw on. Produces the Gemini-authored
 * sections below; several deterministic sections (Canonical Strategy
 * Library, Coverage Notes, Source Index, and — when applicable — Unmatched
 * Strategy-Scoped Knowledge) are generated in code by the orchestrator
 * (runSynthesis.ts) and spliced in afterward, never asked of Gemini.
 *
 * Real-audit fix (Phase 3.5B): "canonical_strategy_library" was previously
 * one of THESE Gemini-authored sections. A real 28-lesson dry run showed
 * Gemini's own prose miscounting and omitting a canonical strategy ("The
 * playbook recognizes fifteen canonical strategies" when there were 16).
 * Completeness of an enumerable, already-known list must never depend on
 * Gemini remembering every item — the library is now built deterministically
 * from `canonicalStrategies` directly (see
 * runSynthesis.ts's buildCanonicalStrategyLibrarySection), guaranteeing
 * exact 1:1 coverage by construction, with a defensive invariant check on
 * top. Gemini is no longer asked to produce this section at all.
 */
const REQUIRED_SECTION_KEYS = [
  "course_philosophy",
  "pre_market_preparation",
  "higher_timeframe_framework",
  "market_context_regime",
  "key_levels",
  "setup_selection",
  "entry_framework",
  "confirmation_framework",
  "risk_management",
  "stop_placement",
  "target_selection",
  "trade_management",
  "no_trade_conditions",
  "strategy_variants",
  "common_mistakes_warnings",
  "conflicts_and_ambiguities",
  "master_trading_checklist",
] as const;

export async function synthesizePlaybook(
  deps: SynthesisStageDeps,
  courseTitle: string,
  canonicalStrategies: CanonicalStrategy[],
  coreFramework: CoreFramework,
): Promise<{ playbook: Playbook; usage: GeminiUsage }> {
  const prompt = buildPrompt(courseTitle, canonicalStrategies, coreFramework);
  const { data, usage } = await callStructuredStage(deps, "playbook", prompt, PLAYBOOK_RESPONSE_JSON_SCHEMA, PlaybookSchema);
  return { playbook: data, usage };
}

function buildPrompt(courseTitle: string, canonicalStrategies: CanonicalStrategy[], coreFramework: CoreFramework): string {
  return `You are writing "${courseTitle} — Comprehensive Trading Playbook" — a single, readable trading-system document — grounded ONLY in the synthesized material below. Do not add trading knowledge, terminology, or rules from outside this material.

Canonical strategies (source material — the actual strategy library section of the final document is generated separately and deterministically, not by you):
${JSON.stringify(canonicalStrategies, null, 2)}

Core trading framework (cross-strategy principles):
${JSON.stringify(coreFramework, null, 2)}

Produce readable markdown-style prose (not raw JSON dumps) for exactly these sections, using these keys: ${REQUIRED_SECTION_KEYS.join(", ")}. A separate, deterministically-generated "Canonical Strategy Library" section (listing every canonical strategy by name, guaranteed complete) is appended to this document automatically — you do not need to enumerate every strategy anywhere; refer to "the canonical strategy library" rather than restating or counting the full list yourself.
- "course_philosophy": the trading principles/mindset evident across the material.
- "pre_market_preparation" / "higher_timeframe_framework" / "market_context_regime" / "key_levels": draw from the core framework's relevant sections.
- "setup_selection" / "entry_framework" / "confirmation_framework" / "strategy_variants": summarize the canonical strategies, naming each one and when it applies.
- "risk_management" / "stop_placement" / "target_selection" / "trade_management" / "no_trade_conditions": draw from both the core framework and any strategy-specific rules that matter — including each canonical strategy's own riskManagementRules/positionSizingRules/scalingInRules/scalingOutRules/runnerManagementRules where present. Do not duplicate a course-wide (core framework) rule into every individual strategy's section; reference the shared rule once and note only what a given strategy adds or overrides.
- "common_mistakes_warnings": drawn from no-trade conditions, invalidation rules, each canonical strategy's own "warnings" array, and ambiguities actually present in the material — never invented.
- "conflicts_and_ambiguities": explicitly surface every CONFLICTING-support rule and notable ambiguity from the material — do not hide disagreements to make the playbook look cleaner.
- "master_trading_checklist": a concrete, step-by-step checklist a trader could follow, derived from the above.

CRITICAL — do not state a rule as universal ("all strategies", "every setup", "the fundamental rule across the Accelerator") unless it is a course_framework-level GLOBAL rule (unscoped) or you can verify EVERY SINGLE canonical strategy above actually shares it. If even one canonical strategy's own rules (entryRules, setup, variants, etc.) contradict or carve out an exception to what looks like a universal pattern (e.g. one strategy explicitly permits a resting stop-order entry while most others require waiting for a retest), you MUST say so explicitly (name the exception) rather than describing the majority pattern as if it applies to all strategies without qualification. Prefer precise framing: "most strategies in this course..." / "strategy X differs by..." / "as a course-wide default, unless a specific strategy's own rules say otherwise...".

Also populate "conflictsAndAmbiguities" as a separate structured list (description + sources) mirroring what you wrote in the conflicts_and_ambiguities section, for programmatic display.

Respond ONLY with JSON matching the required schema.`;
}
