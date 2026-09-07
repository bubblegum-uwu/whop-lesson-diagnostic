import type { KnowledgeItemScope } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import type { CoreFramework } from "./schema.js";

/**
 * Shared by decisionFramework.ts and playbook.ts (Real-audit fix, Phase
 * 3.5B) — splits coreFramework's pooled rules into two disjoint pools by
 * their already-known, deterministically-attached `scope` (see
 * canonicalStrategy.ts/coreFramework.ts's enrichment — scope is NEVER
 * asked of Gemini for a SynthesizedRule, only derived from cited sources).
 * This split itself is 100% deterministic; only how a given stage's prompt
 * USES the two pools is left to the model. Extracted to a shared module so
 * both stages that need "genuinely global vs. scoped" framework material
 * use the exact same derivation rather than two copies that could drift.
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
    const globalRules = section.rules.filter((r) => r.scope == null).map((r): CondensedRule => ({ description: r.description, scope: null }));
    const scopedRules = section.rules.filter((r) => r.scope != null).map((r): CondensedRule => ({ description: r.description, scope: r.scope }));
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
 * scoped terminology into its prose.
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
