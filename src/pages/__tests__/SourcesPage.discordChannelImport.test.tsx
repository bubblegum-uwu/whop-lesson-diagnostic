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

function youtubeSource(overrides: Record<string, unknown> = {}) {
  return {
    provider: "YOUTUBE",
    sourceType: "VIDEO",
    id: 9,
    externalId: "dQw4w9WgXcQ",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Support & Resistance Basics",
    durationSeconds: null,
    status: "READY",
    createdAt: "2026-01-05T00:00:00.000Z",
    collectionId: null,
    origins: [],
    ...overrides,
  };
}

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

function analysisJson(overrides: Record<string, unknown> = {}) {
  return { sourceId: 9, job: null, analysis: null, ...overrides };
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

  it("3: a manually-added YouTube source renders 'Source: Manual'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") {
          return jsonResponse(200, { projectId: 7, sources: [youtubeSource({ origins: [{ originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null }] })] });
        }
        if (url === "https://backend.example.com/api/projects/7/sources/9/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");
    expect(await screen.findByText("Source: Manual")).toBeInTheDocument();
    // 7: a MANUAL-only source never shows a fabricated posted date.
    expect(screen.queryByText(/Posted/)).not.toBeInTheDocument();
  });

  it("4: a Discord-discovered YouTube source renders its channel reference and posted date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") {
          return jsonResponse(200, {
            projectId: 7,
            sources: [
              youtubeSource({
                origins: [
                  {
                    originType: "DISCORD_CHANNEL",
                    discordGuildId: "g1",
                    discordChannelId: "c1",
                    discordChannelName: "pre-market-live",
                    discordMessageId: "m1",
                    discordMessageUrl: "https://discord.com/channels/g1/c1/m1",
                    discordPostedAt: "2026-09-12T14:30:00.000Z",
                  },
                ],
              }),
            ],
          });
        }
        if (url === "https://backend.example.com/api/projects/7/sources/9/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");
    expect(await screen.findByText("Source: Discord · #pre-market-live")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
  });

  it("5: a source with no known origins renders no provenance line — never a fabricated 'Manual' label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [youtubeSource()] });
        if (url === "https://backend.example.com/api/projects/7/sources/9/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("Support & Resistance Basics")).toBeInTheDocument());
    expect(screen.queryByText(/Source:/)).not.toBeInTheDocument();
  });

  it("6/4: Manual + multiple Discord origins render a compact post count, the LATEST posted date, and every origin still available in an expandable detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") {
          return jsonResponse(200, {
            projectId: 7,
            sources: [
              youtubeSource({
                origins: [
                  { originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null },
                  {
                    originType: "DISCORD_CHANNEL",
                    discordGuildId: "g1",
                    discordChannelId: "c1",
                    discordChannelName: "pre-market-live",
                    discordMessageId: "m1",
                    discordMessageUrl: null,
                    discordPostedAt: "2026-09-12T14:30:00.000Z",
                  },
                  {
                    originType: "DISCORD_CHANNEL",
                    discordGuildId: "g1",
                    discordChannelId: "c2",
                    discordChannelName: "trade-ideas",
                    discordMessageId: "m2",
                    discordMessageUrl: null,
                    discordPostedAt: "2026-09-13T09:00:00.000Z",
                  },
                ],
              }),
            ],
          });
        }
        if (url === "https://backend.example.com/api/projects/7/sources/9/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");

    const summary = await screen.findByText("Source: Manual + 2 Discord posts");
    expect(summary).toBeInTheDocument();
    // The latest of the two posted dates (Sep 13 > Sep 12) stays visible
    // in the collapsed row — never hidden behind the expand affordance.
    expect(screen.getByText("Latest posted: Sep 13, 2026")).toBeInTheDocument();
    // 5: the detail list is present in the DOM (a native <details>/<summary>
    // — collapsed by default, never discarded) with every individual origin
    // — its own channel and its own posted date — plus the Manual entry.
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText(/Discord · #pre-market-live \/ Posted:/)).toBeInTheDocument();
    expect(screen.getByText(/Discord · #trade-ideas \/ Posted:/)).toBeInTheDocument();
  });

  it("3: multiple Discord origins with NO manual origin render a compact post count and the latest posted date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") {
          return jsonResponse(200, {
            projectId: 7,
            sources: [
              youtubeSource({
                origins: [
                  {
                    originType: "DISCORD_CHANNEL",
                    discordGuildId: "g1",
                    discordChannelId: "c1",
                    discordChannelName: "pre-market-live",
                    discordMessageId: "m1",
                    discordMessageUrl: null,
                    discordPostedAt: "2026-04-02T00:00:00.000Z",
                  },
                  {
                    originType: "DISCORD_CHANNEL",
                    discordGuildId: "g1",
                    discordChannelId: "c1",
                    discordChannelName: "pre-market-live",
                    discordMessageId: "m2",
                    discordMessageUrl: null,
                    discordPostedAt: "2026-04-08T00:00:00.000Z",
                  },
                  {
                    originType: "DISCORD_CHANNEL",
                    discordGuildId: "g1",
                    discordChannelId: "c2",
                    discordChannelName: "daily-setups",
                    discordMessageId: "m3",
                    discordMessageUrl: null,
                    discordPostedAt: "2026-04-05T00:00:00.000Z",
                  },
                ],
              }),
            ],
          });
        }
        if (url === "https://backend.example.com/api/projects/7/sources/9/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");

    expect(await screen.findByText("Source: 3 Discord posts")).toBeInTheDocument();
    expect(screen.getByText("Latest posted: Apr 8, 2026")).toBeInTheDocument();
    expect(screen.queryByText(/Manual/)).not.toBeInTheDocument();
  });

  it("7: falls back to the raw channel id when no channel name is available — never a fabricated name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") {
          return jsonResponse(200, {
            projectId: 7,
            sources: [
              youtubeSource({
                origins: [
                  {
                    originType: "DISCORD_CHANNEL",
                    discordGuildId: "g1",
                    discordChannelId: "1219022089252503632",
                    discordChannelName: null,
                    discordMessageId: "m1",
                    discordMessageUrl: null,
                    discordPostedAt: "2026-09-12T14:30:00.000Z",
                  },
                ],
              }),
            ],
          });
        }
        if (url === "https://backend.example.com/api/projects/7/sources/9/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");
    expect(await screen.findByText("Source: Discord · channel 1219022089252503632")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
  });

  it("8: an existing source that gains a new provenance record after a refresh updates its display without duplicating the row", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") {
          call += 1;
          const origins =
            call === 1
              ? [{ originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null }]
              : [
                  { originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null },
                  {
                    originType: "DISCORD_CHANNEL",
                    discordGuildId: "g1",
                    discordChannelId: "c1",
                    discordChannelName: "pre-market-live",
                    discordMessageId: "m1",
                    discordMessageUrl: null,
                    discordPostedAt: "2026-09-12T14:30:00.000Z",
                  },
                ];
          return jsonResponse(200, { projectId: 7, sources: [youtubeSource({ origins })] });
        }
        if (url === "https://backend.example.com/api/projects/7/sources/9/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    const { rerender } = renderSources("/projects/7/sources");
    expect(await screen.findByText("Source: Manual")).toBeInTheDocument();
    expect(screen.getAllByText("Support & Resistance Basics")).toHaveLength(1);

    rerender(
      <MemoryRouter initialEntries={["/projects/7/sources"]}>
        <Routes>
          <Route path="/projects/:projectId/sources" element={<SourcesPage {...baseProps({ knoveraToken: "token-2" })} />} />
        </Routes>
      </MemoryRouter>,
    );

    // 2: Manual + exactly one Discord origin must name the actual channel
    // and keep the posted date visible — never collapse to a date-less
    // "Manual + 1 Discord post".
    expect(await screen.findByText("Source: Manual + Discord · #pre-market-live")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
    expect(screen.queryByText(/1 Discord post/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Support & Resistance Basics")).toHaveLength(1);
  });
});
