import type { GeminiUsage } from "../gemini/client.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import { PLAYBOOK_RESPONSE_JSON_SCHEMA, PlaybookSchema, type CanonicalStrategy, type CoreFramework, type Playbook } from "./schema.js";
import { splitFrameworkByScope } from "./frameworkScopeSplit.js";

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
 *
 * Real-audit fix (Phase 3.5B v3, Blocker B): a SECOND real dry run found
 * "master_trading_checklist" claiming to be "a concrete, step-by-step
 * mechanical checklist to execute before, during, and after every trading
 * session" while actually being built almost entirely from intraday-
 * equities/options-only material (liquid mega-cap qualification, QQQ/SPY
 * comparison, PMH/PML, 1-5 minute execution, a 9:30-11:00 AM EST window,
 * options contract rules) — none of it universal to daily/weekly Fibonacci,
 * Inside Bar swing, futures, or forex strategies also taught in this course.
 * Fixed architecturally, the same way canonical_strategy_library was fixed:
 * don't ask Gemini to police its own universality. "master_trading_checklist"
 * is now built ONLY from coreFramework's genuinely GLOBAL rules (see
 * frameworkScopeSplit.ts's splitFrameworkByScope) — Gemini is never shown
 * the scoped material when writing it, so it cannot leak in. All scoped
 * execution material (the intraday/options steps above, and any other
 * instrument/session/timeframe/trader-profile-specific checklist content)
 * instead goes into the new "scoped_execution_checklists" section, which
 * Gemini is explicitly told to label by its actual scope. A deterministic
 * secondary check (universalSectionAudit.ts, wired in by runSynthesis.ts)
 * flags "master_trading_checklist" if scoped vocabulary leaks in anyway.
 *
 * Real-audit fix (Phase 3.5B v4): a THIRD real dry run found (a) the
 * global/scoped split above trusted `scope == null` as "safe to call
 * global", which is not the same as VERIFIED global (see scopeBasis.ts —
 * now fixed via effectiveScopeBasis), and (b) a DIFFERENT section
 * (risk_management-shaped, not the checklist) paraphrased a scoped
 * CoreFramework rule as applying to "every planned execution". The
 * "do not state a rule as universal" instruction below now applies
 * explicitly to every section (not just the checklist) and names the exact
 * absolute-claim words to avoid; universalSectionAudit.ts's secondary check
 * now scans every section, not just the checklist, and also catches
 * word-overlap with a scoped/unverified rule's own description — not only
 * literal scope-vocabulary terms.
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
  "scoped_execution_checklists",
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
  const { global: globalFrameworkSections, scoped: scopedFrameworkSections } = splitFrameworkByScope(coreFramework);

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

CRITICAL — do not state a rule as universal ("all strategies", "every setup", "the fundamental rule across the Accelerator") unless it is a course_framework-level GLOBAL rule (unscoped) or you can verify EVERY SINGLE canonical strategy above actually shares it. If even one canonical strategy's own rules (entryRules, setup, variants, etc.) contradict or carve out an exception to what looks like a universal pattern (e.g. one strategy explicitly permits a resting stop-order entry while most others require waiting for a retest), you MUST say so explicitly (name the exception) rather than describing the majority pattern as if it applies to all strategies without qualification. Prefer precise framing: "most strategies in this course..." / "strategy X differs by..." / "as a course-wide default, unless a specific strategy's own rules say otherwise...".

CRITICAL — THIS APPLIES TO EVERY SECTION, NOT ONLY THE CHECKLIST (real-audit fix, Phase 3.5B v4): look at each core-framework rule's own "scope"/"scopeBasis" field in the JSON above before you describe it. A rule is safe to describe with absolute language (words like "all", "every", "always", "universal(ly)", "without exception", "regardless of", "no matter the/what") ONLY when its scopeBasis is "VERIFIED_GLOBAL". A rule with scopeBasis "SCOPED" carries a real, named restriction (instrument/timeframe/session/trader-profile) that you MUST state explicitly when you describe it. A rule with scopeBasis "UNVERIFIED" has NO confirmed restriction but ALSO no confirmed global applicability — word it as a general default ("as a baseline...", "typically...") rather than an absolute claim. A real past failure: a CoreFramework rule carrying marketsOrInstruments: ["options"], traderProfiles: ["beginner"] (a minimum 2:1 reward-to-risk rule) was paraphrased in a "risk_management"-type section as applying "on every planned execution" — the word "options" never even appeared in that sentence, so the restriction was silently erased. Never do this: if you use "every"/"all"/"always"/etc. anywhere near a paraphrase of a SCOPED or UNVERIFIED rule's substance, you have broadened it incorrectly — name the actual condition instead, or drop the absolute wording.

CRITICAL — "master_trading_checklist" vs "scoped_execution_checklists" (real-audit fix, Phase 3.5B v3, Blocker B): a real dry run found a prior "Master Trading Checklist" claiming to apply "before, during, and after every trading session" while actually being built from intraday-equities/options-only steps (session-open windows, PMH/PML, 1-5 minute execution, options contract rules) — meaningless for a futures, forex, or daily/weekly strategy also taught in this course. Fix these two sections as follows:
- "master_trading_checklist": build this EXCLUSIVELY from the GENUINELY GLOBAL core framework rules below — each one VERIFIED (scopeBasis "VERIFIED_GLOBAL") to hold for every strategy, instrument, timeframe, session, and trader profile in this course. Do NOT include any instrument-specific (e.g. stock/options-only), session-specific (e.g. a specific opening-range time window), timeframe-specific (e.g. 1-minute/5-minute execution), or trader-profile-specific step here, even if it seems generally good practice — if it isn't backed by one of the rules below, it does not belong in this section.
GENUINELY GLOBAL core framework material (only source for master_trading_checklist):
${JSON.stringify(globalFrameworkSections, null, 2)}
- "scoped_execution_checklists": build this from the SCOPED-OR-UNVERIFIED core framework rules below. Some carry a real, named restriction (instrument/timeframe/session/trader-profile) — state it explicitly. Others are UNVERIFIED (no confirmed restriction, but ALSO not confirmed to hold for everyone, typically because they come from older material that was never scope-tagged) — for these, word each step as a general default rather than an absolute rule (e.g. "typically..." / "as a baseline..."), and do not claim it is required for every strategy/instrument/session. Organize the section as one or more clearly labeled sub-checklists (e.g. "Intraday Equities/Options Checklist", "Daily/Weekly Swing Checklist") — group by the rules' actual shared scope where known, and explicitly state each sub-checklist's applicability so a trader following a strategy this does NOT apply to (e.g. futures, forex, or a daily/weekly setup) knows to skip it.
SCOPED-OR-UNVERIFIED core framework material (source for scoped_execution_checklists — never for master_trading_checklist):
${JSON.stringify(scopedFrameworkSections, null, 2)}
Also draw scoped_execution_checklists content from each canonical strategy's own execution-relevant rules (entryRules, confirmationRules, tradeManagementRules, scalingInRules, scalingOutRules, runnerManagementRules) where they add session/timeframe/instrument-specific mechanics beyond the shared global checklist — label which strategy/strategies each such step applies to.

Also populate "conflictsAndAmbiguities" as a separate structured list (description + sources) mirroring what you wrote in the conflicts_and_ambiguities section, for programmatic display.

Respond ONLY with JSON matching the required schema.`;
}
