import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SynthesisSetDetailPage } from "../SynthesisSetDetailPage";
import type { SynthesisSetDetail } from "../../lib/synthesisSetsApi";
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

/** A real, persisted YouTube-channel collection — unaffected by the Phase 4L taxonomy correction. Origin line: "YouTube · SMB Capital". */
const COLLECTION: CatalogCollectionSummary = {
  groupKey: "10",
  kind: "PERSISTED",
  id: 10,
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
  itemCount: 2,
  analyzedCount: 1,
  hasMoreHistory: false,
};

/** A DERIVED group — genuinely manual YouTube à-la-carte adds (Phase 4L taxonomy correction: never a generic "Uncollected" bucket). Origin line: "Manual YouTube". */
const DERIVED_ALA_CARTE: CatalogCollectionSummary = {
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
  itemCount: 1,
  analyzedCount: 0,
  hasMoreHistory: false,
};

/** A DERIVED group for genuinely unclassifiable sources (e.g. a raw-Discord-CDN-URL-paste add with no channel provenance) — never mislabeled as Discord à-la-carte. */
const DERIVED_UNCLASSIFIED: CatalogCollectionSummary = {
  groupKey: "derived:unclassified",
  kind: "DERIVED",
  id: null,
  provider: null,
  sourceType: "UNCLASSIFIED",
  originProvider: null,
  originContainerId: null,
  externalId: null,
  title: "Unclassified Sources",
  sourceUrl: null,
  status: null,
  sanitizedError: null,
  lastSyncedAt: null,
  itemCount: 1,
  analyzedCount: 0,
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
  origins: [],
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
  origins: [],
};

/** A member of the DERIVED_ALA_CARTE group — formerly an "uncollected" YouTube source. */
const ALA_CARTE_ITEM_ELIGIBLE: CatalogItemSummary = {
  id: 301,
  provider: "YOUTUBE",
  externalId: "ccccccccccc",
  title: "Uncollected Eligible Video",
  sourceUrl: "https://www.youtube.com/watch?v=ccccccccccc",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ANALYZED",
  eligibleForSynthesis: true,
  origins: [],
};

/** A member of the DERIVED_UNCLASSIFIED group. */
const UNCLASSIFIED_DISCORD_ITEM: CatalogItemSummary = {
  id: 303,
  provider: "DISCORD",
  externalId: "dddddddddddddddddd",
  title: "Hidden Discord Row",
  sourceUrl: "https://cdn.discordapp.com/attachments/1/2/clip.mp4",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ANALYZED",
  eligibleForSynthesis: true,
  origins: [],
};

interface StubConfig {
  set: SynthesisSetDetail | "not_found";
  collections?: CatalogCollectionSummary[];
  /** Keyed by groupKey (Phase 4L taxonomy correction — persisted and derived groups share one identity space). */
  itemsByCollection?: Record<string, CatalogItemSummary[]>;
  onCollectionBulkAdd?: (groupKey: string) => void;
  onCollectionBulkRemove?: (groupKey: string) => void;
  onAddSource?: (sourceId: number) => void;
  onRemoveSource?: (sourceId: number) => void;
  onBulkSources?: (body: unknown) => void;
  onRename?: (body: unknown) => void;
  onDeleteSet?: () => void;
}

function stubFetch(config: StubConfig) {
  const collections = config.collections ?? [];
  const itemsByCollection = config.itemsByCollection ?? {};

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

    // Phase 4L taxonomy correction — a groupKey may be a plain numeric id
    // (persisted collection) or a URL-encoded "derived:..." key; both are
    // one opaque path segment, so this matches either and decodes it.
    const collectionBulkMatch = url.match(/\/synthesis-sets\/1\/collections\/([^/?]+)$/);
    if (collectionBulkMatch && init?.method === "POST") {
      const groupKey = decodeURIComponent(collectionBulkMatch[1]);
      config.onCollectionBulkAdd?.(groupKey);
      return jsonResponse(200, { collectionId: groupKey, eligibleCount: 1, alreadySelectedCount: 0, addedCount: 1, ineligibleCount: 0 });
    }
    if (collectionBulkMatch && init?.method === "DELETE") {
      const groupKey = decodeURIComponent(collectionBulkMatch[1]);
      config.onCollectionBulkRemove?.(groupKey);
      return jsonResponse(200, { collectionId: groupKey, removedCount: 1 });
    }

    const collectionItemsMatch = url.match(/\/collections\/([^/?]+)(\?|$)/);
    if (collectionItemsMatch && (!init || init.method === undefined)) {
      const groupKey = decodeURIComponent(collectionItemsMatch[1]);
      const collection = collections.find((c) => c.groupKey === groupKey);
      const items = itemsByCollection[groupKey] ?? [];
      return jsonResponse(200, { collection, items, pagination: { limit: 200, offset: 0, totalCount: items.length } });
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

describe("SynthesisSetDetailPage — collection-centric selection (Phase 4L taxonomy correction)", () => {
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

  it("renders a persisted collection row with its PROVIDER · TYPE label and 'N/M eligible selected' summary, counting only the eligible members", async () => {
    stubFetch({
      set: makeSet(),
      collections: [COLLECTION],
      itemsByCollection: { "10": [COLLECTION_ITEM_ELIGIBLE, COLLECTION_ITEM_INELIGIBLE] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("YOUTUBE · CHANNEL")).toBeInTheDocument());
    expect(screen.getByText("YouTube · SMB Capital")).toBeInTheDocument();
    expect(screen.getByText("0/1 eligible selected · 1 available to add")).toBeInTheDocument();
  });

  it("renders a DERIVED group row (e.g. manual YouTube à-la-carte) using the SAME unified group list and labels as the Sources page", async () => {
    stubFetch({
      set: makeSet(),
      collections: [DERIVED_ALA_CARTE],
      itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("YOUTUBE · À-LA-CARTE")).toBeInTheDocument());
    expect(screen.getByText("Manual YouTube")).toBeInTheDocument();
  });

  it("the collection checkbox is unchecked when zero eligible members are selected", async () => {
    stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { "10": [COLLECTION_ITEM_ELIGIBLE] } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital")).not.toBeChecked());
  });

  it("the collection checkbox is checked ('all') when every eligible member is already selected", async () => {
    stubFetch({
      set: makeSet({ sourceCount: 1, analyzedSourceCount: 1, sources: [{ ...COLLECTION_ITEM_ELIGIBLE, analyzed: true } as never] }),
      collections: [COLLECTION],
      itemsByCollection: { "10": [COLLECTION_ITEM_ELIGIBLE] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital")).toBeChecked());
  });

  it("the collection checkbox is indeterminate when only some eligible members are selected", async () => {
    const secondEligible = { ...COLLECTION_ITEM_ELIGIBLE, id: 203, title: "Second Eligible Video" };
    stubFetch({
      set: makeSet({ sourceCount: 1, sources: [{ ...COLLECTION_ITEM_ELIGIBLE, analyzed: true } as never] }),
      collections: [COLLECTION],
      itemsByCollection: { "10": [COLLECTION_ITEM_ELIGIBLE, secondEligible] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital")).toBeInTheDocument());
    const checkbox = screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital") as HTMLInputElement;
    await waitFor(() => expect(checkbox.indeterminate).toBe(true));
  });

  it("clicking an unchecked/partial collection checkbox bulk-selects the whole collection's currently-eligible sources, by groupKey", async () => {
    let addedGroupKey: string | undefined;
    stubFetch({
      set: makeSet(),
      collections: [COLLECTION],
      itemsByCollection: { "10": [COLLECTION_ITEM_ELIGIBLE] },
      onCollectionBulkAdd: (id) => (addedGroupKey = id),
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital"));
    await waitFor(() => expect(addedGroupKey).toBe("10"));
  });

  it("clicking a DERIVED group's unchecked checkbox bulk-selects using its derived groupKey", async () => {
    let addedGroupKey: string | undefined;
    stubFetch({
      set: makeSet(),
      collections: [DERIVED_ALA_CARTE],
      itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE] },
      onCollectionBulkAdd: (id) => (addedGroupKey = id),
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in Manual YouTube")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select all eligible sources in Manual YouTube"));
    await waitFor(() => expect(addedGroupKey).toBe("derived:youtube-ala-carte"));
  });

  it("clicking an all-selected collection checkbox bulk-removes this set's selected sources for that collection", async () => {
    let removedGroupKey: string | undefined;
    stubFetch({
      set: makeSet({ sourceCount: 1, sources: [{ ...COLLECTION_ITEM_ELIGIBLE, analyzed: true } as never] }),
      collections: [COLLECTION],
      itemsByCollection: { "10": [COLLECTION_ITEM_ELIGIBLE] },
      onCollectionBulkRemove: (id) => (removedGroupKey = id),
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital")).toBeChecked());
    fireEvent.click(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital"));
    await waitFor(() => expect(removedGroupKey).toBe("10"));
  });

  it("a collection with zero eligible members has a disabled checkbox — nothing to select", async () => {
    stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { "10": [COLLECTION_ITEM_INELIGIBLE] } });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital")).toBeDisabled());
  });

  it("Fine Tune Sources is collapsed by default; toggling it reveals the flat, filterable source list, which includes DERIVED group members too", async () => {
    stubFetch({ set: makeSet(), collections: [DERIVED_ALA_CARTE], itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE] } });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "Fine Tune Sources" })).toBeInTheDocument());
    expect(screen.queryByLabelText(/Uncollected Eligible Video/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fine Tune Sources" }));
    await waitFor(() => expect(screen.getByLabelText(/Uncollected Eligible Video/)).toBeInTheDocument());
  });

  it("fine-tune: checking an eligible derived-group source calls POST .../sources with its id and never touches the analyze endpoint", async () => {
    let addedId: number | undefined;
    const fetchMock = stubFetch({
      set: makeSet(),
      collections: [DERIVED_ALA_CARTE],
      itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE] },
      onAddSource: (id) => (addedId = id),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    fireEvent.click(await screen.findByLabelText(/Uncollected Eligible Video/));

    await waitFor(() => expect(addedId).toBe(301));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analyze"))).toBe(false);
  });

  it("fine-tune: unchecking a selected source calls DELETE .../sources/:sourceId and never touches its analysis", async () => {
    let removedId: number | undefined;
    stubFetch({
      set: makeSet({ sourceCount: 1, sources: [{ ...ALA_CARTE_ITEM_ELIGIBLE, analyzed: true } as never] }),
      collections: [DERIVED_ALA_CARTE],
      itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE] },
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
    const ineligible = { ...ALA_CARTE_ITEM_ELIGIBLE, status: "NOT_ANALYZED" as const, eligibleForSynthesis: false };
    stubFetch({ set: makeSet(), collections: [DERIVED_ALA_CARTE], itemsByCollection: { "derived:youtube-ala-carte": [ineligible] } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    expect(await screen.findByLabelText(/Uncollected Eligible Video/)).toBeDisabled();
  });

  it("fine-tune: search filters the list by title", async () => {
    const other = { ...ALA_CARTE_ITEM_ELIGIBLE, id: 302, title: "Completely Different Topic" };
    stubFetch({ set: makeSet(), collections: [DERIVED_ALA_CARTE], itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE, other] } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    await screen.findByText("Uncollected Eligible Video");
    fireEvent.change(screen.getByLabelText("Search sources"), { target: { value: "Different" } });
    await waitFor(() => expect(screen.queryByText("Uncollected Eligible Video")).not.toBeInTheDocument());
    expect(screen.getByText("Completely Different Topic")).toBeInTheDocument();
  });

  it("fine-tune: the 'Eligible' selection filter hides not-yet-eligible sources", async () => {
    const ineligible = { ...ALA_CARTE_ITEM_ELIGIBLE, id: 302, title: "Not Eligible Video", status: "NOT_ANALYZED" as const, eligibleForSynthesis: false };
    stubFetch({ set: makeSet(), collections: [DERIVED_ALA_CARTE], itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE, ineligible] } });
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
      collections: [COLLECTION, DERIVED_ALA_CARTE],
      itemsByCollection: { "10": [COLLECTION_ITEM_ELIGIBLE], "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE] },
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
    const secondEligible = { ...ALA_CARTE_ITEM_ELIGIBLE, id: 302, title: "Second Uncollected Video" };
    stubFetch({
      set: makeSet(),
      collections: [DERIVED_ALA_CARTE],
      itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE, secondEligible] },
      onBulkSources: (body) => (bulkBody = body),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    await screen.findByText("Second Uncollected Video");

    fireEvent.click(screen.getByRole("button", { name: "Select All Visible Eligible" }));
    await waitFor(() => expect(bulkBody).toEqual({ add: [301, 302] }));
  });

  it("fine-tune: filtering to YouTube and clicking 'Deselect All Visible' never touches a hidden UNCLASSIFIED Discord row's selection", async () => {
    let bulkBody: unknown;
    stubFetch({
      set: makeSet({ sourceCount: 2, sources: [{ ...ALA_CARTE_ITEM_ELIGIBLE, analyzed: true } as never, { ...UNCLASSIFIED_DISCORD_ITEM, analyzed: true } as never] }),
      collections: [DERIVED_ALA_CARTE, DERIVED_UNCLASSIFIED],
      itemsByCollection: { "derived:youtube-ala-carte": [ALA_CARTE_ITEM_ELIGIBLE], "derived:unclassified": [UNCLASSIFIED_DISCORD_ITEM] },
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
      itemsByCollection: { "10": [COLLECTION_ITEM_ELIGIBLE] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Select all eligible sources in YouTube · SMB Capital"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(2));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/analyze"))).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/run"))).toBe(false);
  });
});

describe("SynthesisSetDetailPage — Fine-Tune provenance display (Phase 4L follow-up)", () => {
  it("a collection-member Discord-origin YouTube row shows its channel and posted date, same rules as Sources/Collection Detail", async () => {
    const withOrigin: CatalogItemSummary = {
      ...COLLECTION_ITEM_ELIGIBLE,
      origins: [
        { originType: "DISCORD_CHANNEL", discordGuildId: "g1", discordChannelId: "c1", discordChannelName: "scarface-alerts", discordMessageId: "m1", discordMessageUrl: null, discordPostedAt: "2026-09-12T00:00:00.000Z" },
      ],
    };
    stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { "10": [withOrigin] } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    expect(await screen.findByText("Source: Discord · #scarface-alerts")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
  });

  it("a Manual-only collection-member row shows 'Source: Manual'", async () => {
    const manual: CatalogItemSummary = {
      ...COLLECTION_ITEM_ELIGIBLE,
      origins: [{ originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null }],
    };
    stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { "10": [manual] } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    expect(await screen.findByText("Source: Manual")).toBeInTheDocument();
  });

  it("a Manual + Discord mixed-origin row renders the combined summary", async () => {
    const mixed: CatalogItemSummary = {
      ...COLLECTION_ITEM_ELIGIBLE,
      origins: [
        { originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null },
        { originType: "DISCORD_CHANNEL", discordGuildId: "g1", discordChannelId: "c1", discordChannelName: "scarface-alerts", discordMessageId: "m1", discordMessageUrl: null, discordPostedAt: "2026-09-12T00:00:00.000Z" },
      ],
    };
    stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { "10": [mixed] } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    expect(await screen.findByText("Source: Manual + Discord · #scarface-alerts")).toBeInTheDocument();
    expect(screen.getByText("Posted: Sep 12, 2026")).toBeInTheDocument();
  });

  it("multiple Discord origins on a collection-member row follow the same compact-count + latest-posted-date rules", async () => {
    const multi: CatalogItemSummary = {
      ...COLLECTION_ITEM_ELIGIBLE,
      origins: [
        { originType: "DISCORD_CHANNEL", discordGuildId: "g1", discordChannelId: "c1", discordChannelName: "pre-market-live", discordMessageId: "m1", discordMessageUrl: null, discordPostedAt: "2026-09-12T00:00:00.000Z" },
        { originType: "DISCORD_CHANNEL", discordGuildId: "g1", discordChannelId: "c2", discordChannelName: "trade-ideas", discordMessageId: "m2", discordMessageUrl: null, discordPostedAt: "2026-09-13T00:00:00.000Z" },
      ],
    };
    stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { "10": [multi] } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    expect(await screen.findByText("Source: 2 Discord posts")).toBeInTheDocument();
    expect(screen.getByText("Latest posted: Sep 13, 2026")).toBeInTheDocument();
  });

  it("a derived-group YouTube source's own provenance renders in Fine-Tune too", async () => {
    const withOrigin = {
      ...ALA_CARTE_ITEM_ELIGIBLE,
      origins: [{ originType: "MANUAL" as const, discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null }],
    };
    stubFetch({ set: makeSet(), collections: [DERIVED_ALA_CARTE], itemsByCollection: { "derived:youtube-ala-carte": [withOrigin] } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    expect(await screen.findByText("Source: Manual")).toBeInTheDocument();
  });

  it("loading a collection's fine-tune provenance costs exactly ONE extra request per collection, never one per item", async () => {
    const items: CatalogItemSummary[] = Array.from({ length: 5 }, (_, i) => ({
      ...COLLECTION_ITEM_ELIGIBLE,
      id: 210 + i,
      title: `Video ${i}`,
      origins: [{ originType: "MANUAL", discordGuildId: null, discordChannelId: null, discordChannelName: null, discordMessageId: null, discordMessageUrl: null, discordPostedAt: null }],
    }));
    const fetchMock = stubFetch({ set: makeSet(), collections: [COLLECTION], itemsByCollection: { "10": items } });
    renderPage();
    await waitFor(() => expect(screen.getByText("YouTube · SMB Capital")).toBeInTheDocument());

    const collectionItemsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/collections/10"));
    expect(collectionItemsCalls).toHaveLength(1); // one GET for the whole collection's items+origins, not five
  });
});

describe("SynthesisSetDetailPage — GENERAL_KNOWLEDGE gating (Phase 4L follow-up)", () => {
  it("direct navigation to a set's detail URL shows 'Coming Soon' instead of the editor, and never calls the synthesis-set API at all", async () => {
    const gkProject = { ...PROJECT, projectType: "GENERAL_KNOWLEDGE" };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [gkProject] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await waitFor(() => expect(screen.getByText(/Synthesis Sets aren.t available for General Knowledge projects yet\./)).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/synthesis-sets/1"))).toBe(false);
  });
});

/**
 * Phase 4L live-bug regression — "Fine Tune Sources is empty" was reported
 * for a derived YOUTUBE · CHANNEL group discovered via a Discord channel
 * scan (`derived:youtube-discord-channel:<container>`), a group shape none
 * of the tests above ever exercised (they only ever used
 * `derived:youtube-ala-carte` / `derived:unclassified`). Unlike stubFetch
 * above, this mock is STATEFUL — it tracks real Synthesis Set membership
 * across requests — so it can drive the full bulk-select → fine-tune →
 * deselect → reselect journey end to end, the same journey the live report
 * walked through, rather than asserting on isolated static snapshots.
 */
describe("SynthesisSetDetailPage — Fine Tune with a derived Discord-channel CHANNEL group (Phase 4L live-bug regression)", () => {
  const DISCORD_CHANNEL_GROUP: CatalogCollectionSummary = {
    groupKey: "derived:youtube-discord-channel:g1:c1",
    kind: "DERIVED",
    id: null,
    provider: "YOUTUBE",
    sourceType: "CHANNEL",
    originProvider: "DISCORD",
    originContainerId: "c1",
    externalId: null,
    title: "Discord · #scarface-alerts",
    sourceUrl: null,
    status: null,
    sanitizedError: null,
    lastSyncedAt: null,
    itemCount: 3,
    analyzedCount: 3,
    hasMoreHistory: false,
  };

  const PERSISTED_YOUTUBE_CHANNEL: CatalogCollectionSummary = { ...COLLECTION, groupKey: "10", itemCount: 3, analyzedCount: 3 };

  function makeItems(ids: number[]): CatalogItemSummary[] {
    return ids.map((id) => ({
      id,
      provider: "YOUTUBE",
      externalId: `vid${id}`,
      title: `YouTube URL ${id}`,
      sourceUrl: `https://www.youtube.com/watch?v=vid${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "ANALYZED",
      eligibleForSynthesis: true,
      origins: [
        {
          originType: "DISCORD_CHANNEL",
          discordGuildId: "g1",
          discordChannelId: "c1",
          discordChannelName: "scarface-alerts",
          discordMessageId: `m${id}`,
          discordMessageUrl: null,
          discordPostedAt: "2026-09-12T00:00:00.000Z",
        },
      ],
    }));
  }

  /** A real backend, unlike stubFetch above, actually reflects membership changes on the next read — this mock does too, so the tri-state journey (deselect → partial → reselect → full) can be exercised exactly as a user would experience it. */
  function stubStatefulFetch(collection: CatalogCollectionSummary, items: CatalogItemSummary[]) {
    let memberIds: number[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/synthesis-sets/1") && (!init || init.method === undefined)) {
        const analyzedCount = memberIds.length;
        return jsonResponse(200, {
          ...makeSet(),
          sourceCount: memberIds.length,
          analyzedSourceCount: analyzedCount,
          needsAnalysisCount: 0,
          sources: memberIds.map((id) => ({ id, analyzed: true })),
        });
      }
      if (url.endsWith("/collections") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, collections: [collection] });
      if (url.includes(`/collections/${encodeURIComponent(collection.groupKey)}`) && (!init || init.method === undefined)) {
        return jsonResponse(200, { collection, items, pagination: { limit: 200, offset: 0, totalCount: items.length } });
      }
      const collectionBulkMatch = url.match(/\/synthesis-sets\/1\/collections\/([^/?]+)$/);
      if (collectionBulkMatch && init?.method === "POST") {
        memberIds = items.filter((i) => i.eligibleForSynthesis).map((i) => i.id);
        return jsonResponse(200, { collectionId: collection.groupKey, eligibleCount: memberIds.length, alreadySelectedCount: 0, addedCount: memberIds.length, ineligibleCount: 0 });
      }
      if (collectionBulkMatch && init?.method === "DELETE") {
        memberIds = [];
        return jsonResponse(200, { collectionId: collection.groupKey, removedCount: 0 });
      }
      if (url.endsWith("/synthesis-sets/1/sources") && init?.method === "POST") {
        const sourceId = JSON.parse(init.body as string).sourceId as number;
        if (!memberIds.includes(sourceId)) memberIds = [...memberIds, sourceId];
        return jsonResponse(201, { synthesisSetId: 1, sourceId, added: true });
      }
      const removeMatch = url.match(/\/synthesis-sets\/1\/sources\/(\d+)$/);
      if (removeMatch && init?.method === "DELETE") {
        memberIds = memberIds.filter((id) => id !== Number(removeMatch[1]));
        return new Response(null, { status: 204 });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function runFullTriStateJourney(collection: CatalogCollectionSummary, originLine: string) {
    const items = makeItems([401, 402, 403]);
    stubStatefulFetch(collection, items);
    renderPage();

    // 1/2/3: renders the group with 3 eligible sources, all initially unselected.
    await waitFor(() => expect(screen.getByText("0/3 eligible selected · 3 available to add")).toBeInTheDocument());

    // bulk-select the whole group (this is the exact click the live report performed).
    fireEvent.click(screen.getByLabelText(`Select all eligible sources in ${originLine}`));
    await waitFor(() => expect(screen.getByText("3/3 eligible selected")).toBeInTheDocument());
    expect(screen.getByText("3 selected · 3 analyzed · 0 needs analysis")).toBeInTheDocument();

    // 3/4/5: Fine Tune shows all 3 rows, all checked, with provenance — never empty.
    fireEvent.click(screen.getByRole("button", { name: "Fine Tune Sources" }));
    await waitFor(() => expect(screen.getByText("YouTube URL 401")).toBeInTheDocument());
    expect(screen.getByText("YouTube URL 402")).toBeInTheDocument();
    expect(screen.getByText("YouTube URL 403")).toBeInTheDocument();
    expect(screen.getByLabelText("Include YouTube URL 401 in Scalping Playbook")).toBeChecked();
    expect(screen.getByLabelText("Include YouTube URL 402 in Scalping Playbook")).toBeChecked();
    expect(screen.getByLabelText("Include YouTube URL 403 in Scalping Playbook")).toBeChecked();
    expect(screen.getAllByText("Source: Discord · #scarface-alerts")).toHaveLength(3);

    // 13: an ineligible row (added below by the caller) must never be checkable — verified per-collection-kind by the caller when present.

    // 6/8/9: deselecting one Fine-Tune row drops the top summary and the collection count, keeps the others selected.
    fireEvent.click(screen.getByLabelText("Include YouTube URL 401 in Scalping Playbook"));
    await waitFor(() => expect(screen.getByText("2 selected · 2 analyzed · 0 needs analysis")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("2/3 eligible selected · 1 available to add")).toBeInTheDocument());
    expect(screen.getByLabelText("Include YouTube URL 401 in Scalping Playbook")).not.toBeChecked();
    expect(screen.getByLabelText("Include YouTube URL 402 in Scalping Playbook")).toBeChecked();
    expect(screen.getByLabelText("Include YouTube URL 403 in Scalping Playbook")).toBeChecked();

    // 7: the collection row itself goes indeterminate (partial), not fully checked.
    const collectionCheckbox = screen.getByLabelText(`Select all eligible sources in ${originLine}`) as HTMLInputElement;
    await waitFor(() => expect(collectionCheckbox.indeterminate).toBe(true));

    // 10: reselecting the same row returns everything to fully selected.
    fireEvent.click(screen.getByLabelText("Include YouTube URL 401 in Scalping Playbook"));
    await waitFor(() => expect(screen.getByText("3/3 eligible selected")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("3 selected · 3 analyzed · 0 needs analysis")).toBeInTheDocument());
    expect(screen.getByLabelText("Include YouTube URL 401 in Scalping Playbook")).toBeChecked();
  }

  it("1-10: the full bulk-select → Fine-Tune → deselect → reselect journey works for a derived Discord-channel CHANNEL group (never an empty list)", async () => {
    await runFullTriStateJourney(DISCORD_CHANNEL_GROUP, "Discord · #scarface-alerts");
  });

  it("11: the same full journey works identically for a real PERSISTED YouTube-channel collection", async () => {
    await runFullTriStateJourney(PERSISTED_YOUTUBE_CHANNEL, "YouTube · SMB Capital");
  });

  it("12: a source is never duplicated in Fine Tune across two different groups in the same project", async () => {
    const otherGroup: CatalogCollectionSummary = { ...DERIVED_ALA_CARTE, groupKey: "derived:youtube-ala-carte" };
    const channelItems = makeItems([501, 502]);
    const alaCarteItems = [ALA_CARTE_ITEM_ELIGIBLE];
    stubFetch({
      set: makeSet(),
      collections: [DISCORD_CHANNEL_GROUP, otherGroup],
      itemsByCollection: { "derived:youtube-discord-channel:g1:c1": channelItems, "derived:youtube-ala-carte": alaCarteItems },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    await screen.findByText("YouTube URL 501");
    expect(screen.getAllByText("YouTube URL 501")).toHaveLength(1);
    expect(screen.getAllByText("YouTube URL 502")).toHaveLength(1);
    expect(screen.getAllByText("Uncollected Eligible Video")).toHaveLength(1);
  });

  it("13: a not-yet-analyzed (ineligible) source inside a derived CHANNEL group is rendered but never selectable", async () => {
    const ineligible = { ...makeItems([601])[0], status: "NOT_ANALYZED" as const, eligibleForSynthesis: false };
    stubFetch({
      set: makeSet(),
      collections: [DISCORD_CHANNEL_GROUP],
      itemsByCollection: { "derived:youtube-discord-channel:g1:c1": [ineligible] },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Fine Tune Sources" }));
    expect(await screen.findByLabelText("Include YouTube URL 601 in Scalping Playbook")).toBeDisabled();
    expect(screen.getByLabelText("Select all eligible sources in Discord · #scarface-alerts")).toBeDisabled();
  });
});
