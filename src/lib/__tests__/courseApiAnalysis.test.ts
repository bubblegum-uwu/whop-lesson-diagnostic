import { describe, it, expect, vi, afterEach } from "vitest";
import {
  enqueueAnalysisJobs,
  retryAnalysisJob,
  cancelAnalysisJob,
  getAnalysisSummary,
  getLessonAnalysisJson,
} from "../courseApi";

const BACKEND_URL = "https://backend.example.com";
const TOKEN = "operator-access-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("enqueueAnalysisJobs", () => {
  it("POSTs lessonIds and force under a bearer header", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/analysis/jobs`);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(init.body as string)).toEqual({ lessonIds: [1, 2], force: true });
      return jsonResponse(202, { queued: [{ lessonId: 1, jobId: "j1" }], skipped: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await enqueueAnalysisJobs(BACKEND_URL, TOKEN, [1, 2], true);
    expect(result.queued).toHaveLength(1);
  });

  it("throws a sanitized error on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: { message: "Missing lessonIds." } })));
    await expect(enqueueAnalysisJobs(BACKEND_URL, TOKEN, [])).rejects.toThrow(/Missing lessonIds/);
  });
});

describe("retryAnalysisJob", () => {
  it("POSTs to the retry endpoint for the given job id", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${BACKEND_URL}/api/analysis/jobs/job_1/retry`);
      return jsonResponse(202, { jobId: "job_1", status: "QUEUED" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(retryAnalysisJob(BACKEND_URL, TOKEN, "job_1")).resolves.toBeUndefined();
  });
});

describe("cancelAnalysisJob", () => {
  it("returns true on success and false on a 409 (not cancellable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { status: "CANCELLED" })));
    expect(await cancelAnalysisJob(BACKEND_URL, TOKEN, "job_1")).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(409, { error: {} })));
    expect(await cancelAnalysisJob(BACKEND_URL, TOKEN, "job_1")).toBe(false);
  });
});

describe("getAnalysisSummary", () => {
  it("returns null when no course has synced yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { summary: null })));
    expect(await getAnalysisSummary(BACKEND_URL, TOKEN)).toBeNull();
  });

  it("returns the parsed summary otherwise", async () => {
    const summary = {
      totalLessons: 10,
      analyzed: 3,
      strategyLessons: 2,
      noStrategy: 1,
      processing: 1,
      queued: 2,
      failed: 0,
      authRequired: 0,
      remaining: 4,
      totalCost: 1.23,
      averageCostPerLesson: 0.41,
      averageProcessingSeconds: 90,
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { summary })));
    expect(await getAnalysisSummary(BACKEND_URL, TOKEN)).toEqual(summary);
  });
});

describe("getLessonAnalysisJson", () => {
  it("returns null on 404 (no analysis yet) without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: {} })));
    expect(await getLessonAnalysisJson(BACKEND_URL, TOKEN, 1)).toBeNull();
  });

  it("returns the validated JSON on success", async () => {
    const validatedJson = { strategy_found: false, strategies: [] };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { validatedJson })));
    expect(await getLessonAnalysisJson(BACKEND_URL, TOKEN, 1)).toEqual(validatedJson);
  });
});
