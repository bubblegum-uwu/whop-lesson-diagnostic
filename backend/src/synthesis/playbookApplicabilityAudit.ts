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
 *     is used with absolute-claim language in a sentence that never
 *     states that scope — "absolute wording applies only inside declared
 *     scope."
 *
 * CONFLICT_DOCUMENTATION and VERIFIED_GLOBAL_ONLY sections are exempt
 * entirely — see playbook.ts's SECTION_POLICY.
 */
const ABSOLUTE_CLAIM_PATTERN = /\b(all|every|always|universal(?:ly)?|without exception|in all cases|regardless of|no matter (?:the|what))\b/i;

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

function scopeTerms(scope: KnowledgeItemScope): string[] {
  return [...scope.marketsOrInstruments, ...scope.sessions, ...scope.timeframes, ...scope.traderProfiles].map((v) => v.toLowerCase());
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
      if (section.scope && isKnowledgeItemScoped(section.scope)) {
        const terms = scopeTerms(section.scope);
        const unqualifiedAbsoluteSentence = splitSentences(section.content).some(
          (sentence) => ABSOLUTE_CLAIM_PATTERN.test(sentence) && !terms.some((t) => containsTerm(sentence, t)),
        );
        if (unqualifiedAbsoluteSentence) {
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

    if (matchedTerms.size > 0 || matchedScopedRules.size > 0 || ownBasis === "SCOPED") {
      universalApplicabilityLeaks.push({ sectionKey: section.key, matchedTerms: [...matchedTerms].sort(), matchedNonGlobalRules: [...matchedScopedRules].sort() });
    } else if (matchedUnverifiedRules.size > 0 || ownBasis === "UNVERIFIED") {
      unverifiedUniversalClaims.push({ sectionKey: section.key, matchedTerms: [], matchedNonGlobalRules: [...matchedUnverifiedRules].sort() });
    }
  }

  return { universalApplicabilityLeaks, unverifiedUniversalClaims, scopedApplicabilityLeaks };
}
