import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CourseIntelligence } from "../CourseIntelligence";
import type { SynthesisStatus, CourseSynthesisData } from "../../lib/synthesisApi";

const BACKEND_URL = "https://backend.example.com";
const TOKEN = "operator-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function baseStatus(overrides: Partial<SynthesisStatus> = {}): SynthesisStatus {
  return {
    course: { title: "Trading Accelerator" },
    counts: { totalLessons: 28, analyzed: 28, processing: 0, queued: 0, failed: 0 },
    noStandaloneSetupLessons: [],
    latestRun: null,
    latestCompletedRun: null,
    isOutOfDate: false,
    canSynthesizeNow: true,
    ...overrides,
  };
}

function baseSynthesisData(overrides: Partial<CourseSynthesisData> = {}): CourseSynthesisData {
  return {
    run: {
      runId: "run_1",
      status: "COMPLETED",
      currentStage: null,
      sourceAnalysisHash: "hash",
      model: "gemini-3.8-flash",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:05:00Z",
      inputTokens: 1000,
      outputTokens: 200,
      thinkingTokens: 10,
      estimatedCost: 0.42,
      processingDurationSeconds: 300,
      errorType: null,
      sanitizedError: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
    clusters: [
      {
        clusterId: 1,
        clusterKey: "br",
        canonicalName: "Break & Retest",
        cluster: { clusterKey: "br", proposedCanonicalName: "Break & Retest", memberInstanceIds: [1, 2], similarityRationale: "r", differencesNotes: "" },
      },
    ],
    canonicalStrategies: [
      {
        canonicalStrategyId: 1,
        clusterId: 1,
        name: "Break & Retest",
        strategy: {
          name: "Break & Retest",
          purpose: "p",
          markets: ["ES"],
          timeframes: ["5m"],
          marketContext: [],
          prerequisites: [],
          setup: [],
          entryRules: [],
          confirmationRules: [],
          stopLossRules: [],
          profitTargetRules: [],
          tradeManagementRules: [],
          invalidationRules: [],
          noTradeConditions: [],
          visualDiscretionaryRules: [],
          variants: [],
          examples: [],
          ambiguities: [],
          conflicts: [],
          sourceLessonIds: [10],
        },
      },
    ],
    coreFramework: { sections: [] },
    playbook: {
      title: "Trading Accelerator Playbook",
      sections: [{ key: "source_index", title: "Source Index", content: "- Lesson 10: Break & Retest" }],
      conflictsAndAmbiguities: [],
      frameworkCoverage: {
        status: "COMPLETE",
        standaloneStrategyLessonsAnalyzed: 28,
        lessonsWithoutStandaloneSetup: 0,
        lessonsMissingSupportingKnowledgeExtraction: 0,
        missingSupportingKnowledgeLessonIds: [],
        missingSupportingKnowledgeLessonTitles: [],
        coverageNote: "Strategy synthesis complete. Course-framework coverage is current — every analyzed lesson taught a standalone setup captured above.",
      },
    },
    decisionFramework: { nodes: [], readableSteps: ["Determine HTF context", "Manage the trade"] },
    ...overrides,
  };
}

function stubFetch(status: SynthesisStatus | null, data: CourseSynthesisData | null = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/course/synthesis-status")) return jsonResponse(200, status ?? { course: null });
      if (url.includes("/api/course/synthesize")) return jsonResponse(202, { created: true, run: data?.run ?? { status: "QUEUED" } });
      if (url.includes("/api/course/synthesis")) return jsonResponse(200, data ?? { run: null });
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

describe("CourseIntelligence", () => {
  it("renders nothing when not connected", () => {
    stubFetch(baseStatus());
    const { container } = render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={null} connected={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a 'Synthesize N analyzed lesson(s)' button when no synthesis exists yet", async () => {
    stubFetch(baseStatus());
    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    expect(await screen.findByRole("button", { name: /synthesize 28 analyzed lesson/i })).toBeInTheDocument();
  });

  it("warns before synthesizing while lessons are still processing/queued, and proceeds only after confirmation", async () => {
    const status = baseStatus({ counts: { totalLessons: 28, analyzed: 21, processing: 3, queued: 4, failed: 0 } });
    stubFetch(status);
    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    const button = await screen.findByRole("button", { name: /synthesize 21 analyzed lesson/i });
    fireEvent.click(button);

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("21")).toBeInTheDocument();
    expect(within(dialog).getByText("7")).toBeInTheDocument(); // 3 processing + 4 queued

    const synthesizeCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/course/synthesize")) {
          synthesizeCalls.push(url);
          return jsonResponse(202, { created: true, run: { status: "QUEUED" } });
        }
        if (url.includes("/api/course/synthesis-status")) return jsonResponse(200, status);
        return jsonResponse(200, { run: null });
      }),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: /synthesize current results/i }));
    await waitFor(() => expect(synthesizeCalls.length).toBe(1));
  });

  it("shows the Course Intelligence tabs and coverage distinction once a completed synthesis exists", async () => {
    const status = baseStatus({
      latestCompletedRun: baseSynthesisData().run,
      latestRun: baseSynthesisData().run,
    });
    const data = baseSynthesisData();
    stubFetch(status, data);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    expect(await screen.findByRole("button", { name: "Canonical Strategies" })).toBeInTheDocument();
    expect(screen.getByText(/Canonical Strategy Coverage:/)).toBeInTheDocument();
    expect(screen.getByText(/Course-Wide Framework Coverage:/)).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Canonical Strategies" }));
    expect(screen.getByText("Break & Retest")).toBeInTheDocument();
  });

  it("shows 'Partial' course-wide framework coverage distinctly from canonical strategy coverage", async () => {
    const dataWithGap = baseSynthesisData({
      playbook: {
        ...baseSynthesisData().playbook!,
        frameworkCoverage: {
          status: "PARTIAL",
          standaloneStrategyLessonsAnalyzed: 20,
          lessonsWithoutStandaloneSetup: 8,
          lessonsMissingSupportingKnowledgeExtraction: 8,
          missingSupportingKnowledgeLessonIds: [11],
          missingSupportingKnowledgeLessonTitles: ["Sizing & Scaling Trades"],
          coverageNote:
            "Strategy synthesis complete. Course-framework coverage is partial: 8 lessons contain no standalone setup and have not yet been analyzed for supporting trading knowledge.",
        },
      },
    });
    const status = baseStatus({ latestCompletedRun: dataWithGap.run, latestRun: dataWithGap.run });
    stubFetch(status, dataWithGap);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    expect(await screen.findByText("Partial")).toBeInTheDocument();
    expect(screen.getByText(/8 lessons contain no standalone setup/)).toBeInTheDocument();
  });

  it("shows the last failed synthesis attempt's error", async () => {
    const status = baseStatus({
      canSynthesizeNow: true,
      latestRun: {
        runId: "run_2",
        status: "FAILED",
        currentStage: null,
        sourceAnalysisHash: "h",
        model: "m",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        estimatedCost: null,
        processingDurationSeconds: null,
        errorType: "permanent",
        sanitizedError: "Gemini output failed schema validation.",
        createdAt: "2026-01-01T00:00:00Z",
      },
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    expect(await screen.findByText(/schema validation/)).toBeInTheDocument();
  });
});
