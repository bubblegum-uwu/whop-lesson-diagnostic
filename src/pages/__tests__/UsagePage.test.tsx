import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { UsagePage } from "../UsagePage";
import type { UsageResponse } from "../../lib/usageApi";

const BACKEND_URL = "https://backend.example.com";
const TOKEN = "operator-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function baseUsage(overrides: Partial<UsageResponse> = {}): UsageResponse {
  return {
    period: { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z", label: "September 2026" },
    total: { analysisCost: 8.94, synthesisCost: 6.42, totalCost: 15.36 },
    projects: [
      {
        projectId: 7,
        projectName: "MasterMind",
        projectType: "TRADING_STRATEGIES",
        analysisCost: 8.94,
        synthesisCost: 6.42,
        totalCost: 15.36,
        analysisRuns: 28,
        lessonsAnalyzed: 28,
        sourcesAnalyzed: 0,
        synthesisRuns: 1,
      },
    ],
    ...overrides,
  };
}

function stubFetch(usage: UsageResponse | "error" | "pending", statusCode = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.includes("/api/usage")) throw new Error(`Unexpected fetch: ${url}`);
      if (usage === "error") return jsonResponse(statusCode, { error: { message: "Failed to load usage.", type: "server_error" } });
      if (usage === "pending") return new Promise<Response>(() => undefined); // never resolves
      return jsonResponse(200, usage);
    }),
  );
}

describe("UsagePage — project-aware usage dashboard (Phase 4F)", () => {
  it("A: loads and renders real usage data from GET /api/usage", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes("/api/usage") ? jsonResponse(200, baseUsage()) : jsonResponse(404, {})));
    vi.stubGlobal("fetch", fetchMock);

    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);
    await waitFor(() => expect(screen.getAllByText("$15.36").length).toBeGreaterThan(0));
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/api/usage?period=current_month`, expect.anything());
  });

  it("B: renders the current-month period label", async () => {
    stubFetch(baseUsage());
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);
    expect(await screen.findByText("September 2026")).toBeInTheDocument();
  });

  it("C: renders the total spend figure", async () => {
    stubFetch(baseUsage());
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);
    expect(await screen.findByText("Total Spend")).toBeInTheDocument();
    const totalCard = screen.getByText("Total Spend").closest(".knovera-usage-total-card")!;
    expect(totalCard).toHaveTextContent("$15.36");
  });

  it("D: renders the analysis/synthesis breakdown under the total", async () => {
    stubFetch(baseUsage());
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);
    await screen.findByText("Total Spend");
    expect(screen.getAllByText("$8.94").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$6.42").length).toBeGreaterThan(0);
  });

  it("E: renders the MasterMind project row/card with its own analysis/synthesis/total breakdown and activity counts", async () => {
    stubFetch(baseUsage());
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);
    expect(await screen.findByText("MasterMind")).toBeInTheDocument();
    expect(screen.getByText("Trading Strategies")).toBeInTheDocument();
    expect(screen.getByText("28 lessons analyzed · 1 synthesis run")).toBeInTheDocument();
  });

  it("F: renders a project with zero cost this month as a real $0.00 row, not hidden", async () => {
    const usage = baseUsage({
      projects: [
        ...baseUsage().projects,
        {
          projectId: 8,
          projectName: "Second Project",
          projectType: "TRADING_STRATEGIES",
          analysisCost: 0,
          synthesisCost: 0,
          totalCost: 0,
          analysisRuns: 0,
          lessonsAnalyzed: 0,
          sourcesAnalyzed: 0,
          synthesisRuns: 0,
        },
      ],
    });
    stubFetch(usage);
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);

    expect(await screen.findByText("Second Project")).toBeInTheDocument();
    const card = screen.getByText("Second Project").closest(".knovera-usage-project-card")!;
    expect(card).toHaveTextContent("$0.00");
    // Zero-activity projects don't show a fabricated "0 lessons analyzed" line.
    expect(card.textContent).not.toMatch(/lessons? analyzed/);
  });

  it("G: shows a loading state before the response arrives", async () => {
    stubFetch("pending");
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);
    expect(await screen.findByText("Loading usage…")).toBeInTheDocument();
  });

  it("H: shows a backend error state on failure, not a crash or fabricated data", async () => {
    stubFetch("error", 500);
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);
    expect(await screen.findByText("Failed to load usage.")).toBeInTheDocument();
    expect(screen.queryByText("Total Spend")).not.toBeInTheDocument();
  });

  it("I: a legitimate all-zero month renders $0.00 with a clear note, not an error", async () => {
    const usage = baseUsage({
      total: { analysisCost: 0, synthesisCost: 0, totalCost: 0 },
      projects: [
        {
          projectId: 7,
          projectName: "MasterMind",
          projectType: "TRADING_STRATEGIES",
          analysisCost: 0,
          synthesisCost: 0,
          totalCost: 0,
          analysisRuns: 0,
          lessonsAnalyzed: 0,
          sourcesAnalyzed: 0,
          synthesisRuns: 0,
        },
      ],
    });
    stubFetch(usage);
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);

    expect((await screen.findAllByText("$0.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("No usage recorded this month.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("J: renders real usage data via the Knovera session alone, with no dependency on live Whop connection state", async () => {
    // UsagePageProps has no `connected`/Whop prop at all — GET /api/usage
    // never requires one (see backend http/app.ts's route classification).
    // This proves the page still loads real data purely from backendUrl/knoveraToken.
    stubFetch(baseUsage());
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);
    expect((await screen.findAllByText("$15.36")).length).toBeGreaterThan(0);
  });

  it("K: currency is always formatted to exactly 2 decimal places", async () => {
    const usage = baseUsage({
      total: { analysisCost: 1, synthesisCost: 2.5, totalCost: 3.5 },
      projects: [
        { projectId: 7, projectName: "MasterMind", projectType: "TRADING_STRATEGIES", analysisCost: 1, synthesisCost: 2.5, totalCost: 3.5, analysisRuns: 1, lessonsAnalyzed: 1, sourcesAnalyzed: 0, synthesisRuns: 1 },
      ],
    });
    stubFetch(usage);
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);

    expect((await screen.findAllByText("$3.50")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("$1.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$2.50").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$1\s*$/)).not.toBeInTheDocument();
  });

  it("N: renders combined Whop + YouTube analysis spend as one Analysis figure, with a breakdown line naming both lessons and videos analyzed (Phase 4H-B)", async () => {
    const usage = baseUsage({
      total: { analysisCost: 9.44, synthesisCost: 6.42, totalCost: 15.86 },
      projects: [
        {
          projectId: 7,
          projectName: "MasterMind",
          projectType: "TRADING_STRATEGIES",
          analysisCost: 9.44, // 8.94 Whop + 0.50 YouTube, already combined server-side
          synthesisCost: 6.42,
          totalCost: 15.86,
          analysisRuns: 29,
          lessonsAnalyzed: 28,
          sourcesAnalyzed: 1,
          synthesisRuns: 1,
        },
      ],
    });
    stubFetch(usage);
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={TOKEN} />);

    expect(await screen.findByText("MasterMind")).toBeInTheDocument();
    expect(screen.getAllByText("$9.44").length).toBeGreaterThan(0);
    expect(screen.getByText("28 lessons analyzed · 1 video analyzed · 1 synthesis run")).toBeInTheDocument();
  });

  it("signed out (no Knovera session) prompts sign-in rather than fetching or fabricating data", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<UsagePage backendUrl={BACKEND_URL} knoveraToken={null} />);
    expect(screen.getByText("Sign in to view usage.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
