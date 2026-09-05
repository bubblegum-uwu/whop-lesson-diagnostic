import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CourseTable } from "../CourseTable";

const baseProps = {
  courseTitle: "Scarface Trades Mastermind",
  lessons: [],
  connected: false,
  syncing: false,
  authRequired: false,
  lastSyncedAt: null,
  onSignIn: vi.fn(),
  onSync: vi.fn(),
  onDisconnect: vi.fn(),
  onAnalyzeLesson: vi.fn(),
};

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

  it("renders one row per lesson with a working Source link, once connected", () => {
    render(
      <CourseTable
        {...baseProps}
        connected
        lessons={[
          {
            id: 1,
            title: "Support & Resistance",
            chapterTitle: "Foundations",
            chapterOrder: 1,
            courseOrder: 2,
            durationSeconds: 2640,
            videoAvailable: true,
            sourceUrl: "https://whop.com/scarface-trades-mastermind/exp_x/app/courses/cors_x/lessons/lesn_x/",
            lastSyncedAt: "2026-01-01T00:00:00Z",
          },
        ]}
      />,
    );

    expect(screen.getByText("Support & Resistance")).toBeInTheDocument();
    expect(screen.getByText("Foundations")).toBeInTheDocument();
    expect(screen.getByText("44m")).toBeInTheDocument();
    const openLink = screen.getByRole("link", { name: /open/i });
    expect(openLink).toHaveAttribute(
      "href",
      "https://whop.com/scarface-trades-mastermind/exp_x/app/courses/cors_x/lessons/lesn_x/",
    );
  });

  it("calls onAnalyzeLesson with the lesson's source URL when Analyze is clicked", () => {
    const onAnalyzeLesson = vi.fn();
    render(
      <CourseTable
        {...baseProps}
        connected
        onAnalyzeLesson={onAnalyzeLesson}
        lessons={[
          {
            id: 1,
            title: "Order Blocks",
            chapterTitle: null,
            chapterOrder: null,
            courseOrder: 1,
            durationSeconds: null,
            videoAvailable: true,
            sourceUrl: "https://whop.com/x/lesn_1/",
            lastSyncedAt: "2026-01-01T00:00:00Z",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));
    expect(onAnalyzeLesson).toHaveBeenCalledWith("https://whop.com/x/lesn_1/");
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
});
