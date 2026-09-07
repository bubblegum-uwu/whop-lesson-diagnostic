import type { KnowledgeItem, KnowledgeItemScope } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";

/**
 * Real-audit fix (Phase 3.5B v4) — a THIRD real 28-lesson dry run showed
 * that "scope is derived from cited sources, never self-reported" (the v3
 * fix) is still not enough on its own: a CoreFramework/canonical-strategy
 * rule can cite a MIX of (a) scope-AWARE evidence (a Phase 3.5A
 * KnowledgeItem, which always carries a real, already-known scope) and (b)
 * scope-BLIND evidence (a pre-3.5B per-lesson `Strategy` rule — market
 * context/confirmation/stop-loss/etc. — which was never scope-tagged at
 * all, because scope tagging is a KnowledgeItem-only concept). The old
 * derivation only ever unioned in scope from (a); citing ONLY (b), or a mix
 * where (b) happens to dominate the rule's actual content, still produced
 * `scope: null` — read downstream as "verified global" — even though we
 * have literally no idea whether that content is scoped, because the
 * source never carried scope metadata to begin with. This is exactly how a
 * rule mentioning "Intraday Fundamentals" / "QQQ/SPY relative strength"
 * surfaced with `scope: null` in a real course: it was built from
 * scope-blind `market_context_rules` citations, not from a scope-aware
 * KnowledgeItem.
 *
 * Fix: track WHY a rule's scope union came out empty, not just THAT it did.
 * `scopeBasis` distinguishes:
 *   - "VERIFIED_GLOBAL" — every citation that contributed real evidence was
 *     a scope-aware KnowledgeItem, and none of them were scoped. Genuinely
 *     safe to treat as course-wide.
 *   - "SCOPED" — at least one cited KnowledgeItem was scoped; `scope` is
 *     the union of their own already-known restrictions, exactly as
 *     before.
 *   - "UNVERIFIED" — the rule cites no scope-aware evidence at all (either
 *     zero valid citations, or only scope-blind ones). We do not know this
 *     rule's true applicability, so it must never be treated as safely
 *     global — same principle as decisionScopeAudit.ts's "ungrounded"
 *     reason, applied one layer upstream.
 */
export const SCOPE_BASIS_VALUES = ["VERIFIED_GLOBAL", "SCOPED", "UNVERIFIED"] as const;
export type ScopeBasis = (typeof SCOPE_BASIS_VALUES)[number];

export function unionScope(a: KnowledgeItemScope, b: KnowledgeItemScope): KnowledgeItemScope {
  const uniq = (arr: string[]) => [...new Set(arr)];
  return {
    strategies: uniq([...a.strategies, ...b.strategies]),
    marketsOrInstruments: uniq([...a.marketsOrInstruments, ...b.marketsOrInstruments]),
    timeframes: uniq([...a.timeframes, ...b.timeframes]),
    sessions: uniq([...a.sessions, ...b.sessions]),
    traderProfiles: uniq([...a.traderProfiles, ...b.traderProfiles]),
  };
}

export interface ScopeAggregationResult {
  scope: KnowledgeItemScope | null;
  scopeBasis: ScopeBasis;
  numericalValues: KnowledgeItem["numericalValues"];
  exceptions: string[];
}

/**
 * `resolve(key)` contract — the caller's citation-key namespace(s) collapse
 * to exactly three outcomes per key, which is what this function needs to
 * tell "no evidence" apart from "unknown-scope evidence" apart from
 * "scope-aware evidence":
 *   - `undefined`            — key doesn't exist at all (Gemini invented or
 *     mistyped it). Dropped defensively, contributes no evidence either way.
 *   - `{ item: undefined }`  — a REAL, known citation, but one with no
 *     KnowledgeItem behind it (a scope-blind legacy per-lesson rule).
 *     Counts as evidence that EXISTS but whose scope is unknown.
 *   - `{ item: KnowledgeItem }` — a real, scope-aware citation.
 */
export function aggregateScopeBasis(
  citedKeys: string[],
  resolve: (key: string) => { item?: KnowledgeItem } | undefined,
): ScopeAggregationResult {
  const numericalValues: KnowledgeItem["numericalValues"] = [];
  const exceptionsSet = new Set<string>();
  let scopeUnion: KnowledgeItemScope | null = null;
  let sawKnowledgeEvidence = false;
  let sawUnverifiedEvidence = false;

  for (const key of citedKeys) {
    const found = resolve(key);
    if (!found) continue;
    if (!found.item) {
      sawUnverifiedEvidence = true;
      continue;
    }
    sawKnowledgeEvidence = true;
    numericalValues.push(...found.item.numericalValues);
    for (const exception of found.item.exceptions) exceptionsSet.add(exception);
    if (isKnowledgeItemScoped(found.item.scope)) {
      scopeUnion = scopeUnion ? unionScope(scopeUnion, found.item.scope) : found.item.scope;
    }
  }

  let scopeBasis: ScopeBasis;
  if (scopeUnion) {
    scopeBasis = "SCOPED";
  } else if (sawUnverifiedEvidence) {
    // Mixing in even one scope-blind citation means global applicability is
    // NOT justified by the evidence — never diluted away by also citing
    // genuinely-global knowledge alongside it (requirement: "when source
    // evidence has materially different [certainty of] scope, do not union
    // it into a falsely global... rule").
    scopeBasis = "UNVERIFIED";
  } else if (sawKnowledgeEvidence) {
    scopeBasis = "VERIFIED_GLOBAL";
  } else {
    // No valid citation contributed anything (zero keys, or every key was
    // invented/unknown) — absence of evidence is not evidence of globality.
    scopeBasis = "UNVERIFIED";
  }

  return { scope: scopeUnion, scopeBasis, numericalValues, exceptions: [...exceptionsSet] };
}

/**
 * A rule enriched by the real pipeline (coreFramework.ts/canonicalStrategy.ts)
 * ALWAYS sets `scopeBasis` explicitly via aggregateScopeBasis above. This
 * fallback exists ONLY for hand-authored data that predates this field (test
 * fixtures built as plain object literals, never round-tripped through
 * enrichment) — it reproduces the old, simpler "null scope = global" rule so
 * such fixtures keep behaving as their authors intended, without ever
 * softening what the real pipeline now computes.
 */
export function effectiveScopeBasis(rule: { scope: KnowledgeItemScope | null; scopeBasis?: ScopeBasis }): ScopeBasis {
  if (rule.scopeBasis) return rule.scopeBasis;
  return rule.scope == null ? "VERIFIED_GLOBAL" : "SCOPED";
}
