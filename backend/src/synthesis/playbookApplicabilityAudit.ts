import type { KnowledgeItemScope } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";
import type { TaggedNonGlobalRule } from "./frameworkScopeSplit.js";
import type { ApplicabilityLeak, ApplicabilityPolicyValue, PlaybookSection } from "./schema.js";

/**
 * Real-audit fix (Phase 3.5B v3-v5) — deterministic safety net for playbook
 * applicability, layered on TOP OF (never instead of) two PRIMARY,
 * provenance-based fixes: (1) "master_trading_checklist" is no longer
 * Gemini-authored at all — built only from VERIFIED_GLOBAL material (see
 * runSynthesis.ts) — so cross-contamination is structurally impossible for
 * it; (2) every remaining section carries its OWN derived
 * scope/scopeBasis/applicabilityPolicy from real citations (see
 * playbook.ts's enrichSection), so THIS module's job is narrower than it
 * used to be: catch prose that broadens what a section's own citations (or
 * the wider course's known scoped material) already tell us, and catch a
 * SCOPED section that fails to state its own applicability. Neither of
 * these is generic NLP classification — every signal is a literal,
 * deterministic comparison against real, already-known data (a scope
 * array's own values, a non-global rule's own description, a section's own
 * derived scopeBasis), per this codebase's stated preference for a safer
 * data-lineage-adjacent check over free-text understanding. Prose matching
 * is explicitly the SECONDARY safeguard here — the section's own derived
 * `scopeBasis` (provenance) is the PRIMARY signal.
 *
 * v3 flagged only "master_trading_checklist" (by section key) for literal
 * scope-vocabulary leaks. v4 widened this to every section and added a
 * word-overlap check against non-global rule descriptions, but as ONE
 * undifferentiated "universalSectionScopeLeaks" gate. A FOURTH real dry
 * run showed that gate was simultaneously too broad — flagging
 * "scoped_execution_checklists", "conflicts_and_ambiguities", and
 * "strategy_variants" for legitimately discussing scoped/conflicting
 * material — and still imprecise. v5 (current) replaces it with THREE
 * differently-severe, policy-aware categories:
 *
 *   - universalApplicabilityLeaks — a DESCRIPTIVE_MIXED section broadened
 *     KNOWN scoped evidence (its own derived scopeBasis is SCOPED, or its
 *     prose matches real scoped vocabulary/rule text) into an absolute
 *     claim. The clearest failure — we KNOW the true restriction.
 *   - unverifiedUniversalClaims — a DESCRIPTIVE_MIXED section asserted
 *     something as universal resting only on UNVERIFIED evidence (its own
 *     derived scopeBasis is UNVERIFIED, or it overlaps only UNVERIFIED
 *     rule text) — a real gap, but weaker than contradicting known
 *     evidence.
 *   - scopedApplicabilityLeaks — a SCOPED-policy section (e.g.
 *     "scoped_execution_checklists") whose own derived scope is real but
 *     is used with absolute-claim language and NEVER states that scope
 *     ANYWHERE in the section — "absolute wording needs its declared
 *     scope stated somewhere in the section."
 *
 * CONFLICT_DOCUMENTATION and VERIFIED_GLOBAL_ONLY sections are exempt
 * entirely — see playbook.ts's SECTION_POLICY.
 *
 * Real-audit fix (v6) — a FIFTH real dry run found two false positives in
 * this module, both from the same root cause: checking too NARROW a slice
 * of real, legitimate prose against too STRICT a co-occurrence rule.
 *   - "scoped_execution_checklists" was flagged even though the section
 *     explicitly declares applicability for each of its sub-checklists —
 *     just not always in the SAME SENTENCE as the absolute-claim word.
 *     The check now looks for the declared scope stated ANYWHERE in the
 *     section (a real course writes "For options day trading: ... always
 *     ..." as two sentences, not one) instead of requiring same-sentence
 *     co-occurrence — still zero false negatives against real broadening,
 *     since genuine broadening never states the scope in the section at
 *     all (see the tests for the five must-still-catch scenarios).
 *   - "strategy_variants" was flagged by the DESCRIPTIVE_MIXED
 *     `ownBasis === "SCOPED"` trigger alone, even when the section's own
 *     prose explicitly names the parent strategy its scoped mechanics
 *     belong to. That trigger is now suppressed when the section's own
 *     declared scope terms are stated somewhere in its prose — but ONLY
 *     for that one trigger; matchedTerms/matchedScopedRules/
 *     matchedUnverifiedRules (comparisons against OTHER, undisclosed
 *     non-global rules) are untouched, so real broadening that happens to
 *     also mention its own declared scope is still caught by those.
 *
 * Real-audit fix (v7) — a SIXTH real dry run found four more false
 * positives (key_levels, setup_selection, risk_management,
 * target_selection), all from the SAME root cause the matchedTerms signal
 * had from the start: it fires whenever a course-wide-known scoped
 * vocabulary term appears ANYWHERE in a section's content, together with an
 * absolute-claim word appearing ANYWHERE ELSE in that same section —
 * completely unrelated occurrences, no requirement the two actually
 * describe the same claim. A DESCRIPTIVE_MIXED section legitimately mixes
 * several separately-qualified rules (e.g. "Beginners should risk 1%.
 * Experienced traders should target 2R on every trade." — "2R... every
 * trade" is itself backed by genuinely global evidence and is not what
 * "beginners"/"experienced" restrict), so a pure section-wide co-occurrence
 * check flags the section merely for discussing ANY scoped concept BY
 * NAME, however properly it's labeled. matchedTerms is now diagnostic only
 * (still reports which vocabulary terms are literally present, for the
 * leak payload); the actual trigger is a SENTENCE-level check — an
 * absolute-claim sentence is only a leak when THAT sentence itself names no
 * qualifying term (course-wide vocabulary OR this section's own declared
 * scope, which can include a strategy name). This is the same
 * co-occurrence mechanism the SCOPED-policy branch already uses, just at
 * sentence instead of whole-section granularity — DESCRIPTIVE_MIXED
 * sections legitimately mix several independently-qualified claims, unlike
 * a SCOPED section's single declared scope covering the whole section, so
 * the finer granularity is what's actually correct here. Real broadening
 * remains caught unweakened: an unqualified absolute sentence with no local
 * qualifier still trips this signal, and matchedScopedRules/
 * matchedUnverifiedRules/unexplainedOwnScope (paraphrase-overlap against a
 * SPECIFIC known non-global rule, and un-stated own-scope) are untouched.
 * A second, related false positive (key_levels) came from
 * frameworkScopeSplit.ts's collectNonGlobalRuleDescriptions matching a
 * rule's SCOPED partition even when that same description ALSO has a
 * VERIFIED_GLOBAL sibling partition (partitioning shares one description
 * verbatim across every partition) — fixed at the source in that function,
 * not here.
 *
 * Real-audit fix (v8) — v7's fix above (hasIndependentGlobalEvidence, a
 * SECTION-level "does this section cite ANY VERIFIED_GLOBAL material at
 * all" flag) over-corrected: an EIGHTH real dry run found it excused an
 * UNRELATED non-global sentence merely because the SAME section also
 * happened to cite something genuinely global elsewhere — a real leak
 * (market_context_regime's "trade strictly in the direction of the
 * dominant higher-timeframe trend...never trade counter-trend", resting on
 * SCOPED beginner + UNVERIFIED evidence with NO VERIFIED_GLOBAL partition
 * at all) went undetected because the section's aggregate
 * hasIndependentGlobalEvidence was true from a DIFFERENT, unrelated rule.
 * `hasIndependentGlobalEvidence` is removed entirely (see
 * PlaybookSectionSchema — it existed only to support this now-abandoned
 * section-level shortcut). Applicability is evaluated at the SENTENCE
 * level instead: a specific unqualified-absolute-claim sentence is only
 * excused when THAT SENTENCE's own words closely overlap ("matches") a
 * KNOWN VERIFIED_GLOBAL rule description (the new `globalRules` parameter,
 * mirroring `nonGlobalRules`'s existing shape/purpose) — not merely
 * because the section cites something global somewhere else.
 * matchedScopedRules/matchedUnverifiedRules (paraphrase-overlap against a
 * SPECIFIC known non-global rule) and unexplainedOwnScope (own-scope
 * un-stated) are otherwise unchanged from v6 — restoring the exact
 * pre-v7-hasIndependentGlobalEvidence behavior for those two signals, since
 * the sentence-level global-match check is what correctly replaces the
 * section-level shortcut's intended job.
 */
// v8 — added "must"/"required to": the real market_context_regime and confirmation-framework
// leaks both use "must" ("trade strictly...never trade counter-trend", "Traders must wait for
// candle closure...") to state an absolute requirement, without any of "all/every/always/etc."
// A "must"-worded sentence is exactly as much an absolute/general requirement as one using
// "always" — the SAME sentence-level qualification/matching logic below applies either way, so
// widening this detection gate doesn't change what counts as "properly qualified" or "genuinely
// global," only what counts as a claim worth checking in the first place.
const ABSOLUTE_CLAIM_PATTERN =
  /\b(all|every|always|universal(?:ly)?|without exception|in all cases|regardless of|no matter (?:the|what)|must|required to)\b/i;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by", "from", "as", "is", "are",
  "was", "were", "be", "been", "being", "this", "that", "these", "those", "it", "its", "their", "your", "you", "we",
  "our", "they", "he", "she", "his", "her", "not", "no", "never", "always", "every", "all", "universal", "universally",
  "without", "exception", "regardless", "matter", "what", "will", "shall", "should", "must", "can", "could", "may",
  "might", "do", "does", "did", "done", "before", "during", "after", "across", "each", "any", "some", "into", "onto",
  "over", "under", "than", "then", "so", "such", "case", "cases",
]);

function significantWords(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? [];
  return new Set(matches.filter((w) => !STOPWORDS.has(w)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fraction of `ruleWords` that also appear in `sectionWords` — measured against the RULE's own word count so a short, precise rule needs to be substantially echoed to trigger a match. */
function overlapRatio(sectionWords: Set<string>, ruleWords: Set<string>): number {
  if (ruleWords.size === 0) return 0;
  let hits = 0;
  for (const w of ruleWords) if (sectionWords.has(w)) hits++;
  return hits / ruleWords.size;
}

const OVERLAP_THRESHOLD = 0.5;

function containsTerm(text: string, term: string): boolean {
  if (term.length < 3) return false;
  return new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text);
}

// Real-audit fix (v6) — includes `strategies`, alongside the other four
// dimensions this always modeled: a SCOPED section restricted to a named
// strategy (the "strategy_variants" case — Inside Bar, ORB, etc.) needs its
// own declared scope recognized in prose exactly like a market/timeframe/
// session/trader-profile restriction does.
function scopeTerms(scope: KnowledgeItemScope): string[] {
  return [...scope.marketsOrInstruments, ...scope.sessions, ...scope.timeframes, ...scope.traderProfiles, ...scope.strategies].map((v) => v.toLowerCase());
}

/** Naive sentence split — deterministic, good enough for a lexical co-occurrence check (never used for anything beyond "does this sentence mention that term"). */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

export interface ApplicabilityAuditInput {
  key: string;
  content: string;
  scope?: KnowledgeItemScope;
  scopeBasis?: PlaybookSection["scopeBasis"];
  applicabilityPolicy?: ApplicabilityPolicyValue;
}

/** A rule known to be VERIFIED_GLOBAL — the mirror of TaggedNonGlobalRule, used only for the sentence-level "does this specific claim have genuine global backing" check (v8). */
export interface TaggedGlobalRule {
  description: string;
}

export interface ApplicabilityAuditResult {
  universalApplicabilityLeaks: ApplicabilityLeak[];
  unverifiedUniversalClaims: ApplicabilityLeak[];
  scopedApplicabilityLeaks: ApplicabilityLeak[];
}

export function findPlaybookApplicabilityLeaks(
  sections: ApplicabilityAuditInput[],
  scopeVocabulary: Set<string>,
  nonGlobalRules: TaggedNonGlobalRule[] = [],
  /** v8 — descriptions of rules known to be VERIFIED_GLOBAL, for the sentence-level "is THIS specific claim genuinely global-backed" check below. Mirrors nonGlobalRules's shape/purpose. */
  globalRules: TaggedGlobalRule[] = [],
): ApplicabilityAuditResult {
  const universalApplicabilityLeaks: ApplicabilityLeak[] = [];
  const unverifiedUniversalClaims: ApplicabilityLeak[] = [];
  const scopedApplicabilityLeaks: ApplicabilityLeak[] = [];

  const scopedRules = nonGlobalRules.filter((r) => r.basis === "SCOPED").map((r) => ({ description: r.description, words: significantWords(r.description) }));
  const unverifiedRules = nonGlobalRules.filter((r) => r.basis === "UNVERIFIED").map((r) => ({ description: r.description, words: significantWords(r.description) }));
  const globalRuleWordSets = globalRules.map((r) => ({ description: r.description, words: significantWords(r.description) }));

  for (const section of sections) {
    const policy = section.applicabilityPolicy ?? "DESCRIPTIVE_MIXED";
    if (policy === "CONFLICT_DOCUMENTATION" || policy === "VERIFIED_GLOBAL_ONLY") continue;

    if (policy === "SCOPED") {
      if (section.scope && isKnowledgeItemScoped(section.scope) && ABSOLUTE_CLAIM_PATTERN.test(section.content)) {
        const terms = scopeTerms(section.scope);
        // Real-audit fix (v6) — declared scope stated ANYWHERE in the section
        // (not just the same sentence as the absolute-claim word) satisfies
        // "this section states its own applicability." Real courses write
        // scope and absolute language in adjacent-but-separate sentences per
        // sub-checklist; only a section that NEVER states its declared scope
        // is a genuine leak.
        const scopeStatedSomewhere = terms.some((t) => containsTerm(section.content, t));
        if (!scopeStatedSomewhere) {
          scopedApplicabilityLeaks.push({ sectionKey: section.key, matchedTerms: terms.sort(), matchedNonGlobalRules: [] });
        }
      }
      continue; // SCOPED sections are otherwise exempt — scoped content/vocabulary is expected here.
    }

    // policy === "DESCRIPTIVE_MIXED" from here on — the only policy left that isn't fully exempt.
    if (!ABSOLUTE_CLAIM_PATTERN.test(section.content)) continue; // no universal claim made — nothing to check.

    const matchedTerms = new Set<string>();
    for (const term of scopeVocabulary) {
      if (containsTerm(section.content, term)) matchedTerms.add(term);
    }

    // Real-audit fix (v7) — matchedTerms above (retained for the leak payload's diagnostic
    // "matchedTerms" field) no longer gates the leak by itself: it was true whenever a scoped
    // term appeared ANYWHERE in the section, regardless of whether it actually qualifies the
    // sentence making the absolute claim. The refined trigger requires BOTH: (1) the section
    // actually discusses some real, known-restricted concept at all (course-wide vocabulary, or
    // this section's own declared scope — which can be a strategy name) — a section with NO
    // known restricted material behind it is never a leak via this signal, only possibly via
    // matchedScopedRules/matchedUnverifiedRules or ownBasis below; and (2) some sentence makes
    // an absolute claim WITHOUT naming any qualifying term in that SAME sentence. A
    // properly-qualified section ("Beginners should risk 1%. Experienced traders should target
    // 2R on every trade.", or "The Gap Fill target applies within Gap Fill setups specifically.")
    // never trips this, since each absolute-claim sentence names its own qualifier.
    //
    // Real-audit fix (v8) — that sentence-level heuristic ALONE still over-fires on a section
    // that mixes properly-qualified scoped material with a SEPARATE, genuinely global claim (the
    // "polarity-inversion"/"2R"/"narrow-specialization" real false positives): the global claim's
    // own sentence legitimately has no local qualifier — it doesn't need one — yet OTHER,
    // properly-qualified sentences in the same section make knownRestrictedConceptPresent true.
    // v7 tried to fix this with a SECTION-level "does this section cite ANY global material"
    // shortcut, which then caused a real false NEGATIVE (market_context_regime) by excusing an
    // UNRELATED non-global sentence just because the section also happened to cite something
    // global elsewhere. The correct fix is evaluated per SENTENCE instead: an unqualified
    // absolute-claim sentence is excused only when THAT SPECIFIC sentence's own words closely
    // overlap a KNOWN VERIFIED_GLOBAL rule description (globalRuleWordSets, mirroring
    // matchedScopedRules/matchedUnverifiedRules's existing overlap technique) — never merely
    // because the section cites something global somewhere else.
    const localQualifierTerms = new Set<string>([...scopeVocabulary, ...(section.scope && isKnowledgeItemScoped(section.scope) ? scopeTerms(section.scope) : [])]);
    const knownRestrictedConceptPresent = [...localQualifierTerms].some((term) => containsTerm(section.content, term));
    const hasUnqualifiedAbsoluteClaim =
      knownRestrictedConceptPresent &&
      splitSentences(section.content).some((sentence) => {
        if (!ABSOLUTE_CLAIM_PATTERN.test(sentence)) return false;
        if ([...localQualifierTerms].some((term) => containsTerm(sentence, term))) return false; // this sentence states its own applicability/scope
        const sentenceWords = significantWords(sentence);
        const matchesGlobalRule = globalRuleWordSets.some((rule) => rule.words.size > 0 && overlapRatio(sentenceWords, rule.words) >= OVERLAP_THRESHOLD);
        return !matchesGlobalRule; // only a leak when THIS sentence has no genuine global backing either
      });

    const sectionWords = significantWords(section.content);
    const matchedScopedRules = new Set<string>();
    for (const rule of scopedRules) {
      if (rule.words.size > 0 && overlapRatio(sectionWords, rule.words) >= OVERLAP_THRESHOLD) matchedScopedRules.add(rule.description);
    }
    const matchedUnverifiedRules = new Set<string>();
    for (const rule of unverifiedRules) {
      if (rule.words.size > 0 && overlapRatio(sectionWords, rule.words) >= OVERLAP_THRESHOLD) matchedUnverifiedRules.add(rule.description);
    }

    // PRIMARY signal: this section's OWN citations already tell us it draws on non-global material.
    const ownBasis = section.scopeBasis;

    // Real-audit fix (v6) — a section legitimately marked SCOPED (e.g.
    // "strategy_variants") is not a leak on that basis ALONE when its own
    // prose states its own declared scope (e.g. names the parent strategy
    // its mechanics belong to) — it is doing exactly what a SCOPED section
    // should. This suppresses ONLY the ownBasis==="SCOPED" trigger; real
    // broadening is still caught below via matchedTerms/matchedScopedRules,
    // which compare against OTHER, undisclosed non-global rules.
    //
    // v7 also gated this on "the section has independent VERIFIED_GLOBAL evidence" — reverted in
    // v8 (see this file's top doc comment): that section-level shortcut is what caused the real
    // market_context_regime false negative, excusing this section's genuinely non-global claims
    // merely because the section ALSO happened to cite something global elsewhere. Sentence-level
    // matching (hasUnqualifiedAbsoluteClaim above) is what correctly distinguishes "this specific
    // claim is global" now, so this signal is restored to its exact pre-v7 form.
    const ownScopeStatedInProse = section.scope && isKnowledgeItemScoped(section.scope) && scopeTerms(section.scope).some((t) => containsTerm(section.content, t));
    const unexplainedOwnScope = ownBasis === "SCOPED" && !ownScopeStatedInProse;

    if (hasUnqualifiedAbsoluteClaim || matchedScopedRules.size > 0 || unexplainedOwnScope) {
      universalApplicabilityLeaks.push({ sectionKey: section.key, matchedTerms: [...matchedTerms].sort(), matchedNonGlobalRules: [...matchedScopedRules].sort() });
    } else if (matchedUnverifiedRules.size > 0 || ownBasis === "UNVERIFIED") {
      unverifiedUniversalClaims.push({ sectionKey: section.key, matchedTerms: [], matchedNonGlobalRules: [...matchedUnverifiedRules].sort() });
    }
  }

  return { universalApplicabilityLeaks, unverifiedUniversalClaims, scopedApplicabilityLeaks };
}
