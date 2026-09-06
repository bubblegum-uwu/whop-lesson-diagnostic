import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { CourseTable } from "../CourseTable";
import type { CourseLessonSummary } from "../../lib/courseApi";

const baseProps = {
  courseTitle: "Scarface Trades Mastermind",
  lessons: [] as CourseLessonSummary[],
  connected: false,
  syncing: false,
  authRequired: false,
  lastSyncedAt: null,
  summary: null,
  onSignIn: vi.fn(),
  onSync: vi.fn(),
  onDisconnect: vi.fn(),
  onEnqueue: vi.fn(),
  onRetry: vi.fn(),
  onCancel: vi.fn(),
  onLoadAnalysis: vi.fn(async () => null),
};

function makeLesson(overrides: Partial<CourseLessonSummary> = {}): CourseLessonSummary {
  return {
    id: 1,
    title: "Support & Resistance",
    chapterTitle: "Foundations",
    chapterOrder: 1,
    courseOrder: 2,
    durationSeconds: 2640,
    videoAvailable: true,
    sourceUrl: "https://whop.com/scarface-trades-mastermind/exp_x/app/courses/cors_x/lessons/lesn_x/",
    lastSyncedAt: "2026-01-01T00:00:00Z",
    job: { jobId: null, status: "NOT_ANALYZED" },
    analysis: null,
    ...overrides,
  };
}

describe("CourseTable", () => {
  it("shows a sign-in prompt, not the table, when disconnected", () => {
    render(<CourseTable {...baseProps} />);
    expect(screen.getByRole("button", { name: /connect whop/i })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("calls onSignIn when the sign-in button is clicked", () => {
    const onSignIn = vi.fn();
    render(<CourseTable {...baseProps} onSignIn={onSignIn} />);
    fireEvent.click(screen.getByRole("button", { name: /connect whop/i }));
    expect(onSignIn).toHaveBeenCalled();
  });

  it("shows a reconnect message when auth_required, instead of a generic prompt", () => {
    render(<CourseTable {...baseProps} authRequired />);
    expect(screen.getByText(/authorization expired/i)).toBeInTheDocument();
  });

  it("renders one row per lesson with a compact summary-only set of columns, once connected", () => {
    render(<CourseTable {...baseProps} connected lessons={[makeLesson()]} />);

    expect(screen.getByText("Support & Resistance")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Not analyzed")).toBeInTheDocument();
    // Full output (summary text, JSON, drawer-only "No Standalone Setup" box) must NOT be rendered inline in the table.
    expect(within(screen.getByRole("table")).queryByText(/no standalone setup/i)).not.toBeInTheDocument();
  });

  it("shows an empty-state message instead of an empty table when nothing has been synced yet", () => {
    render(<CourseTable {...baseProps} connected lessons={[]} />);
    expect(screen.getByText(/no lessons synced yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("disables the sync button and shows syncing state while a sync is in flight", () => {
    render(<CourseTable {...baseProps} connected syncing />);
    expect(screen.getByRole("button", { name: /syncing/i })).toBeDisabled();
  });

  it("queues a single lesson via the row Analyze action, after confirming the batch dialog", () => {
    const onEnqueue = vi.fn();
    render(<CourseTable {...baseProps} connected onEnqueue={onEnqueue} lessons={[makeLesson({ id: 7 })]} />);

    fireEvent.click(screen.getByRole("button", { name: /^analyze$/i }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(onEnqueue).toHaveBeenCalledWith([7], false);
  });

  it("selects lessons via checkboxes and shows the selected count next to Analyze Selected", () => {
    const onEnqueue = vi.fn();
    render(
      <CourseTable
        {...baseProps}
        connected
        onEnqueue={onEnqueue}
        lessons={[makeLesson({ id: 1, title: "A" }), makeLesson({ id: 2, title: "B" })]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Select A"));
    expect(screen.getByRole("button", { name: /analyze selected \(1 selected\)/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /analyze selected/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onEnqueue).toHaveBeenCalledWith([1], true);
  });

  it("Select All Unanalyzed only selects NOT_ANALYZED lessons, then queues them", () => {
    const onEnqueue = vi.fn();
    render(
      <CourseTable
        {...baseProps}
        connected
        onEnqueue={onEnqueue}
        lessons={[
          makeLesson({ id: 1, title: "A", job: { jobId: null, status: "NOT_ANALYZED" } }),
          makeLesson({ id: 2, title: "B", job: { jobId: "job_2", status: "COMPLETED" } }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /select all unanalyzed/i }));
    fireEvent.click(screen.getByRole("button", { name: /analyze all unanalyzed/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onEnqueue).toHaveBeenCalledWith([1], false);
  });

  it("shows a Retry action for a FAILED lesson and calls onRetry with its job id", () => {
    const onRetry = vi.fn();
    render(
      <CourseTable
        {...baseProps}
        connected
        onRetry={onRetry}
        lessons={[makeLesson({ job: { jobId: "job_1", status: "FAILED", sanitizedError: "Gemini rate limit" } })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("job_1");
  });

  it("shows a Cancel action for a QUEUED lesson and calls onCancel with its job id", () => {
    const onCancel = vi.fn();
    render(
      <CourseTable
        {...baseProps}
        connected
        onCancel={onCancel}
        lessons={[makeLesson({ job: { jobId: "job_1", status: "QUEUED" } })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledWith("job_1");
  });

  describe("detail drawer", () => {
    function completedLesson(overrides: Partial<CourseLessonSummary> = {}): CourseLessonSummary {
      return makeLesson({
        job: { jobId: "job_1", status: "COMPLETED" },
        analysis: {
          analysisId: 1,
          strategyFound: true,
          extractedStrategiesLabel: "Break & Retest",
          ruleCounts: [{ label: "Entry", count: 1 }],
          confidence: 0.8,
          summary: "Break & Retest using HTF levels.",
          hasSupportingKnowledge: true,
          knowledgeItemCounts: [],
          schemaVersion: "v2",
          estimatedCost: 0.1,
          processingDurationSeconds: 60,
          completedAt: "2026-01-01T00:00:00Z",
        },
        ...overrides,
      });
    }

    it("opens the side drawer via View, without changing the table's own DOM structure", () => {
      const onLoadAnalysis = vi.fn(async () => ({ strategy_found: true, strategies: [] }));
      render(<CourseTable {...baseProps} connected onLoadAnalysis={onLoadAnalysis} lessons={[completedLesson()]} />);

      const table = screen.getByRole("table");
      const rowCountBefore = within(table).getAllByRole("row").length;

      fireEvent.click(screen.getByRole("button", { name: /^view$/i }));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // The table remains mounted, in place, with the same number of rows —
      // opening one lesson never expands a <tr> or changes table dimensions.
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(rowCountBefore);
    });

    it("closes the drawer via its close button", () => {
      render(<CourseTable {...baseProps} connected lessons={[completedLesson()]} />);
      fireEvent.click(screen.getByRole("button", { name: /^view$/i }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /close analysis panel/i }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it('shows "No Standalone Setup" (never "no useful content") in the drawer for a NO_STRATEGY lesson, alongside its real supporting knowledge', async () => {
      const lesson = completedLesson({
        job: { jobId: "job_2", status: "NO_STRATEGY" },
        analysis: {
          analysisId: 2,
          strategyFound: false,
          extractedStrategiesLabel: null,
          ruleCounts: [],
          confidence: null,
          summary: "Covers risk management and position sizing for scaling into trades.",
          hasSupportingKnowledge: true,
          knowledgeItemCounts: [{ label: "Risk Management", count: 1 }],
          schemaVersion: "v2",
          estimatedCost: 0.05,
          processingDurationSeconds: 30,
          completedAt: "2026-01-01T00:00:00Z",
        },
      });
      const onLoadAnalysis = vi.fn(async () => ({
        strategy_found: false,
        strategies: [],
        knowledge: {
          summary: "Covers risk management and position sizing for scaling into trades.",
          knowledgeItems: [
            {
              category: "risk_management",
              statement: "Never risk more than 1% of account equity on a single trade.",
              ruleType: "HARD_RULE",
              classification: "explicit",
              confidence: 0.95,
              conditions: null,
              exceptions: [],
              scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
              numericalValues: [
                { metric: "max risk per trade", operator: "LTE", value: 1, value2: null, unit: "%", role: "RULE_THRESHOLD", rawText: "1%", context: "max risk per trade" },
              ],
              start_timestamp: "2:15",
              end_timestamp: null,
              evidence: "\"Never risk more than 1% on any single trade.\"",
            },
          ],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      }));
      render(<CourseTable {...baseProps} connected onLoadAnalysis={onLoadAnalysis} lessons={[lesson]} />);

      fireEvent.click(screen.getByRole("button", { name: /^view$/i }));
      expect(await screen.findByText(/no standalone setup/i, { selector: ".no-strategy-box" })).toBeInTheDocument();
      // Never implies the lesson has nothing useful — the real risk-management content still renders.
      expect(screen.getByText("Risk Management")).toBeInTheDocument();
      expect(screen.getByText("Never risk more than 1% of account equity on a single trade.")).toBeInTheDocument();
      expect(screen.getByText("Hard Rule")).toBeInTheDocument();
    });

    it("renders full strategy detail in the drawer for a completed lesson", async () => {
      const validatedJson = {
        strategy_found: true,
        strategies: [
          {
            strategy_name: "Break & Retest",
            market_or_instrument: ["ES"],
            timeframes: ["5m"],
            indicators: [],
            setup_conditions: [],
            entry_rules: [{ description: "retest entry", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }],
            confirmation_rules: [],
            stop_loss_rules: [],
            profit_target_rules: [],
            trade_management_rules: [],
            invalidation_rules: [],
            no_trade_conditions: [],
            market_context_rules: [],
            visual_discretionary_rules: [],
            examples_shown: [],
            ambiguities: [],
          },
        ],
      };
      const onLoadAnalysis = vi.fn(async () => validatedJson);
      render(<CourseTable {...baseProps} connected onLoadAnalysis={onLoadAnalysis} lessons={[completedLesson()]} />);

      fireEvent.click(screen.getByRole("button", { name: /^view$/i }));
      expect(onLoadAnalysis).toHaveBeenCalledWith(1);
      expect(await screen.findByText("retest entry")).toBeInTheDocument();
    });

    it("keeps the raw JSON collapsed by default inside the drawer", async () => {
      const onLoadAnalysis = vi.fn(async () => ({ strategy_found: false, strategies: [] }));
      render(<CourseTable {...baseProps} connected onLoadAnalysis={onLoadAnalysis} lessons={[completedLesson()]} />);
      fireEvent.click(screen.getByRole("button", { name: /^view$/i }));
      const summary = await screen.findByText("▶ Raw JSON");
      expect(summary.closest("details")).not.toHaveAttribute("open");
    });
  });

  describe("search and filters", () => {
    it("filters lessons by title via the search box", () => {
      render(
        <CourseTable
          {...baseProps}
          connected
          lessons={[makeLesson({ id: 1, title: "Support & Resistance" }), makeLesson({ id: 2, title: "Order Blocks" })]}
        />,
      );
      fireEvent.change(screen.getByPlaceholderText(/search lessons/i), { target: { value: "order" } });
      expect(screen.queryByText("Support & Resistance")).not.toBeInTheDocument();
      expect(screen.getByText("Order Blocks")).toBeInTheDocument();
    });

    it("filters lessons by status", () => {
      render(
        <CourseTable
          {...baseProps}
          connected
          lessons={[
            makeLesson({ id: 1, title: "A", job: { jobId: null, status: "NOT_ANALYZED" } }),
            makeLesson({ id: 2, title: "B", job: { jobId: "job_2", status: "FAILED" } }),
          ]}
        />,
      );
      fireEvent.change(screen.getByLabelText(/filter by status/i), { target: { value: "FAILED" } });
      expect(screen.queryByText("A")).not.toBeInTheDocument();
      expect(screen.getByText("B")).toBeInTheDocument();
    });

    it("filters lessons by chapter", () => {
      render(
        <CourseTable
          {...baseProps}
          connected
          lessons={[
            makeLesson({ id: 1, title: "A", chapterTitle: "Foundations" }),
            makeLesson({ id: 2, title: "B", chapterTitle: "Advanced" }),
          ]}
        />,
      );
      fireEvent.change(screen.getByLabelText(/filter by chapter/i), { target: { value: "Advanced" } });
      expect(screen.queryByText("A")).not.toBeInTheDocument();
      expect(screen.getByText("B")).toBeInTheDocument();
    });

    it("shows a no-match message when filters exclude every lesson", () => {
      render(<CourseTable {...baseProps} connected lessons={[makeLesson({ title: "A" })]} />);
      fireEvent.change(screen.getByPlaceholderText(/search lessons/i), { target: { value: "zzz-no-match" } });
      expect(screen.getByText(/no lessons match/i)).toBeInTheDocument();
    });
  });

  describe("ANALYZED column", () => {
    function analyzedLesson(overrides: Partial<CourseLessonSummary> = {}): CourseLessonSummary {
      return makeLesson({
        job: { jobId: "job_1", status: "COMPLETED" },
        analysis: {
          analysisId: 1,
          strategyFound: true,
          extractedStrategiesLabel: "Break & Retest",
          ruleCounts: [],
          confidence: 0.8,
          summary: "s",
          hasSupportingKnowledge: true,
          knowledgeItemCounts: [],
          schemaVersion: "v2",
          estimatedCost: 0.1,
          processingDurationSeconds: 60,
          completedAt: "2026-01-01T08:31:00Z",
        },
        ...overrides,
      });
    }

    it("renders an ANALYZED header and the latest successful analysis's completed timestamp, with the full timestamp available on hover", () => {
      render(<CourseTable {...baseProps} connected lessons={[analyzedLesson()]} />);
      const table = screen.getByRole("table");
      expect(within(table).getByRole("columnheader", { name: /analyzed/i })).toBeInTheDocument();

      const cell = within(table).getByTitle(new Date("2026-01-01T08:31:00Z").toLocaleString());
      expect(cell.textContent).toContain("2026");
    });

    it("shows — for a lesson that has never been successfully analyzed", () => {
      render(<CourseTable {...baseProps} connected lessons={[makeLesson()]} />);
      const table = screen.getByRole("table");
      const row = within(table).getAllByRole("row")[1];
      expect(within(row).getByText("—", { selector: ".col-analyzed" })).toBeInTheDocument();
    });

    it("keeps showing the PREVIOUS successful analysis's timestamp while a re-analysis is QUEUED/PROCESSING — never blanks or advances it early", () => {
      const lesson = analyzedLesson({ job: { jobId: "job_2", status: "ANALYZING", currentStage: "analyzing_lesson" } });
      render(<CourseTable {...baseProps} connected lessons={[lesson]} />);
      const table = screen.getByRole("table");
      // The old completedAt (2026-01-01) still renders even though a NEW job is actively in flight.
      expect(within(table).getByTitle(new Date("2026-01-01T08:31:00Z").toLocaleString())).toBeInTheDocument();
    });

    it("only replaces the ANALYZED timestamp once the new analysis actually completes", () => {
      const before = analyzedLesson({ id: 5 });
      const { rerender } = render(<CourseTable {...baseProps} connected lessons={[before]} />);
      expect(screen.getByTitle(new Date("2026-01-01T08:31:00Z").toLocaleString())).toBeInTheDocument();

      // Re-analysis in flight: job advances, but `analysis` (and its completedAt) is untouched — same backend shape as production (independent job/analysis fields).
      const inFlight = analyzedLesson({ id: 5, job: { jobId: "job_2", status: "UPLOADING" } });
      rerender(<CourseTable {...baseProps} connected lessons={[inFlight]} />);
      expect(screen.getByTitle(new Date("2026-01-01T08:31:00Z").toLocaleString())).toBeInTheDocument();

      // Only once the new analysis actually completes does a NEW completedAt appear.
      const completed = analyzedLesson({
        id: 5,
        job: { jobId: "job_2", status: "COMPLETED" },
        analysis: {
          analysisId: 2,
          strategyFound: true,
          extractedStrategiesLabel: "Break & Retest",
          ruleCounts: [],
          confidence: 0.8,
          summary: "s",
          hasSupportingKnowledge: true,
          knowledgeItemCounts: [],
          schemaVersion: "v2",
          estimatedCost: 0.1,
          processingDurationSeconds: 60,
          completedAt: "2026-02-02T09:00:00Z",
        },
      });
      rerender(<CourseTable {...baseProps} connected lessons={[completed]} />);
      expect(screen.queryByTitle(new Date("2026-01-01T08:31:00Z").toLocaleString())).not.toBeInTheDocument();
      expect(screen.getByTitle(new Date("2026-02-02T09:00:00Z").toLocaleString())).toBeInTheDocument();
    });

    it("sorts by ANALYZED date when the header is clicked, toggling direction on repeated clicks", () => {
      const older = analyzedLesson({ id: 1, title: "Older Lesson", analysis: { ...analyzedLesson().analysis!, completedAt: "2026-01-01T00:00:00Z" } });
      const newer = analyzedLesson({ id: 2, title: "Newer Lesson", analysis: { ...analyzedLesson().analysis!, completedAt: "2026-06-01T00:00:00Z" } });
      render(<CourseTable {...baseProps} connected lessons={[older, newer]} />);

      const table = screen.getByRole("table");
      const titlesInOrder = () => within(table).getAllByRole("row").slice(1).map((r) => within(r).getByRole("checkbox").getAttribute("aria-label"));

      fireEvent.click(within(table).getByRole("button", { name: /sort by analyzed date/i }));
      expect(titlesInOrder()).toEqual(["Select Newer Lesson", "Select Older Lesson"]); // first click: most recent first

      fireEvent.click(within(table).getByRole("button", { name: /sort by analyzed date/i }));
      expect(titlesInOrder()).toEqual(["Select Older Lesson", "Select Newer Lesson"]); // second click: oldest first
    });

    it("always sorts never-analyzed lessons to the end, in either sort direction", () => {
      const analyzed = analyzedLesson({ id: 1, title: "Analyzed" });
      const neverAnalyzed = makeLesson({ id: 2, title: "Never Analyzed" });
      render(<CourseTable {...baseProps} connected lessons={[neverAnalyzed, analyzed]} />);

      const table = screen.getByRole("table");
      const titlesInOrder = () => within(table).getAllByRole("row").slice(1).map((r) => within(r).getByRole("checkbox").getAttribute("aria-label"));

      fireEvent.click(within(table).getByRole("button", { name: /sort by analyzed date/i }));
      expect(titlesInOrder()).toEqual(["Select Analyzed", "Select Never Analyzed"]);

      fireEvent.click(within(table).getByRole("button", { name: /sort by analyzed date/i }));
      expect(titlesInOrder()).toEqual(["Select Analyzed", "Select Never Analyzed"]);
    });
  });

  it("keeps Lesson/Status/Progress/Result/Actions columns unmarked for narrow-screen hiding", () => {
    render(<CourseTable {...baseProps} connected lessons={[makeLesson()]} />);
    const table = screen.getByRole("table");
    const alwaysVisible = ["Lesson", "Status", "Progress", "Result"];
    for (const label of alwaysVisible) {
      const th = within(table)
        .getAllByRole("columnheader")
        .find((h) => h.textContent === label);
      expect(th, `expected a "${label}" header`).toBeDefined();
      expect(th?.className).not.toContain("hide-narrow");
    }
  });

  it("marks Chapter/Duration/Cost as secondary (hidden on narrow screens)", () => {
    render(<CourseTable {...baseProps} connected lessons={[makeLesson()]} />);
    const table = screen.getByRole("table");
    for (const label of ["Chapter", "Duration", "Cost"]) {
      const th = within(table)
        .getAllByRole("columnheader")
        .find((h) => h.textContent === label);
      expect(th, `expected a "${label}" header`).toBeDefined();
      expect(th?.className).toContain("hide-narrow");
    }
  });

  describe("responsive layout", () => {
    const originalInnerWidth = window.innerWidth;
    afterEach(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    });

    it("renders the desktop table on a wide viewport", () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
      render(<CourseTable {...baseProps} connected lessons={[makeLesson()]} />);
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });

    it("switches to compact lesson cards on a narrow viewport, after a resize", () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
      render(<CourseTable {...baseProps} connected lessons={[makeLesson()]} />);
      expect(screen.getByRole("table")).toBeInTheDocument();

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
      fireEvent(window, new Event("resize"));

      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(screen.getByText("Support & Resistance")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^analyze$/i })).toBeInTheDocument();
    });
  });

  describe("worker heartbeat status hints", () => {
    it("shows no heartbeat warning while the heartbeat is recent", () => {
      const recent = new Date(Date.now() - 5_000).toISOString();
      render(
        <CourseTable
          {...baseProps}
          connected
          lessons={[makeLesson({ job: { jobId: "job_1", status: "ANALYZING", lastHeartbeatAt: recent } })]}
        />,
      );
      expect(screen.queryByText(/waiting for update/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/no recent worker heartbeat/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/waiting for recovery/i)).not.toBeInTheDocument();
    });

    it("shows a soft 'Waiting for update' hint once the heartbeat is moderately old — never the word 'stale'", () => {
      const moderatelyOld = new Date(Date.now() - 45_000).toISOString();
      render(
        <CourseTable
          {...baseProps}
          connected
          lessons={[makeLesson({ job: { jobId: "job_1", status: "GEMINI_PROCESSING", lastHeartbeatAt: moderatelyOld } })]}
        />,
      );
      expect(screen.getByText(/waiting for update/i)).toBeInTheDocument();
      expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
    });

    it("shows 'Waiting for recovery' wording, not a fabricated failure status, once the lease has actually expired", () => {
      const longAgo = new Date(Date.now() - 120_000).toISOString();
      const expiredLease = new Date(Date.now() - 5_000).toISOString();
      render(
        <CourseTable
          {...baseProps}
          connected
          lessons={[
            makeLesson({
              job: { jobId: "job_1", status: "ANALYZING", lastHeartbeatAt: longAgo, leaseExpiresAt: expiredLease },
            }),
          ]}
        />,
      );
      expect(screen.getByText(/waiting for recovery/i)).toBeInTheDocument();
      // Still shows the real (non-terminal) job status — never invents a new backend status or implies failure.
      const table = within(screen.getByRole("table"));
      expect(table.getAllByText(/analyzing/i).length).toBeGreaterThan(0);
      expect(table.queryByText(/^failed$/i)).not.toBeInTheDocument();
    });

    it("never shows a heartbeat warning for a terminal job, no matter how old its last heartbeat is", () => {
      const veryOld = new Date(Date.now() - 10 * 60_000).toISOString();
      render(
        <CourseTable
          {...baseProps}
          connected
          lessons={[makeLesson({ job: { jobId: "job_1", status: "COMPLETED", lastHeartbeatAt: veryOld } })]}
        />,
      );
      expect(screen.queryByText(/waiting for update/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/no recent worker heartbeat/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/waiting for recovery/i)).not.toBeInTheDocument();
    });
  });
});
