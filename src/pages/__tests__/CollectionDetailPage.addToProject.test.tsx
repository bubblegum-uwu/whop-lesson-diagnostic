import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
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
  name: "Discord Knowledge",
  projectType: "GENERAL_KNOWLEDGE",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  courseCount: 0,
  lessonCount: 0,
  analyzedLessonCount: 0,
  latestSynthesisStatus: null,
  latestSynthesisCompletedAt: null,
};

const OTHER_PROJECT = { ...PROJECT, id: 9, name: "Trading Accelerator", projectType: "TRADING_STRATEGIES" };

const COLLECTION = {
  id: 1,
  provider: "DISCORD",
  externalId: "guild_1:chan_1",
  title: "#trading-videos",
  sourceUrl: "https://discord.com/channels/guild_1/chan_1",
  status: "READY",
  sanitizedError: null,
  lastSyncedAt: null,
  itemCount: 1,
  analyzedCount: 0,
};

const DISCORD_ITEM = {
  id: 201,
  provider: "DISCORD",
  externalId: "998877665544332211",
  title: "clip.mp4",
  sourceUrl: "https://cdn.discordapp.com/attachments/1/998877665544332211/clip.mp4",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "NOT_ANALYZED",
  eligibleForSynthesis: false,
};

function stubFetch(overrides: { onAddToProjects?: (body: unknown) => void } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT, OTHER_PROJECT] });
    if (url.includes("/collections/1?") || url.endsWith("/collections/1")) {
      return jsonResponse(200, { collection: COLLECTION, items: [DISCORD_ITEM], pagination: { limit: 200, offset: 0, totalCount: 1 } });
    }
    if (url.endsWith("/add-to-projects") && init?.method === "POST") {
      overrides.onAddToProjects?.(JSON.parse(init.body as string));
      return jsonResponse(200, { results: [{ projectId: 9, kind: "added" }] });
    }
    return jsonResponse(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/7/collections/1"]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_MARKER</div>} />
        <Route path="/projects/:projectId/collections/:collectionId" element={<CollectionDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CollectionDetailPage — Add to Project (Phase 4K-B revised)", () => {
  it("offers 'Add to Project…' for a captured Discord item, opens a dialog listing other projects (excluding the current one)", async () => {
    stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("clip.mp4")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to Project…" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Trading Accelerator/)).toBeInTheDocument();
    // The current project (Discord Knowledge) is never offered as a target.
    expect(within(dialog).queryByText(/Discord Knowledge/)).not.toBeInTheDocument();
  });

  it("submitting selected projects calls add-to-projects with exactly the selected target ids and shows the result", async () => {
    let sentBody: unknown;
    stubFetch({ onAddToProjects: (body) => (sentBody = body) });
    renderPage();
    await waitFor(() => expect(screen.getByText("clip.mp4")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to Project…" }));
    await waitFor(() => expect(screen.getByText(/Trading Accelerator/)).toBeInTheDocument());

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: /Add to 1 Project/ }));

    await waitFor(() => expect(sentBody).toEqual({ targetProjectIds: [9] }));
    await waitFor(() => expect(screen.getByText("Added")).toBeInTheDocument());
  });

  it("Cancel never calls the add-to-projects endpoint", async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("clip.mp4")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to Project…" }));
    await waitFor(() => expect(screen.getByText(/Trading Accelerator/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/add-to-projects"))).toBe(false);
  });
});
