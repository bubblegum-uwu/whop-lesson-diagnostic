import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { ProvenanceLine } from "../components/ProvenanceLine";
import { useResolvedProject } from "../lib/useResolvedProject";
import { OPERATIONAL_PROJECT_TYPES } from "../lib/projects";
import { getProjectSources, type YouTubeProjectSource, type DiscordProjectSource, type ProjectSourceOriginSummary } from "../lib/sourcesApi";
import { getProjectSourceAnalysis } from "../lib/projectSourceAnalysisApi";
import { listSourceCollections, getSourceCollection, type CatalogCollectionSummary } from "../lib/catalogApi";
import {
  getSynthesisSet,
  updateSynthesisSet,
  deleteSynthesisSet,
  addSourceToSynthesisSet,
  removeSourceFromSynthesisSet,
  bulkAddCollectionToSynthesisSet,
  bulkRemoveCollectionFromSynthesisSet,
  bulkUpdateSynthesisSetSources,
  SynthesisSetError,
  type SynthesisSetDetail,
} from "../lib/synthesisSetsApi";

export interface SynthesisSetDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

/** One row in the fine-tune list — a collection member OR an uncollected source, unified into one shape for search/filter/select-visible. */
interface FineTuneRow {
  id: number;
  provider: "YOUTUBE" | "DISCORD";
  title: string;
  eligible: boolean;
  collectionTitle: string | null;
  /** Phase 4K-C provenance — always empty for DISCORD rows (provenance describes how a YOUTUBE video was found, never a Discord source's own identity). */
  origins: ProjectSourceOriginSummary[];
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | {
      phase: "loaded";
      set: SynthesisSetDetail;
      collections: CatalogCollectionSummary[];
      /** Every item of every collection, keyed by collection id — the source of both the tri-state rollups and the fine-tune list's collected rows. */
      itemsByCollection: Map<number, FineTuneRow[]>;
      uncollected: FineTuneRow[];
    }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

type SelectionFilter = "all" | "selected" | "not_selected" | "eligible";
type ProviderFilter = "all" | "YOUTUBE" | "DISCORD";

function readinessSummary(set: SynthesisSetDetail): string {
  return `${set.sourceCount} selected · ${set.analyzedSourceCount} analyzed · ${set.needsAnalysisCount} needs analysis`;
}

/** Tri-state checkbox — HTML has no `indeterminate` attribute, only a DOM property, so it's set imperatively via a ref. */
function TriStateCheckbox({ state, disabled, onChange, ariaLabel }: { state: "none" | "partial" | "all"; disabled: boolean; onChange: () => void; ariaLabel: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "partial";
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state === "all"} disabled={disabled} onChange={onChange} aria-label={ariaLabel} />;
}

async function loadFineTuneRowsForCollection(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  collectionId: number,
): Promise<FineTuneRow[]> {
  const detail = await getSourceCollection(backendUrl, knoveraToken, projectId, collectionId, { limit: 200 });
  return detail.items.map((item) => ({
    id: item.id,
    provider: item.provider,
    title: item.title ?? item.sourceUrl,
    eligible: item.eligibleForSynthesis,
    collectionTitle: detail.collection.title,
    origins: item.origins,
  }));
}

/**
 * Phase 4L — for uncollected (à-la-carte) sources there is no batched
 * "collection items" endpoint to read eligibility from, so this reuses the
 * per-source analysis-status read (GET .../sources/:id/analysis) — the
 * EXACT same call, and the same per-source loop shape, SourcesPage.tsx
 * already makes for every video source today. `analysis` there is only
 * ever a completed/no_strategy row (see projectSourceAnalysesRepo's
 * findLatestByFingerprint doc comment), so its mere presence already IS
 * the eligibility signal — never a second/different rule.
 */
async function loadFineTuneRowsForUncollected(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  sources: (YouTubeProjectSource | DiscordProjectSource)[],
): Promise<FineTuneRow[]> {
  return Promise.all(
    sources.map(async (source) => {
      let eligible = false;
      try {
        const status = await getProjectSourceAnalysis(backendUrl, knoveraToken, projectId, source.id);
        eligible = status.analysis != null;
      } catch {
        // Best-effort — a transient status-read failure leaves this source
        // showing as not-yet-eligible rather than surfacing a page-level error.
      }
      return {
        id: source.id,
        provider: source.provider,
        title: source.title ?? source.sourceUrl,
        eligible,
        collectionTitle: null,
        origins: source.provider === "YOUTUBE" ? source.origins : [],
      };
    }),
  );
}

/**
 * "/projects/:projectId/synthesis-sets/:setId" — Phase 4L. Collection
 * -centric Synthesis Set membership editor: a tri-state checklist for
 * selecting/deselecting a WHOLE collection's currently-eligible sources
 * (a one-time snapshot bulk action, never a live rule — see
 * synthesisSetsApi.bulkAddCollectionToSynthesisSet's doc comment), plus a
 * "Fine Tune Sources" flat, searchable/filterable list for toggling
 * individual sources (collected or uncollected) one at a time. Every
 * action here is membership only — it never analyzes anything, never
 * enqueues a job, never runs synthesis (Phase 4M's concern, not this
 * page's — see the Run History placeholder at the bottom).
 */
export function SynthesisSetDetailPage({ backendUrl, knoveraToken }: SynthesisSetDetailPageProps) {
  const navigate = useNavigate();
  const { setId: setIdParam } = useParams<{ setId: string }>();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [fineTuneOpen, setFineTuneOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectionFilter, setSelectionFilter] = useState<SelectionFilter>("all");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;
  const setId = setIdParam ? Number(setIdParam) : NaN;
  // Phase 4L follow-up — a GENERAL_KNOWLEDGE project can never have an
  // eligible source (see synthesisSets.ts's create-handler doc comment),
  // so this page must refuse direct-URL navigation too, not just hide the
  // nav tab — never fetch or render the set-editing UI for it.
  const isOperational = projectState.phase === "resolved" && OPERATIONAL_PROJECT_TYPES.has(projectState.project.projectType);
  const notOperational = projectState.phase === "resolved" && !isOperational;

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const [set, collections, sourcesResult] = await Promise.all([
        getSynthesisSet(url, token, projectId, setId),
        listSourceCollections(url, token, projectId),
        getProjectSources(url, token, projectId),
      ]);
      const itemsByCollection = new Map<number, FineTuneRow[]>();
      await Promise.all(
        collections.map(async (c) => {
          itemsByCollection.set(c.id, await loadFineTuneRowsForCollection(url, token, projectId, c.id));
        }),
      );
      const uncollectedSources = sourcesResult.sources.filter(
        (s): s is YouTubeProjectSource | DiscordProjectSource => (s.provider === "YOUTUBE" || s.provider === "DISCORD") && s.collectionId === null,
      );
      const uncollected = await loadFineTuneRowsForUncollected(url, token, projectId, uncollectedSources);
      if (!cancelledRef.current) setState({ phase: "loaded", set, collections, itemsByCollection, uncollected });
    } catch (err) {
      if (cancelledRef.current) return;
      if (err instanceof SynthesisSetError && err.type === "synthesis_set_not_found") {
        setState({ phase: "not_found" });
      } else {
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load synthesis set." });
      }
    }
  }

  useEffect(() => {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || !Number.isInteger(setId) || !isOperational) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, resolvedProjectId, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, setId, isOperational]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) {
      void load(backendUrl, knoveraToken, resolvedProjectId, { current: false });
    }
  }

  function startRename() {
    if (state.phase !== "loaded") return;
    setNameDraft(state.set.name);
    setDescriptionDraft(state.set.description ?? "");
    setRenameError(null);
    setRenaming(true);
  }

  async function saveRename() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    const trimmed = nameDraft.trim();
    if (trimmed.length === 0) {
      setRenameError("Name is required.");
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      await updateSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, {
        name: trimmed,
        description: descriptionDraft.trim() || null,
      });
      setRenaming(false);
      refresh();
    } catch (err) {
      setRenameError(err instanceof SynthesisSetError ? err.message : "Failed to save changes. Please try again.");
    } finally {
      setRenameSaving(false);
    }
  }

  async function handleDelete() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    setDeleting(true);
    try {
      await deleteSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id);
      navigate(`/projects/${resolvedProjectId}/synthesis-sets`);
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : "Failed to delete synthesis set.");
      setDeleting(false);
    }
  }

  async function toggleCollection(collection: CatalogCollectionSummary, currentState: "none" | "partial" | "all") {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    setMembershipError(null);
    setBusyKey(`collection:${collection.id}`);
    try {
      if (currentState === "all") {
        await bulkRemoveCollectionFromSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, collection.id);
      } else {
        await bulkAddCollectionToSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, collection.id);
      }
      refresh();
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : "Failed to update this collection's selection.");
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleSource(row: FineTuneRow, isMember: boolean) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    setMembershipError(null);
    setBusyKey(`source:${row.id}`);
    try {
      if (isMember) {
        await removeSourceFromSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, row.id);
      } else {
        await addSourceToSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, row.id);
      }
      refresh();
    } catch (err) {
      setMembershipError(err instanceof SynthesisSetError ? err.message : "Failed to update selection. Please try again.");
    } finally {
      setBusyKey(null);
    }
  }

  if (state.phase !== "loaded") {
    return (
      <div className="knovera-page">
        <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />
        {notOperational && (
          <div className="kv-card knovera-empty-state">
            <p>
              <span className="kv-badge kv-badge-muted">Coming Soon</span>
            </p>
            <p>Synthesis Sets aren&rsquo;t available for General Knowledge projects yet.</p>
          </div>
        )}
        {!notOperational && state.phase === "loading" && <p className="knovera-sources-loading">Loading synthesis set…</p>}
        {state.phase === "not_found" && (
          <div className="kv-card knovera-empty-state" role="alert">
            <p>This synthesis set doesn't exist.</p>
            {resolvedProjectId != null && (
              <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/synthesis-sets`)}>
                ← Back to Synthesis Sets
              </button>
            )}
          </div>
        )}
        {state.phase === "error" && (
          <div className="kv-card knovera-empty-state" role="alert">
            <p>{state.message}</p>
          </div>
        )}
      </div>
    );
  }

  const { set, collections, itemsByCollection, uncollected } = state;
  const memberIds = new Set(set.sources.map((s) => ("id" in s ? s.id : -1)));

  const allRows: FineTuneRow[] = [...collections.flatMap((c) => itemsByCollection.get(c.id) ?? []), ...uncollected];
  const visibleRows = allRows.filter((row) => {
    if (providerFilter !== "all" && row.provider !== providerFilter) return false;
    const isMember = memberIds.has(row.id);
    if (selectionFilter === "selected" && !isMember) return false;
    if (selectionFilter === "not_selected" && isMember) return false;
    if (selectionFilter === "eligible" && !row.eligible) return false;
    if (search.trim().length > 0 && !row.title.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  async function selectAllVisibleEligible() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    const ids = visibleRows.filter((r) => r.eligible && !memberIds.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    setBusyKey("bulk-select-visible");
    setMembershipError(null);
    try {
      await bulkUpdateSynthesisSetSources(backendUrl, knoveraToken, resolvedProjectId, set.id, { add: ids });
      refresh();
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : "Failed to select visible sources.");
    } finally {
      setBusyKey(null);
    }
  }

  async function deselectAllVisible() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    const ids = visibleRows.filter((r) => memberIds.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    setBusyKey("bulk-deselect-visible");
    setMembershipError(null);
    try {
      await bulkUpdateSynthesisSetSources(backendUrl, knoveraToken, resolvedProjectId, set.id, { remove: ids });
      refresh();
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : "Failed to deselect visible sources.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/synthesis-sets`)}>
        ← Synthesis Sets
      </button>

      {!renaming ? (
        <div className="knovera-page-header">
          <div>
            <h2 className="knovera-section-title">{set.name}</h2>
            <p className="knovera-project-card-source">{set.description || "No description"}</p>
          </div>
          <div className="knovera-synthesis-set-detail-actions">
            <button type="button" className="link-button" onClick={startRename}>
              Rename
            </button>
            {confirmingDelete ? (
              <>
                <span className="hint">Delete this set?</span>
                <button type="button" className="link-button" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                  Cancel
                </button>
                <button type="button" className="link-button danger" onClick={() => void handleDelete()} disabled={deleting}>
                  {deleting ? "Deleting…" : "Confirm Delete"}
                </button>
              </>
            ) : (
              <button type="button" className="link-button danger" onClick={() => setConfirmingDelete(true)}>
                Delete Set
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="kv-card knovera-synthesis-set-rename-form">
          <label htmlFor="rename-synthesis-set-name">Name</label>
          <input
            id="rename-synthesis-set-name"
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            disabled={renameSaving}
            autoFocus
            autoComplete="off"
          />
          <label htmlFor="rename-synthesis-set-description">Description (optional)</label>
          <input
            id="rename-synthesis-set-description"
            type="text"
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            disabled={renameSaving}
            autoComplete="off"
          />
          {renameError && (
            <p className="knovera-field-error" role="alert">
              {renameError}
            </p>
          )}
          <div className="knovera-dialog-actions">
            <button type="button" className="link-button" onClick={() => setRenaming(false)} disabled={renameSaving}>
              Cancel
            </button>
            <button type="button" onClick={() => void saveRename()} disabled={renameSaving || nameDraft.trim().length === 0}>
              {renameSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      <p className="hint" aria-label="Readiness summary">
        {readinessSummary(set)}
      </p>

      {membershipError && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{membershipError}</p>
        </div>
      )}

      <h2 className="knovera-section-title">Collections</h2>
      {collections.length === 0 ? (
        <div className="kv-card knovera-empty-state">
          <p>No collections in this project yet.</p>
          <p>Add a YouTube channel or import a Discord channel on the Sources page, then come back here to select them.</p>
        </div>
      ) : (
        <ul className="knovera-youtube-source-list">
          {collections.map((collection) => {
            const items = itemsByCollection.get(collection.id) ?? [];
            const eligibleIds = items.filter((i) => i.eligible).map((i) => i.id);
            const selectedEligibleCount = eligibleIds.filter((id) => memberIds.has(id)).length;
            const triState: "none" | "partial" | "all" =
              eligibleIds.length === 0 || selectedEligibleCount === 0 ? "none" : selectedEligibleCount === eligibleIds.length ? "all" : "partial";
            const availableToAdd = eligibleIds.length - selectedEligibleCount;
            const busy = busyKey === `collection:${collection.id}`;
            return (
              <li key={collection.id} className="kv-card knovera-youtube-source-row">
                <label className="knovera-synthesis-set-source-checkbox">
                  <TriStateCheckbox
                    state={triState}
                    disabled={busy || eligibleIds.length === 0}
                    onChange={() => void toggleCollection(collection, triState)}
                    ariaLabel={`Select all eligible sources in ${collection.title}`}
                  />
                  <div className="knovera-youtube-source-main">
                    <span className="knovera-youtube-source-label">{collection.provider === "YOUTUBE" ? "YouTube Channel" : "Discord Collection"}</span>
                    <span className="knovera-youtube-source-title">{collection.title}</span>
                  </div>
                </label>
                <div className="knovera-youtube-source-actions">
                  <span className="hint">
                    {selectedEligibleCount}/{eligibleIds.length} eligible selected
                    {availableToAdd > 0 ? ` · ${availableToAdd} available to add` : ""}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="knovera-synthesis-set-detail-actions">
        <button type="button" className="link-button" onClick={() => setFineTuneOpen((v) => !v)}>
          {fineTuneOpen ? "Hide Fine Tune Sources" : "Fine Tune Sources"}
        </button>
      </div>

      {fineTuneOpen && (
        <div className="kv-card knovera-synthesis-set-fine-tune">
          <div className="knovera-synthesis-set-fine-tune-filters">
            <input
              type="text"
              placeholder="Search sources…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search sources"
              autoComplete="off"
            />
            <select value={selectionFilter} onChange={(e) => setSelectionFilter(e.target.value as SelectionFilter)} aria-label="Filter by selection">
              <option value="all">All</option>
              <option value="selected">Selected</option>
              <option value="not_selected">Not Selected</option>
              <option value="eligible">Analyzed / Eligible</option>
            </select>
            <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value as ProviderFilter)} aria-label="Filter by provider">
              <option value="all">All Providers</option>
              <option value="YOUTUBE">YouTube</option>
              <option value="DISCORD">Discord</option>
            </select>
          </div>
          <div className="knovera-synthesis-set-detail-actions">
            <button type="button" className="link-button" disabled={busyKey === "bulk-select-visible"} onClick={() => void selectAllVisibleEligible()}>
              Select All Visible Eligible
            </button>
            <button type="button" className="link-button" disabled={busyKey === "bulk-deselect-visible"} onClick={() => void deselectAllVisible()}>
              Deselect All Visible
            </button>
          </div>

          {visibleRows.length === 0 ? (
            <p className="hint">No sources match the current search/filter.</p>
          ) : (
            <ul className="knovera-youtube-source-list">
              {visibleRows.map((row) => {
                const isMember = memberIds.has(row.id);
                const busy = busyKey === `source:${row.id}`;
                return (
                  <li key={row.id} className="kv-card knovera-youtube-source-row">
                    <label className="knovera-synthesis-set-source-checkbox">
                      <input
                        type="checkbox"
                        checked={isMember}
                        disabled={busy || !row.eligible}
                        onChange={() => void toggleSource(row, isMember)}
                        aria-label={`Include ${row.title} in ${set.name}`}
                      />
                      <div className="knovera-youtube-source-main">
                        <span className="knovera-youtube-source-label">{row.collectionTitle ?? "Uncollected"}</span>
                        <span className="knovera-youtube-source-title">{row.title}</span>
                        {row.provider === "YOUTUBE" && <ProvenanceLine origins={row.origins} />}
                      </div>
                    </label>
                    <div className="knovera-youtube-source-actions">
                      <span className={`kv-badge ${row.eligible ? "kv-badge-accent" : "kv-badge-muted"}`}>{row.eligible ? "Eligible" : "Not eligible"}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <h2 className="knovera-section-title">Run History</h2>
      <div className="kv-card knovera-empty-state">
        <p>Coming in Phase 4M.</p>
        <p>Executing this set into an immutable, versioned synthesis run isn't available yet — this page only manages which sources are selected.</p>
      </div>
    </div>
  );
}
