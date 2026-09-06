import { describe, it, expect, vi } from "vitest";
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

  it("renders one row per lesson with a working Source link and status badge, once connected", () => {
    render(<CourseTable {...baseProps} connected lessons={[makeLesson()]} />);

    expect(screen.getByText("Support & Resistance")).toBeInTheDocument();
    expect(screen.getByText("Foundations")).toBeInTheDocument();
    expect(screen.getByText("44m")).toBeInTheDocument();
    expect(screen.getByText("Not analyzed")).toBeInTheDocument();
    const openLink = screen.getByRole("link", { name: /open/i });
    expect(openLink).toHaveAttribute("href", makeLesson().sourceUrl);
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

  it("selects lessons via checkboxes and queues them with Analyze Selected", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /analyze selected/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(onEnqueue).toHaveBeenCalledWith([1], false);
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

  it("expands [ View Analysis ] for a completed lesson and loads its validated JSON", async () => {
    const onLoadAnalysis = vi.fn(async () => ({ strategy_found: false, strategies: [] }));
    render(
      <CourseTable
        {...baseProps}
        connected
        onLoadAnalysis={onLoadAnalysis}
        lessons={[
          makeLesson({
            job: { jobId: "job_1", status: "COMPLETED" },
            analysis: {
              analysisId: 1,
              strategyFound: false,
              extractedStrategiesLabel: null,
              ruleCounts: [],
              confidence: null,
              summary: "No concrete trading strategy taught.",
              estimatedCost: 0.01,
              processingDurationSeconds: 60,
              completedAt: "2026-01-01T00:00:00Z",
            },
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view analysis/i }));
    expect(onLoadAnalysis).toHaveBeenCalledWith(1);
    expect(await screen.findByText("No concrete trading strategy taught.")).toBeInTheDocument();
  });

  it("offers Re-analyze for a completed lesson, which force-enqueues", () => {
    const onEnqueue = vi.fn();
    render(
      <CourseTable
        {...baseProps}
        connected
        onEnqueue={onEnqueue}
        lessons={[makeLesson({ id: 3, job: { jobId: "job_1", status: "COMPLETED" } })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /re-analyze/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onEnqueue).toHaveBeenCalledWith([3], true);
  });

  it("keeps Lesson/Status/Progress/Strategy/Actions columns unmarked for narrow-screen hiding", () => {
    render(<CourseTable {...baseProps} connected lessons={[makeLesson()]} />);
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    const alwaysVisible = ["Lesson", "Status", "Progress", "Extracted Strategies", "Actions"];
    for (const label of alwaysVisible) {
      const th = within(table)
        .getAllByRole("columnheader")
        .find((h) => h.textContent === label);
      expect(th).toBeDefined();
      expect(th?.className).not.toContain("hide-narrow");
    }
    void headers;
  });
});
