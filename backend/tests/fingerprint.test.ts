import { describe, it, expect } from "vitest";
import { computeAnalysisFingerprint } from "../src/pipeline/fingerprint.js";

describe("computeAnalysisFingerprint", () => {
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
