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
      estimatedCost: 0.12,
      processingDurationSeconds: 95,
      completedAt: "2026-01-02T00:00:00Z",
    },
    ...overrides,
  };
}

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
};

const noStrategyJson = { strategy_found: false, strategies: [] };

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

  it('shows "No concrete trading strategy taught." prominently for NO_STRATEGY, without empty strategy sections', async () => {
    const lesson = makeLesson({
      job: { jobId: "job_2", status: "NO_STRATEGY" },
      analysis: {
        analysisId: 2,
        strategyFound: false,
        extractedStrategiesLabel: null,
        ruleCounts: [],
        confidence: null,
        summary: "No concrete trading strategy taught.",
        estimatedCost: 0.05,
        processingDurationSeconds: 40,
        completedAt: "2026-01-02T00:00:00Z",
      },
    });
    render(<LessonDetailDrawer lesson={lesson} onClose={vi.fn()} onLoadAnalysis={vi.fn(async () => noStrategyJson)} />);
    expect(await screen.findByText("No concrete trading strategy taught.")).toBeInTheDocument();
    expect(screen.queryByText("Setup")).not.toBeInTheDocument();
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
