import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SynthesisPage } from "../SynthesisPage";
import type { SynthesisStatus } from "../../lib/synthesisApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const STATUS: SynthesisStatus = {
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
 * one-page app) did not change what CourseIntelligence itself does: it
 * still fetches the SAME endpoint, with the SAME props, and renders its
 * own unmodified "Course Intelligence" UI.
 */
describe("SynthesisPage — relocates the existing CourseIntelligence component unchanged", () => {
  it("renders the project header plus the existing CourseIntelligence UI once connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/course/synthesis-status")) return jsonResponse(200, STATUS);
        return jsonResponse(404, {});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/mastermind/synthesis"]}>
        <Routes>
          <Route
            path="/projects/:projectId/synthesis"
            element={<SynthesisPage backendUrl="https://backend.example.com" accessToken="token" connected={true} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Course Intelligence")).toBeInTheDocument());
  });

  it("renders nothing from CourseIntelligence when not connected (matches pre-Phase-4 gating)", () => {
    render(
      <MemoryRouter initialEntries={["/projects/mastermind/synthesis"]}>
        <Routes>
          <Route
            path="/projects/:projectId/synthesis"
            element={<SynthesisPage backendUrl="https://backend.example.com" accessToken={null} connected={false} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText("Course Intelligence")).not.toBeInTheDocument();
  });
});
