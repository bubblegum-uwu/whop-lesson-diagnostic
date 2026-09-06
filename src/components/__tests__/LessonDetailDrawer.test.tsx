import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LessonDetailDrawer } from "../LessonDetailDrawer";
import type { CourseLessonSummary } from "../../lib/courseApi";

function makeLesson(overrides: Partial<CourseLessonSummary> = {}): CourseLessonSummary {
  return {
    id: 1,
    title: "Support & Resistance",
    chapterTitle: "Foundations",
    chapterOrder: 1,
    courseOrder: 1,
    durationSeconds: 2640,
    videoAvailable: true,
    sourceUrl: "https://whop.com/scarface-trades-mastermind/exp_x/app/courses/cors_x/lessons/lesn_x/",
    lastSyncedAt: "2026-01-01T00:00:00Z",
    job: { jobId: "job_1", status: "COMPLETED" },
    analysis: {
      analysisId: 1,
      strategyFound: true,
      extractedStrategiesLabel: "Break & Retest",
      ruleCounts: [{ label: "Entry", count: 2 }],
      confidence: 0.87,
      summary: "Break & Retest using HTF levels.",
      hasSupportingKnowledge: true,
      knowledgeItemCounts: [],
      schemaVersion: "v2",
      estimatedCost: 0.12,
      processingDurationSeconds: 95,
      completedAt: "2026-01-02T00:00:00Z",
    },
    ...overrides,
  };
}

const emptyKnowledge = { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] };

const strategyJson = {
  strategy_found: true,
  strategies: [
    {
      strategy_name: "Break & Retest",
      market_or_instrument: ["ES"],
      timeframes: ["5m"],
      indicators: ["VWAP"],
      setup_conditions: [],
      entry_rules: [
        { description: "retest entry", classification: "explicit", confidence: 0.9, start_timestamp: "00:10", end_timestamp: null, evidence: "e" },
      ],
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
  knowledge: emptyKnowledge,
};

const noStrategyJson = {
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
        evidence: '"Never risk more than 1% on any single trade."',
      },
      {
        category: "psychology",
        statement: "I usually take a short break after two consecutive losses.",
        ruleType: "PREFERENCE",
        classification: "explicit",
        confidence: 0.7,
        conditions: null,
        exceptions: [],
        scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
        numericalValues: [],
        start_timestamp: "8:40",
        end_timestamp: null,
        evidence: '"I usually step away after two losses in a row."',
      },
    ],
    examples: [
      {
        description: "A trade sized at 1% risk on a $10,000 account.",
        illustratesCategory: "position_sizing",
        outcome: "Stopped out for the planned 1% loss.",
        start_timestamp: "5:00",
        end_timestamp: "5:45",
        evidence: '"Here I risked exactly 1%, which came out to two contracts."',
      },
    ],
    conflictsAndAmbiguities: ["Unclear whether the 1% figure is per-trade or per-day."],
  },
};

describe("LessonDetailDrawer", () => {
  it("renders nothing when lesson is null", () => {
    const { container } = render(<LessonDetailDrawer lesson={null} onClose={vi.fn()} onLoadAnalysis={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens with the lesson's meta info immediately, before the JSON has loaded", () => {
    const onLoadAnalysis = vi.fn(() => new Promise<unknown>(() => {})); // never resolves
    render(<LessonDetailDrawer lesson={makeLesson()} onClose={vi.fn()} onLoadAnalysis={onLoadAnalysis} />);

    expect(screen.getByRole("dialog", { name: /support & resistance/i })).toBeInTheDocument();
    expect(screen.getByText(/foundations/i)).toBeInTheDocument();
    expect(screen.getByText("Break & Retest using HTF levels.")).toBeInTheDocument();
    expect(screen.getByText("Loading analysis…")).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<LessonDetailDrawer lesson={makeLesson()} onClose={onClose} onLoadAnalysis={vi.fn(async () => strategyJson)} />);
    fireEvent.click(screen.getByRole("button", { name: /close analysis panel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<LessonDetailDrawer lesson={makeLesson()} onClose={onClose} onLoadAnalysis={vi.fn(async () => strategyJson)} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(<LessonDetailDrawer lesson={makeLesson()} onClose={onClose} onLoadAnalysis={vi.fn(async () => strategyJson)} />);
    fireEvent.click(container.querySelector(".drawer-backdrop")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders full strategy detail once the analysis JSON loads", async () => {
    render(<LessonDetailDrawer lesson={makeLesson()} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => strategyJson)} />);
    expect(await screen.findByText("retest entry")).toBeInTheDocument();
    expect(screen.getByText(/Markets: ES/)).toBeInTheDocument();
  });

  it('shows "No Standalone Setup" prominently for NO_STRATEGY, without empty strategy sections — and never implies the lesson has no useful content', async () => {
    const lesson = makeLesson({
      job: { jobId: "job_2", status: "NO_STRATEGY" },
      analysis: {
        analysisId: 2,
        strategyFound: false,
        extractedStrategiesLabel: null,
        ruleCounts: [],
        confidence: null,
        summary: "Covers risk management and position sizing for scaling into trades.",
        hasSupportingKnowledge: true,
        knowledgeItemCounts: [{ label: "Risk Management", count: 1 }, { label: "Psychology", count: 1 }],
        schemaVersion: "v2",
        estimatedCost: 0.05,
        processingDurationSeconds: 40,
        completedAt: "2026-01-02T00:00:00Z",
      },
    });
    render(<LessonDetailDrawer lesson={lesson} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => noStrategyJson)} />);
    expect(await screen.findByText(/no standalone setup/i, { selector: ".no-strategy-box" })).toBeInTheDocument();
    expect(screen.getByText(/still contains supporting knowledge/i, { selector: ".no-strategy-box" })).toBeInTheDocument();
    expect(screen.queryByText("Setup")).not.toBeInTheDocument();
  });

  it("keeps supporting-knowledge sections visible for a no-strategy lesson, organized by category, hiding categories with no items", async () => {
    const lesson = makeLesson({ job: { jobId: "job_2", status: "NO_STRATEGY" } });
    render(<LessonDetailDrawer lesson={lesson} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => noStrategyJson)} />);

    expect(await screen.findByText("Risk Management")).toBeInTheDocument();
    expect(screen.getByText("Never risk more than 1% of account equity on a single trade.")).toBeInTheDocument();
    expect(screen.getByText("Hard Rule")).toBeInTheDocument();
    expect(screen.getByText("1%", { selector: ".mono-box" })).toBeInTheDocument();
    expect(screen.getByText("max risk per trade", { selector: ".rule-description" })).toBeInTheDocument();

    // A category with zero items (e.g. Execution) never renders its own empty section.
    expect(screen.queryByText("Execution")).not.toBeInTheDocument();
  });

  it("separates instructor preferences from hard rules — never promotes a stated preference into a rule", async () => {
    const lesson = makeLesson({ job: { jobId: "job_2", status: "NO_STRATEGY" } });
    render(<LessonDetailDrawer lesson={lesson} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => noStrategyJson)} />);

    expect(await screen.findByText("Instructor Heuristics")).toBeInTheDocument();
    expect(screen.getByText("I usually take a short break after two consecutive losses.")).toBeInTheDocument();
    expect(screen.getByText("Preference")).toBeInTheDocument();
  });

  it("shows examples and conflicts/ambiguities as their own sections, distinct from knowledgeItems", async () => {
    const lesson = makeLesson({ job: { jobId: "job_2", status: "NO_STRATEGY" } });
    render(<LessonDetailDrawer lesson={lesson} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => noStrategyJson)} />);

    expect(await screen.findByText("Examples")).toBeInTheDocument();
    expect(screen.getByText("A trade sized at 1% risk on a $10,000 account.")).toBeInTheDocument();
    expect(screen.getByText(/Stopped out for the planned 1% loss/, { selector: ".rule-conditions" })).toBeInTheDocument();

    expect(screen.getByText("Conflicts / Ambiguity")).toBeInTheDocument();
    expect(screen.getByText("Unclear whether the 1% figure is per-trade or per-day.")).toBeInTheDocument();
  });

  it("hides every knowledge section when knowledge is entirely empty (e.g. a strategy-only lesson)", async () => {
    render(<LessonDetailDrawer lesson={makeLesson()} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => strategyJson)} />);
    await screen.findByText("retest entry");
    for (const label of ["Risk Management", "Position Sizing", "Numerical Rules", "Examples", "Instructor Heuristics", "Conflicts / Ambiguity"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("keeps raw JSON collapsed by default, even after the analysis has loaded", async () => {
    render(<LessonDetailDrawer lesson={makeLesson()} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => strategyJson)} />);
    await screen.findByText("retest entry");
    const details = screen.getByText("▶ Raw JSON").closest("details");
    expect(details).not.toHaveAttribute("open");
  });

  it("shows the raw JSON in a fixed-height scroll container once expanded, with copy/download actions", async () => {
    render(<LessonDetailDrawer lesson={makeLesson()} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => strategyJson)} />);
    await screen.findByText("retest entry");
    fireEvent.click(screen.getByText("▶ Raw JSON"));
    expect(screen.getByText(/"strategy_found": true/)).toBeInTheDocument();
    expect(screen.getByText(/"strategy_found": true/).closest("pre")).toHaveClass("json-block-scroll");
    expect(screen.getAllByRole("button", { name: /copy json/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /download json/i }).length).toBeGreaterThan(0);
  });

  it("re-fetches the analysis when switching to a different lesson", async () => {
    const onLoadAnalysis = vi.fn(async () => strategyJson);
    const { rerender } = render(<LessonDetailDrawer lesson={makeLesson({ id: 1 })} onClose={vi.fn()} onLoadAnalysis={onLoadAnalysis} />);
    await waitFor(() => expect(onLoadAnalysis).toHaveBeenCalledWith(1));

    rerender(<LessonDetailDrawer lesson={makeLesson({ id: 2, title: "Order Blocks" })} onClose={vi.fn()} onLoadAnalysis={onLoadAnalysis} />);
    await waitFor(() => expect(onLoadAnalysis).toHaveBeenCalledWith(2));
    expect(screen.getByRole("dialog", { name: /order blocks/i })).toBeInTheDocument();
  });
});
