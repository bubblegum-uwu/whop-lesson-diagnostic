import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AddYouTubeVideoDialog } from "../AddYouTubeVideoDialog";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderDialog(overrides: { onClose?: () => void; onAdded?: () => void } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onAdded = overrides.onAdded ?? vi.fn();
  render(
    <AddYouTubeVideoDialog
      backendUrl="https://backend.example.com"
      knoveraToken="test-token"
      projectId={7}
      onClose={onClose}
      onAdded={onAdded}
    />,
  );
  return { onClose, onAdded };
}

describe("AddYouTubeVideoDialog (Phase 4H-A)", () => {
  it("B: opens with a YouTube URL field and Cancel/Add Video actions", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Add YouTube Video" })).toBeInTheDocument();
    expect(screen.getByLabelText("YouTube URL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Video" })).toBeInTheDocument();
  });

  it("C: the URL input accepts typed text", () => {
    renderDialog();
    const input = screen.getByLabelText("YouTube URL") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    expect(input.value).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("the Add Video button is disabled until a URL is entered", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Add Video" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
    expect(screen.getByRole("button", { name: "Add Video" })).toBeEnabled();
  });

  it("D: Cancel calls onClose and never calls fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { onClose } = renderDialog();

    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clicking the backdrop calls onClose and never calls fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { onClose } = renderDialog();

    fireEvent.click(screen.getByRole("presentation"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("E: an invalid URL renders a clean client-side error and never calls fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://vimeo.com/12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/youtube\.com or youtu\.be/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("E: a playlist URL renders the exact unsupported-playlist message", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/playlist?list=PLabc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Playlist URLs are not supported yet — add an individual video URL.");
  });

  it("F: a successful POST calls onAdded and closes the dialog", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://backend.example.com/api/projects/7/sources/youtube");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
      return jsonResponse(201, {
        source: {
          provider: "YOUTUBE",
          sourceType: "VIDEO",
          id: 1,
          externalId: "dQw4w9WgXcQ",
          sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          title: null,
          durationSeconds: null,
          status: "READY",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        duplicate: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { onAdded, onClose } = renderDialog();

    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled(); // the dialog's own onClose is never called directly — the parent (SourcesPage) closes it from onAdded
  });

  it("a duplicate-response (200) POST still calls onAdded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          source: {
            provider: "YOUTUBE",
            sourceType: "VIDEO",
            id: 1,
            externalId: "dQw4w9WgXcQ",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            title: null,
            durationSeconds: null,
            status: "READY",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          duplicate: true,
        }),
      ),
    );
    const { onAdded } = renderDialog();

    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  });

  it("a backend error response (e.g. project no longer exists) renders the backend's exact message and does not call onAdded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { message: "Unknown project.", type: "project_not_found" } })),
    );
    const { onAdded } = renderDialog();

    // A well-formed URL that passes the same client-side parser the backend
    // uses — so this genuinely exercises the network-error path, not the
    // client-validation short-circuit.
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unknown project."));
    expect(onAdded).not.toHaveBeenCalled();
  });
});
