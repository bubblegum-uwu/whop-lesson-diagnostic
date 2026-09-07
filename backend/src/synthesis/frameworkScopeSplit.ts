import type { KnowledgeItemScope } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import { effectiveScopeBasis, type ScopeBasis } from "./scopeBasis.js";
import { STRATEGY_RULE_CATEGORIES } from "./synthesisSourcePool.js";
import type { CanonicalStrategy, CoreFramework } from "./schema.js";

/**
 * Shared by decisionFramework.ts and playbook.ts (Real-audit fix, Phase
 * 3.5B) — splits coreFramework's pooled rules into two disjoint pools by
 * their already-known, deterministically-attached `scope`/`scopeBasis` (see
 * canonicalStrategy.ts/coreFramework.ts's enrichment — never asked of
 * Gemini for a SynthesizedRule, only derived from cited sources).
 * This split itself is 100% deterministic; only how a given stage's prompt
 * USES the two pools is left to the model. Extracted to a shared module so
 * both stages that need "genuinely global vs. everything else" framework
 * material use the exact same derivation rather than two copies that could
 * drift.
 *
 * Real-audit fix (Phase 3.5B v4) — "global" now means `effectiveScopeBasis
 * === "VERIFIED_GLOBAL"`, not merely `scope == null`. A rule can have an
 * empty scope union yet still be UNVERIFIED (built from scope-blind
 * evidence — see scopeBasis.ts) — such a rule is NOT safe to hand to
 * Gemini as "genuinely global" material, even though nothing in its own
 * `scope` object names a restriction. UNVERIFIED rules now fall into the
 * SAME "scoped" bucket as genuinely-restricted ones for this reason.
 */
export interface CondensedRule {
  description: string;
  scope: KnowledgeItemScope | null;
}

export interface ScopedFrameworkSection {
  title: string;
  rules: CondensedRule[];
}

export function splitFrameworkByScope(coreFramework: CoreFramework): { global: ScopedFrameworkSection[]; scoped: ScopedFrameworkSection[] } {
  const global: ScopedFrameworkSection[] = [];
  const scoped: ScopedFrameworkSection[] = [];
  for (const section of coreFramework.sections) {
    const globalRules = section.rules
      .filter((r) => effectiveScopeBasis(r) === "VERIFIED_GLOBAL")
      .map((r): CondensedRule => ({ description: r.description, scope: null }));
    const scopedRules = section.rules
      .filter((r) => effectiveScopeBasis(r) !== "VERIFIED_GLOBAL")
      .map((r): CondensedRule => ({ description: r.description, scope: r.scope }));
    if (globalRules.length > 0) global.push({ title: section.title, rules: globalRules });
    if (scopedRules.length > 0) scoped.push({ title: section.title, rules: scopedRules });
  }
  return { global, scoped };
}

/**
 * Every distinct, real scope-array value (instrument/session/timeframe/
 * trader-profile — never a strategy name, which is a different kind of
 * "scope") appearing anywhere in the course's actual scoped material.
 * Used by universalSectionAudit.ts as a deterministic (non-NLP) vocabulary
 * to check whether a section CLAIMED to be universal actually leaked
 * scoped terminology into its prose. UNVERIFIED rules contribute nothing
 * here (their `scope` is empty by definition — there is no specific term
 * to collect); they're covered instead by collectNonGlobalRuleDescriptions'
 * word-overlap check below.
 */
export function collectScopeVocabulary(coreFramework: CoreFramework, extraScopes: KnowledgeItemScope[] = []): Set<string> {
  const vocabulary = new Set<string>();
  const add = (scope: KnowledgeItemScope | null | undefined) => {
    if (!scope || !isKnowledgeItemScoped(scope)) return;
    for (const value of [...scope.marketsOrInstruments, ...scope.sessions, ...scope.timeframes, ...scope.traderProfiles]) {
      vocabulary.add(value.toLowerCase());
    }
  };
  for (const section of coreFramework.sections) {
    for (const rule of section.rules) add(rule.scope);
  }
  for (const scope of extraScopes) add(scope);
  return vocabulary;
}

/** A non-global rule description tagged with WHY it's non-global — see playbookApplicabilityAudit.ts, which routes a leak to "universalApplicabilityLeaks" (a KNOWN restriction was erased) vs. "unverifiedUniversalClaims" (an UNKNOWN-but-unproven restriction was asserted as fact) accordingly. */
export interface TaggedNonGlobalRule {
  description: string;
  basis: "SCOPED" | "UNVERIFIED";
}

/**
 * Real-audit fix (Phase 3.5B v4/v5) — every rule description that is NOT
 * verified-global (i.e. SCOPED or UNVERIFIED), pooled from both
 * coreFramework and (optionally) every canonical strategy's own rules,
 * tagged with which. Used by playbookApplicabilityAudit.ts to catch a
 * playbook section that uses absolute-claim language ("all", "every",
 * "always"...) while its prose significantly overlaps one of these — the
 * exact failure mode a real dry run found (a section paraphrased a scoped
 * rule as if it were universal without repeating any of its literal
 * scope-array words, so collectScopeVocabulary's term-matching alone could
 * never have caught it).
 *
 * Real-audit fix (v7) — a rule that CoreFramework's evidence-class
 * partitioning (see coreFramework.ts's enrichAndPartitionRule) split into
 * multiple output rules shares the exact same `description` text VERBATIM
 * across every partition, by design (only which citations/scope back each
 * copy differs). If one partition is VERIFIED_GLOBAL, its SCOPED or
 * UNVERIFIED sibling partition's description is therefore word-for-word
 * (or near enough to trip the overlap check) identical to a description
 * that DOES also carry independently-sufficient global evidence — a real
 * dry run found this produced a false leak (the "polarity-inversion rule"
 * in key_levels): playbook prose describing the genuinely-global partition
 * overlapped its own non-global sibling's description and got flagged as
 * broadening, even though the described content is not actually
 * restriction-only. Descriptions that ALSO appear as a VERIFIED_GLOBAL
 * rule anywhere in the pool are excluded here for exactly that reason —
 * this only ever REMOVES a candidate from the returned list (a real
 * restriction with no globally-backed sibling is still caught unchanged).
 */
export function collectNonGlobalRuleDescriptions(coreFramework: CoreFramework, canonicalStrategies: CanonicalStrategy[] = []): TaggedNonGlobalRule[] {
  const candidates: TaggedNonGlobalRule[] = [];
  const globallyBackedDescriptions = new Set<string>();
  const visit = (rule: { description: string; scope: KnowledgeItemScope | null; scopeBasis?: ScopeBasis }) => {
    const basis = effectiveScopeBasis(rule);
    if (basis === "VERIFIED_GLOBAL") globallyBackedDescriptions.add(rule.description);
    else if (basis === "SCOPED" || basis === "UNVERIFIED") candidates.push({ description: rule.description, basis });
  };
  for (const section of coreFramework.sections) {
    for (const rule of section.rules) visit(rule);
  }
  for (const strategy of canonicalStrategies) {
    for (const category of STRATEGY_RULE_CATEGORIES) {
      for (const rule of strategy[category]) visit(rule);
    }
  }
  return candidates.filter((candidate) => !globallyBackedDescriptions.has(candidate.description));
}
