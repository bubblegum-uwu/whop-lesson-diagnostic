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

const DISCORD_COLLECTION = {
  id: 2,
  provider: "DISCORD",
  externalId: "123456789012345678",
  title: "#trade-reviews",
  sourceUrl: "https://discord.com/channels/g/123456789012345678",
  status: "READY",
  sanitizedError: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z",
  itemCount: 1,
  analyzedCount: 0,
};

const DISCORD_ITEM = {
  id: 201,
  provider: "DISCORD",
  externalId: "987654321098765432",
  title: "clip.mp4",
  sourceUrl: "https://cdn.discordapp.com/attachments/1/987654321098765432/clip.mp4",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "NOT_ANALYZED",
  eligibleForSynthesis: false,
};

function renderPage(initialPath = "/projects/7/collections/2") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_MARKER</div>} />
        <Route path="/projects/:projectId/collections/:collectionId" element={<CollectionDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CollectionDetailPage — Discord collections (Phase 4K-B)", () => {
  it("shows the Discord Collection label and a Refresh button (refresh is no longer YouTube-only)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.includes("/collections/2")) return jsonResponse(200, { collection: DISCORD_COLLECTION, items: [DISCORD_ITEM], pagination: { limit: 200, offset: 0, totalCount: 1 } });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await waitFor(() => expect(screen.getByText("Discord Collection · 1 item · 0 analyzed")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("clicking Refresh on a Discord collection calls the shared refresh endpoint and reloads items", async () => {
    let refreshCalled = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/collections/2/refresh") && init?.method === "POST") {
        refreshCalled = true;
        return jsonResponse(200, { collection: { ...DISCORD_COLLECTION, itemCount: 2 }, discoveredCount: 1, importedCount: 1, adoptedCount: 0, failedCount: 0, hasMoreHistory: false });
      }
      if (url.includes("/collections/2")) {
        return jsonResponse(200, {
          collection: refreshCalled ? { ...DISCORD_COLLECTION, itemCount: 2 } : DISCORD_COLLECTION,
          items: refreshCalled ? [DISCORD_ITEM, { ...DISCORD_ITEM, id: 202, externalId: "222" }] : [DISCORD_ITEM],
          pagination: { limit: 200, offset: 0, totalCount: refreshCalled ? 2 : 1 },
        });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/collections/2/refresh", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.getByText("Discord Collection · 2 items · 0 analyzed")).toBeInTheDocument());
  });
});
