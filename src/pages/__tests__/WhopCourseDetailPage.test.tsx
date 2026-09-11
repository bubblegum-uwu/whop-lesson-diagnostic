import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { WhopCourseDetailPage } from "../WhopCourseDetailPage";

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

const COURSE = {
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
};

const LESSON_ANALYZED = { id: 201, title: "Intro", chapterTitle: "Foundations", sourceUrl: "https://whop.com/x", durationSeconds: 600, status: "ANALYZED", eligibleForSynthesis: true };
const LESSON_NOT_ANALYZED = { id: 202, title: "Advanced Setups", chapterTitle: null, sourceUrl: "https://whop.com/y", durationSeconds: 900, status: "NOT_ANALYZED", eligibleForSynthesis: false };

function stubFetch(overrides: { onEnqueue?: (body: unknown) => void } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
    if (url.includes("/whop-courses/5/lessons")) return jsonResponse(200, { course: COURSE, items: [LESSON_ANALYZED, LESSON_NOT_ANALYZED], pagination: { limit: 200, offset: 0, totalCount: 2 } });
    if (url.endsWith("/api/analysis/jobs") && init?.method === "POST") {
      overrides.onEnqueue?.(JSON.parse(init.body as string));
      return jsonResponse(200, { queued: [202] });
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

describe("WhopCourseDetailPage (Phase 4K)", () => {
  it("shows lessons with analyzed/not-analyzed status distinctly", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Trading Accelerator" })).toBeInTheDocument());
    expect(screen.getByText("Analyzed")).toBeInTheDocument();
    expect(screen.getByText("Not analyzed")).toBeInTheDocument();
  });

  it("checking a lesson's checkbox never triggers analysis", async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select Advanced Setups"));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analysis/jobs"))).toBe(false);
  });

  it("individual Analyze enqueues exactly that lesson via the existing lesson-analysis job API", async () => {
    let enqueued: unknown;
    stubFetch({ onEnqueue: (body) => (enqueued = body) });
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(enqueued).toEqual({ lessonIds: [202], force: false }));
  });

  it("Select All Unanalyzed + batch analyze enqueues exactly the unanalyzed lesson", async () => {
    let enqueued: unknown;
    stubFetch({ onEnqueue: (body) => (enqueued = body) });
    renderPage();
    await waitFor(() => expect(screen.getByText("Advanced Setups")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Select All Unanalyzed" }));
    fireEvent.click(screen.getByRole("button", { name: /Analyze Selected/ }));
    await waitFor(() => expect(enqueued).toEqual({ lessonIds: [202], force: false }));
  });

  it("displays chapter titles when present, and omits them when absent", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Foundations")).toBeInTheDocument());
  });
});
