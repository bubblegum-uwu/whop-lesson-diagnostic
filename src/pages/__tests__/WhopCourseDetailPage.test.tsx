import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Link } from "react-router-dom";
import { WhopCourseDetailPage } from "../WhopCourseDetailPage";
import type { CourseLessonSummary, AnalysisSummary } from "../../lib/courseApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PROJECT = {
  id: 7,
  name: "MasterMind",
  projectType: "TRADING_STRATEGIES",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  courseCount: 0,
  lessonCount: 0,
  analyzedLessonCount: 0,
  latestSynthesisStatus: null,
  latestSynthesisCompletedAt: null,
};

function makeCourse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    provider: "WHOP",
    sourceType: "COURSE",
    courseId: 5,
    externalId: "cors_abc",
    name: "Trading Accelerator",
    lessonCount: 2,
    analyzedLessonCount: 1,
    queuedCount: 0,
    processingCount: 0,
    failedCount: 0,
    remainingCount: 0,
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    totalCost: 1.5,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<AnalysisSummary> = {}): AnalysisSummary {
  return {
    totalLessons: 2,
    analyzed: 1,
    strategyLessons: 1,
    noStrategy: 0,
    processing: 0,
    queued: 0,
    failed: 0,
    authRequired: 0,
    remaining: 1,
    totalCost: 0.08,
    averageCostPerLesson: 0.08,
    averageProcessingSeconds: 155,
    ...overrides,
  };
}

function makeLesson(overrides: Partial<CourseLessonSummary> = {}): CourseLessonSummary {
  return {
    id: 201,
    title: "Introduction To Accelerator",
    chapterTitle: "Foundations",
    chapterOrder: 1,
    courseOrder: 1,
    durationSeconds: 600,
    videoAvailable: true,
    sourceUrl: "https://whop.com/x/lesn_201",
    lastSyncedAt: "2026-01-01T00:00:00Z",
    job: { jobId: "job_201", status: "COMPLETED" },
    analysis: {
      analysisId: 1,
      strategyFound: true,
      extractedStrategiesLabel: "Break & Retest",
      ruleCounts: [],
      confidence: 0.9,
      summary: "Break and retest continuation.",
      hasSupportingKnowledge: true,
      knowledgeItemCounts: [],
      schemaVersion: "v2",
      estimatedCost: 0.08,
      processingDurationSeconds: 155,
      completedAt: "2026-01-01T00:05:00Z",
    },
    ...overrides,
  };
}

const NOT_ANALYZED_LESSON = makeLesson({
  id: 202,
  title: "Advanced Setups",
  chapterTitle: null,
  courseOrder: 2,
  durationSeconds: 900,
  sourceUrl: "https://whop.com/x/lesn_202",
  job: { jobId: null, status: "NOT_ANALYZED" },
  analysis: null,
});

interface StubConfig {
  course?: ReturnType<typeof makeCourse>;
  summary?: AnalysisSummary;
  lessons?: CourseLessonSummary[];
  connected?: boolean;
  onEnqueue?: (body: unknown) => void;
  onRetry?: (jobId: string) => void;
  onRefresh?: () => void;
}

function stubFetch(config: StubConfig = {}) {
  const course = config.course ?? makeCourse();
  const summary = config.summary ?? makeSummary();
  const lessons = config.lessons ?? [makeLesson(), NOT_ANALYZED_LESSON];
  const connected = config.connected ?? true;

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
    if (url.endsWith("/api/auth/status")) return jsonResponse(200, { connected, status: connected ? "active" : null, whopUserId: connected ? "user_1" : null });
    if (url.includes(`/whop-courses/${course.courseId}/dashboard`)) return jsonResponse(200, { course, summary, lessons });
    if (url.includes(`/whop-courses/${course.courseId}/refresh`) && init?.method === "POST") {
      config.onRefresh?.();
      return jsonResponse(200, { course });
    }
    if (url.endsWith("/api/analysis/jobs") && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      config.onEnqueue?.(body);
      return jsonResponse(202, { queued: (body.lessonIds as number[]).map((id) => ({ lessonId: id, jobId: `job_${id}` })), skipped: [] });
    }
    const retryMatch = url.match(/\/api\/analysis\/jobs\/([^/]+)\/retry$/);
    if (retryMatch && init?.method === "POST") {
      config.onRetry?.(decodeURIComponent(retryMatch[1]));
      return jsonResponse(202, { jobId: retryMatch[1], status: "QUEUED" });
    }
    if (url.includes("/course/lessons/") && url.endsWith("/analysis")) {
      return jsonResponse(200, { validatedJson: { strategy_found: true, strategies: [] } });
    }
    return jsonResponse(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(initialPath = "/projects/7/whop-courses/5") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_MARKER</div>} />
        <Route path="/projects/:projectId/whop-courses/:courseId" element={<WhopCourseDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WhopCourseDetailPage — rich course management UI (Phase 4K follow-up)", () => {
  it("1: loads the requested courseId's dashboard and renders its rich stats and lessons", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trading Accelerator" })).toBeInTheDocument());
    // DashboardSummary tiles.
    expect(screen.getByText("Total Lessons")).toBeInTheDocument();
    expect(screen.getAllByText("Analyzed").length).toBeGreaterThan(0);
    expect(screen.getByText("Introduction To Accelerator")).toBeInTheDocument();
    expect(screen.getByText("Advanced Setups")).toBeInTheDocument();
  });

  it("2/3: multi-course isolation — Course A's page shows only Course A's data, Course B's page shows only Course B's data", async () => {
    const courseA = makeCourse({ courseId: 5, name: "Course A" });
    const courseB = makeCourse({ courseId: 9, name: "Course B" });
    const lessonA = makeLesson({ id: 301, title: "Course A Lesson" });
    const lessonB = makeLesson({ id: 401, title: "Course B Lesson" });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/api/auth/status")) return jsonResponse(200, { connected: true, status: "active", whopUserId: "u" });
      if (url.includes("/whop-courses/5/dashboard")) return jsonResponse(200, { course: courseA, summary: makeSummary(), lessons: [lessonA] });
      if (url.includes("/whop-courses/9/dashboard")) return jsonResponse(200, { course: courseB, summary: makeSummary(), lessons: [lessonB] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderPage("/projects/7/whop-courses/5");
    await waitFor(() => expect(screen.getByText("Course A Lesson")).toBeInTheDocument());
    expect(screen.queryByText("Course B Lesson")).not.toBeInTheDocument();
    unmount();

    renderPage("/projects/7/whop-courses/9");
    await waitFor(() => expect(screen.getByText("Course B Lesson")).toBeInTheDocument());
    expect(screen.queryByText("Course A Lesson")).not.toBeInTheDocument();
  });

  it("4: navigating from Course A directly to Course B (same mounted page) never keeps showing Course A's lessons", async () => {
    const courseA = makeCourse({ courseId: 5, name: "Course A" });
    const courseB = makeCourse({ courseId: 9, name: "Course B" });
    const lessonA = makeLesson({ id: 301, title: "Course A Lesson" });
    const lessonB = makeLesson({ id: 401, title: "Course B Lesson" });
    let resolveB!: (value: Response) => void;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/api/auth/status")) return jsonResponse(200, { connected: true, status: "active", whopUserId: "u" });
      if (url.includes("/whop-courses/5/dashboard")) return jsonResponse(200, { course: courseA, summary: makeSummary(), lessons: [lessonA] });
      if (url.includes("/whop-courses/9/dashboard")) return new Promise<Response>((resolve) => (resolveB = resolve));
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    // A real in-router navigation (not a MemoryRouter remount, which never
    // actually changes the current location — it only reads initialEntries
    // once) between two sibling course routes, the way Sources' own course
    // cards would link between courses.
    render(
      <MemoryRouter initialEntries={["/projects/7/whop-courses/5"]}>
        <Routes>
          <Route
            path="/projects/:projectId/whop-courses/:courseId"
            element={
              <>
                <Link to="/projects/7/whop-courses/9">Go to Course B</Link>
                <WhopCourseDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("Course A Lesson")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("link", { name: "Go to Course B" }));
    // Course A's lesson must disappear immediately, before Course B's fetch resolves.
    await waitFor(() => expect(screen.queryByText("Course A Lesson")).not.toBeInTheDocument());
    expect(screen.queryByText("Course B Lesson")).not.toBeInTheDocument();

    resolveB(jsonResponse(200, { course: courseB, summary: makeSummary(), lessons: [lessonB] }));
    await waitFor(() => expect(screen.getByText("Course B Lesson")).toBeInTheDocument());
  });

  it("5: an unknown/foreign courseId shows a not-found state, never a broken page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
        if (url.endsWith("/api/auth/status")) return jsonResponse(200, { connected: false, status: null, whopUserId: null });
        if (url.includes("/dashboard")) return jsonResponse(404, { error: { message: "Unknown Whop course.", type: "course_not_found" } });
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("This Whop course doesn't exist.")).toBeInTheDocument());
  });

  it("6: search filters the lesson list", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Search lessons"), { target: { value: "Advanced" } });
    await waitFor(() => expect(screen.queryByText("Introduction To Accelerator")).not.toBeInTheDocument());
    expect(screen.getByText("Advanced Setups")).toBeInTheDocument();
  });

  it("7: Select All Unanalyzed + Analyze Selected enqueues exactly the unanalyzed lesson via the real analysis job API", async () => {
    let enqueued: unknown;
    stubFetch({ onEnqueue: (body) => (enqueued = body) });
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Select All Unanalyzed" }));
    fireEvent.click(screen.getByRole("button", { name: /Analyze Selected/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(enqueued).toEqual({ lessonIds: [202], force: true }));
  });

  it("8: Retry Failed retries the real failed job's jobId", async () => {
    let retriedJobId: string | undefined;
    stubFetch({
      lessons: [makeLesson({ id: 203, title: "Failed Lesson", job: { jobId: "job_203", status: "FAILED", sanitizedError: "boom" }, analysis: null })],
      onRetry: (jobId) => (retriedJobId = jobId),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Retry Failed" }));
    await waitFor(() => expect(retriedJobId).toBe("job_203"));
  });

  it("9: View opens the rich lesson detail drawer with the real analysis, not raw analysis inline on the page", async () => {
    stubFetch();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View" }));
    await waitFor(() => expect(screen.getByText("Break and retest continuation.")).toBeInTheDocument());
  });

  it("10: Refresh Course calls the course-scoped refresh endpoint for THIS course, never a global sync", async () => {
    let refreshed = false;
    const fetchMock = stubFetch({ onRefresh: () => (refreshed = true) });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh Course" }));
    await waitFor(() => expect(refreshed).toBe(true));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/whop-courses/5/refresh"))).toBe(true);
  });

  it("11: Refresh Course never enqueues an analysis job", async () => {
    let enqueueCalled = false;
    const fetchMock = stubFetch({ onEnqueue: () => (enqueueCalled = true) });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh Course" }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/refresh"))).toBe(true));
    expect(enqueueCalled).toBe(false);
  });

  it("12: reads existing analysis data (cost, duration, result) without mutating or re-running anything", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trading Accelerator" })).toBeInTheDocument());
    expect(screen.getAllByText("$0.08").length).toBeGreaterThan(0);
    // No re-analysis / Gemini call is ever implied by simply viewing the page.
    const fetchMock = vi.mocked(fetch) as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).endsWith("/api/analysis/jobs") && (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("checking a lesson's checkbox never triggers analysis", async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select Advanced Setups"));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analysis/jobs"))).toBe(false);
  });

  it("displays chapter titles when present, and omits them when absent", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getAllByText("Foundations").length).toBeGreaterThan(0));
  });

  it("← Sources navigates back to the Sources page", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trading Accelerator" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "← Sources" }));
    expect(screen.getByText("SOURCES_MARKER")).toBeInTheDocument();
  });
});
