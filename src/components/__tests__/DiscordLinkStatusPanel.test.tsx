import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DiscordLinkStatusPanel } from "../DiscordLinkStatusPanel";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("DiscordLinkStatusPanel", () => {
  it("shows 'Not Linked' and no Unlink button when no Discord account is linked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { linked: false, discordUserIds: [] })));
    render(<DiscordLinkStatusPanel backendUrl="https://backend.example.com" knoveraToken="token" />);

    await waitFor(() => expect(screen.getByText("Not Linked")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Unlink Discord" })).not.toBeInTheDocument();
  });

  it("shows 'Linked ✓' and an Unlink action when a Discord account is linked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { linked: true, discordUserIds: ["123"] })));
    render(<DiscordLinkStatusPanel backendUrl="https://backend.example.com" knoveraToken="token" />);

    await waitFor(() => expect(screen.getByText("Linked ✓")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Unlink Discord" })).toBeInTheDocument();
  });

  it("Unlink requires confirmation, then calls DELETE and refreshes to Not Linked — never deletes previously-captured content (no such call is ever made by this panel)", async () => {
    let deleteCalled = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleteCalled = true;
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { linked: !deleteCalled, discordUserIds: deleteCalled ? [] : ["123"] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscordLinkStatusPanel backendUrl="https://backend.example.com" knoveraToken="token" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Unlink Discord" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Unlink Discord" }));

    // Requires confirmation — clicking once must not call DELETE yet.
    expect(deleteCalled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm Unlink" }));

    await waitFor(() => expect(deleteCalled).toBe(true));
    await waitFor(() => expect(screen.getByText("Not Linked")).toBeInTheDocument());
  });

  it("never shows a guild/server picker — no select/combobox at all, just the message-command instructions and the user-install button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { linked: false, discordUserIds: [] })));
    render(<DiscordLinkStatusPanel backendUrl="https://backend.example.com" knoveraToken="token" />);

    await waitFor(() => expect(screen.getByText(/Save to Knovera/)).toBeInTheDocument());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
