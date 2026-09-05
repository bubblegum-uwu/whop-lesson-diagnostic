import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FindWhopUserId } from "../FindWhopUserId";

describe("FindWhopUserId", () => {
  it("shows a sign-in button in the idle state, collapsed behind a disclosure", () => {
    render(<FindWhopUserId state={{ phase: "idle" }} onStart={vi.fn()} />);
    expect(screen.getByText(/first-time setup/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in to find my user id/i })).toBeInTheDocument();
  });

  it("calls onStart when the button is clicked", () => {
    const onStart = vi.fn();
    render(<FindWhopUserId state={{ phase: "idle" }} onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in to find my user id/i }));
    expect(onStart).toHaveBeenCalled();
  });

  it("shows a signing-in status while running", () => {
    render(<FindWhopUserId state={{ phase: "running" }} onStart={vi.fn()} />);
    expect(screen.getByText(/signing in with whop/i)).toBeInTheDocument();
  });

  it("displays the resulting user id with setup instructions, once found", () => {
    render(<FindWhopUserId state={{ phase: "result", sub: "user_abc123" }} onStart={vi.fn()} />);
    expect(screen.getByText("user_abc123")).toBeInTheDocument();
    expect(screen.getByText(/WHOP_OPERATOR_USER_ID=user_abc123/)).toBeInTheDocument();
    expect(screen.getByText(/not a secret/i)).toBeInTheDocument();
  });

  it("shows an error message when identification fails", () => {
    render(<FindWhopUserId state={{ phase: "error", message: "Could not determine your Whop user ID." }} onStart={vi.fn()} />);
    expect(screen.getByText("Could not determine your Whop user ID.")).toBeInTheDocument();
  });
});
