import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { WhopCourseDetailPage } from "../WhopCourseDetailPage";
import type { CourseLessonSummary, AnalysisSummary } from "../../lib/courseApi";
import type { WhopCourseSummary } from "../../lib/catalogApi";

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

function makeCourse(overrides: Partial<WhopCourseSummary> = {}): WhopCourseSummary {
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
    remainingCount: 1,
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    totalCost: 1.5,
    ...overrides,
  };
}

function makeLesson(overrides: Partial<CourseLessonSummary> = {}): CourseLessonSummary {
  return {
    id: 201,
    title: "Intro",
    chapterTitle: "Foundations",
    chapterOrder: 1,
    courseOrder: 1,
    durationSeconds: 600,
    videoAvailable: true,
    sourceUrl: "https://whop.com/x",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    job: { jobId: null, status: "NOT_ANALYZED" },
    analysis: null,
    ...overrides,
  };
}

function analyzedLesson(overrides: Partial<CourseLessonSummary> = {}): CourseLessonSummary {
  return makeLesson({
    id: 201,
    title: "Intro",
    job: { jobId: "job_1", status: "COMPLETED" },
    analysis: {
      analysisId: 1,
      strategyFound: true,
      extractedStrategiesLabel: "Break & Retest",
      ruleCounts: [{ label: "Entry", count: 1 }],
      confidence: 0.8,
      summary: "Break & Retest using HTF levels.",
      hasSupportingKnowledge: true,
      knowledgeItemCounts: [],
      schemaVersion: "v2",
      estimatedCost: 0.08,
      processingDurationSeconds: 155,
      completedAt: "2026-01-01T08:31:00Z",
    },
    ...overrides,
  });
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

interface CourseFixture {
  projectId: number;
  courseId: number;
  course: WhopCourseSummary;
  lessons: CourseLessonSummary[];
  summary: AnalysisSummary;
}

interface StubConfig {
  courses: CourseFixture[];
  connected?: boolean;
  authRequired?: boolean;
  onEnqueue?: (body: unknown) => void;
  onRetry?: (jobId: string) => void;
  onCancel?: (jobId: string) => void;
  onRefresh?: (projectId: number, courseId: number) => void;
  analysisByLesson?: Record<number, unknown>;
}

function stubFetch(config: StubConfig) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
    if (url.endsWith("/api/auth/status")) {
      return jsonResponse(200, { connected: config.connected ?? true, status: config.authRequired ? "auth_required" : config.connected === false ? null : "active", whopUserId: null });
    }

    const dashboardMatch = url.match(/\/projects\/(\d+)\/whop-courses\/(\d+)\/dashboard$/);
    if (dashboardMatch && (!init || init.method === undefined)) {
      const projectId = Number(dashboardMatch[1]);
      const courseId = Number(dashboardMatch[2]);
      const fixture = config.courses.find((c) => c.projectId === projectId && c.courseId === courseId);
      if (!fixture) return jsonResponse(404, { error: { message: "Unknown Whop course.", type: "course_not_found" } });
      return jsonResponse(200, { course: fixture.course, lessons: fixture.lessons, summary: fixture.summary });
    }

    const refreshMatch = url.match(/\/projects\/(\d+)\/whop-courses\/(\d+)\/refresh$/);
    if (refreshMatch && init?.method === "POST") {
      const projectId = Number(refreshMatch[1]);
      const courseId = Number(refreshMatch[2]);
      config.onRefresh?.(projectId, courseId);
      const fixture = config.courses.find((c) => c.projectId === projectId && c.courseId === courseId);
      return jsonResponse(200, { course: fixture?.course ?? makeCourse() });
    }

    if (url.endsWith("/api/analysis/jobs") && init?.method === "POST") {
      config.onEnqueue?.(JSON.parse(init.body as string));
      return jsonResponse(200, { queued: [] });
    }
    const retryMatch = url.match(/\/api\/analysis\/jobs\/([^/]+)\/retry$/);
    if (retryMatch && init?.method === "POST") {
      config.onRetry?.(decodeURIComponent(retryMatch[1]));
      return jsonResponse(200, {});
    }
    const cancelMatch = url.match(/\/api\/analysis\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && init?.method === "POST") {
      config.onCancel?.(decodeURIComponent(cancelMatch[1]));
      return jsonResponse(200, {});
    }
    const analysisMatch = url.match(/\/api\/course\/lessons\/(\d+)\/analysis$/);
    if (analysisMatch && (!init || init.method === undefined)) {
      const lessonId = Number(analysisMatch[1]);
      const validatedJson = config.analysisByLesson?.[lessonId];
      if (validatedJson === undefined) return jsonResponse(404, {});
      return jsonResponse(200, { validatedJson });
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

describe("WhopCourseDetailPage — rich course management (Phase 4K-D follow-up)", () => {
  it("9: the course detail route loads the requested courseId's dashboard", async () => {
    const fetchMock = stubFetch({ courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [makeLesson()], summary: makeSummary() }] });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trading Accelerator" })).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/whop-courses/5/dashboard"))).toBe(true);
  });

  it("10/26/27: MULTI-COURSE ISOLATION — Course A and Course B never leak data into each other", async () => {
    const courseA = { projectId: 7, courseId: 1, course: makeCourse({ courseId: 1, name: "Course A" }), lessons: [makeLesson({ id: 11, title: "A Lesson" })], summary: makeSummary({ totalLessons: 1 }) };
    const courseB = { projectId: 7, courseId: 2, course: makeCourse({ courseId: 2, name: "Course B" }), lessons: [makeLesson({ id: 22, title: "B Lesson" })], summary: makeSummary({ totalLessons: 1 }) };
    stubFetch({ courses: [courseA, courseB] });

    const { unmount } = renderPage("/projects/7/whop-courses/1");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Course A" })).toBeInTheDocument());
    expect(screen.getByText("A Lesson")).toBeInTheDocument();
    expect(screen.queryByText("B Lesson")).not.toBeInTheDocument();
    unmount();

    renderPage("/projects/7/whop-courses/2");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Course B" })).toBeInTheDocument());
    expect(screen.getByText("B Lesson")).toBeInTheDocument();
    expect(screen.queryByText("A Lesson")).not.toBeInTheDocument();
  });

  it("11: rich dashboard statistics (tiles + spend) render from the course-scoped summary", async () => {
    stubFetch({
      courses: [
        {
          projectId: 7,
          courseId: 5,
          course: makeCourse(),
          lessons: [analyzedLesson(), makeLesson({ id: 202, title: "Advanced Setups" })],
          summary: makeSummary({ totalCost: 4.21, averageCostPerLesson: 0.08, averageProcessingSeconds: 155 }),
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Total Lessons")).toBeInTheDocument());
    expect(screen.getByText("Course Gemini Spend:")).toBeInTheDocument();
    expect(screen.getByText("$4.21")).toBeInTheDocument();
    expect(screen.getByText("Average Cost / Lesson:")).toBeInTheDocument();
  });

  it("12: search filters lessons by title", async () => {
    stubFetch({ courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [makeLesson({ id: 1, title: "Support & Resistance" }), makeLesson({ id: 2, title: "Order Blocks" })], summary: makeSummary() }] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Support & Resistance")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/search lessons/i), { target: { value: "order" } });
    expect(screen.queryByText("Support & Resistance")).not.toBeInTheDocument();
    expect(screen.getByText("Order Blocks")).toBeInTheDocument();
  });

  it("13: status filtering works", async () => {
    stubFetch({
      courses: [
        {
          projectId: 7,
          courseId: 5,
          course: makeCourse(),
          lessons: [makeLesson({ id: 1, title: "A" }), makeLesson({ id: 2, title: "B", job: { jobId: "j2", status: "FAILED" } })],
          summary: makeSummary(),
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/filter by status/i), { target: { value: "FAILED" } });
    expect(screen.queryByText("A")).not.toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("14: chapter filtering works", async () => {
    stubFetch({
      courses: [
        {
          projectId: 7,
          courseId: 5,
          course: makeCourse(),
          lessons: [makeLesson({ id: 1, title: "A", chapterTitle: "Foundations" }), makeLesson({ id: 2, title: "B", chapterTitle: "Advanced" })],
          summary: makeSummary(),
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("A")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/filter by chapter/i), { target: { value: "Advanced" } });
    expect(screen.queryByText("A")).not.toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("15: strategy filtering works", async () => {
    stubFetch({
      courses: [
        {
          projectId: 7,
          courseId: 5,
          course: makeCourse(),
          lessons: [analyzedLesson({ id: 1, title: "Strategy Found" }), makeLesson({ id: 2, title: "Not Analyzed Yet" })],
          summary: makeSummary(),
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Strategy Found")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/filter by strategy found/i), { target: { value: "FOUND" } });
    expect(screen.getByText("Strategy Found")).toBeInTheDocument();
    expect(screen.queryByText("Not Analyzed Yet")).not.toBeInTheDocument();
  });

  it("16/17: Select All Unanalyzed + Analyze Selected enqueues exactly the unanalyzed lesson", async () => {
    let enqueued: unknown;
    stubFetch({
      courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [analyzedLesson({ id: 1 }), makeLesson({ id: 2, title: "Advanced Setups" })], summary: makeSummary() }],
      onEnqueue: (body) => (enqueued = body),
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Select All Unanalyzed" }));
    fireEvent.click(screen.getByRole("button", { name: /Analyze Selected/ }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    // "Analyze Selected" always force-re-analyzes the chosen set, regardless
    // of how the selection was built — matches CourseTable.test.tsx's own
    // "selects lessons via checkboxes..." expectation.
    await waitFor(() => expect(enqueued).toEqual({ lessonIds: [2], force: true }));
  });

  it("18: Analyze All Unanalyzed enqueues every not-yet-analyzed lesson", async () => {
    let enqueued: unknown;
    stubFetch({
      courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [analyzedLesson({ id: 1 }), makeLesson({ id: 2, title: "Advanced Setups" })], summary: makeSummary() }],
      onEnqueue: (body) => (enqueued = body),
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Analyze All Unanalyzed/ }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(enqueued).toEqual({ lessonIds: [2], force: false }));
  });

  it("19: Retry Failed retries every FAILED lesson's job", async () => {
    const retried: string[] = [];
    stubFetch({
      courses: [
        {
          projectId: 7,
          courseId: 5,
          course: makeCourse(),
          lessons: [makeLesson({ id: 1, title: "Failed Lesson", job: { jobId: "job_1", status: "FAILED", sanitizedError: "boom" } })],
          summary: makeSummary(),
        },
      ],
      onRetry: (jobId) => retried.push(jobId),
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Failed Lesson")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Retry Failed/ }));
    await waitFor(() => expect(retried).toEqual(["job_1"]));
  });

  it("20: lesson rows render status/result/cost columns", async () => {
    stubFetch({ courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [analyzedLesson()], summary: makeSummary() }] });
    renderPage();
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("Break & Retest");
    expect(table).toHaveTextContent("$0.08");
  });

  it("21: View opens the rich lesson detail drawer, fetching the full analysis JSON", async () => {
    stubFetch({
      courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [analyzedLesson()], summary: makeSummary() }],
      analysisByLesson: { 201: { strategy_found: true, strategies: [] } },
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("22: Re-analyze remains an explicit, separate action (force=true), never automatic", async () => {
    let enqueued: unknown;
    stubFetch({
      courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [analyzedLesson()], summary: makeSummary() }],
      onEnqueue: (body) => (enqueued = body),
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Re-analyze" }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(enqueued).toEqual({ lessonIds: [201], force: true }));
  });

  it("23/24: Refresh Course is course-scoped and never triggers analysis", async () => {
    let refreshedCourseId: number | null = null;
    const fetchMock = stubFetch({
      courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [makeLesson()], summary: makeSummary() }],
      onRefresh: (_projectId, courseId) => (refreshedCourseId = courseId),
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /Refresh Course/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Refresh Course/ }));
    await waitFor(() => expect(refreshedCourseId).toBe(5));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analysis/jobs") && (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("25: reads existing analysis IDs/results without ever mutating them — opening the page issues only GET requests", async () => {
    const fetchMock = stubFetch({ courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [analyzedLesson()], summary: makeSummary() }] });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trading Accelerator" })).toBeInTheDocument());
    const mutatingCalls = fetchMock.mock.calls.filter((c) => {
      const init = c[1] as RequestInit | undefined;
      return init?.method && init.method !== "GET";
    });
    expect(mutatingCalls).toHaveLength(0);
  });

  it("28/29: a course belonging to a different project (cross-project) shows a not-found state, never that project's data", async () => {
    stubFetch({ courses: [{ projectId: 99, courseId: 5, course: makeCourse(), lessons: [makeLesson()], summary: makeSummary() }] });
    renderPage("/projects/7/whop-courses/5");
    await waitFor(() => expect(screen.getByText("This Whop course doesn't exist.")).toBeInTheDocument());
  });

  it("34: checking a lesson's checkbox never triggers analysis", async () => {
    const fetchMock = stubFetch({ courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [makeLesson({ id: 202, title: "Advanced Setups" })], summary: makeSummary() }] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select Advanced Setups"));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analysis/jobs"))).toBe(false);
  });

  it("navigates back to Sources via the breadcrumb", async () => {
    stubFetch({ courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [makeLesson()], summary: makeSummary() }] });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trading Accelerator" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "← Sources" }));
    expect(screen.getByText("SOURCES_MARKER")).toBeInTheDocument();
  });

  it("never shows a Remove Collection or Add Collection to Project action (Whop courses have neither concept)", async () => {
    stubFetch({ courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [makeLesson()], summary: makeSummary() }] });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trading Accelerator" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Remove Collection" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Collection to Project" })).not.toBeInTheDocument();
  });

  it("Cancel is available for a QUEUED lesson and calls the generic job-cancel endpoint", async () => {
    const cancelled: string[] = [];
    stubFetch({
      courses: [{ projectId: 7, courseId: 5, course: makeCourse(), lessons: [makeLesson({ id: 1, title: "Queued Lesson", job: { jobId: "job_1", status: "QUEUED" } })], summary: makeSummary() }],
      onCancel: (jobId) => cancelled.push(jobId),
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Queued Lesson")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(cancelled).toEqual(["job_1"]));
  });
});
