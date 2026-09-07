import type { PlaybookSection, UniversalSectionScopeLeak } from "./schema.js";

/**
 * Real-audit fix (Phase 3.5B v3, Blocker B/D-4) — deterministic secondary
 * safety net for playbook sections that CLAIM to be universal/global (today,
 * only "master_trading_checklist" — see playbook.ts's REQUIRED_SECTION_KEYS
 * doc comment). Unlike a decision-graph node, free prose has no citation
 * mechanism to validate by lineage alone, so this cannot be a hard guarantee
 * the way findGlobalGateScopeLeaks is. It is intentionally NOT generic NLP
 * classification: it only flags a section's text containing a REAL scoped
 * term (an actual instrument/session/timeframe/trader-profile value drawn
 * from this course's own scoped rules — see
 * frameworkScopeSplit.ts's collectScopeVocabulary), never a heuristic guess
 * at meaning. The PRIMARY fix is restricting what Gemini is shown when
 * writing this section (playbook.ts); this function exists to catch what
 * that restriction misses (e.g. Gemini paraphrasing scoped material anyway).
 */
const UNIVERSAL_SECTION_KEYS = ["master_trading_checklist"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findUniversalSectionScopeLeaks(
  sections: Pick<PlaybookSection, "key" | "content">[],
  scopeVocabulary: Set<string>,
  targetKeys: readonly string[] = UNIVERSAL_SECTION_KEYS,
): UniversalSectionScopeLeak[] {
  const leaks: UniversalSectionScopeLeak[] = [];
  for (const section of sections) {
    if (!targetKeys.includes(section.key)) continue;

    const matched = new Set<string>();
    for (const term of scopeVocabulary) {
      if (term.length < 3) continue; // skip terms too short to avoid over-matching common words
      const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
      if (pattern.test(section.content)) matched.add(term);
    }
    if (matched.size > 0) {
      leaks.push({ sectionKey: section.key, matchedTerms: [...matched].sort() });
    }
  }
  return leaks;
}
