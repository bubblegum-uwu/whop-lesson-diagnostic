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

/** A real, persisted YouTube-channel collection (Phase 4K) — unaffected by the Phase 4L taxonomy correction. */
const PERSISTED_YOUTUBE_COLLECTION = {
  groupKey: "1",
  kind: "PERSISTED",
  id: 1,
  provider: "YOUTUBE",
  sourceType: "CHANNEL",
  originProvider: null,
  originContainerId: null,
  externalId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  title: "SMB Capital",
  sourceUrl: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
  status: "READY",
  sanitizedError: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z",
  itemCount: 1,
  analyzedCount: 0,
  hasMoreHistory: false,
};

/** A DERIVED group — YouTube videos discovered by scanning a Discord channel (Phase 4L taxonomy correction: never a generic "Uncollected/À-la-carte" bucket). */
const DERIVED_DISCORD_CHANNEL_GROUP = {
  groupKey: "derived:youtube-discord-channel:998877",
  kind: "DERIVED",
  id: null,
  provider: "YOUTUBE",
  sourceType: "CHANNEL",
  originProvider: "DISCORD",
  originContainerId: "998877",
  externalId: null,
  title: "Discord · #scarface-alerts",
  sourceUrl: null,
  status: null,
  sanitizedError: null,
  lastSyncedAt: null,
  itemCount: 3,
  analyzedCount: 0,
  hasMoreHistory: false,
};

/** A DERIVED group — genuinely manual YouTube à-la-carte adds. */
const DERIVED_MANUAL_ALA_CARTE_GROUP = {
  groupKey: "derived:youtube-ala-carte",
  kind: "DERIVED",
  id: null,
  provider: "YOUTUBE",
  sourceType: "A_LA_CARTE",
  originProvider: "MANUAL",
  originContainerId: null,
  externalId: null,
  title: "Manual YouTube",
  sourceUrl: null,
  status: null,
  sanitizedError: null,
  lastSyncedAt: null,
  itemCount: 1,
  analyzedCount: 0,
  hasMoreHistory: false,
};

const ALA_CARTE_WHOP_LESSON = {
  id: 501,
  courseId: 9,
  courseTitle: "Scarface Mastermind",
  title: "Risk Management 101",
  sourceUrl: "https://whop.com/lessons/501",
  durationSeconds: null,
  status: "NOT_ANALYZED",
  eligibleForSynthesis: false,
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

function stubFetch(collections: unknown[], projects: unknown[] = [PROJECT], alaCarteWhopLessons: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections });
      if (url.endsWith("/whop-lessons")) return jsonResponse(200, { projectId: 7, items: alaCarteWhopLessons });
      return jsonResponse(404, {});
    }),
  );
}

function renderSources(initialPath: string, props: Partial<SourcesPageProps> = {}) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<SourcesPage {...baseProps(props)} />} />
        <Route path="/projects/:projectId/whop-ala-carte" element={<div>WHOP_ALA_CARTE_DETAIL_MARKER</div>} />
        <Route path="/projects/:projectId/collections/:collectionId" element={<div>COLLECTION_DETAIL_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SourcesPage — collection/group-first Sources UI (Phase 4L taxonomy correction)", () => {
  it("renders a PERSISTED collection card with its PROVIDER · TYPE label, item/analyzed counts", async () => {
    stubFetch([PERSISTED_YOUTUBE_COLLECTION]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · CHANNEL" })).toBeInTheDocument());
    expect(screen.getByText(/YouTube · SMB Capital/)).toBeInTheDocument();
    expect(screen.getByText(/1 item.*0 analyzed/)).toBeInTheDocument();
  });

  it("clicking Open on a persisted collection card navigates to its detail page by groupKey", async () => {
    stubFetch([PERSISTED_YOUTUBE_COLLECTION]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · CHANNEL" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("COLLECTION_DETAIL_MARKER")).toBeInTheDocument();
  });

  it("a YouTube-via-Discord-channel DERIVED group renders as its own card — never a generic 'Uncollected/À-la-carte' bucket", async () => {
    stubFetch([DERIVED_DISCORD_CHANNEL_GROUP]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · CHANNEL" })).toBeInTheDocument());
    expect(screen.getByText(/Discord · #scarface-alerts/)).toBeInTheDocument();
    expect(screen.getByText(/3 items/)).toBeInTheDocument();
    expect(screen.queryByText(/À-la-carte/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Uncollected Sources" })).not.toBeInTheDocument();
  });

  it("a manual YouTube à-la-carte DERIVED group renders as YOUTUBE · À-LA-CARTE / Manual YouTube", async () => {
    stubFetch([DERIVED_MANUAL_ALA_CARTE_GROUP]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · À-LA-CARTE" })).toBeInTheDocument());
    expect(screen.getByText(/Manual YouTube/)).toBeInTheDocument();
  });

  it("a persisted collection and a derived group never merge into one card, even when both hold YOUTUBE items", async () => {
    stubFetch([PERSISTED_YOUTUBE_COLLECTION, DERIVED_DISCORD_CHANNEL_GROUP]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "YOUTUBE · CHANNEL" })).toHaveLength(2));
    expect(screen.getByText(/YouTube · SMB Capital/)).toBeInTheDocument();
    expect(screen.getByText(/Discord · #scarface-alerts/)).toBeInTheDocument();
  });

  it("clicking Open on a derived group card navigates using its URL-encoded groupKey", async () => {
    stubFetch([DERIVED_DISCORD_CHANNEL_GROUP]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · CHANNEL" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("COLLECTION_DETAIL_MARKER")).toBeInTheDocument();
  });

  it("a WHOP · À-LA-CARTE card renders only when qualifying à-la-carte Whop lessons exist — never a fabricated empty card", async () => {
    stubFetch([], [PROJECT], []);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "WHOP · À-LA-CARTE" })).not.toBeInTheDocument();
  });

  it("a WHOP · À-LA-CARTE card renders with its item count when qualifying lessons exist, and Open navigates to its own detail page", async () => {
    stubFetch([], [PROJECT], [ALA_CARTE_WHOP_LESSON]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "WHOP · À-LA-CARTE" })).toBeInTheDocument());
    expect(screen.getByText(/Individual Whop Content · 1 item · 0 analyzed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("WHOP_ALA_CARTE_DETAIL_MARKER")).toBeInTheDocument();
  });

  it("multiple collections/groups each render their own card with independent counts", async () => {
    const secondCollection = { ...PERSISTED_YOUTUBE_COLLECTION, groupKey: "2", id: 2, title: "Another Channel", itemCount: 3, analyzedCount: 3 };
    stubFetch([PERSISTED_YOUTUBE_COLLECTION, secondCollection]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText(/YouTube · SMB Capital/)).toBeInTheDocument());
    expect(screen.getByText(/YouTube · Another Channel/)).toBeInTheDocument();
    expect(screen.getByText(/3 item.*3 analyzed/)).toBeInTheDocument();
  });

  it("no Collections section renders when the project has no collections/groups and no à-la-carte Whop lessons", async () => {
    stubFetch([], [PROJECT], []);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByText("Collections")).not.toBeInTheDocument();
  });

  it("a SYNC_FAILED persisted collection surfaces its sanitized error on the card", async () => {
    const failed = { ...PERSISTED_YOUTUBE_COLLECTION, status: "SYNC_FAILED", sanitizedError: "Channel is private." };
    stubFetch([failed]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("Channel is private.")).toBeInTheDocument());
  });
});
