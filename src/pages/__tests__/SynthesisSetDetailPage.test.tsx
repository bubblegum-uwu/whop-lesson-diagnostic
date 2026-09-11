import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SynthesisSetDetailPage } from "../SynthesisSetDetailPage";
import type { SynthesisSetDetail } from "../../lib/synthesisSetsApi";
import type { YouTubeProjectSource, DiscordProjectSource } from "../../lib/sourcesApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

const PROJECT = {
  id: 7,
  name: "MasterMind",
  projectType: "TRADING_STRATEGIES",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  courseCount: 0,
  lessonCount: 0,
  analyzedLessonCount: 0,
  latestSynthesisStatus: null,
  latestSynthesisCompletedAt: null,
};

const YT_SOURCE: YouTubeProjectSource = {
  provider: "YOUTUBE",
  sourceType: "VIDEO",
  id: 101,
  externalId: "dQw4w9WgXcQ",
  sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Scalping Basics",
  durationSeconds: 600,
  status: "READY",
  createdAt: "2026-01-01T00:00:00.000Z",
  collectionId: null,
};

const DISCORD_SOURCE: DiscordProjectSource = {
  provider: "DISCORD",
  sourceType: "VIDEO",
  id: 102,
  externalId: "attach-1",
  sourceUrl: "https://cdn.discordapp.com/attachments/1/2/clip.mp4",
  title: "Trade Review Clip",
  durationSeconds: 120,
  status: "READY",
  createdAt: "2026-01-01T00:00:00.000Z",
  collectionId: null,
};

function makeSet(overrides: Partial<SynthesisSetDetail> = {}): SynthesisSetDetail {
  return {
    id: 1,
    projectId: 7,
    name: "Scalping Playbook",
    description: "Fast setups",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sourceCount: 1,
    analyzedSourceCount: 1,
    needsAnalysisCount: 0,
    sources: [{ ...YT_SOURCE, analyzed: true }],
    ...overrides,
  };
}

function stubFetch(set: SynthesisSetDetail | "not_found", allSources: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/synthesis-sets/1")) {
        return set === "not_found"
          ? jsonResponse(404, { error: { message: "Unknown synthesis set.", type: "synthesis_set_not_found" } })
          : jsonResponse(200, set);
      }
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: allSources });
      return jsonResponse(404, {});
    }),
  );
}

function renderPage(initialPath = "/projects/7/synthesis-sets/1") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/synthesis-sets" element={<div>SET_LIST_MARKER</div>} />
        <Route path="/projects/:projectId/synthesis-sets/:setId" element={<SynthesisSetDetailPage backendUrl="https://backend.example.com" knoveraToken="token" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SynthesisSetDetailPage (Phase 4J)", () => {
  it("shows a not-found state for an unknown/foreign set, with a way back to the list", async () => {
    stubFetch("not_found", []);
    renderPage();
    await waitFor(() => expect(screen.getByText("This synthesis set doesn't exist.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Back to Synthesis Sets/ }));
    expect(screen.getByText("SET_LIST_MARKER")).toBeInTheDocument();
  });

  it("renders the set's name/description, readiness summary, and every project video source with its membership + analysis state shown separately", async () => {
    stubFetch(makeSet(), [YT_SOURCE, { ...DISCORD_SOURCE }]);
    renderPage();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    expect(screen.getByText("1 selected · 1 analyzed · 0 needs analysis")).toBeInTheDocument();

    const ytCheckbox = screen.getByLabelText(/Scalping Basics/);
    expect(ytCheckbox).toBeChecked();
    expect(screen.getByText("Analyzed")).toBeInTheDocument();

    const discordCheckbox = screen.getByLabelText(/Trade Review Clip/);
    expect(discordCheckbox).not.toBeChecked();
    // A non-member source shows no analyzed/not-analyzed badge at all — membership state and analysis state are two separate signals.
  });

  it("member + NOT analyzed is a fully valid, visible state — never hidden or blocked", async () => {
    stubFetch(makeSet({ analyzedSourceCount: 0, needsAnalysisCount: 1, sources: [{ ...YT_SOURCE, analyzed: false }] }), [YT_SOURCE]);
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Scalping Basics/)).toBeChecked());
    expect(screen.getByText("Not analyzed")).toBeInTheDocument();
    expect(screen.getByText("1 selected · 0 analyzed · 1 needs analysis")).toBeInTheDocument();
  });

  for (const [label, source] of [
    ["YouTube", YT_SOURCE],
    ["Discord", DISCORD_SOURCE],
  ] as const) {
    it(`${label}: checking an unselected source calls POST .../sources with its id and NEVER calls the analyze endpoint`, async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
        if (url.endsWith("/synthesis-sets/1") && (!init || init.method === undefined)) {
          return jsonResponse(200, makeSet({ sourceCount: 0, analyzedSourceCount: 0, needsAnalysisCount: 0, sources: [] }));
        }
        if (url.endsWith("/sources") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, sources: [source] });
        if (url.endsWith("/synthesis-sets/1/sources") && init?.method === "POST") {
          expect(JSON.parse(init.body as string)).toEqual({ sourceId: source.id });
          return jsonResponse(201, { synthesisSetId: 1, sourceId: source.id, added: true });
        }
        return jsonResponse(404, {});
      });
      vi.stubGlobal("fetch", fetchMock);
      renderPage();

      const title = source.title!;
      await waitFor(() => expect(screen.getByLabelText(new RegExp(title))).not.toBeChecked());
      fireEvent.click(screen.getByLabelText(new RegExp(title)));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/synthesis-sets/1/sources", expect.objectContaining({ method: "POST" })));
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analyze"))).toBe(false);
    });

    it(`${label}: unchecking a selected source calls DELETE .../sources/:sourceId and never touches its analysis`, async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
        if (url.endsWith("/synthesis-sets/1") && (!init || init.method === undefined)) {
          return jsonResponse(200, makeSet({ sources: [{ ...source, analyzed: true }] }));
        }
        if (url.endsWith("/sources") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, sources: [source] });
        if (url.endsWith(`/synthesis-sets/1/sources/${source.id}`) && init?.method === "DELETE") return noContentResponse();
        return jsonResponse(404, {});
      });
      vi.stubGlobal("fetch", fetchMock);
      renderPage();

      const title = source.title!;
      await waitFor(() => expect(screen.getByLabelText(new RegExp(title))).toBeChecked());
      fireEvent.click(screen.getByLabelText(new RegExp(title)));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(`https://backend.example.com/api/projects/7/synthesis-sets/1/sources/${source.id}`, expect.objectContaining({ method: "DELETE" })),
      );
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analyze"))).toBe(false);
    });
  }

  it("Rename edits name and description via PATCH, without touching membership", async () => {
    let renamed = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/synthesis-sets/1") && init?.method === "PATCH") {
        expect(JSON.parse(init.body as string)).toEqual({ name: "Renamed Set", description: "Updated" });
        renamed = true;
        return jsonResponse(200, { ...makeSet(), name: "Renamed Set", description: "Updated" });
      }
      if (url.endsWith("/synthesis-sets/1") && (!init || init.method === undefined)) {
        return jsonResponse(200, renamed ? { ...makeSet(), name: "Renamed Set", description: "Updated" } : makeSet());
      }
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [YT_SOURCE] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed Set" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Renamed Set" })).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/sources") && (c[1] as RequestInit | undefined)?.method)).toBe(false);
  });

  it("Delete Set requires a confirm step, then calls DELETE and navigates back to the list", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/synthesis-sets/1") && init?.method === "DELETE") return noContentResponse();
      if (url.endsWith("/synthesis-sets/1") && (!init || init.method === undefined)) return jsonResponse(200, makeSet());
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [YT_SOURCE] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete Set" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

    await waitFor(() => expect(screen.getByText("SET_LIST_MARKER")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/synthesis-sets/1", expect.objectContaining({ method: "DELETE" }));
  });

  it("shows an empty state when the project has no YouTube/Discord sources to select from yet", async () => {
    stubFetch(makeSet({ sourceCount: 0, analyzedSourceCount: 0, needsAnalysisCount: 0, sources: [] }), []);
    renderPage();
    await waitFor(() => expect(screen.getByText("No YouTube or Discord sources in this project yet.")).toBeInTheDocument());
  });
});
