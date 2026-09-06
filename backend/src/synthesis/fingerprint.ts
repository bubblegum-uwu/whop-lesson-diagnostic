import { createHash } from "node:crypto";
import { SYNTHESIS_PROMPT_VERSION, SYNTHESIS_SCHEMA_VERSION, SYNTHESIZER_VERSION } from "./version.js";

export interface SourceAnalysisHashInput {
  courseId: number;
  /** The latest completed/no_strategy lesson_analyses.analysis_id per contributing lesson. */
  analysisIds: number[];
  model: string;
  synthesisPromptVersion?: string;
  synthesisSchemaVersion?: string;
  synthesizerVersion?: string;
}

/**
 * A deterministic identity for "this exact set of source analyses,
 * synthesized this exact way." Mirrors pipeline/fingerprint.ts. Sorting
 * analysisIds makes the hash independent of query/array ordering — only the
 * *set* of contributing analyses matters, never the order they were fetched
 * in.
 */
export function computeSourceAnalysisHash(input: SourceAnalysisHashInput): string {
  const sortedIds = [...input.analysisIds].sort((a, b) => a - b);
  const parts = [
    String(input.courseId),
    sortedIds.join(","),
    input.model,
    input.synthesisPromptVersion ?? SYNTHESIS_PROMPT_VERSION,
    input.synthesisSchemaVersion ?? SYNTHESIS_SCHEMA_VERSION,
    input.synthesizerVersion ?? SYNTHESIZER_VERSION,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
