import type { PlaybookSection, UniversalSectionScopeLeak } from "./schema.js";

/**
 * Real-audit fix (Phase 3.5B v3, Blocker B) — deterministic secondary
 * safety net for playbook sections that CLAIM to be universal/global.
 * Unlike a decision-graph node, free prose has no citation mechanism to
 * validate by lineage alone, so this cannot be a hard guarantee the way
 * findGlobalGateScopeLeaks is. It is intentionally NOT generic NLP
 * classification — every signal it uses is a literal, deterministic string
 * match against real data (a scoped rule's own scope-array values, or a
 * non-global rule's own description text), never a semantic/ML judgment.
 * The PRIMARY fix is restricting/annotating what Gemini is shown when
 * writing the playbook (playbook.ts); this function exists to catch what
 * that restriction misses (e.g. Gemini paraphrasing scoped material anyway).
 *
 * Real-audit fix (Phase 3.5B v4) — a THIRD real dry run found TWO gaps in
 * the v3 version of this check:
 *
 *   1. It only ever scanned "master_trading_checklist". A section with NO
 *      special name — e.g. "risk_management" — stated a scoped CoreFramework
 *      rule's restriction (options/beginner-only 2R) as if it applied "on
 *      every planned execution". Universal-claim language can appear in ANY
 *      section, so this now scans every section in the playbook.
 *
 *   2. It only matched LITERAL scope-array vocabulary (e.g. the word
 *      "options" appearing in the prose). The real leak above never
 *      mentioned "options" or "beginner" at all — it just paraphrased the
 *      rule's own substantive wording ("minimum reward-to-risk ratio...")
 *      under absolute-claim language. A NEW check now flags a section that
 *      (a) contains absolute-claim language ("all", "every", "always",
 *      "universal", "without exception", ...) AND (b) shares significant
 *      word-overlap with a known non-global (SCOPED or UNVERIFIED) rule's
 *      own description — see frameworkScopeSplit.ts's
 *      collectNonGlobalRuleDescriptions. This is still a literal, bounded
 *      string comparison against real rule text (a Jaccard-style overlap
 *      ratio), not free-form language understanding.
 *
 * Both checks require the ABSOLUTE-CLAIM gate to fire first — a section
 * merely discussing scoped content (e.g. "for options traders...") without
 * an accompanying universal claim is legitimate and is never flagged.
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

/** Fraction of `ruleWords` that also appear in `sectionWords` — deliberately measured against the RULE's own word count (not the section's, which is usually much longer prose) so a short, precise rule needs to be substantially echoed to trigger a match. */
function overlapRatio(sectionWords: Set<string>, ruleWords: Set<string>): number {
  if (ruleWords.size === 0) return 0;
  let hits = 0;
  for (const w of ruleWords) if (sectionWords.has(w)) hits++;
  return hits / ruleWords.size;
}

const OVERLAP_THRESHOLD = 0.5;

export function findUniversalSectionScopeLeaks(
  sections: Pick<PlaybookSection, "key" | "content">[],
  scopeVocabulary: Set<string>,
  nonGlobalRuleDescriptions: string[] = [],
): UniversalSectionScopeLeak[] {
  const nonGlobalRules = nonGlobalRuleDescriptions.map((description) => ({ description, words: significantWords(description) }));

  const leaks: UniversalSectionScopeLeak[] = [];
  for (const section of sections) {
    if (!ABSOLUTE_CLAIM_PATTERN.test(section.content)) continue; // no universal claim made in this section — nothing to check.

    const matchedTerms = new Set<string>();
    for (const term of scopeVocabulary) {
      if (term.length < 3) continue; // skip terms too short to avoid over-matching common words
      const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
      if (pattern.test(section.content)) matchedTerms.add(term);
    }

    const sectionWords = significantWords(section.content);
    const matchedNonGlobalRules = new Set<string>();
    for (const rule of nonGlobalRules) {
      if (rule.words.size === 0) continue;
      if (overlapRatio(sectionWords, rule.words) >= OVERLAP_THRESHOLD) matchedNonGlobalRules.add(rule.description);
    }

    if (matchedTerms.size > 0 || matchedNonGlobalRules.size > 0) {
      leaks.push({
        sectionKey: section.key,
        matchedTerms: [...matchedTerms].sort(),
        matchedNonGlobalRules: [...matchedNonGlobalRules].sort(),
      });
    }
  }
  return leaks;
}
