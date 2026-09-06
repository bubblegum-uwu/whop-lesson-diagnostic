import type { GeminiUsage } from "../gemini/client.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import { PLAYBOOK_RESPONSE_JSON_SCHEMA, PlaybookSchema, type CanonicalStrategy, type CoreFramework, type Playbook } from "./schema.js";

/**
 * Stage 5 — comprehensive course playbook. Grounded ONLY in the canonical
 * strategies and core framework already synthesized (Stages 3-4) — never
 * supplemented with outside trading knowledge, enforced simply by never
 * giving the model anything else to draw on. Produces sections 1-18 of the
 * required structure; section 19 ("Source Index") is generated
 * deterministically in code by the orchestrator (it's just a lesson
 * listing, no synthesis needed) and appended afterward.
 */
const REQUIRED_SECTION_KEYS = [
  "course_philosophy",
  "pre_market_preparation",
  "higher_timeframe_framework",
  "market_context_regime",
  "key_levels",
  "setup_selection",
  "canonical_strategy_library",
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

Canonical strategies (the strategy library):
${JSON.stringify(canonicalStrategies, null, 2)}

Core trading framework (cross-strategy principles):
${JSON.stringify(coreFramework, null, 2)}

Produce readable markdown-style prose (not raw JSON dumps) for exactly these sections, using these keys: ${REQUIRED_SECTION_KEYS.join(", ")}.
- "course_philosophy": the trading principles/mindset evident across the material.
- "pre_market_preparation" / "higher_timeframe_framework" / "market_context_regime" / "key_levels": draw from the core framework's relevant sections.
- "setup_selection" / "canonical_strategy_library" / "entry_framework" / "confirmation_framework" / "strategy_variants": summarize the canonical strategies, naming each one and when it applies; canonical_strategy_library should list every canonical strategy with a short description, including any instructorPreferences worth noting as discretionary color (never stated as a hard requirement).
- "risk_management" / "stop_placement" / "target_selection" / "trade_management" / "no_trade_conditions": draw from both the core framework and any strategy-specific rules that matter — including each canonical strategy's own riskManagementRules/positionSizingRules/scalingInRules/scalingOutRules/runnerManagementRules where present. Do not duplicate a course-wide (core framework) rule into every individual strategy's section; reference the shared rule once and note only what a given strategy adds or overrides.
- "common_mistakes_warnings": drawn from no-trade conditions, invalidation rules, each canonical strategy's own "warnings" array, and ambiguities actually present in the material — never invented.
- "conflicts_and_ambiguities": explicitly surface every CONFLICTING-support rule and notable ambiguity from the material — do not hide disagreements to make the playbook look cleaner.
- "master_trading_checklist": a concrete, step-by-step checklist a trader could follow, derived from the above.

Also populate "conflictsAndAmbiguities" as a separate structured list (description + sources) mirroring what you wrote in the conflicts_and_ambiguities section, for programmatic display.

Respond ONLY with JSON matching the required schema.`;
}
