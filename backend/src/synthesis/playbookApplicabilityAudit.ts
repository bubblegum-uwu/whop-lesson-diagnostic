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
 *
 * Real-audit fix (v9) — a NINTH real dry run found the DESCRIPTIVE_MIXED
 * gate was STILL too coarse in the opposite direction: nine sections
 * (course_philosophy, key_levels, setup_selection, entry_framework,
 * confirmation_framework, risk_management, target_selection,
 * strategy_variants, common_mistakes_warnings) were false-positive-flagged,
 * while a real leak (pre_market_preparation) went uncaught. The remaining
 * two triggers from v6-v8 — `unexplainedOwnScope` (fires on the section's
 * own AGGREGATE `scopeBasis` alone) and the vocabulary-presence fallback
 * inside `hasUnqualifiedAbsoluteClaim` (fires merely because a known
 * scoped-vocabulary TERM is present somewhere) — are BOTH removed as
 * independent triggers: neither actually proves a SPECIFIC claim broadens
 * SPECIFIC non-global content, which is the only thing worth flagging.
 * combineScopeBasis's "SCOPED dominates" priority means a section citing
 * one genuinely-scoped rule alongside plenty of properly-qualified or
 * VERIFIED_GLOBAL material still reads aggregate "SCOPED" — that alone
 * proves nothing about whether the section's PROSE broadens anything.
 *
 * Replaced with exactly two mechanisms, both requiring an ACTUAL matched
 * rule (never bare vocabulary or bare ownBasis):
 *   (A) sentence-level — a specific sentence uses generalizing language
 *       (GENERALIZING_LANGUAGE_PATTERN, widened from v8's
 *       ABSOLUTE_CLAIM_PATTERN to also recognize "as a general baseline",
 *       "as a foundational principle", "course-wide default", "dictates",
 *       "used exclusively", "govern", "never", "strictly"), closely
 *       overlaps a KNOWN SCOPED/UNVERIFIED rule description, and does not
 *       itself state a qualifying term (course vocabulary, or this
 *       section's own declared scope/strategy name). Once a real
 *       SCOPED/UNVERIFIED match exists, it ALWAYS flags — v8's separate
 *       "known-global rule" escape hatch is removed here (see below).
 *   (B) collection-declaration — a sentence explicitly declares a
 *       FOLLOWING collection universal (COLLECTION_DECLARATION_PATTERNS —
 *       "govern all...", "all playbook operations", "course-wide for all
 *       trades", "the following...apply to all/every..."); when present,
 *       the WHOLE section is checked for non-global rule overlap (the
 *       declared-universal collection's actual restricted members usually
 *       sit in list items AFTER the declaring sentence, not overlapping it
 *       directly, so per-sentence matching alone would miss them).
 * Both mechanisms are otherwise the SAME overlap technique already used
 * throughout this file; only what triggers them changed.
 *
 * v9 ALSO removes v8's `globalRules` parameter/escape hatch entirely: a
 * NINTH real dry run found it could suppress a genuine leak when a single
 * sentence mixes an erased restriction with genuinely global wording
 * ("Always risk no more than 1% [restricted]...and target at least a two R
 * multiple [global]") — the global portion's overlap ratio could
 * numerically outscore the real, still-erased restriction's, hiding it
 * entirely. Mechanism A no longer has any weaker, bare-vocabulary trigger
 * left for that escape hatch to rescue a genuinely-global sentence from —
 * it only ever flags when a sentence ACTUALLY overlaps a specific known
 * SCOPED/UNVERIFIED rule, so a purely-global sentence (no such overlap) is
 * already correctly left unflagged with no extra check needed, and a real
 * match now always wins regardless of any competing global reading.
 */
// v8 — added "must"/"required to": the real market_context_regime and confirmation-framework
// leaks both use "must" ("trade strictly...never trade counter-trend", "Traders must wait for
// candle closure...") to state an absolute requirement, without any of "all/every/always/etc."
// A "must"-worded sentence is exactly as much an absolute/general requirement as one using
// "always" — the SAME sentence-level qualification/matching logic below applies either way, so
// widening this detection gate doesn't change what counts as "properly qualified" or "genuinely
// global," only what counts as a claim worth checking in the first place.
//
// v9 — renamed from ABSOLUTE_CLAIM_PATTERN and further widened with "as a general baseline",
// "course-wide default", "dictates", "used exclusively", "govern", "never", "strictly", "as a
// foundational principle" — real leak wording (higher_timeframe_framework's
// "dictates...used exclusively", pre_market_preparation's "as a general baseline",
// market_context_regime's "As a foundational principle, trade strictly...never trade
// counter-trend") that named no word from the original narrower list at all.
const GENERALIZING_LANGUAGE_PATTERN =
  /\b(all|every|always|never|strictly|universal(?:ly)?|without exception|in all cases|regardless of|no matter (?:the|what)|must|required to|as a general baseline|as a foundational principle|course-wide default|dictates?|used exclusively|govern(?:s)?)\b/i;

/**
 * v9 — a NARROWER pattern than GENERALIZING_LANGUAGE_PATTERN, for mechanism
 * (B) only (see this file's top doc comment): a sentence that explicitly
 * declares a FOLLOWING collection of rules/steps universal, e.g. "The
 * following explicit no-trade filters govern all playbook operations."
 * The real no_trade_conditions leak is exactly this shape — the declaring
 * sentence itself names no specific restricted mechanic (so per-sentence
 * overlap matching against it alone finds nothing), but the LIST it
 * introduces does.
 */
const COLLECTION_DECLARATION_PATTERNS: RegExp[] = [
  /\bgovern(?:s)?\s+all\b/i,
  /\ball\s+playbook\s+operations\b/i,
  /\bcourse-?wide\s+(?:default\s+)?for\s+all\s+trades\b/i,
  /\bthe\s+following[^.!?]{0,120}\b(?:apply|applies)\s+to\s+(?:all|every)\b/i,
];

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "at", "by", "from", "as", "is", "are",
  "was", "were", "be", "been", "being", "this", "that", "these", "those", "it", "its", "their", "your", "you", "we",
  "our", "they", "he", "she", "his", "her", "not", "no", "never", "always", "every", "all", "universal", "universally",
  "without", "exception", "regardless", "matter", "what", "will", "shall", "should", "must", "can", "could", "may",
  "might", "do", "does", "did", "done", "before", "during", "after", "across", "each", "any", "some", "into", "onto",
  "over", "under", "than", "then", "so", "such", "case", "cases",
]);

/** Exported for reuse by decisionScopeAudit.ts's readableSteps check (v9, Part 3) — the same lexical-overlap technique applies unchanged to a plain-text step as it does to a playbook sentence. */
export function significantWords(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z][a-z']{2,}/g) ?? [];
  return new Set(matches.filter((w) => !STOPWORDS.has(w)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fraction of `ruleWords` that also appear in `sectionWords` — measured against the RULE's own word count so a short, precise rule needs to be substantially echoed to trigger a match. Exported for reuse by decisionScopeAudit.ts (v9, Part 3). */
export function overlapRatio(sectionWords: Set<string>, ruleWords: Set<string>): number {
  if (ruleWords.size === 0) return 0;
  let hits = 0;
  for (const w of ruleWords) if (sectionWords.has(w)) hits++;
  return hits / ruleWords.size;
}

export const OVERLAP_THRESHOLD = 0.5;

/** v9 — the single best-matching rule (by overlap ratio, at or above OVERLAP_THRESHOLD) among `rules`, or null if none clears the bar. Used at sentence granularity by mechanism (A) in findPlaybookApplicabilityLeaks below, to pick the ONE rule a given sentence most closely echoes rather than treating every rule above the threshold as equally matched. Exported for reuse by decisionScopeAudit.ts's readableSteps check (v9, Part 3). */
export function bestOverlapMatch(sentenceWords: Set<string>, rules: { description: string; words: Set<string> }[]): { description: string; ratio: number } | null {
  let best: { description: string; ratio: number } | null = null;
  for (const rule of rules) {
    if (rule.words.size === 0) continue;
    const ratio = overlapRatio(sentenceWords, rule.words);
    if (ratio >= OVERLAP_THRESHOLD && (!best || ratio > best.ratio)) best = { description: rule.description, ratio };
  }
  return best;
}

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

export interface ApplicabilityAuditResult {
  universalApplicabilityLeaks: ApplicabilityLeak[];
  unverifiedUniversalClaims: ApplicabilityLeak[];
  scopedApplicabilityLeaks: ApplicabilityLeak[];
}

export function findPlaybookApplicabilityLeaks(
  sections: ApplicabilityAuditInput[],
  scopeVocabulary: Set<string>,
  nonGlobalRules: TaggedNonGlobalRule[] = [],
): ApplicabilityAuditResult {
  const universalApplicabilityLeaks: ApplicabilityLeak[] = [];
  const unverifiedUniversalClaims: ApplicabilityLeak[] = [];
  const scopedApplicabilityLeaks: ApplicabilityLeak[] = [];

  const scopedRules = nonGlobalRules.filter((r) => r.basis === "SCOPED").map((r) => ({ description: r.description, words: significantWords(r.description) }));
  const unverifiedRules = nonGlobalRules.filter((r) => r.basis === "UNVERIFIED").map((r) => ({ description: r.description, words: significantWords(r.description) }));

  for (const section of sections) {
    const policy = section.applicabilityPolicy ?? "DESCRIPTIVE_MIXED";
    if (policy === "CONFLICT_DOCUMENTATION" || policy === "VERIFIED_GLOBAL_ONLY") continue;

    if (policy === "SCOPED") {
      if (section.scope && isKnowledgeItemScoped(section.scope) && GENERALIZING_LANGUAGE_PATTERN.test(section.content)) {
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
    // v9 — see this file's top doc comment for the full rationale. Exactly two mechanisms, both
    // requiring an ACTUAL matched SCOPED/UNVERIFIED rule (never bare vocabulary, never bare
    // aggregate ownBasis):
    const sentences = splitSentences(section.content);
    const localQualifierTerms = new Set<string>([...scopeVocabulary, ...(section.scope && isKnowledgeItemScoped(section.scope) ? scopeTerms(section.scope) : [])]);

    const matchedTerms = new Set<string>(); // diagnostic only — reported in the leak payload, never gates a leak by itself.
    for (const term of scopeVocabulary) {
      if (containsTerm(section.content, term)) matchedTerms.add(term);
    }

    const matchedScopedRuleDescs = new Set<string>();
    const matchedUnverifiedRuleDescs = new Set<string>();

    // Mechanism (A) — sentence-level: a specific sentence uses generalizing language, closely
    // overlaps a KNOWN SCOPED/UNVERIFIED rule, and does not itself state a qualifying term.
    for (const sentence of sentences) {
      if (!GENERALIZING_LANGUAGE_PATTERN.test(sentence)) continue;
      if ([...localQualifierTerms].some((term) => containsTerm(sentence, term))) continue; // states its own applicability/scope

      const sentenceWords = significantWords(sentence);
      const scopedMatch = bestOverlapMatch(sentenceWords, scopedRules);
      const unverifiedMatch = bestOverlapMatch(sentenceWords, unverifiedRules);
      // v9 — a real non-global match ALWAYS wins when present (do-not-weaken: a sentence
      // combining an erased restriction with genuinely global wording — "Always risk no more
      // than 1% [restricted]... and target at least a two R multiple [global]" — must not have
      // its restriction erasure excused just because the SAME sentence also reads as globally
      // backed). v8's separate "known-global rule pool" escape hatch is removed: it could
      // suppress this exact case (a strong global-rule overlap outscoring a real non-global
      // match), and mechanism A no longer has any WEAKER, bare-vocabulary trigger left for it to
      // rescue a genuinely-global sentence from — a sentence is only ever flagged here when it
      // ACTUALLY overlaps a specific known SCOPED/UNVERIFIED rule, so a purely-global sentence
      // (no such overlap) is already correctly left unflagged with no extra check needed.
      if (scopedMatch) matchedScopedRuleDescs.add(scopedMatch.description);
      else if (unverifiedMatch) matchedUnverifiedRuleDescs.add(unverifiedMatch.description);
    }

    // Mechanism (B) — collection-declaration: a sentence explicitly declares a FOLLOWING
    // collection universal ("govern all playbook operations", etc). The declaring sentence
    // itself usually names no specific restricted mechanic (the restricted members are list
    // items that follow it), so the whole section is checked for non-global overlap instead.
    if (sentences.some((sentence) => COLLECTION_DECLARATION_PATTERNS.some((pattern) => pattern.test(sentence)))) {
      const sectionWords = significantWords(section.content);
      for (const rule of scopedRules) {
        if (rule.words.size > 0 && overlapRatio(sectionWords, rule.words) >= OVERLAP_THRESHOLD) matchedScopedRuleDescs.add(rule.description);
      }
      for (const rule of unverifiedRules) {
        if (rule.words.size > 0 && overlapRatio(sectionWords, rule.words) >= OVERLAP_THRESHOLD) matchedUnverifiedRuleDescs.add(rule.description);
      }
    }

    if (matchedScopedRuleDescs.size > 0) {
      universalApplicabilityLeaks.push({ sectionKey: section.key, matchedTerms: [...matchedTerms].sort(), matchedNonGlobalRules: [...matchedScopedRuleDescs].sort() });
    } else if (matchedUnverifiedRuleDescs.size > 0) {
      unverifiedUniversalClaims.push({ sectionKey: section.key, matchedTerms: [], matchedNonGlobalRules: [...matchedUnverifiedRuleDescs].sort() });
    }
  }

  return { universalApplicabilityLeaks, unverifiedUniversalClaims, scopedApplicabilityLeaks };
}
