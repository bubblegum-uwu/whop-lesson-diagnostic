import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CourseIntelligence } from "../CourseIntelligence";
import type { SynthesisStatus, SynthesisRunSummary, CourseSynthesisData } from "../../lib/synthesisApi";

function baseRunSummary(overrides: Partial<SynthesisRunSummary> = {}): SynthesisRunSummary {
  return {
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
    updatedAt: "2026-01-01T00:05:00Z",
    stageIndex: 7,
    totalStages: 7,
    stageLabel: "Completed",
    overallProgress: 100,
    stageProgress: 100,
    isCountable: false,
    isIndeterminate: false,
    completedItems: null,
    totalItems: null,
    currentItem: null,
    lastHeartbeatAt: null,
    leaseExpiresAt: null,
    heartbeatTier: "none",
    ...overrides,
  };
}

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
    preflight: {
      lessonCount: 28,
      latestSuccessfulAnalysisCount: 28,
      currentAnalysisCount: 28,
      staleAnalysisCount: 0,
      missingAnalysisCount: 0,
      staleLessonIds: [],
      staleLessonTitles: [],
      missingLessonIds: [],
      missingLessonTitles: [],
      ready: true,
    },
    ...overrides,
  };
}

function baseSynthesisData(overrides: Partial<CourseSynthesisData> = {}): CourseSynthesisData {
  return {
    run: baseRunSummary(),
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
          riskManagementRules: [],
          positionSizingRules: [],
          scalingInRules: [],
          scalingOutRules: [],
          runnerManagementRules: [],
          warnings: [],
          instructorPreferences: [],
          variants: [],
          examples: [],
          ambiguities: [],
          conflicts: [],
          sourceLessonIds: [10],
          supportingKnowledgeLessonIds: [],
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
        missingFrameworkDimensions: [],
        coverageNote: "Strategy synthesis complete. Course-framework coverage is current — every analyzed lesson taught a standalone setup captured above.",
      },
      strategyScopeMapping: {
        distinctRawNameCount: 0,
        matchedRawNameCount: 0,
        unmatchedRawNameCount: 0,
        matchedRawNames: [],
        unmatchedRawNames: [],
        totalStrategyScopedItemCount: 0,
        matchedItemCount: 0,
        unmatchedItemCount: 0,
        completeness: "COMPLETE",
      },
      universalSectionScopeLeaks: [],
    },
    decisionFramework: { nodes: [], readableSteps: ["Determine HTF context", "Manage the trade"], scopeLeaks: [] },
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
          missingFrameworkDimensions: [],
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
      latestRun: baseRunSummary({
        runId: "run_2",
        status: "FAILED",
        currentStage: "CANONICALIZING",
        stageLabel: "Building Canonical Strategies",
        overallProgress: 38,
        stageProgress: 50,
        isCountable: true,
        completedItems: 2,
        totalItems: 4,
        sourceAnalysisHash: "h",
        model: "m",
        completedAt: "2026-01-01T00:01:00Z",
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        estimatedCost: null,
        processingDurationSeconds: null,
        errorType: "permanent",
        sanitizedError: "Gemini output failed schema validation.",
      }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    expect(await screen.findByText(/schema validation/)).toBeInTheDocument();
    expect(screen.getByText("Synthesis failed")).toBeInTheDocument();
    expect(screen.getByText(/Building Canonical Strategies/)).toBeInTheDocument();
    expect(screen.getByText(/38%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry Synthesis" })).toBeInTheDocument();
  });

  it("shows the active progress card for a RUNNING synthesis with real countable stage progress and current item", async () => {
    const status = baseStatus({
      latestRun: baseRunSummary({
        status: "RUNNING",
        currentStage: "CANONICALIZING",
        stageIndex: 3,
        totalStages: 7,
        stageLabel: "Building Canonical Strategies",
        overallProgress: 29,
        stageProgress: 25,
        isCountable: true,
        isIndeterminate: false,
        completedItems: 1,
        totalItems: 4,
        currentItem: "Break & Retest",
        completedAt: null,
      }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    expect(await screen.findByText("Synthesizing Course")).toBeInTheDocument();
    expect(screen.getByText("Stage 3 of 7")).toBeInTheDocument();
    expect(screen.getByText("Building Canonical Strategies")).toBeInTheDocument();
    expect(screen.getByText("1 of 4 complete")).toBeInTheDocument();
    expect(screen.getByText("29%")).toBeInTheDocument();
    expect(screen.getByText("Break & Retest")).toBeInTheDocument();
    expect(screen.getByText(/Elapsed:/)).toBeInTheDocument();
    expect(screen.getByText(/You may close this page safely/)).toBeInTheDocument();
  });

  it("renders the full 7-stage timeline with done/active/pending markers reflecting the current stage", async () => {
    const status = baseStatus({
      latestRun: baseRunSummary({ status: "RUNNING", currentStage: "CANONICALIZING", stageIndex: 3, completedAt: null }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    await screen.findByText("Synthesizing Course");

    const items = screen.getAllByRole("listitem").filter((li) => li.className.startsWith("synthesis-stage-"));
    expect(items.map((li) => li.textContent)).toEqual(["✓Normalize", "✓Cluster", "●Canonical Strategies", "○Core Framework", "○Playbook", "○Decision Framework", "○Finalizing"]);
    expect(items[0].className).toContain("synthesis-stage-done");
    expect(items[2].className).toContain("synthesis-stage-active");
    expect(items[3].className).toContain("synthesis-stage-pending");
  });

  it("shows 'Gemini is working…' with no fabricated percentage for a single indeterminate Gemini-call stage", async () => {
    const status = baseStatus({
      latestRun: baseRunSummary({
        status: "RUNNING",
        currentStage: "PLAYBOOK",
        stageIndex: 5,
        stageLabel: "Building Comprehensive Playbook",
        overallProgress: 70,
        stageProgress: null,
        isCountable: false,
        isIndeterminate: true,
        completedItems: null,
        totalItems: null,
        currentItem: null,
        completedAt: null,
      }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    expect(await screen.findByText("Gemini is working…")).toBeInTheDocument();
    expect(screen.queryByText(/of .* complete/)).not.toBeInTheDocument();
  });

  it("reconstructs an in-progress run entirely from the reloaded status — no synthesis is re-triggered on mount", async () => {
    const status = baseStatus({
      canSynthesizeNow: false,
      latestRun: baseRunSummary({ status: "RUNNING", currentStage: "CLUSTERING", stageIndex: 2, overallProgress: 12, completedAt: null }),
    });
    const synthesizeCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/course/synthesize")) {
          synthesizeCalls.push(url);
          return jsonResponse(202, { created: true, run: status.latestRun });
        }
        if (url.includes("/api/course/synthesis-status")) return jsonResponse(200, status);
        return jsonResponse(200, { run: null });
      }),
    );

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    expect(await screen.findByText("Synthesizing Course")).toBeInTheDocument();
    expect(synthesizeCalls).toHaveLength(0); // reloaded purely from GET /synthesis-status — no POST /synthesize fired
  });

  it.each([
    ["none", null],
    ["waiting_for_update", "Waiting for update…"],
    ["no_recent_heartbeat", /No recent worker heartbeat/],
    ["waiting_for_recovery", /Waiting for recovery/],
  ] as const)("shows the correct non-alarming heartbeat message for tier %s", async (tier, expectedText) => {
    const status = baseStatus({
      latestRun: baseRunSummary({ status: "RUNNING", currentStage: "PLAYBOOK", heartbeatTier: tier, completedAt: null }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    await screen.findByText("Synthesizing Course");

    if (expectedText === null) {
      expect(screen.queryByText(/Waiting for update|No recent worker heartbeat|Waiting for recovery/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(expectedText)).toBeInTheDocument();
    }
    // A heartbeat gap must never render as "FAILED" — the run's actual status still governs that.
    expect(screen.queryByText("Synthesis failed")).not.toBeInTheDocument();
  });

  it("shows the compact completed summary (duration, canonical strategy count, cost, coverage) once synthesis reaches 100%, and never the progress card", async () => {
    const data = baseSynthesisData({ run: baseRunSummary({ status: "COMPLETED", overallProgress: 100, processingDurationSeconds: 313, estimatedCost: 1.23 }) });
    const status = baseStatus({ latestRun: data.run, latestCompletedRun: data.run });
    stubFetch(status, data);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Duration: 5 min")).toBeInTheDocument();
    expect(screen.getByText("Canonical Strategies: 1")).toBeInTheDocument();
    expect(screen.getByText("Total Synthesis Cost: $1.23")).toBeInTheDocument();
    expect(screen.getByText("Coverage: COMPLETE")).toBeInTheDocument();
    expect(screen.queryByText("Synthesizing Course")).not.toBeInTheDocument();
  });

  it("never advances the displayed percentage on its own between polls — only the elapsed clock ticks locally", async () => {
    const status = baseStatus({
      latestRun: baseRunSummary({ status: "RUNNING", currentStage: "PLAYBOOK", overallProgress: 42, isIndeterminate: true, isCountable: false, completedAt: null }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    await screen.findByText("42%");

    // Real time passes (several of the component's 1s ticks) with no new
    // fetch response — the stubbed run object never changes, so the
    // percentage must not drift, even though the elapsed-time text does.
    await new Promise((r) => setTimeout(r, 1200));
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("shows the full diagnostic snapshot on failure — progress within stage, current item, duration, last heartbeat, and cost incurred — for retrying a failed synthesis", async () => {
    const status = baseStatus({
      canSynthesizeNow: true,
      latestRun: baseRunSummary({
        status: "FAILED",
        currentStage: "CANONICALIZING",
        stageLabel: "Building Canonical Strategies",
        overallProgress: 38,
        isCountable: true,
        completedItems: 1,
        totalItems: 2,
        currentItem: "Order Block Sweep",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:03:00Z",
        lastHeartbeatAt: "2026-01-01T00:02:50Z",
        processingDurationSeconds: 180,
        estimatedCost: 0.07,
        errorType: "permanent",
        sanitizedError: 'Gemini did not return valid JSON for stage "canonical_strategy".',
      }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    expect(await screen.findByText("Synthesis failed")).toBeInTheDocument();
    expect(screen.getByText("Progress within stage: 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Order Block Sweep")).toBeInTheDocument();
    expect(screen.getByText("Duration: 3 min")).toBeInTheDocument();
    expect(screen.getByText("Last heartbeat: 10s before failure")).toBeInTheDocument();
    expect(screen.getByText("Cost incurred: $0.07")).toBeInTheDocument();
    expect(screen.getByText(/canonical_strategy/)).toBeInTheDocument();
    // Never the raw Gemini output or prompt content — only the safe, already-redacted message.
    expect(screen.queryByText(/synthesizing ONE canonical trading strategy/)).not.toBeInTheDocument();
  });

  it("shows 'Cost so far' for a RUNNING synthesis, restored immediately on mount from the persisted run (e.g. after a browser refresh)", async () => {
    const status = baseStatus({
      latestRun: baseRunSummary({ status: "RUNNING", currentStage: "CANONICALIZING", completedAt: null, estimatedCost: 0.07 }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    expect(await screen.findByText("Synthesizing Course")).toBeInTheDocument();
    expect(screen.getByText("Cost so far: $0.07")).toBeInTheDocument();
  });

  it("never renders a cost line before any Gemini usage has been reported (null estimatedCost) — no fabricated cost between calls", async () => {
    const status = baseStatus({
      latestRun: baseRunSummary({ status: "RUNNING", currentStage: "NORMALIZING", completedAt: null, estimatedCost: null }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    await screen.findByText("Synthesizing Course");
    expect(screen.queryByText(/Cost so far/)).not.toBeInTheDocument();
  });

  it("renders 'Cost so far: $0.00' once a real zero cost is persisted, distinct from no cost reported yet", async () => {
    const status = baseStatus({
      latestRun: baseRunSummary({ status: "RUNNING", currentStage: "CANONICALIZING", completedAt: null, estimatedCost: 0 }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);

    expect(await screen.findByText("Cost so far: $0.00")).toBeInTheDocument();
  });

  it("never drifts 'Cost so far' between local clock ticks — only a new poll can change it", async () => {
    const status = baseStatus({
      latestRun: baseRunSummary({ status: "RUNNING", currentStage: "CANONICALIZING", completedAt: null, estimatedCost: 0.05 }),
    });
    stubFetch(status);

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    expect(await screen.findByText("Cost so far: $0.05")).toBeInTheDocument();

    // Real time passes (several of the component's 1s elapsed-clock ticks) with no new
    // fetch response — the stubbed run object never changes, so cost must not drift,
    // even though the elapsed-time text does (mirrors the existing "never advances the
    // displayed percentage" test's real-timer pattern above).
    await new Promise((r) => setTimeout(r, 1200));
    expect(screen.getByText("Cost so far: $0.05")).toBeInTheDocument();
  });

  it("updates 'Cost so far' once a new poll returns increased backend progress data — never before then", async () => {
    let pollCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/course/synthesis-status")) {
          pollCount++;
          const estimatedCost = pollCount === 1 ? 0.05 : 0.09;
          return jsonResponse(
            200,
            baseStatus({ latestRun: baseRunSummary({ status: "RUNNING", currentStage: "CANONICALIZING", completedAt: null, estimatedCost }) }),
          );
        }
        return jsonResponse(200, { run: null });
      }),
    );

    render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
    expect(await screen.findByText("Cost so far: $0.05")).toBeInTheDocument();

    // The component polls /synthesis-status every 4s while RUNNING (see CourseIntelligence's
    // refresh() effect) — wait past that boundary for the second, higher-cost response to land.
    await waitFor(() => expect(screen.getByText("Cost so far: $0.09")).toBeInTheDocument(), { timeout: 6000 });
  }, 8000);

  describe("Download Full Synthesis JSON", () => {
    let originalCreateObjectURL: typeof URL.createObjectURL;
    let originalRevokeObjectURL: typeof URL.revokeObjectURL;

    afterEach(() => {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });

    it("does not appear before any synthesis has completed", async () => {
      stubFetch(baseStatus());
      render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
      await screen.findByRole("button", { name: /synthesize 28 analyzed lesson/i });
      expect(screen.queryByRole("button", { name: /download full synthesis json/i })).not.toBeInTheDocument();
    });

    it("downloads the ENTIRE synthesis — clusters, canonical strategies, core framework, playbook, and decision framework — as one JSON file, not just one section", async () => {
      const data = baseSynthesisData();
      const status = baseStatus({ latestCompletedRun: data.run, latestRun: data.run });
      stubFetch(status, data);

      originalCreateObjectURL = URL.createObjectURL;
      originalRevokeObjectURL = URL.revokeObjectURL;
      const createObjectURL = vi.fn((_obj: Blob | MediaSource) => "blob:mock-url");
      const revokeObjectURL = vi.fn();
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

      render(<CourseIntelligence backendUrl={BACKEND_URL} accessToken={TOKEN} connected />);
      const button = await screen.findByRole("button", { name: /download full synthesis json/i });
      fireEvent.click(button);

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blobArg = createObjectURL.mock.calls[0][0] as Blob;
      expect(blobArg.type).toBe("application/json");
      const parsed = JSON.parse(await blobArg.text());
      // Every top-level section CourseSynthesisData carries, not just the playbook.
      expect(parsed.clusters).toHaveLength(1);
      expect(parsed.canonicalStrategies).toHaveLength(1);
      expect(parsed.canonicalStrategies[0].strategy.name).toBe("Break & Retest");
      expect(parsed.coreFramework).toEqual({ sections: [] });
      expect(parsed.playbook.title).toBe("Trading Accelerator Playbook");
      expect(parsed.decisionFramework.readableSteps).toEqual(["Determine HTF context", "Manage the trade"]);
      expect(parsed.run.runId).toBe("run_1");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

      clickSpy.mockRestore();
    });
  });
});
