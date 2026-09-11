import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SynthesisSetsPage } from "../SynthesisSetsPage";
import type { SynthesisSetSummary } from "../../lib/synthesisSetsApi";

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

const SET_A: SynthesisSetSummary = {
  id: 1,
  projectId: 7,
  name: "Scalping Playbook",
  description: "Fast setups",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sourceCount: 2,
  analyzedSourceCount: 1,
  needsAnalysisCount: 1,
};

function stubFetch(sets: SynthesisSetSummary[] | "error") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/synthesis-sets")) {
        return sets === "error" ? jsonResponse(500, { error: { message: "Synthesis sets unavailable." } }) : jsonResponse(200, { projectId: 7, synthesisSets: sets });
      }
      return jsonResponse(404, {});
    }),
  );
}

function renderPage(initialPath = "/projects/7/synthesis-sets") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/synthesis-sets" element={<SynthesisSetsPage backendUrl="https://backend.example.com" knoveraToken="token" />} />
        <Route path="/projects/:projectId/synthesis-sets/:setId" element={<div>SET_DETAIL_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SynthesisSetsPage (Phase 4J)", () => {
  it("shows an empty state when the project has no synthesis sets yet", async () => {
    stubFetch([]);
    renderPage();
    await waitFor(() => expect(screen.getByText("No synthesis sets yet.")).toBeInTheDocument());
  });

  it("shows a backend error state when the list fetch fails", async () => {
    stubFetch("error");
    renderPage();
    await waitFor(() => expect(screen.getByText(/Synthesis sets unavailable/)).toBeInTheDocument());
  });

  it("renders a set with its readiness summary — never collapsing the unanalyzed count away", async () => {
    stubFetch([SET_A]);
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    expect(screen.getByText("2 selected · 1 analyzed · 1 needs analysis")).toBeInTheDocument();
  });

  it("New Synthesis Set creates an empty set via POST and navigates to its detail page", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/synthesis-sets") && (!init || init.method === undefined)) {
        return jsonResponse(200, { projectId: 7, synthesisSets: [] });
      }
      if (url.endsWith("/synthesis-sets") && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ name: "Momentum Setups", description: null });
        return jsonResponse(201, {
          id: 5,
          projectId: 7,
          name: "Momentum Setups",
          description: null,
          createdAt: "2026-01-04T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
          sourceCount: 0,
          analyzedSourceCount: 0,
          needsAnalysisCount: 0,
        });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => expect(screen.getByText("No synthesis sets yet.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /New Synthesis Set/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Momentum Setups" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Synthesis Set" }));

    await waitFor(() => expect(screen.getByText("SET_DETAIL_MARKER")).toBeInTheDocument());
  });

  it("Cancel on New Synthesis Set never calls the API", async () => {
    stubFetch([]);
    renderPage();
    await waitFor(() => expect(screen.getByText("No synthesis sets yet.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /New Synthesis Set/ }));
    const dialog = screen.getByRole("dialog");
    const fetchMock = vi.fn();
    const originalFetch = (globalThis as { fetch: typeof fetch }).fetch;
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", originalFetch);
  });

  it("Delete requires a confirm step, then calls DELETE and removes the card", async () => {
    let deleted = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/synthesis-sets/1") && init?.method === "DELETE") {
        deleted = true;
        return noContentResponse();
      }
      if (url.endsWith("/synthesis-sets") && (!init || init.method === undefined)) {
        return jsonResponse(200, { projectId: 7, synthesisSets: deleted ? [] : [SET_A] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this set?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/synthesis-sets/1", expect.objectContaining({ method: "DELETE" })));
    await waitFor(() => expect(screen.getByText("No synthesis sets yet.")).toBeInTheDocument());
  });

  it("Cancel on the delete confirm never calls DELETE", async () => {
    stubFetch([SET_A]);
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument();
  });

  it("Open navigates to the set's detail page", async () => {
    stubFetch([SET_A]);
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("SET_DETAIL_MARKER")).toBeInTheDocument();
  });
});
