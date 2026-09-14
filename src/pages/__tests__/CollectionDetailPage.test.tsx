import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { CollectionDetailPage } from "../CollectionDetailPage";

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

const COLLECTION = {
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
  itemCount: 2,
  analyzedCount: 1,
  hasMoreHistory: false,
};

const ITEM_ANALYZED = {
  id: 101,
  provider: "YOUTUBE",
  externalId: "aaaaaaaaaaa",
  title: "Analyzed Video",
  sourceUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ANALYZED",
  eligibleForSynthesis: true,
  origins: [],
};

const ITEM_NOT_ANALYZED = {
  id: 102,
  provider: "YOUTUBE",
  externalId: "bbbbbbbbbbb",
  title: "Not Analyzed Video",
  sourceUrl: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "NOT_ANALYZED",
  eligibleForSynthesis: false,
  origins: [],
};

function stubFetch(
  overrides: {
    onAnalyzeBatch?: (body: unknown) => void;
    onAnalyzeOne?: (sourceId: string) => void;
    onAnalyzeCollection?: () => void;
    projectType?: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE";
  } = {},
) {
  const project = overrides.projectType ? { ...PROJECT, projectType: overrides.projectType } : PROJECT;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [project] });
    if (url.includes("/collections/1?") || url.endsWith("/collections/1")) {
      return jsonResponse(200, { collection: COLLECTION, items: [ITEM_ANALYZED, ITEM_NOT_ANALYZED], pagination: { limit: 200, offset: 0, totalCount: 2 } });
    }
    if (url.endsWith("/collections/1/analyze") && init?.method === "POST") {
      overrides.onAnalyzeCollection?.();
      return jsonResponse(200, { queued: 1, alreadyAnalyzed: 1, alreadyQueued: 0, processing: 0, failed: 0 });
    }
    if (url.endsWith("/sources/analyze-batch") && init?.method === "POST") {
      overrides.onAnalyzeBatch?.(JSON.parse(init.body as string));
      return jsonResponse(202, { results: [{ sourceId: 102, kind: "queued" }] });
    }
    const analyzeMatch = url.match(/\/sources\/(\d+)\/analyze$/);
    if (analyzeMatch && init?.method === "POST") {
      overrides.onAnalyzeOne?.(analyzeMatch[1]);
      return jsonResponse(202, { alreadyQueued: false, job: { jobId: "job-1", projectSourceId: Number(analyzeMatch[1]), status: "QUEUED", attemptCount: 1, sanitizedError: null } });
    }
    return jsonResponse(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(initialPath = "/projects/7/collections/1") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_MARKER</div>} />
        <Route path="/projects/:projectId/collections/:collectionId" element={<CollectionDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CollectionDetailPage (Phase 4K)", () => {
  it("shows analyzed and not-analyzed items with distinct status badges", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · CHANNEL" })).toBeInTheDocument());
    expect(screen.getByText("Analyzed")).toBeInTheDocument();
    expect(screen.getByText("Not analyzed")).toBeInTheDocument();
  });

  it("an unanalyzed item shows an Analyze action and a checkbox; checking it does NOT analyze it", async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Not Analyzed Video")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Select Not Analyzed Video"));
    // Selecting (checking the box) must never itself call the analyze endpoint.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analyze"))).toBe(false);
  });

  it("individual Analyze click calls the single-item analyze endpoint for exactly that item", async () => {
    let analyzedId: string | undefined;
    stubFetch({ onAnalyzeOne: (id) => (analyzedId = id) });
    renderPage();
    await waitFor(() => expect(screen.getByText("Not Analyzed Video")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(analyzedId).toBe("102"));
  });

  it("Select All Unanalyzed then Analyze Selected calls the batch endpoint with exactly the unanalyzed item", async () => {
    let batchBody: unknown;
    stubFetch({ onAnalyzeBatch: (body) => (batchBody = body) });
    renderPage();
    await waitFor(() => expect(screen.getByText("Not Analyzed Video")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Select All Unanalyzed" }));
    fireEvent.click(screen.getByRole("button", { name: /Analyze Selected/ }));

    await waitFor(() => expect(batchBody).toEqual({ sourceIds: [102] }));
  });

  it("the analyzed item's checkbox is NOT auto-checked — selection is independent of analysis state", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Analyzed Video")).toBeInTheDocument());
    expect(screen.getByLabelText("Select Analyzed Video")).not.toBeChecked();
    expect(screen.getByLabelText("Select Not Analyzed Video")).not.toBeChecked();
  });

  it("shows a not-found state for an unknown collection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
        return jsonResponse(404, { error: { message: "Unknown source collection.", type: "collection_not_found" } });
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("This collection doesn't exist, or currently has no sources.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Back to Sources/ }));
    expect(screen.getByText("SOURCES_MARKER")).toBeInTheDocument();
  });
});

describe("CollectionDetailPage — Analyze Collection (Phase 4L)", () => {
  it("shows an 'Analyze N Remaining' button sized to the not-yet-analyzed count", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze 1 Remaining" })).toBeInTheDocument());
  });

  it("clicking it calls the collection-analyze endpoint and shows a concise result summary", async () => {
    let called = false;
    stubFetch({ onAnalyzeCollection: () => (called = true) });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze 1 Remaining" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Analyze 1 Remaining" }));
    await waitFor(() => expect(called).toBe(true));
    expect(await screen.findByText(/1 queued/)).toBeInTheDocument();
    expect(screen.getByText(/1 already analyzed/)).toBeInTheDocument();
  });

  it("is never shown for a GENERAL_KNOWLEDGE collection (no Analyze/Retry controls there at all)", async () => {
    stubFetch({ projectType: "GENERAL_KNOWLEDGE" });
    renderPage();
    await waitFor(() => expect(screen.getByText("Not Analyzed Video")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Analyze.*Remaining/ })).not.toBeInTheDocument();
  });

  it("is never shown when every item is already analyzed (remaining count is zero)", async () => {
    const fullyAnalyzedCollection = { ...COLLECTION, itemCount: 1, analyzedCount: 1 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
        if (url.includes("/collections/1?") || url.endsWith("/collections/1")) {
          return jsonResponse(200, { collection: fullyAnalyzedCollection, items: [ITEM_ANALYZED], pagination: { limit: 200, offset: 0, totalCount: 1 } });
        }
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Analyzed Video")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Analyze.*Remaining/ })).not.toBeInTheDocument();
  });

  it("never touches Synthesis Set membership — Analyze Collection is analysis only", async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze 1 Remaining" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Analyze 1 Remaining" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/collections/1/analyze"), expect.anything()));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/synthesis-sets"))).toBe(false);
  });
});

describe("CollectionDetailPage — DERIVED groups (Phase 4L taxonomy correction)", () => {
  const DERIVED_GROUP_KEY = "derived:youtube-discord-channel:998877";
  const DERIVED_GROUP = {
    groupKey: DERIVED_GROUP_KEY,
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
    itemCount: 1,
    analyzedCount: 0,
    hasMoreHistory: false,
  };
  const DERIVED_ITEM_WITH_ORIGIN = {
    id: 401,
    provider: "YOUTUBE",
    externalId: "eeeeeeeeeee",
    title: "Alert Recap",
    sourceUrl: "https://www.youtube.com/watch?v=eeeeeeeeeee",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "NOT_ANALYZED",
    eligibleForSynthesis: false,
    origins: [
      { originType: "DISCORD_CHANNEL", discordGuildId: "g1", discordChannelId: "998877", discordChannelName: "scarface-alerts", discordMessageId: "m1", discordMessageUrl: null, discordPostedAt: "2026-09-12T00:00:00.000Z" },
    ],
  };

  function stubDerivedFetch(overrides: { onAnalyzeCollection?: () => void } = {}) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      // The frontend URL-encodes the groupKey (it contains colons).
      if (url.includes(`/collections/${encodeURIComponent(DERIVED_GROUP_KEY)}/analyze`) && init?.method === "POST") {
        overrides.onAnalyzeCollection?.();
        return jsonResponse(200, { queued: 1, alreadyAnalyzed: 0, alreadyQueued: 0, processing: 0, failed: 0 });
      }
      if (url.includes(`/collections/${encodeURIComponent(DERIVED_GROUP_KEY)}`)) {
        return jsonResponse(200, { collection: DERIVED_GROUP, items: [DERIVED_ITEM_WITH_ORIGIN], pagination: { limit: 200, offset: 0, totalCount: 1 } });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function renderDerivedPage() {
    return render(
      <MemoryRouter initialEntries={[`/projects/7/collections/${encodeURIComponent(DERIVED_GROUP_KEY)}`]}>
        <Routes>
          <Route path="/projects/:projectId/sources" element={<div>SOURCES_MARKER</div>} />
          <Route path="/projects/:projectId/collections/:collectionId" element={<CollectionDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("opening a derived group's URL shows exactly its members, with its PROVIDER · TYPE header and origin line", async () => {
    stubDerivedFetch();
    renderDerivedPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · CHANNEL" })).toBeInTheDocument());
    // Appears both in the page header's origin line and in the item's own provenance row.
    expect(screen.getAllByText(/Discord · #scarface-alerts/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Alert Recap")).toBeInTheDocument();
  });

  it("never shows Refresh or Remove Collection for a derived group — there is no row to refresh or delete", async () => {
    stubDerivedFetch();
    renderDerivedPage();
    await waitFor(() => expect(screen.getByText("Alert Recap")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Collection" })).not.toBeInTheDocument();
  });

  it("shows each item's provenance (Discord channel + posted date), same rules as a persisted collection", async () => {
    stubDerivedFetch();
    renderDerivedPage();
    expect(await screen.findByText("Source: Discord · #scarface-alerts")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
  });

  it("Analyze Collection on a derived group posts to its URL-encoded groupKey and resolves exactly its members server-side", async () => {
    let called = false;
    const fetchMock = stubDerivedFetch({ onAnalyzeCollection: () => (called = true) });
    renderDerivedPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze 1 Remaining" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Analyze 1 Remaining" }));
    await waitFor(() => expect(called).toBe(true));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(encodeURIComponent(DERIVED_GROUP_KEY)))).toBe(true);
  });
});
