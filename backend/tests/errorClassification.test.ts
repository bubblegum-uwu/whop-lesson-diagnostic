import { describe, it, expect } from "vitest";
import { classifyError, computeNextRetryAt } from "../src/pipeline/errorClassification.js";
import { WhopApiError, WhopUnauthorizedError } from "../src/whop/client.js";
import { AuthRequiredError } from "../src/whop/sessionService.js";
import { FfmpegRemuxError } from "../src/ffmpeg/remux.js";
import { GeminiAnalysisError } from "../src/gemini/client.js";
import { SchemaValidationError } from "../src/pipeline/analyzeLesson.js";

describe("classifyError", () => {
  it("classifies AuthRequiredError as auth_required", () => {
    expect(classifyError(new AuthRequiredError())).toBe("auth_required");
  });

  for (const status of [429, 500, 502, 503, 504]) {
    it(`classifies a Whop ${status} as transient`, () => {
      expect(classifyError(new WhopApiError("boom", status, "server_error"))).toBe("transient");
    });
  }

  for (const status of [400, 403, 404]) {
    it(`classifies a Whop ${status} as permanent`, () => {
      expect(classifyError(new WhopApiError("boom", status, "client_error"))).toBe("permanent");
    });
  }

  it("classifies a Whop 401 (not an auth-refresh failure) as permanent", () => {
    expect(classifyError(new WhopUnauthorizedError("boom", "unauthorized"))).toBe("permanent");
  });

  it("classifies SchemaValidationError as permanent", () => {
    expect(classifyError(new SchemaValidationError("bad json"))).toBe("permanent");
  });

  it("classifies a generic ffmpeg failure as permanent", () => {
    expect(classifyError(new FfmpegRemuxError("ffmpeg exited with code 1", 1))).toBe("permanent");
  });

  it("classifies an ffmpeg timeout as transient", () => {
    expect(classifyError(new FfmpegRemuxError("ffmpeg timed out during remux.", null))).toBe("transient");
  });

  it("classifies a Gemini 503 error as transient", () => {
    expect(classifyError(new GeminiAnalysisError("Gemini analysis request failed: 503 Service Unavailable"))).toBe(
      "transient",
    );
  });

  it("classifies a generic Gemini error as permanent", () => {
    expect(classifyError(new GeminiAnalysisError("Gemini analysis request failed: invalid schema"))).toBe(
      "permanent",
    );
  });

  it("classifies an unrecognized error as permanent (never silently retried forever)", () => {
    expect(classifyError(new Error("something truly unexpected"))).toBe("permanent");
  });

  it("classifies a network error as transient", () => {
    expect(classifyError(new Error("ECONNRESET"))).toBe("transient");
  });
});

describe("computeNextRetryAt", () => {
  it("grows exponentially and is capped at 10 minutes", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(computeNextRetryAt(1, now).getTime() - now.getTime()).toBe(30_000);
    expect(computeNextRetryAt(2, now).getTime() - now.getTime()).toBe(60_000);
    expect(computeNextRetryAt(3, now).getTime() - now.getTime()).toBe(120_000);
    expect(computeNextRetryAt(10, now).getTime() - now.getTime()).toBe(10 * 60_000);
  });
});
