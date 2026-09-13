import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SynthesisSetDetailPage } from "../SynthesisSetDetailPage";
import type { SynthesisSetDetail } from "../../lib/synthesisSetsApi";
import type { YouTubeProjectSource, DiscordProjectSource } from "../../lib/sourcesApi";
import type { CatalogCollectionSummary, CatalogItemSummary } from "../../lib/catalogApi";

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

function makeSet(overrides: Partial<SynthesisSetDetail> = {}): SynthesisSetDetail {
  return {
    id: 1,
    projectId: 7,
    name: "Scalping Playbook",
    description: "Fast setups",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sourceCount: 0,
    analyzedSourceCount: 0,
    needsAnalysisCount: 0,
    sources: [],
    ...overrides,
  };
}

const COLLECTION: CatalogCollectionSummary = {
  id: 10,
  provider: "YOUTUBE",
  externalId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  title: "SMB Capital",
  sourceUrl: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
  status: "READY",
  sanitizedError: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z",
  itemCount: 2,
  analyzedCount: 1,
  hasMoreHistory: false,
};

const COLLECTION_ITEM_ELIGIBLE: CatalogItemSummary = {
  id: 201,
  provider: "YOUTUBE",
  externalId: "aaaaaaaaaaa",
  title: "Eligible Collection Video",
  sourceUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ANALYZED",
  eligibleForSynthesis: true,
};

const COLLECTION_ITEM_INELIGIBLE: CatalogItemSummary = {
  id: 202,
  provider: "YOUTUBE",
  externalId: "bbbbbbbbbbb",
  title: "Not Yet Analyzed Collection Video",
  sourceUrl: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "NOT_ANALYZED",
  eligibleForSynthesis: false,
};

const UNCOLLECTED_YOUTUBE: YouTubeProjectSource = {
  provider: "YOUTUBE",
  sourceType: "VIDEO",
  id: 301,
  externalId: "ccccccccccc",
  sourceUrl: "https://www.youtube.com/watch?v=ccccccccccc",
  title: "Uncollected Eligible Video",
  durationSeconds: null,
  status: "READY",
  createdAt: "2026-01-01T00:00:00.000Z",
  collectionId: null,
  origins: [],
};

interface StubConfig {
  set: SynthesisSetDetail | "not_found";
  collections?: CatalogCollectionSummary[];
  itemsByCollection?: Record<number, CatalogItemSummary[]>;
  uncollectedSources?: (YouTubeProjectSource | DiscordProjectSource)[];
  /** sourceId -> whether GET .../sources/:id/analysis reports a usable analysis. */
  uncollectedEligibility?: Record<number, boolean>;
  onCollectionBulkAdd?: (collectionId: number) => void;
  onCollectionBulkRemove?: (collectionId: number) => void;
  onAddSource?: (sourceId: number) => void;
  onRemoveSource?: (sourceId: number) => void;
  onBulkSources?: (body: unknown) => void;
  onRename?: (body: unknown) => void;
  onDeleteSet?: () => void;
}

function stubFetch(config: StubConfig) {
  const collections = config.collections ?? [];
  const itemsByCollection = config.itemsByCollection ?? {};
  const uncollectedSources = config.uncollectedSources ?? [];
  const uncollectedEligibility = config.uncollectedEligibility ?? {};

  let renamed = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });

    if (url.endsWith("/synthesis-sets/1") && init?.method === "PATCH") {
      config.onRename?.(JSON.parse(init.body as string));
      renamed = true;
      return jsonResponse(200, { ...makeSet(), name: "Renamed Set", description: "Updated" });
    }
    if (url.endsWith("/synthesis-sets/1") && init?.method === "DELETE") {
      config.onDeleteSet?.();
      return noContentResponse();
    }
    if (url.endsWith("/synthesis-sets/1") && (!init || init.method === undefined)) {
      if (config.set === "not_found") return jsonResponse(404, { error: { message: "Unknown synthesis set.", type: "synthesis_set_not_found" } });
      return jsonResponse(200, renamed ? { ...config.set, name: "Renamed Set", description: "Updated" } : config.set);
    }

    if (url.endsWith("/collections") && (!init || init.method === undefined)) {
      return jsonResponse(200, { projectId: 7, collections });
    }
    const collectionItemsMatch = url.match(/\/collections\/(\d+)(\?|$)/);
    if (collectionItemsMatch && (!init || init.method === undefined)) {
      const collectionId = Number(collectionItemsMatch[1]);
      const collection = collections.find((c) => c.id === collectionId);
      const items = itemsByCollection[collectionId] ?? [];
      return jsonResponse(200, { collection, items, pagination: { limit: 200, offset: 0, totalCount: items.length } });
    }

    if (url.endsWith("/sources") && (!init || init.method === undefined)) {
      return jsonResponse(200, { projectId: 7, sources: uncollectedSources });
    }
    const analysisMatch = url.match(/\/sources\/(\d+)\/analysis$/);
    if (analysisMatch && (!init || init.method === undefined)) {
      const sourceId = Number(analysisMatch[1]);
      const eligible = uncollectedEligibility[sourceId] ?? false;
      return jsonResponse(200, { sourceId, job: null, analysis: eligible ? { analysisId: 1, status: "no_strategy" } : null });
    }

    const collectionBulkMatch = url.match(/\/synthesis-sets\/1\/collections\/(\d+)$/);
    if (collectionBulkMatch && init?.method === "POST") {
      config.onCollectionBulkAdd?.(Number(collectionBulkMatch[1]));
      return jsonResponse(200, { collectionId: Number(collectionBulkMatch[1]), eligibleCount: 1, alreadySelectedCount: 0, addedCount: 1, ineligibleCount: 0 });
    }
    if (collectionBulkMatch && init?.method === "DELETE") {
      config.onCollectionBulkRemove?.(Number(collectionBulkMatch[1]));
      return jsonResponse(200, { collectionId: Number(collectionBulkMatch[1]), removedCount: 1 });
    }

    if (url.endsWith("/synthesis-sets/1/sources/bulk") && init?.method === "POST") {
      config.onBulkSources?.(JSON.parse(init.body as string));
      return jsonResponse(200, { synthesisSetId: 1, addedCount: 1, ineligibleSkippedCount: 0, removedCount: 1 });
    }
    if (url.endsWith("/synthesis-sets/1/sources") && init?.method === "POST") {
      const sourceId = JSON.parse(init.body as string).sourceId as number;
      config.onAddSource?.(sourceId);
      return jsonResponse(201, { synthesisSetId: 1, sourceId, added: true });
    }
    const removeMatch = url.match(/\/synthesis-sets\/1\/sources\/(\d+)$/);
    if (removeMatch && init?.method === "DELETE") {
      config.onRemoveSource?.(Number(removeMatch[1]));
      return noContentResponse();
    }

    return jsonResponse(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

describe("SynthesisSetDetailPage — collection-centric selection (Phase 4L)", () => {
  it("shows a not-found state for an unknown/foreign set, with a way back to the list", async () => {
    stubFetch({ set: "not_found" });
    renderPage();
    await waitFor(() => expect(screen.getByText("This synthesis set doesn't exist.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Back to Synthesis Sets/ }));
    expect(screen.getByText("SET_LIST_MARKER")).toBeInTheDocument();
  });

  it("renders the set's name/description and readiness summary", async () => {
    stubFetch({ set: makeSet() });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    expect(screen.getByText("Fast setups")).toBeInTheDocument();
    expect(screen.getByText("0 selected · 0 analyzed · 0 needs analysis")).toBeInTheDocument();
  });

  it("shows an empty state when the project has no collections yet", async () => {
    stubFetch({ set: makeSet() });
    renderPage();
    await waitFor(() => expect(screen.getByText("No collections in this project yet.")).toBeInTheDocument());
  });

  it("renders a collection row with its 'N/M eligible selected' summary, counting only the eligible members", async () => {
    stubFetch({
      set: makeSet(),
      collections: [COLLECTION],
      itemsByCollection: { 10: [COLLECTION_ITEM_ELIGIBLE, COLLECTION_ITEM_INELIGIBLE] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("SMB Capital")).toBeInTheDocument());
    expect(screen.getByText("0/1 eligible selected · 1 available to add")).toBeInTheDocument();
  });

  it("the collection checkbox is unchecked when zero eligible members are selected", async () => {
    stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { 10: [COLLECTION_ITEM_ELIGIBLE] } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in SMB Capital")).not.toBeChecked());
  });

  it("the collection checkbox is checked ('all') when every eligible member is already selected", async () => {
    stubFetch({
      set: makeSet({ sourceCount: 1, analyzedSourceCount: 1, sources: [{ ...COLLECTION_ITEM_ELIGIBLE, analyzed: true } as never] }),
      collections: [COLLECTION],
      itemsByCollection: { 10: [COLLECTION_ITEM_ELIGIBLE] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in SMB Capital")).toBeChecked());
  });

  it("the collection checkbox is indeterminate when only some eligible members are selected", async () => {
    const secondEligible = { ...COLLECTION_ITEM_ELIGIBLE, id: 203, title: "Second Eligible Video" };
    stubFetch({
      set: makeSet({ sourceCount: 1, sources: [{ ...COLLECTION_ITEM_ELIGIBLE, analyzed: true } as never] }),
      collections: [COLLECTION],
      itemsByCollection: { 10: [COLLECTION_ITEM_ELIGIBLE, secondEligible] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in SMB Capital")).toBeInTheDocument());
    const checkbox = screen.getByLabelText("Select all eligible sources in SMB Capital") as HTMLInputElement;
    await waitFor(() => expect(checkbox.indeterminate).toBe(true));
  });

  it("clicking an unchecked/partial collection checkbox bulk-selects the whole collection's currently-eligible sources", async () => {
    let addedCollectionId: number | undefined;
    stubFetch({
      set: makeSet(),
      collections: [COLLECTION],
      itemsByCollection: { 10: [COLLECTION_ITEM_ELIGIBLE] },
      onCollectionBulkAdd: (id) => (addedCollectionId = id),
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in SMB Capital")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select all eligible sources in SMB Capital"));
    await waitFor(() => expect(addedCollectionId).toBe(10));
  });

  it("clicking an all-selected collection checkbox bulk-removes this set's selected sources for that collection", async () => {
    let removedCollectionId: number | undefined;
    stubFetch({
      set: makeSet({ sourceCount: 1, sources: [{ ...COLLECTION_ITEM_ELIGIBLE, analyzed: true } as never] }),
      collections: [COLLECTION],
      itemsByCollection: { 10: [COLLECTION_ITEM_ELIGIBLE] },
      onCollectionBulkRemove: (id) => (removedCollectionId = id),
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in SMB Capital")).toBeChecked());
    fireEvent.click(screen.getByLabelText("Select all eligible sources in SMB Capital"));
    await waitFor(() => expect(removedCollectionId).toBe(10));
  });

  it("a collection with zero eligible members has a disabled checkbox — nothing to select", async () => {
    stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { 10: [COLLECTION_ITEM_INELIGIBLE] } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in SMB Capital")).toBeDisabled());
  });

  it("Fine Tune Sources is collapsed by default; toggling it reveals the flat, filterable source list", async () => {
    stubFetch({ set: makeSet(), uncollectedSources: [UNCOLLECTED_YOUTUBE], uncollectedEligibility: { 301: true } });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Fine Tune Sources" })).toBeInTheDocument());
    expect(screen.queryByLabelText(/Uncollected Eligible Video/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fine Tune Sources" }));
    await waitFor(() => expect(screen.getByLabelText(/Uncollected Eligible Video/)).toBeInTheDocument());
  });

  it("fine-tune: checking an eligible uncollected source calls POST .../sources with its id and never touches the analyze endpoint", async () => {
    let addedId: number | undefined;
    const fetchMock = stubFetch({ set: makeSet(), uncollectedSources: [UNCOLLECTED_YOUTUBE], uncollectedEligibility: { 301: true }, onAddSource: (id) => (addedId = id) });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    fireEvent.click(await screen.findByLabelText(/Uncollected Eligible Video/));

    await waitFor(() => expect(addedId).toBe(301));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analyze"))).toBe(false);
  });

  it("fine-tune: unchecking a selected source calls DELETE .../sources/:sourceId and never touches its analysis", async () => {
    let removedId: number | undefined;
    stubFetch({
      set: makeSet({ sourceCount: 1, sources: [{ ...UNCOLLECTED_YOUTUBE, analyzed: true }] }),
      uncollectedSources: [UNCOLLECTED_YOUTUBE],
      uncollectedEligibility: { 301: true },
      onRemoveSource: (id) => (removedId = id),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    const checkbox = await screen.findByLabelText(/Uncollected Eligible Video/);
    await waitFor(() => expect(checkbox).toBeChecked());
    fireEvent.click(checkbox);

    await waitFor(() => expect(removedId).toBe(301));
  });

  it("fine-tune: an ineligible source's checkbox is disabled — it cannot be selected", async () => {
    stubFetch({ set: makeSet(), uncollectedSources: [UNCOLLECTED_YOUTUBE], uncollectedEligibility: { 301: false } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    expect(await screen.findByLabelText(/Uncollected Eligible Video/)).toBeDisabled();
  });

  it("fine-tune: search filters the list by title", async () => {
    const other = { ...UNCOLLECTED_YOUTUBE, id: 302, title: "Completely Different Topic" };
    stubFetch({ set: makeSet(), uncollectedSources: [UNCOLLECTED_YOUTUBE, other], uncollectedEligibility: { 301: true, 302: true } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    await screen.findByText("Uncollected Eligible Video");
    fireEvent.change(screen.getByLabelText("Search sources"), { target: { value: "Different" } });
    await waitFor(() => expect(screen.queryByText("Uncollected Eligible Video")).not.toBeInTheDocument());
    expect(screen.getByText("Completely Different Topic")).toBeInTheDocument();
  });

  it("fine-tune: the 'Eligible' selection filter hides not-yet-eligible sources", async () => {
    const ineligible = { ...UNCOLLECTED_YOUTUBE, id: 302, title: "Not Eligible Video" };
    stubFetch({ set: makeSet(), uncollectedSources: [UNCOLLECTED_YOUTUBE, ineligible], uncollectedEligibility: { 301: true, 302: false } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    await screen.findByText("Not Eligible Video");
    fireEvent.change(screen.getByLabelText("Filter by selection"), { target: { value: "eligible" } });
    await waitFor(() => expect(screen.queryByText("Not Eligible Video")).not.toBeInTheDocument());
    expect(screen.getByText("Uncollected Eligible Video")).toBeInTheDocument();
  });

  it("fine-tune: the provider filter hides sources of the other provider, without hiding anything else", async () => {
    stubFetch({
      set: makeSet(),
      collections: [COLLECTION],
      itemsByCollection: { 10: [COLLECTION_ITEM_ELIGIBLE] },
      uncollectedSources: [UNCOLLECTED_YOUTUBE],
      uncollectedEligibility: { 301: true },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    await screen.findByText("Uncollected Eligible Video");
    expect(screen.getByText("Eligible Collection Video")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by provider"), { target: { value: "DISCORD" } });
    await waitFor(() => expect(screen.queryByText("Uncollected Eligible Video")).not.toBeInTheDocument());
    expect(screen.queryByText("Eligible Collection Video")).not.toBeInTheDocument();
  });

  it("fine-tune: 'Select All Visible Eligible' bulk-adds only the currently visible, eligible, unselected rows", async () => {
    let bulkBody: unknown;
    const secondEligible = { ...UNCOLLECTED_YOUTUBE, id: 302, title: "Second Uncollected Video" };
    stubFetch({
      set: makeSet(),
      uncollectedSources: [UNCOLLECTED_YOUTUBE, secondEligible],
      uncollectedEligibility: { 301: true, 302: true },
      onBulkSources: (body) => (bulkBody = body),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    await screen.findByText("Second Uncollected Video");

    fireEvent.click(screen.getByRole("button", { name: "Select All Visible Eligible" }));
    await waitFor(() => expect(bulkBody).toEqual({ add: [301, 302] }));
  });

  it("fine-tune: filtering to YouTube and clicking 'Deselect All Visible' never touches a hidden Discord row's selection", async () => {
    let bulkBody: unknown;
    const discordSource = { ...UNCOLLECTED_YOUTUBE, id: 303, provider: "DISCORD" as const, title: "Hidden Discord Row" };
    stubFetch({
      set: makeSet({ sourceCount: 2, sources: [{ ...UNCOLLECTED_YOUTUBE, analyzed: true }, { ...discordSource, analyzed: true } as never] }),
      uncollectedSources: [UNCOLLECTED_YOUTUBE, discordSource],
      uncollectedEligibility: { 301: true, 303: true },
      onBulkSources: (body) => (bulkBody = body),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    await screen.findByText("Hidden Discord Row");
    fireEvent.change(screen.getByLabelText("Filter by provider"), { target: { value: "YOUTUBE" } });
    await waitFor(() => expect(screen.queryByText("Hidden Discord Row")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Deselect All Visible" }));
    await waitFor(() => expect(bulkBody).toEqual({ remove: [301] }));
  });

  it("Rename edits name and description via PATCH, without touching membership", async () => {
    let renameBody: unknown;
    stubFetch({ set: makeSet(), onRename: (body) => (renameBody = body) });
    renderPage();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed Set" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Renamed Set" })).toBeInTheDocument());
    expect(renameBody).toEqual({ name: "Renamed Set", description: "Updated" });
  });

  it("Delete Set requires a confirm step, then calls DELETE and navigates back to the list", async () => {
    let deleted = false;
    stubFetch({ set: makeSet(), onDeleteSet: () => (deleted = true) });
    renderPage();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Scalping Playbook" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete Set" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

    await waitFor(() => expect(screen.getByText("SET_LIST_MARKER")).toBeInTheDocument());
    expect(deleted).toBe(true);
  });

  it("shows the Phase 4M placeholder for Run History, never a real run/execution control", async () => {
    stubFetch({ set: makeSet() });
    renderPage();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Run History" })).toBeInTheDocument());
    expect(screen.getByText("Coming in Phase 4M.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run/ })).not.toBeInTheDocument();
  });

  it("no selection action on this page ever calls an analyze or synthesis-run endpoint", async () => {
    const fetchMock = stubFetch({
      set: makeSet(),
      collections: [COLLECTION],
      itemsByCollection: { 10: [COLLECTION_ITEM_ELIGIBLE] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in SMB Capital")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select all eligible sources in SMB Capital"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(3));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analyze"))).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/run"))).toBe(false);
  });
});
