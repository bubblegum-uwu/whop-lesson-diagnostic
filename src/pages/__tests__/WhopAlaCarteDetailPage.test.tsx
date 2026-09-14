import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { WhopAlaCarteDetailPage } from "../WhopAlaCarteDetailPage";

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

const LESSON = {
  id: 42,
  title: "Lesson 7",
  courseId: 5,
  courseTitle: "Big Course",
  sourceUrl: "https://whop.com/x",
  durationSeconds: null,
  status: "NOT_ANALYZED",
  eligibleForSynthesis: false,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/whop-ala-carte"]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_MARKER</div>} />
        <Route path="/projects/:projectId/whop-ala-carte" element={<WhopAlaCarteDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WhopAlaCarteDetailPage — WHOP · À-LA-CARTE group detail (Phase 4L taxonomy correction)", () => {
  it("renders each à-la-carte lesson distinctly from Connected Courses, with an individual Analyze action", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/whop-lessons") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, items: [LESSON] });
      if (url.endsWith("/api/analysis/jobs") && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ lessonIds: [42], force: false });
        return jsonResponse(200, { queued: [{ lessonId: 42, jobId: "job-1" }], skipped: [] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await waitFor(() => expect(screen.getByText("Lesson 7")).toBeInTheDocument());
    expect(screen.getByText("Big Course")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/analysis/jobs", expect.objectContaining({ method: "POST" })));
  });

  it("shows an empty state rather than fabricating a lesson row when there are none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
        if (url.endsWith("/whop-lessons")) return jsonResponse(200, { projectId: 7, items: [] });
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("No à-la-carte Whop lessons.")).toBeInTheDocument());
  });

  it("a FAILED lesson shows Retry, and a successful Retry refreshes the list", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/whop-lessons") && (!init || init.method === undefined)) {
        attempt += 1;
        return jsonResponse(200, { projectId: 7, items: [{ ...LESSON, status: attempt === 1 ? "FAILED" : "QUEUED" }] });
      }
      if (url.endsWith("/api/analysis/jobs") && init?.method === "POST") {
        return jsonResponse(200, { queued: [{ lessonId: 42, jobId: "job-2" }], skipped: [] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await waitFor(() => expect(screen.getByText("Failed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Queued")).toBeInTheDocument());
  });

  it("an ANALYZED lesson shows Re-analyze, which force-re-queues it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/whop-lessons") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, items: [{ ...LESSON, status: "ANALYZED" }] });
      if (url.endsWith("/api/analysis/jobs") && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ lessonIds: [42], force: true });
        return jsonResponse(200, { queued: [{ lessonId: 42, jobId: "job-3" }], skipped: [] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Re-analyze" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Re-analyze" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/analysis/jobs", expect.objectContaining({ method: "POST" })));
  });

  it("← Sources navigates back to the main Sources page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
        if (url.endsWith("/whop-lessons")) return jsonResponse(200, { projectId: 7, items: [LESSON] });
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Lesson 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Sources/ }));
    expect(screen.getByText("SOURCES_MARKER")).toBeInTheDocument();
  });
});
