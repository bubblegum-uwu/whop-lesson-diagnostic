import type { SourceRef } from "./schema.js";

/**
 * Generic keyed-provenance registry — the same proven pattern
 * canonicalStrategy.ts's keySourceData introduced (see schema.ts's v4
 * changelog for why: a real diagnostic run showed Gemini re-emitting
 * already-known evidence text per source citation caused real output-token
 * amplification/truncation). Phase 3.5B reuses this pattern for the new
 * rich-knowledge inputs (KnowledgeItems, examples, pooled cross-lesson
 * rules) instead of inventing a second, divergent mechanism.
 *
 * Deliberately generic over the PROMPT payload shape (`T`) — every caller
 * decides what fields Gemini actually sees per item; only the provenance
 * fields needed to resolve a citation back to a SourceRef are fixed.
 * Never touches canonicalStrategy.ts's own "s"-prefixed keying for
 * strategy-instance rules — this registry always keys with "k" so the two
 * pools can appear in the same prompt without collision.
 */
export interface CitableFact {
  lessonId: number;
  lessonTitle: string;
  strategyInstanceId: number | null;
  startTimestamp: string | null;
  endTimestamp: string | null;
  evidence: string;
}

export interface KeyedRegistry<T> {
  /** Every input's own payload, decorated with its assigned "key" — this is what goes into the prompt. */
  promptItems: (T & { key: string })[];
  /** key -> the full provenance needed to resolve a citation, never re-derived from Gemini's own output. */
  keyMap: Map<string, CitableFact>;
}

/**
 * Assigns a short, stable "k1", "k2", ... key to every input, in order.
 * Pure and deterministic: the same input list always yields the same keys,
 * so a caller building the prompt and a caller resolving citations later
 * can each call this independently and agree.
 */
export function keyFacts<T>(inputs: { fact: CitableFact; payload: T }[]): KeyedRegistry<T> {
  const keyMap = new Map<string, CitableFact>();
  const promptItems = inputs.map(({ fact, payload }, index) => {
    const key = `k${index + 1}`;
    keyMap.set(key, fact);
    return { ...payload, key };
  });
  return { promptItems, keyMap };
}

/**
 * Resolves citation keys back to full SourceRef objects using only data
 * already known before the Gemini call. A key that doesn't appear in the
 * map (Gemini invented or mistyped one) is silently dropped, never
 * fabricated into a source — mirrors canonicalStrategy.ts's
 * resolveSourceKeys exactly.
 */
export function resolveKeys(keys: string[], keyMap: Map<string, CitableFact>): SourceRef[] {
  const sources: SourceRef[] = [];
  for (const key of keys) {
    const fact = keyMap.get(key);
    if (!fact) continue;
    sources.push({
      lessonId: fact.lessonId,
      lessonTitle: fact.lessonTitle,
      strategyInstanceId: fact.strategyInstanceId,
      startTimestamp: fact.startTimestamp,
      endTimestamp: fact.endTimestamp,
      evidence: fact.evidence,
    });
  }
  return sources;
}
