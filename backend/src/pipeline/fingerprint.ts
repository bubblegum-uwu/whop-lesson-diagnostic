import { createHash } from "node:crypto";
import { PROMPT_VERSION, SCHEMA_VERSION, EXTRACTOR_VERSION } from "./analysisVersion.js";

export interface FingerprintInput {
  whopLessonId: string;
  geminiModel: string;
  promptVersion?: string;
  schemaVersion?: string;
  extractorVersion?: string;
}

/**
 * A deterministic identity for "this exact lesson analyzed this exact way."
 * Used to decide whether an identical successful analysis already exists
 * before spending a Gemini call — see lessonAnalysesRepo.findLatestByFingerprint.
 * Deliberately NOT a database uniqueness key (see the PR2 migration comment on
 * lesson_analyses): an explicit force re-analyze may legitimately produce a
 * second successful row with the same fingerprint.
 */
export function computeAnalysisFingerprint(input: FingerprintInput): string {
  const parts = [
    input.whopLessonId,
    input.geminiModel,
    input.promptVersion ?? PROMPT_VERSION,
    input.schemaVersion ?? SCHEMA_VERSION,
    input.extractorVersion ?? EXTRACTOR_VERSION,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
