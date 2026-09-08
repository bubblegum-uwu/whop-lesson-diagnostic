import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SynthesisPage } from "../SynthesisPage";
import type { ProjectSynthesisStatus } from "../../lib/synthesisApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const MASTERMIND_PROJECT = {
  id: 7,
  name: "MasterMind",
  projectType: "TRADING_STRATEGIES",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  courseCount: 1,
  lessonCount: 28,
  analyzedLessonCount: 28,
  latestSynthesisStatus: "COMPLETED",
  latestSynthesisCompletedAt: "2026-01-02T00:00:00.000Z",
};

const STATUS: ProjectSynthesisStatus = {
  status: "ready",
  projectId: MASTERMIND_PROJECT.id,
  projectType: "TRADING_STRATEGIES",
  sourceCount: 1,
  sourceCourseId: 3,
  sourceName: "The Trading Accelerator",
  course: { title: "The Trading Accelerator" },
  counts: { totalLessons: 28, analyzed: 28, processing: 0, queued: 0, failed: 0 },
  noStandaloneSetupLessons: [],
  latestRun: null,
  latestCompletedRun: null,
  isOutOfDate: false,
  canSynthesizeNow: true,
  preflight: {
    lessonCount: 28,
    latestSuccessfulAnalysisCount: 28,
    currentAnalysisCount: 28,
    staleAnalysisCount: 0,
    missingAnalysisCount: 0,
    staleLessonIds: [],
    staleLessonTitles: [],
    missingLessonIds: [],
    missingLessonTitles: [],
    ready: true,
  },
};

/**
 * Phase 4A — proves the relocation (Synthesis is now reached via
 * /projects/:projectId/synthesis instead of always rendering inline on the
 * one-page app) did not change what CourseIntelligence itself does.
 *
 * Phase 4E — CourseIntelligence is now project-aware: it resolves the real
 * numeric project id (via the same useResolvedProject ProjectHeader uses)
 * and calls the project-scoped synthesis endpoints, never the legacy
 * globally-configured-course ones. These tests mock GET /api/projects so
 * the legacy "mastermind" route slug resolves to a real project id, then
 * assert the project-scoped status endpoint is what's actually called.
 */
describe("SynthesisPage — project-aware synthesis (Phase 4E)", () => {
  it("resolves the real project id and renders the existing CourseIntelligence UI once connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_PROJECT] });
        if (url.endsWith(`/api/projects/${MASTERMIND_PROJECT.id}/synthesis/status`)) return jsonResponse(200, STATUS);
        return jsonResponse(404, {});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/mastermind/synthesis"]}>
        <Routes>
          <Route
            path="/projects/:projectId/synthesis"
            element={<SynthesisPage backendUrl="https://backend.example.com" knoveraToken="token" connected={true} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Synthesized Intelligence")).toBeInTheDocument());
    expect(screen.getByText(/Synthesized from The Trading Accelerator/)).toBeInTheDocument();
  });

  it("never calls the legacy global-course synthesis endpoints from the project workspace", async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calledUrls.push(url);
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_PROJECT] });
        if (url.endsWith(`/api/projects/${MASTERMIND_PROJECT.id}/synthesis/status`)) return jsonResponse(200, STATUS);
        return jsonResponse(404, {});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/mastermind/synthesis"]}>
        <Routes>
          <Route
            path="/projects/:projectId/synthesis"
            element={<SynthesisPage backendUrl="https://backend.example.com" knoveraToken="token" connected={true} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("Synthesized Intelligence")).toBeInTheDocument());
    expect(calledUrls.some((u) => u.includes("/api/course/synthesis"))).toBe(false);
  });

  it("renders nothing from CourseIntelligence when not connected (matches pre-Phase-4 gating)", () => {
    render(
      <MemoryRouter initialEntries={["/projects/mastermind/synthesis"]}>
        <Routes>
          <Route
            path="/projects/:projectId/synthesis"
            element={<SynthesisPage backendUrl="https://backend.example.com" knoveraToken={null} connected={false} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText("Synthesized Intelligence")).not.toBeInTheDocument();
  });
});
