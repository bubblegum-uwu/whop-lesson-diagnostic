import { describe, it, expect } from "vitest";
import { computeAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
import { PROMPT_VERSION, SCHEMA_VERSION, EXTRACTOR_VERSION } from "../src/pipeline/analysisVersion.js";

describe("computeAnalysisFingerprint", () => {
  // Phase 3.5: PROMPT_VERSION/SCHEMA_VERSION/EXTRACTOR_VERSION were bumped
  // v1 -> v2 for the rich-knowledge extractor (see analysisVersion.ts's v2
  // changelog). Confirms the REAL current constants (not just placeholder
  // strings) produce a fingerprint distinct from the old v1 one for the
  // exact same lesson+model — this is the entire mechanism that makes a
  // lesson analyzed under v1 eligible for re-analysis: the "already
  // analyzed, skip" check (findLatestByFingerprint) looks up by the NEW
  // fingerprint and finds nothing, since the old row's fingerprint is v1's.
  it("the current v2 constants produce a fingerprint distinct from v1 — old analyses become eligible for re-analysis", () => {
    const v1 = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "gemini-3.8-flash", promptVersion: "v1", schemaVersion: "v1", extractorVersion: "v1" });
    const v2Current = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "gemini-3.8-flash" }); // defaults to the live PROMPT_VERSION/SCHEMA_VERSION/EXTRACTOR_VERSION
    expect(v2Current).not.toBe(v1);
    expect(PROMPT_VERSION).toBe("v2");
    expect(SCHEMA_VERSION).toBe("v2");
    expect(EXTRACTOR_VERSION).toBe("v2");
  });

  it("is stable for identical inputs", () => {
    const a = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "gemini-3.8-flash" });
    const b = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "gemini-3.8-flash" });
    expect(a).toBe(b);
  });

  it("changes when the lesson id changes", () => {
    const a = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "gemini-3.8-flash" });
    const b = computeAnalysisFingerprint({ whopLessonId: "lesn_2", geminiModel: "gemini-3.8-flash" });
    expect(a).not.toBe(b);
  });

  it("changes when the model changes", () => {
    const a = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "gemini-3.8-flash" });
    const b = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "gemini-4.0" });
    expect(a).not.toBe(b);
  });

  it("changes when prompt/schema/extractor version changes", () => {
    const a = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "m", promptVersion: "v1" });
    const b = computeAnalysisFingerprint({ whopLessonId: "lesn_1", geminiModel: "m", promptVersion: "v2" });
    expect(a).not.toBe(b);
  });
});
