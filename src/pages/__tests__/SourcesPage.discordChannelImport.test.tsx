import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SourcesPage, type SourcesPageProps } from "../SourcesPage";
import * as bridge from "../../lib/discordCompanionBridge";

vi.mock("../../lib/discordCompanionBridge", async () => {
  const actual = await vi.importActual<typeof import("../../lib/discordCompanionBridge")>("../../lib/discordCompanionBridge");
  return { ...actual, detectDiscordCompanion: vi.fn(), scanDiscordChannel: vi.fn() };
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
    connected: true,
    providerErrorMessage: null,
    onSignIn: () => {},
    onDisconnect: () => {},
    backendUrl: "https://backend.example.com",
    knoveraToken: "token",
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

  it("3: a successful import refreshes BOTH the sources list and the collections/group catalog (regression) — the imported channel's card appears without a reload", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: true });
    vi.mocked(bridge.scanDiscordChannel).mockReturnValue({
      requestId: "req-1",
      result: Promise.resolve({
        channel: { guildId: "1218766394997346395", channelId: "1219022089252503632", channelName: "trading-alerts" },
        occurrences: [{ youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", messageId: "m1", messageUrl: null, postedAt: "2026-01-01T00:00:00Z" }],
        messagesScanned: 10,
        cancelled: false,
      }),
      cancel: () => {},
    });

    let sourcesCallCount = 0;
    let collectionsCallCount = 0;
    const channelCollection = {
      groupKey: "derived:youtube-discord-channel:1218766394997346395:1219022089252503632",
      kind: "DERIVED",
      id: null,
      provider: "YOUTUBE",
      sourceType: "CHANNEL",
      originProvider: "DISCORD",
      originContainerId: "1219022089252503632",
      externalId: null,
      title: "Discord · #trading-alerts",
      sourceUrl: null,
      status: null,
      sanitizedError: null,
      lastSyncedAt: null,
      itemCount: 1,
      analyzedCount: 0,
      hasMoreHistory: false,
    };

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources" && (!init || init.method === undefined)) {
        sourcesCallCount += 1;
        return jsonResponse(200, { projectId: 7, sources: [] });
      }
      if (url === "https://backend.example.com/api/projects/7/collections" && (!init || init.method === undefined)) {
        collectionsCallCount += 1;
        return jsonResponse(200, { projectId: 7, collections: collectionsCallCount === 1 ? [] : [channelCollection] });
      }
      if (url === "https://backend.example.com/api/projects/7/sources/youtube/discord-import" && init?.method === "POST") {
        return jsonResponse(200, {
          results: [{ youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", messageId: "m1", kind: "added" }],
          occurrencesProcessed: 1,
          newSourceCount: 1,
          newOriginCount: 0,
          enrichedOriginCount: 0,
          duplicateOriginCount: 0,
          invalidCount: 0,
        });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Import YouTube from a Channel" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Import YouTube from a Channel" }));

    const channelUrlInput = await screen.findByLabelText("Discord Channel URL");
    fireEvent.change(channelUrlInput, { target: { value: "https://discord.com/channels/1218766394997346395/1219022089252503632" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan Channel" }));

    fireEvent.click(await screen.findByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByText(/1 added/)).toBeInTheDocument());
    // Both the raw sources list AND the collection/group catalog must
    // refresh once the import actually commits — refreshing only
    // `sources` was the bug that left the imported channel's card
    // invisible until a hard reload.
    await waitFor(() => expect(sourcesCallCount).toBeGreaterThan(1));
    await waitFor(() => expect(collectionsCallCount).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · CHANNEL" })).toBeInTheDocument());
    expect(screen.getByText("Discord · #trading-alerts · 1 item · 0 analyzed")).toBeInTheDocument();
  });
});
