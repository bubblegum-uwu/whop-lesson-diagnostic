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

export interface ProjectSourceFingerprintInput {
  projectSourceId: number;
  geminiModel: string;
  promptVersion?: string;
  schemaVersion?: string;
  extractorVersion?: string;
}

/**
 * Phase 4H-B — the same deterministic-identity idea as
 * computeAnalysisFingerprint above, applied to a project_sources row
 * instead of a Whop lesson. Reuses the SAME frozen PROMPT_VERSION/
 * SCHEMA_VERSION/EXTRACTOR_VERSION constants (the extraction prompts/
 * schema are byte-for-byte identical for both providers — see
 * pipeline/twoPassExtraction.ts) — a version bump here always means the
 * exact same underlying prompt/schema change as it does for Whop lessons.
 */
export function computeProjectSourceAnalysisFingerprint(input: ProjectSourceFingerprintInput): string {
  const parts = [
    String(input.projectSourceId),
    input.geminiModel,
    input.promptVersion ?? PROMPT_VERSION,
    input.schemaVersion ?? SCHEMA_VERSION,
    input.extractorVersion ?? EXTRACTOR_VERSION,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
