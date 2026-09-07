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

/**
 * Real-audit fix (Phase 3.5B v6) — a FIFTH real 28-lesson dry run found a
 * concrete impossible classification: a CoreFramework rule reading "In
 * options day trading, scale out 50% to 80% ..." was classified
 * `scope: null, scopeBasis: VERIFIED_GLOBAL`. The v3-v5 fixes correctly
 * stopped treating "no scope-aware citation" as global — but they never
 * questioned the OTHER half of the assumption: that a scope-aware
 * KnowledgeItem's empty STRUCTURED `scope` array is itself trustworthy.
 * Phase 3.5A's structured extraction can miss a restriction that's still
 * sitting right there in the item's own text (an extraction gap — never
 * touched here, since Phase 3.5A itself is out of scope). "No structured
 * scope was extracted" and "positively verified universal applicability"
 * are NOT the same claim, and this is the deterministic check that keeps
 * them apart: a rule/evidence item can only be downgraded FROM
 * VERIFIED_GLOBAL by this, never promoted TO it, and never dropped —
 * see finalizeScopeBasis below.
 *
 * Deliberately NOT a second, independent vocabulary system: every pattern
 * here is a fixed, representative instance of one of the five dimensions
 * KnowledgeItemScope already models (marketsOrInstruments, timeframes,
 * sessions, traderProfiles, strategies) — this just recognizes them
 * lexically in prose Phase 3.5A didn't structurally tag, using the exact
 * category examples the real audit named.
 */
const EXPLICIT_APPLICABILITY_PATTERNS: RegExp[] = [
  // named instrument/market
  /\boptions?\b/i,
  /\bfutures?\b/i,
  /\bequit(?:y|ies)\b/i,
  /\bstocks?\b/i,
  /\bforex\b/i,
  /\bcrypto(?:currency)?\b/i,
  /\b(?:es|nq|mes|mnq|ym|rty)\b/,
  /\b(?:qqq|spy|spx|dia)\b/i,
  // named timeframe
  /\b\d+\s*-?\s*(?:minute|min)s?\b/i,
  /\b\d+\s*-?\s*m\b/,
  /\b\d+\s*-?\s*(?:hour|hr)s?\b/i,
  /\bdaily\b/i,
  /\bweekly\b/i,
  /\bmonthly\b/i,
  /\bintraday\b/i,
  // named session/window
  /\bpre-?market\b/i,
  /\bmarket\s+open\b/i,
  /\bmarket\s+close\b/i,
  /\bopening\s+range\b/i,
  /\b0-?dte\b/i,
  /\b9:30\b/,
  /\b(?:monday|tuesday|wednesday|thursday|friday)\b/i,
  // named trader profile (both the person-noun and the activity/style-gerund
  // form — real Gemini-authored rule text names the STYLE, e.g. "For
  // momentum day trading, ...", at least as often as the person, e.g. "day
  // traders should ...")
  /\bbeginners?\b/i,
  /\bexperienced\b/i,
  /\badvanced\b/i,
  /\bscalpers?\b/i,
  /\bscalping\b/i,
  /\bday\s+traders?\b/i,
  /\bday\s+trading\b/i,
  /\bswing\s+traders?\b/i,
  /\bswing\s+trading\b/i,
  /\bnovice\b/i,
  // named strategy/setup applicability
  /\binside\s+bar\b/i,
  /\borb\b/i,
  /\bopening\s+range\s+breakout\b/i,
  /\bb&r\b/i,
  /\bbreak\s+and\s+retest\b/i,
  /\bgap\s+fill\b/i,
  /\b84%?\s*(?:rule|re-?entry)\b/i,
];

/** True when `text` names an instrument/timeframe/session/trader-profile/strategy restriction — see EXPLICIT_APPLICABILITY_PATTERNS above. */
export function containsExplicitApplicabilityLanguage(text: string): boolean {
  return EXPLICIT_APPLICABILITY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Real-audit fix (Phase 3.5B v8) — a SEVENTH real dry run found VERIFIED_GLOBAL
 * still requires only the ABSENCE of a detected restriction, never POSITIVE
 * proof of universality. Three concrete real rules leaked through this way,
 * each backed by only ONE lesson and containing no restriction keyword at
 * all: a candle-close confirmation rule (directly contradicted by the
 * canonical Inside Bar strategy's own explicit resting buy-stop/sell-stop
 * exception), an HOD/LOD scale-out rule (session/intraday trade-management
 * guidance, not proof every strategy/timeframe uses it), and a 25%-50%
 * starter-position sizing rule (one lesson's specific technique). "No
 * restriction was detected" and "positively verified universal" are STILL
 * not the same claim even after the v6/v7 fixes — this closes that gap.
 *
 * Deliberately narrow, matching the real audit's own explicit language
 * (never generic words like "always"/"all the time"/"personally" alone,
 * which are common in scoped/single-lesson prose too and prove nothing on
 * their own) — see finalizeScopeBasis below for how this combines with
 * the distinct-lesson-count requirement.
 */
const EXPLICIT_POSITIVE_UNIVERSAL_PATTERNS: RegExp[] = [
  /\bevery\s+(?:single\s+)?trade\b/i,
  /\ball\s+trades\b/i,
  /\bwhenever\s+you'?re\s+trading\b/i,
  /\bwhenever\s+you\s+are\s+trading\b/i,
];

/** True when `text` contains EXPLICIT positive universal-applicability language (see EXPLICIT_POSITIVE_UNIVERSAL_PATTERNS above) — deliberately narrower than a generic absolute-claim check (never "always"/"all the time"/"personally" alone). */
export function containsExplicitPositiveUniversalLanguage(text: string): boolean {
  return EXPLICIT_POSITIVE_UNIVERSAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Real-audit fix (Phase 3.5B v9) — an EIGHTH real dry run found the v8
 * multi-lesson positive-proof path itself exploitable: a candle-color/
 * hide-P&L rule stayed VERIFIED_GLOBAL because it cited TWO structurally
 * unscoped KnowledgeItems from two distinct lessons — but both citations'
 * own statements openly qualify the recommendation to a SUBSET of traders
 * ("A lot of people don't like the green and red...", "Me personally...",
 * "Some people cannot actually bear to see a red candlestick...", "people
 * that are scared of candlesticks..."). Phase 3.5A's structured scope
 * extraction missed this the same way v6 found it missing instrument/
 * timeframe restrictions — except here the gap isn't a named restriction
 * dimension at all, it's PREFERENCE/SUBSET framing: "some traders find
 * this helpful" is not "every trader must do this," no matter how many
 * separate lessons independently say "some traders find this helpful."
 *
 * This is deliberately a NARROWER, DIFFERENT check from
 * containsExplicitApplicabilityLanguage above: it doesn't name a concrete
 * instrument/timeframe/session/profile/strategy (so it can't safely
 * downgrade the whole citation to "restricted, route through
 * sawUnverifiedEvidence" the way v6's check does — we don't know a
 * specific restriction, just that this specific mention doesn't prove
 * universality). It therefore only ever affects the v8 positive-proof
 * MULTI-LESSON count (see aggregateScopeBasis below) — a citation carrying
 * this language never counts as one of the ">=2 distinct lessons" a rule
 * needs, but is otherwise kept exactly as before: still real evidence,
 * still contributes its numericalValues/exceptions, still lets the rule's
 * base scopeBasis computation proceed unchanged. Explicit genuine
 * universal language ("every trade", "whenever you're trading") is a
 * completely separate, independently-sufficient path (see
 * containsExplicitPositiveUniversalLanguage above) and is NOT filtered by
 * this — a citation can carry both a "some people" hedge AND a genuine
 * universal claim elsewhere in the same statement.
 */
const CONDITIONAL_EVIDENCE_PATTERNS: RegExp[] = [
  /\bsome\s+people\b/i,
  /\ba\s+lot\s+of\s+people\b/i,
  /\bpeople\s+(?:who|that)\b/i,
  /\btraders\s+who\b/i,
  /\bfor\s+beginners?\b/i,
  /\bbeginner\s+traders?\b/i,
  /\bin\s+the\s+beginning\b/i,
  /\bme\s+personally\b/i,
  /\bpersonally\b/i,
];

/** True when `text` limits its recommendation to a subset/profile/preference rather than stating it broadly — see CONDITIONAL_EVIDENCE_PATTERNS above. Affects ONLY whether a citation counts toward the v8 positive-proof multi-lesson path (aggregateScopeBasis/finalizeScopeBasis) — never deletes evidence, never independently downgrades a basis. */
export function containsConditionalEvidenceLanguage(text: string): boolean {
  return CONDITIONAL_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The final correctness gate for VERIFIED_GLOBAL — applied to a rule's own
 * consolidated description AFTER aggregateScopeBasis has already computed
 * a basis from citations. Only ever downgrades, only ever to UNVERIFIED
 * (never SCOPED — we don't know the specific restriction, only that one
 * exists; fabricating a scope array would be worse than not knowing one),
 * and never drops the rule:
 *
 *   1. The rule's own text names a restriction Phase 3.5A's structured
 *      extraction missed (containsExplicitApplicabilityLanguage) — the
 *      exact real-audit failure.
 *   2. The rule documents a genuine methodological CONFLICT
 *      (supportLevel "CONFLICTING") — disputed evidence is never a
 *      settled universal principle safe to power a mandatory checklist,
 *      regardless of what its citations' structured scope says.
 *
 * v7 correction — coreFramework.ts's buildRuleFromKeys used to skip calling
 * this for a partitioned (evidence-class-split) rule, passing an empty
 * description instead, reasoning that the shared Gemini-authored text could
 * name a restriction belonging to a DIFFERENT partition. A real dry run
 * showed that was unsafe: every partition still emits the SAME description
 * to downstream consumers (playbook, Master Trading Checklist) — there is
 * no partition-specific text for a reader to fall back on — so if that
 * emitted text names a restriction, no partition sharing it may claim
 * VERIFIED_GLOBAL. This function itself didn't change; the caller now
 * always passes the real `description` instead of conditionally passing "".
 *
 * v8 addition — requirement 3: an otherwise-eligible rule ALSO needs
 * POSITIVE proof of universality, not merely the absence of a detected
 * restriction:
 *   1. Support from at least TWO DISTINCT lesson IDs whose evidence is
 *      itself unscoped/unrestricted (`unscopedEvidenceLessonIds` — passed
 *      through from aggregateScopeBasis, which is the only place that
 *      knows which citations contributed "good" evidence and from which
 *      lesson; counted by distinct value here, never by citation count
 *      from the same lesson); OR
 *   2. Explicit positive universal applicability language
 *      (containsExplicitPositiveUniversalLanguage) naming the rule itself
 *      — checked against BOTH the final description and (via
 *      `citationHadPositiveLanguage`, also from aggregateScopeBasis)
 *      each contributing citation's own statement, since Gemini's
 *      consolidated wording and a single lesson's own quoted rule can
 *      each independently carry it.
 * If uncertain, UNVERIFIED — conservative omission from the Master
 * Trading Checklist is correct; the rule, its evidence, and its
 * provenance are never dropped, only reclassified. Both new parameters
 * default to "no proof available" so every existing call site (and every
 * pre-v8 hand-built test fixture) keeps its prior behavior unless it
 * explicitly opts in by passing them.
 */
export function finalizeScopeBasis(
  basis: ScopeBasis,
  description: string,
  supportLevel?: string,
  unscopedEvidenceLessonIds: number[] = [],
  citationHadPositiveLanguage = false,
): ScopeBasis {
  if (basis !== "VERIFIED_GLOBAL") return basis;
  if (supportLevel === "CONFLICTING") return "UNVERIFIED";
  if (containsExplicitApplicabilityLanguage(description)) return "UNVERIFIED";
  const distinctLessons = new Set(unscopedEvidenceLessonIds).size;
  const hasPositiveProof =
    distinctLessons >= 2 || citationHadPositiveLanguage || containsExplicitPositiveUniversalLanguage(description);
  if (!hasPositiveProof) return "UNVERIFIED";
  return basis;
}

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
  /** v8 — distinct lesson IDs whose evidence contributed to `sawKnowledgeEvidence` below (unscoped, unrestricted KnowledgeItem citations only) — the raw material finalizeScopeBasis's positive-proof requirement counts distinct values from. Meaningless when scopeBasis isn't VERIFIED_GLOBAL. */
  unscopedEvidenceLessonIds: number[];
  /** v8 — true when at least one of those same "good" citations' own statement contains explicit positive universal-applicability language (containsExplicitPositiveUniversalLanguage). */
  citationHadPositiveLanguage: boolean;
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
 * `lessonId` is required regardless of which of the three above applies —
 * every real citation (known-key) is always traceable to the lesson it came
 * from (v8 — needed to count DISTINCT lessons for the positive-proof
 * requirement; never a citation count from the same lesson).
 */
export function aggregateScopeBasis(
  citedKeys: string[],
  resolve: (key: string) => { item?: KnowledgeItem; lessonId: number } | undefined,
): ScopeAggregationResult {
  const numericalValues: KnowledgeItem["numericalValues"] = [];
  const exceptionsSet = new Set<string>();
  const unscopedEvidenceLessonIds = new Set<number>();
  let citationHadPositiveLanguage = false;
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
    if (isKnowledgeItemScoped(found.item.scope)) {
      scopeUnion = scopeUnion ? unionScope(scopeUnion, found.item.scope) : found.item.scope;
    } else if (containsExplicitApplicabilityLanguage(found.item.statement)) {
      // Real-audit fix (v6) — this citation's STRUCTURED scope is empty, but
      // its own statement names a restriction Phase 3.5A's extraction
      // missed (e.g. "In options day trading, scale out 50% to 80%...").
      // Route it the same way as a scope-blind legacy citation — real
      // evidence that EXISTS, but never counted toward "verified global".
      sawUnverifiedEvidence = true;
      continue;
    }
    sawKnowledgeEvidence = true;
    // Real-audit fix (v9) — a citation whose own statement limits the recommendation to a
    // subset/profile/preference ("a lot of people...", "me personally...", "some people
    // cannot...") never counts toward the >=2-distinct-lesson positive-proof requirement,
    // even though it's structurally unscoped and names no concrete restriction dimension.
    // Evidence is NOT deleted: it still contributes numericalValues/exceptions below, and the
    // base scopeBasis computation (this loop's sawKnowledgeEvidence/scopeUnion/
    // sawUnverifiedEvidence priority) is completely unaffected — only whether THIS lesson can
    // be counted as one of the required distinct broad-evidence lessons changes.
    if (!containsConditionalEvidenceLanguage(found.item.statement)) {
      unscopedEvidenceLessonIds.add(found.lessonId);
    }
    if (containsExplicitPositiveUniversalLanguage(found.item.statement)) citationHadPositiveLanguage = true;
    numericalValues.push(...found.item.numericalValues);
    for (const exception of found.item.exceptions) exceptionsSet.add(exception);
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

  return {
    scope: scopeUnion,
    scopeBasis,
    numericalValues,
    exceptions: [...exceptionsSet],
    unscopedEvidenceLessonIds: [...unscopedEvidenceLessonIds],
    citationHadPositiveLanguage,
  };
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
