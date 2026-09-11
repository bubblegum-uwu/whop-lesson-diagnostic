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
  id: 1,
  provider: "YOUTUBE",
  externalId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  title: "SMB Capital",
  sourceUrl: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
  status: "READY",
  sanitizedError: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z",
  itemCount: 2,
  analyzedCount: 1,
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
};

function stubFetch(overrides: { onAnalyzeBatch?: (body: unknown) => void; onAnalyzeOne?: (sourceId: string) => void } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
    if (url.includes("/collections/1?") || url.endsWith("/collections/1")) {
      return jsonResponse(200, { collection: COLLECTION, items: [ITEM_ANALYZED, ITEM_NOT_ANALYZED], pagination: { limit: 200, offset: 0, totalCount: 2 } });
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
    await waitFor(() => expect(screen.getByRole("heading", { name: "SMB Capital" })).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText("This collection doesn't exist.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Back to Sources/ }));
    expect(screen.getByText("SOURCES_MARKER")).toBeInTheDocument();
  });
});
