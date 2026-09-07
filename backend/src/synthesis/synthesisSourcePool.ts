import type { KnowledgeItemScope } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import { unionScope, effectiveScopeBasis, type ScopeBasis } from "./scopeBasis.js";
import type { CanonicalStrategy, CoreFramework } from "./schema.js";

/**
 * Shared by decisionFramework.ts and playbook.ts (real-audit fix, Phase
 * 3.5B v3-v5) — the single keyed pool of every CoreFramework and
 * canonical-strategy rule a stage's output could conceivably be built
 * from/cite, plus the deterministic scope-combination logic used to derive
 * a node's/section's own scope/scopeBasis from whichever pool entries it
 * cites. Originally lived inside decisionFramework.ts; extracted once
 * playbook.ts needed the exact same pool+combination logic for its own
 * per-section provenance (v5) — two independent copies risked drifting.
 */

const EMPTY_SCOPE: KnowledgeItemScope = { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] };

/** Every canonical-strategy rule category a decision node or playbook section could plausibly be built from. Deliberately excludes `marketContext` (course-wide, already pooled via coreFramework) to avoid double-keying the same conceptual rule twice under two different pools. */
export const STRATEGY_RULE_CATEGORIES = [
  "prerequisites",
  "setup",
  "entryRules",
  "confirmationRules",
  "stopLossRules",
  "profitTargetRules",
  "tradeManagementRules",
  "invalidationRules",
  "noTradeConditions",
  "visualDiscretionaryRules",
  "riskManagementRules",
  "positionSizingRules",
  "scalingInRules",
  "scalingOutRules",
  "runnerManagementRules",
  "warnings",
] as const satisfies readonly (keyof CanonicalStrategy)[];

export interface SourcePoolEntry {
  key: string;
  description: string;
  scope: KnowledgeItemScope;
  scopeBasis: ScopeBasis;
}

/**
 * Real-audit fix (Phase 3.5B v3) — every rule a decision node or playbook
 * section could conceivably be built from, each assigned a stable
 * "k"-prefixed key. This is what lets a node's/section's applicability be
 * validated deterministically from data lineage (which rule(s) it actually
 * cites) instead of trusting Gemini's own self-reported scope.
 */
export function buildSynthesisSourcePool(
  canonicalStrategies: CanonicalStrategy[],
  coreFramework: CoreFramework,
): { poolEntries: SourcePoolEntry[]; byKey: Map<string, SourcePoolEntry> } {
  const byKey = new Map<string, SourcePoolEntry>();
  let counter = 0;
  const add = (description: string, scope: KnowledgeItemScope | null, scopeBasis: ScopeBasis | undefined) => {
    const key = `k${++counter}`;
    byKey.set(key, { key, description, scope: scope ?? EMPTY_SCOPE, scopeBasis: effectiveScopeBasis({ scope, scopeBasis }) });
  };

  for (const section of coreFramework.sections) {
    for (const rule of section.rules) add(rule.description, rule.scope, rule.scopeBasis);
  }
  for (const strategy of canonicalStrategies) {
    for (const category of STRATEGY_RULE_CATEGORIES) {
      for (const rule of strategy[category]) add(`[${strategy.name}] ${rule.description}`, rule.scope, rule.scopeBasis);
    }
  }

  return { poolEntries: [...byKey.values()], byKey };
}

/** Resolves a list of cited keys against the pool, dropping unknown/invented ones — never fabricated. */
export function resolveSourcePoolKeys(keys: string[], byKey: Map<string, SourcePoolEntry>): SourcePoolEntry[] {
  const resolved: SourcePoolEntry[] = [];
  for (const key of keys) {
    const entry = byKey.get(key);
    if (entry) resolved.push(entry);
  }
  return resolved;
}

/**
 * Combines a set of cited pool entries' own scope/scopeBasis into ONE
 * result, with the same priority scopeBasis.ts's aggregateScopeBasis uses
 * one layer upstream: a SCOPED citation dominates (its concrete
 * restriction is real and must survive); failing that, an UNVERIFIED
 * citation means the whole is NOT justified as global even though the
 * literal scope union is empty; only when every citation is
 * VERIFIED_GLOBAL (and at least one exists) does the combined result count
 * as verified global. Zero citations is UNVERIFIED — absence of evidence
 * is not evidence of globality.
 */
export function combineScopeBasis(entries: { scope: KnowledgeItemScope; scopeBasis: ScopeBasis }[]): { scope: KnowledgeItemScope; scopeBasis: ScopeBasis } {
  let scope = EMPTY_SCOPE;
  let sawUnverified = false;
  for (const entry of entries) {
    if (entry.scopeBasis === "SCOPED") {
      scope = unionScope(scope, entry.scope);
    } else if (entry.scopeBasis === "UNVERIFIED") {
      sawUnverified = true;
    }
  }
  if (isKnowledgeItemScoped(scope)) return { scope, scopeBasis: "SCOPED" };
  if (sawUnverified) return { scope, scopeBasis: "UNVERIFIED" };
  if (entries.length > 0) return { scope, scopeBasis: "VERIFIED_GLOBAL" };
  return { scope, scopeBasis: "UNVERIFIED" };
}
