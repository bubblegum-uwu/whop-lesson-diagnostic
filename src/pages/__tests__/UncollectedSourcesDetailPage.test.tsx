import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { UncollectedSourcesDetailPage } from "../UncollectedSourcesDetailPage";

afterEach(() => {
  vi.unstubAllGlobals();
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
const GENERAL_KNOWLEDGE_PROJECT = { ...MASTERMIND_API_PROJECT, projectType: "GENERAL_KNOWLEDGE" };

const YOUTUBE_SOURCE = {
  provider: "YOUTUBE",
  sourceType: "VIDEO",
  id: 1,
  externalId: "dQw4w9WgXcQ",
  sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Support & Resistance Basics",
  durationSeconds: null,
  status: "READY",
  createdAt: "2026-01-05T00:00:00.000Z",
  collectionId: null,
  origins: [],
};

const DISCORD_SOURCE = {
  provider: "DISCORD",
  sourceType: "VIDEO",
  id: 5,
  externalId: "987654321098765432",
  sourceUrl: "https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip.mp4?ex=1&is=2&hm=3",
  title: "Trade Recap Clip",
  durationSeconds: null,
  status: "READY",
  createdAt: "2026-01-05T00:00:00.000Z",
  collectionId: null,
};

function renderPage(initialPath = "/projects/7/collections/uncollected") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_MARKER</div>} />
        <Route
          path="/projects/:projectId/collections/uncollected"
          element={<UncollectedSourcesDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function analysisJson(overrides: Record<string, unknown> = {}) {
  return { sourceId: 1, job: null, analysis: null, ...overrides };
}

describe("UncollectedSourcesDetailPage — routing and basics (Phase 4L)", () => {
  it("Back to Sources navigates to the main Sources page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("No uncollected sources.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "← Sources" }));
    expect(screen.getByText("SOURCES_MARKER")).toBeInTheDocument();
  });

  it("renders only sources with collectionId === null, excluding any collected source the backend might also return", async () => {
    const collected = { ...YOUTUBE_SOURCE, id: 2, title: "Collected Video", collectionId: 10 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE, collected] });
        if (url.includes("/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Support & Resistance Basics")).toBeInTheDocument());
    expect(screen.queryByText("Collected Video")).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no uncollected sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("No uncollected sources.")).toBeInTheDocument());
  });

  it("Phase 4K-C provenance still renders for a YouTube source discovered via Discord", async () => {
    const withOrigin = {
      ...YOUTUBE_SOURCE,
      origins: [
        { originType: "DISCORD_CHANNEL", discordGuildId: "g1", discordChannelId: "c1", discordChannelName: "scarface-alerts", discordMessageId: "m1", discordMessageUrl: null, discordPostedAt: "2026-09-12T00:00:00.000Z" },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [withOrigin] });
        if (url.includes("/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Support & Resistance Basics")).toBeInTheDocument());
    expect(screen.getByText(/Source: Discord · #scarface-alerts/)).toBeInTheDocument();
  });

  it("a YouTube source with no title falls back to its canonical URL, never a fabricated title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [{ ...YOUTUBE_SOURCE, title: null }] });
        if (url.includes("/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeInTheDocument());
  });

  it("a manual-only YouTube source shows 'Source: Manual'", async () => {
    const manual = { ...YOUTUBE_SOURCE, origins: [{ originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [manual] });
        if (url.includes("/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Support & Resistance Basics")).toBeInTheDocument());
    expect(screen.getByText("Source: Manual")).toBeInTheDocument();
  });
});

describe("UncollectedSourcesDetailPage — analysis actions (Phase 4H-B behavior relocated in Phase 4L)", () => {
  it("A/C: clicking Analyze calls POST .../sources/:sourceId/analyze", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
      if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") return jsonResponse(200, analysisJson());
      if (url === "https://backend.example.com/api/projects/7/sources/1/analyze" && init?.method === "POST") {
        expect(JSON.parse(init!.body as string)).toEqual({ force: false });
        return jsonResponse(202, { alreadyQueued: false, job: { jobId: "job-1", projectSourceId: 1, status: "QUEUED", attemptCount: 1, sanitizedError: null } });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/sources/1/analyze", expect.objectContaining({ method: "POST" })),
    );
  });

  it("clicking Analyze disables the button (shows 'Starting…') while the request is in flight", async () => {
    let resolveAnalyze!: (res: Response) => void;
    const analyzePromise = new Promise<Response>((resolve) => {
      resolveAnalyze = resolve;
    });
    let queued = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
      if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
        return jsonResponse(200, queued ? analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "QUEUED", attemptCount: 1, sanitizedError: null } }) : analysisJson());
      }
      if (url === "https://backend.example.com/api/projects/7/sources/1/analyze" && init?.method === "POST") {
        queued = true;
        return analyzePromise;
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled());
    const analyzeCalls = fetchMock.mock.calls.filter(([url]) => url === "https://backend.example.com/api/projects/7/sources/1/analyze");
    expect(analyzeCalls).toHaveLength(1);

    resolveAnalyze(jsonResponse(202, { alreadyQueued: false, job: { jobId: "job-1", projectSourceId: 1, status: "QUEUED", attemptCount: 1, sanitizedError: null } }));
    await waitFor(() => expect(screen.getByText("Queued")).toBeInTheDocument());
  });

  it("D: Whop disconnected does not disable the Analyze button (analysis never touches Whop)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled());
  });

  it("a QUEUED job shows the Queued status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "QUEUED", attemptCount: 1, sanitizedError: null } }));
        }
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Queued")).toBeInTheDocument());
  });

  it("an ANALYZING job shows the Analyzing status and hides the Analyze button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "ANALYZING", attemptCount: 1, sanitizedError: null } }));
        }
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Analyzing")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Analyze" })).not.toBeInTheDocument();
  });

  it("an analyzed source exposes View, and View displays the persisted analysis under a YouTube Video identity", async () => {
    const analysis = {
      analysisId: 1,
      projectSourceId: 1,
      status: "completed",
      strategyFound: true,
      validatedJson: {
        lesson: { title: "Support & Resistance Basics", duration_seconds: null },
        strategy_found: true,
        strategies: [
          {
            strategy_name: "Break & Retest",
            market_or_instrument: ["ES"],
            timeframes: ["5m"],
            entry_rules: [{ description: "retest entry", start_timestamp: "00:15", end_timestamp: null, evidence: "shown on chart" }],
          },
        ],
        knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] },
      },
      analysisSummary: "Break & Retest using VWAP",
      processingDurationSeconds: 30,
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 0,
      estimatedCost: 0.05,
      completedAt: "2026-01-06T00:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "COMPLETED", attemptCount: 1, sanitizedError: null }, analysis }));
        }
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("YouTube Video").length).toBeGreaterThan(0);
    expect(screen.getByText("Break & Retest")).toBeInTheDocument();
    expect(screen.queryByText(/Whop lesson/i)).not.toBeInTheDocument();
  });

  it("a FAILED job exposes Retry with the Failed badge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "FAILED", attemptCount: 1, sanitizedError: "Video unavailable." } }));
        }
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("Re-analyze on an analyzed source calls analyze with force:true", async () => {
    const analysis = {
      analysisId: 1,
      projectSourceId: 1,
      status: "no_strategy",
      strategyFound: false,
      validatedJson: { lesson: { title: "x", duration_seconds: null }, strategy_found: false, strategies: [], knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] } },
      analysisSummary: "summary",
      processingDurationSeconds: 10,
      inputTokens: 1,
      outputTokens: 1,
      thinkingTokens: 0,
      estimatedCost: 0.01,
      completedAt: "2026-01-06T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
      if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") return jsonResponse(200, analysisJson({ analysis }));
      if (url === "https://backend.example.com/api/projects/7/sources/1/analyze" && init?.method === "POST") {
        expect(JSON.parse(init!.body as string)).toEqual({ force: true });
        return jsonResponse(202, { alreadyQueued: false, job: { jobId: "job-2", projectSourceId: 1, status: "QUEUED", attemptCount: 1, sanitizedError: null } });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Re-analyze" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Re-analyze" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/sources/1/analyze", expect.objectContaining({ method: "POST" })),
    );
  });
});

describe("UncollectedSourcesDetailPage — Discord sources and GENERAL_KNOWLEDGE gating", () => {
  it("a Discord source shows the same generic Analyze logic as YouTube, under a 'Discord Video' label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [DISCORD_SOURCE] });
        if (url.endsWith("/sources/5/analysis")) return jsonResponse(200, { sourceId: 5, job: null, analysis: null });
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Discord Video")).toBeInTheDocument());
    expect(screen.getByText("Not analyzed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeInTheDocument();
  });

  it("View on a completed Discord analysis opens the drawer under a 'Discord Video' identity with an 'Open Attachment' link, never a fake Whop lesson or YouTube label", async () => {
    const analysis = {
      analysisId: 1,
      projectSourceId: 5,
      status: "completed",
      strategyFound: true,
      validatedJson: {
        lesson: { title: "Trade Recap Clip", duration_seconds: null },
        strategy_found: true,
        strategies: [
          {
            strategy_name: "Break & Retest",
            market_or_instrument: [],
            timeframes: [],
            entry_rules: [{ description: "retest entry", start_timestamp: "00:15", end_timestamp: null, evidence: "shown on screen" }],
          },
        ],
        knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] },
      },
      analysisSummary: "Break & Retest",
      processingDurationSeconds: 20,
      inputTokens: 10,
      outputTokens: 5,
      thinkingTokens: 0,
      estimatedCost: 0.02,
      completedAt: "2026-01-06T00:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [DISCORD_SOURCE] });
        if (url.endsWith("/sources/5/analysis")) {
          return jsonResponse(200, { sourceId: 5, job: { jobId: "job-1", projectSourceId: 5, status: "COMPLETED", attemptCount: 1, sanitizedError: null }, analysis });
        }
        return jsonResponse(404, {});
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Discord Video").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open Attachment" })).toHaveAttribute("href", DISCORD_SOURCE.sourceUrl);
    expect(screen.queryByText("YouTube Video")).not.toBeInTheDocument();
    expect(screen.queryByText(/Whop lesson/i)).not.toBeInTheDocument();
  });

  it("no Analyze/Retry/View controls appear for any uncollected source in a General Knowledge project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [GENERAL_KNOWLEDGE_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [DISCORD_SOURCE] });
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Discord Video")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Analyze" })).not.toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
  });
});

describe("UncollectedSourcesDetailPage — batch selection", () => {
  it("Select All Unanalyzed then Analyze Selected calls the batch endpoint with exactly the unanalyzed item", async () => {
    let batchBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url.endsWith("/sources/1/analysis")) return jsonResponse(200, analysisJson());
        if (url.endsWith("/sources/analyze-batch") && init?.method === "POST") {
          batchBody = JSON.parse(init.body as string);
          return jsonResponse(202, { results: [{ sourceId: 1, kind: "queued" }] });
        }
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Support & Resistance Basics")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Select All Unanalyzed" }));
    fireEvent.click(screen.getByRole("button", { name: /Analyze Selected/ }));

    await waitFor(() => expect(batchBody).toEqual({ sourceIds: [1] }));
  });
});

describe("UncollectedSourcesDetailPage — Discord channel import provenance display (Phase 4K-C, relocated in Phase 4L)", () => {
  it("3: a manually-added YouTube source renders 'Source: Manual'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) {
          return jsonResponse(200, {
            projectId: 7,
            sources: [{ ...YOUTUBE_SOURCE, origins: [{ originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null }] }],
          });
        }
        if (url.endsWith("/sources/1/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    expect(await screen.findByText("Source: Manual")).toBeInTheDocument();
    expect(screen.queryByText(/Posted/)).not.toBeInTheDocument();
  });

  it("4: a Discord-discovered YouTube source renders its channel reference and posted date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) {
          return jsonResponse(200, {
            projectId: 7,
            sources: [
              {
                ...YOUTUBE_SOURCE,
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
              },
            ],
          });
        }
        if (url.endsWith("/sources/1/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    expect(await screen.findByText("Source: Discord · #pre-market-live")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
  });

  it("5: a source with no known origins renders no provenance line — never a fabricated 'Manual' label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url.endsWith("/sources/1/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Support & Resistance Basics")).toBeInTheDocument());
    expect(screen.queryByText(/Source:/)).not.toBeInTheDocument();
  });

  it("6/4: Manual + multiple Discord origins render a compact post count, the LATEST posted date, and every origin still available in an expandable detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) {
          return jsonResponse(200, {
            projectId: 7,
            sources: [
              {
                ...YOUTUBE_SOURCE,
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
              },
            ],
          });
        }
        if (url.endsWith("/sources/1/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();

    const summary = await screen.findByText("Source: Manual + 2 Discord posts");
    expect(summary).toBeInTheDocument();
    expect(screen.getByText("Latest posted: Sep 13, 2026")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText(/Discord · #pre-market-live \/ Posted:/)).toBeInTheDocument();
    expect(screen.getByText(/Discord · #trade-ideas \/ Posted:/)).toBeInTheDocument();
  });

  it("3: multiple Discord origins with NO manual origin render a compact post count and the latest posted date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) {
          return jsonResponse(200, {
            projectId: 7,
            sources: [
              {
                ...YOUTUBE_SOURCE,
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
              },
            ],
          });
        }
        if (url.endsWith("/sources/1/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();

    expect(await screen.findByText("Source: 3 Discord posts")).toBeInTheDocument();
    expect(screen.getByText("Latest posted: Apr 8, 2026")).toBeInTheDocument();
    expect(screen.queryByText(/Manual/)).not.toBeInTheDocument();
  });

  it("7: falls back to the raw channel id when no channel name is available — never a fabricated name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) {
          return jsonResponse(200, {
            projectId: 7,
            sources: [
              {
                ...YOUTUBE_SOURCE,
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
              },
            ],
          });
        }
        if (url.endsWith("/sources/1/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    renderPage();
    expect(await screen.findByText("Source: Discord · channel 1219022089252503632")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
  });

  it("8: an existing source that gains a new provenance record after a refresh (re-navigating to this page) updates its display without duplicating the row", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) {
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
          return jsonResponse(200, { projectId: 7, sources: [{ ...YOUTUBE_SOURCE, origins }] });
        }
        if (url.endsWith("/sources/1/analysis")) return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );
    const { rerender } = renderPage();
    expect(await screen.findByText("Source: Manual")).toBeInTheDocument();
    expect(screen.getAllByText("Support & Resistance Basics")).toHaveLength(1);

    rerender(
      <MemoryRouter initialEntries={["/projects/7/collections/uncollected"]}>
        <Routes>
          <Route
            path="/projects/:projectId/collections/uncollected"
            element={<UncollectedSourcesDetailPage backendUrl="https://backend.example.com" knoveraToken="token-2" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Source: Manual + Discord · #pre-market-live")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
    expect(screen.queryByText(/1 Discord post/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Support & Resistance Basics")).toHaveLength(1);
  });
});
