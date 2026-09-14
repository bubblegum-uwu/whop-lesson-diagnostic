import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SourcesPage, type SourcesPageProps } from "../SourcesPage";
import * as bridge from "../../lib/discordCompanionBridge";

vi.mock("../../lib/discordCompanionBridge", async () => {
  const actual = await vi.importActual<typeof import("../../lib/discordCompanionBridge")>("../../lib/discordCompanionBridge");
  return { ...actual, detectDiscordCompanion: vi.fn() };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const MASTERMIND_API_PROJECT = {
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

function baseProps(overrides: Partial<SourcesPageProps> = {}): SourcesPageProps {
  return {
    courseTitle: null,
    lessons: [],
    connected: true,
    syncing: false,
    authRequired: false,
    lastSyncedAt: null,
    summary: null,
    courseErrorMessage: null,
    onSignIn: () => {},
    onSync: () => {},
    onDisconnect: () => {},
    onEnqueue: () => {},
    onRetry: () => {},
    onCancel: () => {},
    onLoadAnalysis: async () => null,
    identifyState: { phase: "idle" },
    onFindUserId: () => {},
    backendUrl: "https://backend.example.com",
    knoveraToken: "token",
    diagnosticState: { phase: "config", errorMessage: null, submitting: false },
    redirectUri: "https://example.com/",
    onDiagnosticSubmit: () => {},
    onDiagnosticReset: () => {},
    ...overrides,
  };
}

function renderSources(initialPath: string, props: Partial<SourcesPageProps> = {}) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<SourcesPage {...baseProps(props)} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SourcesPage — Discord channel import (Phase 4K-C)", () => {
  it("1: the Discord provider card exposes 'Import YouTube from a Channel'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [] });
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Import YouTube from a Channel" })).toBeEnabled());
  });

  it("2: clicking it opens the dialog, which shows the install-required state when the companion isn't detected", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [] });
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Import YouTube from a Channel" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Import YouTube from a Channel" }));

    expect(await screen.findByText("Knovera Browser Companion is required to scan Discord channels.")).toBeInTheDocument();
  });

});
