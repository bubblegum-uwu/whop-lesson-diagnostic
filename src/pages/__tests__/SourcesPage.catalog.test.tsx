import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Link } from "react-router-dom";
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

/** The DERIVED group a manually-added YouTube video (MANUAL origin, no Discord-channel origin) is classified into — see the backend's derivedSourceGroupsRepo.ts doc comment (YOUTUBE_ALA_CARTE_GROUP_KEY / "Manual YouTube"). */
function manualYouTubeCollection(itemCount = 1, analyzedCount = 0) {
  return {
    groupKey: "derived:youtube-ala-carte",
    kind: "DERIVED",
    id: null,
    provider: "YOUTUBE",
    sourceType: "A_LA_CARTE",
    originProvider: "MANUAL",
    originContainerId: null,
    externalId: null,
    title: "Manual YouTube",
    sourceUrl: null,
    status: null,
    sanitizedError: null,
    lastSyncedAt: null,
    itemCount,
    analyzedCount,
    hasMoreHistory: false,
  };
}

function baseProps(overrides: Partial<SourcesPageProps> = {}): SourcesPageProps {
  return {
    connected: true,
    providerErrorMessage: null,
    onSignIn: () => {},
    onDisconnect: () => {},
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

describe("SourcesPage — stale collection UI after adding a source (regression)", () => {
  it("Manual YouTube add: the new Collection card appears immediately after a successful add, with no reload/remount", async () => {
    let collectionsCallCount = 0;
    let sourcesCallCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources") && (!init || init.method === undefined)) {
        sourcesCallCount += 1;
        return jsonResponse(200, { projectId: 7, sources: [] });
      }
      if (url.endsWith("/sources/youtube") && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
        return jsonResponse(201, { source: { id: 101, provider: "YOUTUBE" }, duplicate: false });
      }
      if (url.endsWith("/collections") && (!init || init.method === undefined)) {
        collectionsCallCount += 1;
        // The first call (initial page load) reflects "nothing yet" — every
        // call after the add reflects the backend's now-updated derived
        // group classification (see derivedSourceGroupsRepo.ts).
        return jsonResponse(200, { projectId: 7, collections: collectionsCallCount === 1 ? [] : [manualYouTubeCollection()] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "YOUTUBE · À-LA-CARTE" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add YouTube Video" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Both the raw sources list AND the collection/group catalog must
    // refresh — refreshing only `sources` (the original bug) left the new
    // card invisible until a hard browser reload.
    await waitFor(() => expect(sourcesCallCount).toBeGreaterThan(1));
    await waitFor(() => expect(collectionsCallCount).toBeGreaterThan(1));

    // The new Collection card is visible with no remount/reload required.
    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · À-LA-CARTE" })).toBeInTheDocument());
    expect(screen.getByText("Manual YouTube · 1 item · 0 analyzed")).toBeInTheDocument();
  });

  it("Duplicate manual YouTube add stays idempotent: refreshed collections still show exactly one card, never two", async () => {
    let collectionsCallCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, sources: [] });
      // Backend reports the source already existed (idempotent re-add) —
      // still a 200/success, never a second project_sources row.
      if (url.endsWith("/sources/youtube") && init?.method === "POST") return jsonResponse(200, { source: { id: 101, provider: "YOUTUBE" }, duplicate: true });
      if (url.endsWith("/collections") && (!init || init.method === undefined)) {
        collectionsCallCount += 1;
        return jsonResponse(200, { projectId: 7, collections: [manualYouTubeCollection(1, 0)] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Add YouTube Video" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(collectionsCallCount).toBeGreaterThan(1));
    expect(screen.getAllByRole("heading", { name: "YOUTUBE · À-LA-CARTE" })).toHaveLength(1);
    expect(screen.getByText("Manual YouTube · 1 item · 0 analyzed")).toBeInTheDocument();
  });

  it("YouTube Bulk Import: a successful batch import refreshes both sources and the collections catalog", async () => {
    let collectionsCallCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/sources/youtube/batch") && init?.method === "POST") {
        return jsonResponse(200, {
          results: [{ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", kind: "added" }],
          addedCount: 1,
          duplicateCount: 0,
          invalidCount: 0,
        });
      }
      if (url.endsWith("/collections") && (!init || init.method === undefined)) {
        collectionsCallCount += 1;
        return jsonResponse(200, { projectId: 7, collections: collectionsCallCount === 1 ? [] : [manualYouTubeCollection()] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Bulk Import" })[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Bulk Import" })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(dialog.querySelector("textarea") as HTMLTextAreaElement, { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Import 1 URL/ }));

    await waitFor(() => expect(screen.getByText(/1 added/)).toBeInTheDocument());
    await waitFor(() => expect(collectionsCallCount).toBeGreaterThan(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · À-LA-CARTE" })).toBeInTheDocument());
  });
});

describe("SourcesPage — stale request protection (follow-up)", () => {
  it("REGRESSION: a slow initial /collections request resolving AFTER a faster post-add refresh must not revert the new card", async () => {
    let collectionsCallCount = 0;
    let resolveInitialCollections!: (value: Response) => void;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/sources/youtube") && init?.method === "POST") return jsonResponse(201, { source: { id: 101, provider: "YOUTUBE" }, duplicate: false });
      if (url.endsWith("/collections") && (!init || init.method === undefined)) {
        collectionsCallCount += 1;
        if (collectionsCallCount === 1) {
          // The initial page-load request (R1) — deliberately held open so
          // it resolves AFTER the post-add refresh below.
          return new Promise<Response>((resolve) => (resolveInitialCollections = resolve));
        }
        // The post-add refresh's own request (R2) — resolves immediately
        // with the new card.
        return jsonResponse(200, { projectId: 7, collections: [manualYouTubeCollection()] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeInTheDocument());
    await waitFor(() => expect(collectionsCallCount).toBe(1)); // R1 is now in flight, held open.

    fireEvent.click(screen.getByRole("button", { name: "Add YouTube Video" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(collectionsCallCount).toBe(2)); // R2 fired and already resolved.
    await waitFor(() => expect(screen.getByRole("heading", { name: "YOUTUBE · À-LA-CARTE" })).toBeInTheDocument());

    // R1 (older, started first) finally resolves with the STALE pre-add
    // snapshot. It must be discarded, not applied on top of R2's data.
    resolveInitialCollections(jsonResponse(200, { projectId: 7, collections: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole("heading", { name: "YOUTUBE · À-LA-CARTE" })).toBeInTheDocument();
  });

  it("REGRESSION: same-project /sources requests resolving out of order — the newest response wins, never the oldest", async () => {
    const newCourse = whopSource(9, "New Course B");
    let sourcesCallCount = 0;
    let resolveInitialSources!: (value: Response) => void;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources") && (!init || init.method === undefined)) {
        sourcesCallCount += 1;
        if (sourcesCallCount === 1) {
          // The initial page-load request (R1) — deliberately held open.
          return new Promise<Response>((resolve) => (resolveInitialSources = resolve));
        }
        // The post-add refresh's own request (R2) — resolves immediately.
        return jsonResponse(200, { projectId: 7, sources: [newCourse] });
      }
      if (url.endsWith("/sources/youtube") && init?.method === "POST") return jsonResponse(201, { source: { id: 101, provider: "YOUTUBE" }, duplicate: false });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeInTheDocument());
    await waitFor(() => expect(sourcesCallCount).toBe(1)); // R1 is now in flight, held open.

    fireEvent.click(screen.getByRole("button", { name: "Add YouTube Video" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(sourcesCallCount).toBe(2)); // R2 fired and already resolved.
    await waitFor(() => expect(screen.getByRole("heading", { name: "New Course B" })).toBeInTheDocument());

    // R1 (older, started first) finally resolves with the STALE pre-add
    // snapshot (no Whop courses at all). It must be discarded.
    resolveInitialSources(jsonResponse(200, { projectId: 7, sources: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole("heading", { name: "New Course B" })).toBeInTheDocument();
  });

  it("REGRESSION: navigating Project A -> Project B never lets Project A's slow, stale sources/collections responses leak onto Project B", async () => {
    const PROJECT_A = { ...PROJECT, id: 7, name: "Project A" };
    const PROJECT_B = { ...PROJECT, id: 9, name: "Project B" };
    const collectionA = { ...COLLECTION, groupKey: "a1", id: 101, title: "Project A Channel" };
    const collectionB = { ...COLLECTION, groupKey: "b1", id: 102, title: "Project B Channel" };
    const courseA = whopSource(501, "Project A Course");
    const courseB = whopSource(502, "Project B Course");
    let resolveProjectASources!: (value: Response) => void;
    let resolveProjectACollections!: (value: Response) => void;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT_A, PROJECT_B] });
      if (url.endsWith("/api/projects/7/sources")) return new Promise<Response>((resolve) => (resolveProjectASources = resolve));
      if (url.endsWith("/api/projects/9/sources")) return jsonResponse(200, { projectId: 9, sources: [courseB] });
      if (url.endsWith("/api/projects/7/collections")) return new Promise<Response>((resolve) => (resolveProjectACollections = resolve));
      if (url.endsWith("/api/projects/9/collections")) return jsonResponse(200, { projectId: 9, collections: [collectionB] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/projects/7/sources"]}>
        <Routes>
          <Route
            path="/projects/:projectId/sources"
            element={
              <>
                <Link to="/projects/9/sources">Go to Project B</Link>
                <SourcesPage {...baseProps()} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("link", { name: "Go to Project B" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Project B Course" })).toBeInTheDocument());
    expect(screen.getByText(/Project B Channel/)).toBeInTheDocument();

    // Project A's slow, still-in-flight requests (started before
    // navigation) finally resolve with Project A's own data.
    resolveProjectASources(jsonResponse(200, { projectId: 7, sources: [courseA] }));
    resolveProjectACollections(jsonResponse(200, { projectId: 7, collections: [collectionA] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Project B's data must remain — Project A's stale response must never land.
    expect(screen.getByRole("heading", { name: "Project B Course" })).toBeInTheDocument();
    expect(screen.getByText(/Project B Channel/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Project A Course" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Project A Channel/)).not.toBeInTheDocument();
  });
});
