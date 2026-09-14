import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SourcesPage, type SourcesPageProps } from "../SourcesPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

function whopSource(courseId: number, name: string) {
  return {
    provider: "WHOP",
    sourceType: "COURSE",
    courseId,
    externalId: `cors_${courseId}`,
    name,
    lessonCount: 3,
    analyzedLessonCount: 1,
    queuedCount: 0,
    processingCount: 0,
    failedCount: 0,
    remainingCount: 2,
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    totalCost: 0.5,
  };
}

const COLLECTION = {
  groupKey: "9",
  kind: "PERSISTED",
  id: 9,
  provider: "YOUTUBE",
  sourceType: "CHANNEL",
  originProvider: null,
  originContainerId: null,
  externalId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  title: "SMB Capital",
  sourceUrl: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
  status: "READY",
  sanitizedError: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z",
  itemCount: 5,
  analyzedCount: 2,
  hasMoreHistory: false,
};

function baseProps(overrides: Partial<SourcesPageProps> = {}): SourcesPageProps {
  return {
    courseTitle: null,
    lessons: [],
    connected: true,
    syncing: false,
    authRequired: false,
    lastSyncedAt: null,
    summary: null,
    courseErrorMessage: null,
    onSignIn: () => {},
    onSync: () => {},
    onDisconnect: () => {},
    onEnqueue: () => {},
    onRetry: () => {},
    onCancel: () => {},
    onLoadAnalysis: async () => null,
    identifyState: { phase: "idle" },
    onFindUserId: () => {},
    backendUrl: "https://backend.example.com",
    knoveraToken: "token",
    diagnosticState: { phase: "config", errorMessage: null, submitting: false },
    redirectUri: "https://example.com/",
    onDiagnosticSubmit: () => {},
    onDiagnosticReset: () => {},
    ...overrides,
  };
}

function renderSources(props: Partial<SourcesPageProps> = {}) {
  return render(
    <MemoryRouter initialEntries={["/projects/7/sources"]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<SourcesPage {...baseProps(props)} />} />
        <Route path="/projects/:projectId/collections/:collectionId" element={<div>COLLECTION_DETAIL_MARKER</div>} />
        <Route path="/projects/:projectId/whop-courses/:courseId" element={<div>WHOP_COURSE_DETAIL_MARKER</div>} />
        <Route path="/projects/:projectId/whop-ala-carte" element={<div>WHOP_ALA_CARTE_DETAIL_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SourcesPage — multi-course Whop + collections catalog (Phase 4K)", () => {
  it("MULTIPLE COURSES: renders one card per Whop course, each independently navigable", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [whopSource(1, "Course A"), whopSource(2, "Course B")] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Course A" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Course B" })).toBeInTheDocument();
    expect(screen.getByText("2 courses connected — lessons synced and analyzed via Whop.")).toBeInTheDocument();

    const courseACard = screen.getByRole("heading", { name: "Course A" }).closest(".kv-card") as HTMLElement;
    fireEvent.click(within(courseACard).getByRole("button", { name: /Open/ }));
    expect(screen.getByText("WHOP_COURSE_DETAIL_MARKER")).toBeInTheDocument();
  });

  it("shows the Collections section with item/analyzed counts, navigable to the collection detail page", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [COLLECTION] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · CHANNEL" })).toBeInTheDocument());
    expect(screen.getByText("YouTube · SMB Capital · 5 items · 2 analyzed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("COLLECTION_DETAIL_MARKER")).toBeInTheDocument();
  });

  it("Add Channel opens the YouTube channel dialog and imports without analyzing", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/collections/youtube") && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ channelRef: "UC_x5XG1OV2P6uZZ5FSM9Ttw" });
        return jsonResponse(201, { collection: COLLECTION, discoveredCount: 5, importedCount: 5, adoptedCount: 0 });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add Channel" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add Channel" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Channel URL/), { target: { value: "UC_x5XG1OV2P6uZZ5FSM9Ttw" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Channel" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/collections/youtube", expect.objectContaining({ method: "POST" })));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analyze"))).toBe(false);
  });

  it("Connect Another Course opens the Whop course dialog when Whop is connected", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/whop-courses") && init?.method === "POST") {
        return jsonResponse(201, { course: whopSource(3, "New Course") });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources({ connected: true });

    await waitFor(() => expect(screen.getByRole("button", { name: "+ Connect Another Course" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "+ Connect Another Course" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/Whop Course URL/)).toBeInTheDocument();
  });

  it("Bulk Import opens a multi-line dialog for YouTube", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Bulk Import" })[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Bulk Import" })[0]);
    expect(screen.getByRole("heading", { name: "Bulk Import YouTube Videos" })).toBeInTheDocument();
  });

  it("renders a WHOP · À-LA-CARTE card (never a flat lesson row on the main Sources page) and Open navigates to its own detail page", async () => {
    const alaCarteLesson = { id: 42, title: "Lesson 7", courseId: 5, courseTitle: "Big Course", sourceUrl: "https://whop.com/x", durationSeconds: null, status: "NOT_ANALYZED", eligibleForSynthesis: false };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] }); // no connected courses
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/whop-lessons")) return jsonResponse(200, { projectId: 7, items: [alaCarteLesson] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getByRole("heading", { name: "WHOP · À-LA-CARTE" })).toBeInTheDocument());
    expect(screen.getByText("Individual Whop Content · 1 item · 0 analyzed")).toBeInTheDocument();
    // Phase 4L taxonomy correction — the main Sources page is
    // collection/group-only: the individual lesson never renders here,
    // only on WhopAlaCarteDetailPage (see WhopAlaCarteDetailPage.test.tsx).
    expect(screen.queryByText("Lesson 7")).not.toBeInTheDocument();
    // Never rendered as a Connected Courses card.
    expect(screen.queryByRole("heading", { name: "Big Course", level: 2 })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("WHOP_ALA_CARTE_DETAIL_MARKER")).toBeInTheDocument();
  });

  it("Bulk Import Lessons opens the WHOP_LESSON batch dialog when Whop is connected", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources({ connected: true });

    await waitFor(() => expect(screen.getByRole("button", { name: "Bulk Import Lessons" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Bulk Import Lessons" }));
    expect(screen.getByRole("heading", { name: "Bulk Import Whop Lessons" })).toBeInTheDocument();
  });
});
