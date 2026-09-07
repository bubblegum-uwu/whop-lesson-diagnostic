import type { KnowledgeItem, LessonExample, LessonKnowledge } from "../gemini/schema.js";
import { isKnowledgeItemScoped } from "../gemini/schema.js";

/**
 * Stage 1b (Phase 3.5B) — deterministic normalization of Phase 3.5A's rich
 * per-lesson knowledge (`lesson_analyses.validated_json.knowledge`) into
 * course-wide records with lesson provenance attached. Pure, no Gemini
 * call — exactly like normalize.ts's existing strategy-instance
 * normalization, applied to the knowledge model that Phase 3.4 synthesis
 * never read at all (see sourceData.ts, which now gathers `knowledge` for
 * EVERY contributing lesson — completed AND no_strategy — where before it
 * only fetched `strategy_instances` for completed lessons).
 */
export interface KnowledgeItemRecord {
  lessonId: number;
  lessonTitle: string;
  analysisId: number;
  item: KnowledgeItem;
  /** Derived once here via isKnowledgeItemScoped — the single source of truth for GLOBAL vs SCOPED, reused everywhere downstream instead of re-deriving it. */
  isScoped: boolean;
}

export interface LessonExampleRecord {
  lessonId: number;
  lessonTitle: string;
  analysisId: number;
  example: LessonExample;
}

export interface LessonKnowledgeSource {
  analysisId: number;
  lessonId: number;
  lessonTitle: string;
  knowledge: LessonKnowledge;
}

export interface NormalizedKnowledge {
  items: KnowledgeItemRecord[];
  examples: LessonExampleRecord[];
  /** scope.strategies/marketsOrInstruments/timeframes/sessions/traderProfiles ALL empty — genuinely course-wide. */
  globalItems: KnowledgeItemRecord[];
  /** At least one scope array populated. */
  scopedItems: KnowledgeItemRecord[];
  /** Subset of scopedItems whose scope.strategies is non-empty — candidates for strategy-scope mapping (see strategyScopeMapping.ts). */
  strategyScopedItems: KnowledgeItemRecord[];
  /** Subset of scopedItems with an EMPTY scope.strategies but another scope dimension populated (instrument/timeframe/session/traderProfile only) — these belong in the course-wide framework, never a specific canonical strategy, but must keep their scope tag rather than being flattened into a universal rule (see coreFramework.ts). */
  otherScopedItems: KnowledgeItemRecord[];
}

export function normalizeLessonKnowledge(sources: LessonKnowledgeSource[]): NormalizedKnowledge {
  const items: KnowledgeItemRecord[] = [];
  const examples: LessonExampleRecord[] = [];

  for (const source of sources) {
    for (const item of source.knowledge.knowledgeItems) {
      items.push({
        lessonId: source.lessonId,
        lessonTitle: source.lessonTitle,
        analysisId: source.analysisId,
        item,
        isScoped: isKnowledgeItemScoped(item.scope),
      });
    }
    for (const example of source.knowledge.examples) {
      examples.push({
        lessonId: source.lessonId,
        lessonTitle: source.lessonTitle,
        analysisId: source.analysisId,
        example,
      });
    }
  }

  const globalItems = items.filter((r) => !r.isScoped);
  const scopedItems = items.filter((r) => r.isScoped);
  const strategyScopedItems = scopedItems.filter((r) => r.item.scope.strategies.length > 0);
  const otherScopedItems = scopedItems.filter((r) => r.item.scope.strategies.length === 0);

  return { items, examples, globalItems, scopedItems, strategyScopedItems, otherScopedItems };
}

/**
 * Every distinct raw strategy-scope name referenced anywhere in
 * strategyScopedItems, e.g. ["Break & Retest", "B&R", "Order Block Retest"]
 * — the exact-string, un-deduplicated-by-meaning input strategyScopeMapping.ts
 * resolves to canonical strategy clusters. Preserves original casing/spelling
 * (case-insensitive matching happens downstream) since a name Gemini could
 * not confidently map should still be reportable in its original form.
 */
export function collectRawStrategyScopeNames(strategyScopedItems: KnowledgeItemRecord[]): string[] {
  const names = new Set<string>();
  for (const record of strategyScopedItems) {
    for (const name of record.item.scope.strategies) names.add(name);
  }
  return [...names];
}
