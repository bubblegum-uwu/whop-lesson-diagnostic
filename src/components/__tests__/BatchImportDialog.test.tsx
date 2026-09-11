import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BatchImportDialog } from "../BatchImportDialog";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("BatchImportDialog (Phase 4K)", () => {
  it("splits pasted text into one URL per line and reports per-entry results without hiding partial success", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body.urls).toEqual(["https://www.youtube.com/watch?v=aaaaaaaaaaa", "not a url", "https://www.youtube.com/watch?v=bbbbbbbbbbb"]);
      return jsonResponse(200, {
        results: [
          { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", kind: "added" },
          { url: "not a url", kind: "invalid", message: "Could not parse YouTube URL." },
          { url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", kind: "duplicate" },
        ],
        addedCount: 1,
        duplicateCount: 1,
        invalidCount: 1,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn();
    render(<BatchImportDialog backendUrl="https://backend.example.com" knoveraToken="token" projectId={7} provider="YOUTUBE" onClose={() => {}} onImported={onImported} />);

    fireEvent.change(screen.getByPlaceholderText(/youtube.com\/watch/), {
      target: { value: "https://www.youtube.com/watch?v=aaaaaaaaaaa\nnot a url\nhttps://www.youtube.com/watch?v=bbbbbbbbbbb" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Import 3 URLs/ }));

    await waitFor(() => expect(screen.getByText("1 added · 1 duplicate · 1 invalid")).toBeInTheDocument());
    expect(screen.getByText("not a url")).toBeInTheDocument();
    expect(screen.getByText("Could not parse YouTube URL.")).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("blank lines are ignored when counting URLs", () => {
    render(<BatchImportDialog backendUrl="https://backend.example.com" knoveraToken="token" projectId={7} provider="DISCORD" onClose={() => {}} onImported={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/discordapp/), { target: { value: "https://cdn.discordapp.com/attachments/1/2/a.mp4\n\n\nhttps://cdn.discordapp.com/attachments/1/3/b.mp4\n" } });
    expect(screen.getByRole("button", { name: "Import 2 URLs" })).toBeInTheDocument();
  });

  it("Cancel never calls the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<BatchImportDialog backendUrl="https://backend.example.com" knoveraToken="token" projectId={7} provider="YOUTUBE" onClose={onClose} onImported={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/youtube.com\/watch/), { target: { value: "https://www.youtube.com/watch?v=aaaaaaaaaaa" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
