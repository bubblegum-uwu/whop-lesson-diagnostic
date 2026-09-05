import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfigForm } from "../ConfigForm";

describe("ConfigForm", () => {
  it("does not render a Client ID input — it's build-time config now, never typed in", () => {
    render(<ConfigForm redirectUri="https://example.com/" onSubmit={vi.fn()} />);
    expect(screen.queryByLabelText(/client_id/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/app_xxxxxxxxxxxx/i)).not.toBeInTheDocument();
  });

  it("still asks for the lesson URL and submits just that", () => {
    const onSubmit = vi.fn();
    render(<ConfigForm redirectUri="https://example.com/" onSubmit={onSubmit} />);

    const input = screen.getByLabelText(/whop lesson url/i);
    fireEvent.change(input, { target: { value: "  https://whop.com/some/lesson/  " } });
    fireEvent.click(screen.getByRole("button", { name: /sign in with whop/i }));

    expect(onSubmit).toHaveBeenCalledWith("https://whop.com/some/lesson/");
  });

  it("shows the exact redirect URI to register in Whop", () => {
    render(<ConfigForm redirectUri="https://bubblegum-uwu.github.io/whop-lesson-diagnostic/" onSubmit={vi.fn()} />);
    expect(screen.getByText("https://bubblegum-uwu.github.io/whop-lesson-diagnostic/")).toBeInTheDocument();
  });
});
