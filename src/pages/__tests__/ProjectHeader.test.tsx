import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectHeader } from "../ProjectHeader";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) {
        return jsonResponse(200, {
          projects: [
            {
              id: 7,
              name: "Test Project",
              projectType,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              courseCount: 0,
              lessonCount: 0,
              analyzedLessonCount: 0,
              latestSynthesisStatus: null,
              latestSynthesisCompletedAt: null,
            },
          ],
        });
      }
      return jsonResponse(404, {});
    }),
  );
}

function renderHeader() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/sources"]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<ProjectHeader backendUrl="https://backend.example.com" knoveraToken="token" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectHeader — Synthesis Sets tab gating (Phase 4L follow-up)", () => {
  it("shows the Synthesis Sets tab for a TRADING_STRATEGIES project", async () => {
    stubProject("TRADING_STRATEGIES");
    renderHeader();
    await waitFor(() => expect(screen.getByText("Test Project")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Synthesis Sets" })).toBeInTheDocument();
  });

  it("hides the Synthesis Sets tab for a GENERAL_KNOWLEDGE project (Sources/Synthesis tabs remain)", async () => {
    stubProject("GENERAL_KNOWLEDGE");
    renderHeader();
    await waitFor(() => expect(screen.getByText("Test Project")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Synthesis Sets" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sources" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Synthesis" })).toBeInTheDocument();
  });
});
