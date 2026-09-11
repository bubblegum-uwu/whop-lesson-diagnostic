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

  it("WHOP_LESSON provider posts to the whop-lessons/batch endpoint and shows per-URL results, including invalid/unsupported entries", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://backend.example.com/api/projects/7/whop-lessons/batch");
      const body = JSON.parse(init!.body as string);
      expect(body.urls).toEqual(["https://whop.com/co/exp_x/app/courses/cors_x/lessons/lesn_a/", "https://whop.com/co/exp_x/app/courses/cors_x/lessons/lesn_b/", "not a whop url"]);
      return jsonResponse(200, {
        results: [
          { url: "https://whop.com/co/exp_x/app/courses/cors_x/lessons/lesn_a/", kind: "added", lesson: { id: 1, title: "Lesson A", courseId: 5, courseTitle: "Course X", sourceUrl: "https://whop.com/x" } },
          { url: "https://whop.com/co/exp_x/app/courses/cors_x/lessons/lesn_b/", kind: "duplicate", lesson: { id: 2, title: "Lesson B", courseId: 5, courseTitle: "Course X", sourceUrl: "https://whop.com/y" } },
          { url: "not a whop url", kind: "invalid", message: "The provided value is not a valid URL." },
        ],
        addedCount: 1,
        duplicateCount: 1,
        invalidCount: 1,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BatchImportDialog backendUrl="https://backend.example.com" knoveraToken="token" projectId={7} provider="WHOP_LESSON" onClose={() => {}} onImported={() => {}} />);

    expect(screen.getByRole("heading", { name: "Bulk Import Whop Lessons" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/whop.com/), {
      target: {
        value:
          "https://whop.com/co/exp_x/app/courses/cors_x/lessons/lesn_a/\nhttps://whop.com/co/exp_x/app/courses/cors_x/lessons/lesn_b/\nnot a whop url",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Import 3 URLs/ }));

    await waitFor(() => expect(screen.getByText("1 added · 1 duplicate · 1 invalid")).toBeInTheDocument());
    expect(screen.getByText("The provided value is not a valid URL.")).toBeInTheDocument();
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
