import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SourcesPage, type SourcesPageProps } from "../SourcesPage";

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

const GENERAL_KNOWLEDGE_PROJECT = { ...PROJECT, projectType: "GENERAL_KNOWLEDGE" };

const COLLECTED_SOURCE = {
  provider: "YOUTUBE",
  sourceType: "VIDEO",
  id: 201,
  externalId: "ccccccccccc",
  sourceUrl: "https://www.youtube.com/watch?v=ccccccccccc",
  title: "Inside a Channel",
  durationSeconds: null,
  status: "READY",
  createdAt: "2026-01-05T00:00:00.000Z",
  collectionId: 1,
  origins: [],
};

const UNCOLLECTED_SOURCE = {
  provider: "YOUTUBE",
  sourceType: "VIDEO",
  id: 202,
  externalId: "ddddddddddd",
  sourceUrl: "https://www.youtube.com/watch?v=ddddddddddd",
  title: "A La Carte Video",
  durationSeconds: null,
  status: "READY",
  createdAt: "2026-01-05T00:00:00.000Z",
  collectionId: null,
  origins: [],
};

const COLLECTION_SUMMARY = {
  id: 1,
  provider: "YOUTUBE",
  externalId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  title: "SMB Capital",
  sourceUrl: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
  status: "READY",
  sanitizedError: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z",
  itemCount: 1,
  analyzedCount: 0,
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

function stubFetch(sources: unknown[], collections: unknown[], projects: unknown[] = [PROJECT]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections });
      return jsonResponse(404, {});
    }),
  );
}

function renderSources(initialPath: string, props: Partial<SourcesPageProps> = {}) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<SourcesPage {...baseProps(props)} />} />
        <Route path="/projects/:projectId/collections/uncollected" element={<div>UNCOLLECTED_DETAIL_MARKER</div>} />
        <Route path="/projects/:projectId/collections/:collectionId" element={<div>COLLECTION_DETAIL_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SourcesPage — collection-first Sources UI (Phase 4L)", () => {
  it("renders a Collection card (not a flat per-item row) for a collection, with item/analyzed counts", async () => {
    stubFetch([COLLECTED_SOURCE], [COLLECTION_SUMMARY]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByRole("heading", { name: "SMB Capital" })).toBeInTheDocument());
    expect(screen.getByText(/1 item.*0 analyzed/)).toBeInTheDocument();
    // The collected source's own row must never render flatly on this page.
    expect(screen.queryByText("Inside a Channel")).not.toBeInTheDocument();
  });

  it("clicking Open on a collection card navigates to that collection's detail page", async () => {
    stubFetch([COLLECTED_SOURCE], [COLLECTION_SUMMARY]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "SMB Capital" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("COLLECTION_DETAIL_MARKER")).toBeInTheDocument();
  });

  it("shows an à-la-carte (uncollected) source under its own 'Uncollected Sources' section", async () => {
    stubFetch([UNCOLLECTED_SOURCE], []);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Uncollected Sources" })).toBeInTheDocument());
    // The main Sources page is collection-only — the individual source
    // title/row never renders here, only the virtual card's summary.
    expect(screen.queryByText("A La Carte Video")).not.toBeInTheDocument();
    expect(screen.getByText(/À-la-carte · 1 item/)).toBeInTheDocument();
  });

  it("the Uncollected Sources card still renders for a GENERAL_KNOWLEDGE project, without an analyzed-count clause (Analyze isn't available there)", async () => {
    stubFetch([UNCOLLECTED_SOURCE], [], [GENERAL_KNOWLEDGE_PROJECT]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Uncollected Sources" })).toBeInTheDocument());
    expect(screen.getByText("À-la-carte · 1 item")).toBeInTheDocument();
  });

  it("a collected source never inflates the Uncollected Sources card's count", async () => {
    stubFetch([COLLECTED_SOURCE, UNCOLLECTED_SOURCE], [COLLECTION_SUMMARY]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Uncollected Sources" })).toBeInTheDocument());
    expect(screen.getByText(/À-la-carte · 1 item/)).toBeInTheDocument();
    expect(screen.queryByText("Inside a Channel")).not.toBeInTheDocument();
    expect(screen.queryByText("A La Carte Video")).not.toBeInTheDocument();
  });

  it("no Uncollected Sources card renders when every video source belongs to a collection", async () => {
    stubFetch([COLLECTED_SOURCE], [COLLECTION_SUMMARY]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "SMB Capital" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Uncollected Sources" })).not.toBeInTheDocument();
  });

  it("clicking Open on the Uncollected Sources card navigates to its virtual detail route", async () => {
    stubFetch([UNCOLLECTED_SOURCE], []);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Uncollected Sources" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("UNCOLLECTED_DETAIL_MARKER")).toBeInTheDocument();
  });

  it("multiple collections each render their own card with independent counts", async () => {
    const secondCollection = { ...COLLECTION_SUMMARY, id: 2, title: "Another Channel", itemCount: 3, analyzedCount: 3 };
    stubFetch([], [COLLECTION_SUMMARY, secondCollection]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "SMB Capital" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Another Channel" })).toBeInTheDocument();
    expect(screen.getByText(/3 item.*3 analyzed/)).toBeInTheDocument();
  });

  it("neither Collections nor Uncollected Sources sections render when the project has no video sources at all", async () => {
    stubFetch([], []);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Uncollected Sources" })).not.toBeInTheDocument();
    expect(screen.queryByText("Collections")).not.toBeInTheDocument();
  });

  it("a SYNC_FAILED collection surfaces its sanitized error on the card", async () => {
    const failed = { ...COLLECTION_SUMMARY, status: "SYNC_FAILED", sanitizedError: "Channel is private." };
    stubFetch([], [failed]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("Channel is private.")).toBeInTheDocument());
  });
});
