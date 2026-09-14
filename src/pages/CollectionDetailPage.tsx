import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectSourceAnalysisDrawer } from "../components/ProjectSourceAnalysisDrawer";
import { ProvenanceLine } from "../components/ProvenanceLine";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { AddToProjectDialog } from "../components/AddToProjectDialog";
import { useResolvedProject } from "../lib/useResolvedProject";
import {
  getSourceCollection,
  refreshSourceCollection,
  deleteSourceCollection,
  CatalogApiError,
  batchAnalyzeProjectSources,
  analyzeCollection,
  catalogGroupTypeLabel,
  catalogGroupOriginLine,
  type CatalogCollectionSummary,
  type CatalogItemSummary,
  type AnalyzeCollectionResult,
} from "../lib/catalogApi";
import {
  analyzeProjectSource,
  getProjectSourceAnalysis,
  retryProjectSourceAnalysis,
  ProjectSourceAnalysisError,
  type ProjectSourceAnalysisStatus,
} from "../lib/projectSourceAnalysisApi";
import type { YouTubeProjectSource, DiscordProjectSource } from "../lib/sourcesApi";

export interface CollectionDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; collection: CatalogCollectionSummary; items: CatalogItemSummary[] }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

const STATUS_LABELS: Record<CatalogItemSummary["status"], string> = {
  NOT_ANALYZED: "Not analyzed",
  QUEUED: "Queued",
  ANALYZING: "Analyzing",
  VALIDATING: "Validating",
  ANALYZED: "Analyzed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};
const PENDING_STATUSES = new Set<CatalogItemSummary["status"]>(["QUEUED", "ANALYZING", "VALIDATING"]);

/**
 * "/projects/:projectId/collections/:collectionId" — Phase 4K, extended in
 * the Phase 4L taxonomy correction to also cover DERIVED groups (see
 * derivedSourceGroupsRepo.ts and CatalogCollectionSummary's doc comment):
 * a real persisted YouTube/Discord channel collection, or a group computed
 * purely from provenance (e.g. YouTube videos discovered by scanning a
 * Discord channel, or genuinely manual à-la-carte YouTube adds). Both
 * kinds render through this exact same page — checkbox selection +
 * explicit "Analyze Selected" (never automatic — see the Phase 4K spec's
 * core invariants), individual Analyze/View/Retry per item reusing the
 * exact same project-source-analysis endpoints and
 * ProjectSourceAnalysisDrawer SourcesPage already uses. Refresh/Remove
 * only ever apply to a PERSISTED collection — a derived group has no row
 * to refresh or delete; it simply reflects whatever the sources' real
 * provenance currently is.
 */
export function CollectionDetailPage({ backendUrl, knoveraToken }: CollectionDetailPageProps) {
  const navigate = useNavigate();
  const { collectionId: groupKeyParam } = useParams<{ collectionId: string }>();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewingSourceId, setViewingSourceId] = useState<number | null>(null);
  const [viewingStatus, setViewingStatus] = useState<ProjectSourceAnalysisStatus | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [addToProjectItem, setAddToProjectItem] = useState<CatalogItemSummary | null>(null);
  const [analyzeCollectionResult, setAnalyzeCollectionResult] = useState<AnalyzeCollectionResult | null>(null);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;
  const groupKey = groupKeyParam ?? "";
  // Live-validation Fix 3 — the backend rejects Analyze for any project
  // whose type isn't TRADING_STRATEGIES (see
  // projectSourceAnalysis.ts's own guard: "Analysis is only available for
  // Trading Strategies projects right now"), because the worker still runs
  // trading-specific extraction prompts. A GENERAL_KNOWLEDGE collection
  // (e.g. Discord Knowledge) must never show an Analyze/Retry/Re-analyze
  // control that would inevitably 400 — mirrors SourcesPage's own
  // isTradingStrategies gate exactly, so the two pages stay consistent.
  const isTradingStrategies = projectState.phase === "resolved" && projectState.project.projectType === "TRADING_STRATEGIES";

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const result = await getSourceCollection(url, token, projectId, groupKey, { limit: 200 });
      if (!cancelledRef.current) setState({ phase: "loaded", collection: result.collection, items: result.items });
    } catch (err) {
      if (cancelledRef.current) return;
      if (err instanceof CatalogApiError && err.type === "collection_not_found") {
        setState({ phase: "not_found" });
      } else {
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load collection." });
      }
    }
  }

  useEffect(() => {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || groupKey.length === 0) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, resolvedProjectId, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, groupKey]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) void load(backendUrl, knoveraToken, resolvedProjectId, { current: false });
  }

  function toggleSelected(id: string | number) {
    setSelected((prev) => {
      const next = new Set(prev);
      const numId = Number(id);
      if (next.has(numId)) next.delete(numId);
      else next.add(numId);
      return next;
    });
  }

  function selectAllUnanalyzed() {
    if (state.phase !== "loaded") return;
    setSelected(new Set(state.items.filter((i) => i.status === "NOT_ANALYZED" || i.status === "FAILED").map((i) => i.id)));
  }

  /**
   * Phase 4L — "Analyze N Remaining." A real server-resolved batch op
   * (never a client-enumerated id list capped at 50 — see
   * catalogApi.analyzeCollection's doc comment), so this works regardless
   * of how many items the collection holds, not just the first page loaded
   * here. Never selects anything into a Synthesis Set.
   */
  async function handleAnalyzeCollection() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setBusy(true);
    setActionError(null);
    setAnalyzeCollectionResult(null);
    try {
      const result = await analyzeCollection(backendUrl, knoveraToken, resolvedProjectId, groupKey);
      setAnalyzeCollectionResult(result);
      refresh();
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to start analysis for this collection.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAnalyzeSelected() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || selected.size === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await batchAnalyzeProjectSources(backendUrl, knoveraToken, resolvedProjectId, [...selected]);
      setSelected(new Set());
      refresh();
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to start analysis.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAnalyzeOne(sourceId: number, force = false) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setBusy(true);
    setActionError(null);
    try {
      await analyzeProjectSource(backendUrl, knoveraToken, resolvedProjectId, sourceId, force);
      refresh();
    } catch (err) {
      setActionError(err instanceof ProjectSourceAnalysisError ? err.message : "Failed to start analysis.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryOne(sourceId: number) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setBusy(true);
    setActionError(null);
    try {
      await retryProjectSourceAnalysis(backendUrl, knoveraToken, resolvedProjectId, sourceId);
      refresh();
    } catch (err) {
      setActionError(err instanceof ProjectSourceAnalysisError ? err.message : "Failed to retry analysis.");
    } finally {
      setBusy(false);
    }
  }

  async function openView(sourceId: number) {
    setViewingSourceId(sourceId);
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    try {
      setViewingStatus(await getProjectSourceAnalysis(backendUrl, knoveraToken, resolvedProjectId, sourceId));
    } catch {
      setViewingStatus(null);
    }
  }

  /** Only ever called when state.collection.kind === "PERSISTED" (its `id` is then guaranteed non-null) — see the Refresh button's own guard below. A derived group has no row to refresh. */
  async function handleRefreshCollection() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded" || state.collection.id == null) return;
    setBusy(true);
    setActionError(null);
    try {
      await refreshSourceCollection(backendUrl, knoveraToken, resolvedProjectId, state.collection.id);
      refresh();
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to refresh collection.");
    } finally {
      setBusy(false);
    }
  }

  /** Only ever called when state.collection.kind === "PERSISTED" — see the Remove Collection button's own guard below. A derived group has no row to delete. */
  async function handleDeleteCollection() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded" || state.collection.id == null) return;
    setBusy(true);
    try {
      await deleteSourceCollection(backendUrl, knoveraToken, resolvedProjectId, state.collection.id);
      navigate(`/projects/${resolvedProjectId}/sources`);
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to remove collection.");
      setBusy(false);
    }
  }

  const remainingCount = state.phase === "loaded" ? state.items.filter((i) => i.status !== "ANALYZED").length : 0;

  const viewingItem = state.phase === "loaded" ? state.items.find((i) => i.id === viewingSourceId) : undefined;
  const viewingSourceForDrawer: YouTubeProjectSource | DiscordProjectSource | null = viewingItem
    ? {
        provider: viewingItem.provider,
        sourceType: "VIDEO",
        id: viewingItem.id,
        externalId: viewingItem.externalId,
        sourceUrl: viewingItem.sourceUrl,
        title: viewingItem.title,
        durationSeconds: null,
        status: "READY",
        createdAt: viewingItem.createdAt,
        collectionId: state.phase === "loaded" ? state.collection.id : null,
        origins: viewingItem.origins,
      }
    : null;

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      {state.phase === "loading" && <p className="knovera-sources-loading">Loading collection…</p>}

      {state.phase === "not_found" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>This collection doesn't exist, or currently has no sources.</p>
          {resolvedProjectId != null && (
            <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/sources`)}>
              ← Back to Sources
            </button>
          )}
        </div>
      )}

      {state.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{state.message}</p>
        </div>
      )}

      {state.phase === "loaded" && (
        <>
          <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/sources`)}>
            ← Sources
          </button>

          <div className="knovera-page-header">
            <div>
              <h2 className="knovera-section-title">{catalogGroupTypeLabel(state.collection)}</h2>
              <p className="knovera-project-card-source">
                {catalogGroupOriginLine(state.collection)} · {state.items.length} item{state.items.length === 1 ? "" : "s"} ·{" "}
                {state.collection.analyzedCount} analyzed
              </p>
            </div>
            {state.collection.kind === "PERSISTED" && (
              <div className="knovera-synthesis-set-detail-actions">
                {state.collection.provider === "YOUTUBE" && (
                  <button type="button" className="link-button" disabled={busy} onClick={() => void handleRefreshCollection()}>
                    {busy ? "Refreshing…" : "Refresh"}
                  </button>
                )}
                {confirmingDelete ? (
                  <>
                    <span className="hint">Remove this collection?</span>
                    <button type="button" className="link-button" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                      Cancel
                    </button>
                    <button type="button" className="link-button danger" onClick={() => void handleDeleteCollection()} disabled={busy}>
                      {busy ? "Removing…" : "Confirm Remove"}
                    </button>
                  </>
                ) : (
                  <button type="button" className="link-button danger" onClick={() => setConfirmingDelete(true)}>
                    Remove Collection
                  </button>
                )}
              </div>
            )}
          </div>
          {state.collection.kind === "PERSISTED" ? (
            <p className="hint">Removing a collection only removes the grouping — its items and their analyses are kept.</p>
          ) : (
            <p className="hint">This group is computed from each source's own provenance — there's no separate grouping to remove.</p>
          )}

          {actionError && (
            <div className="kv-card knovera-empty-state" role="alert">
              <p>{actionError}</p>
            </div>
          )}

          {/* Live-validation Fix 3 — never offered for a GENERAL_KNOWLEDGE
              collection (e.g. Discord Knowledge): there is nothing here
              that analysis would accept yet (see isTradingStrategies
              above), and checkbox selection exists only to feed this
              toolbar. */}
          {isTradingStrategies && (
            <>
              {remainingCount > 0 && (
                <div className="knovera-synthesis-set-detail-actions">
                  <button type="button" disabled={busy} onClick={() => void handleAnalyzeCollection()}>
                    {busy ? "Starting…" : `Analyze ${remainingCount} Remaining`}
                  </button>
                </div>
              )}
              {analyzeCollectionResult && (
                <p className="hint" role="status">
                  {analyzeCollectionResult.queued} queued · {analyzeCollectionResult.alreadyAnalyzed} already analyzed ·{" "}
                  {analyzeCollectionResult.alreadyQueued} already queued · {analyzeCollectionResult.processing} processing ·{" "}
                  {analyzeCollectionResult.failed} failed to queue
                </p>
              )}
              <div className="knovera-synthesis-set-detail-actions">
                <button type="button" className="link-button" onClick={selectAllUnanalyzed}>
                  Select All Unanalyzed
                </button>
                <button type="button" disabled={busy || selected.size === 0} onClick={() => void handleAnalyzeSelected()}>
                  {busy ? "Starting…" : `Analyze Selected (${selected.size})`}
                </button>
              </div>
            </>
          )}

          <ul className="knovera-youtube-source-list">
            {state.items.map((item) => {
              const isPending = PENDING_STATUSES.has(item.status);
              const isFailed = item.status === "FAILED";
              const isDone = item.status === "ANALYZED";
              const badgeClass = isFailed ? "kv-badge-danger" : isDone ? "kv-badge-accent" : "kv-badge-muted";
              const title = item.title ?? item.sourceUrl;
              return (
                <li key={item.id} className="kv-card knovera-youtube-source-row">
                  {isTradingStrategies ? (
                    <label className="knovera-synthesis-set-source-checkbox">
                      <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`Select ${title}`} />
                      <div className="knovera-youtube-source-main">
                        <span className="knovera-youtube-source-title">{title}</span>
                        {item.provider === "YOUTUBE" && <ProvenanceLine origins={item.origins} />}
                      </div>
                    </label>
                  ) : (
                    <div className="knovera-youtube-source-main">
                      <span className="knovera-youtube-source-title">{title}</span>
                      {item.provider === "YOUTUBE" && <ProvenanceLine origins={item.origins} />}
                    </div>
                  )}
                  <div className="knovera-youtube-source-actions">
                    <span className={`kv-badge ${badgeClass}`}>{STATUS_LABELS[item.status]}</span>
                    {isTradingStrategies && item.status === "NOT_ANALYZED" && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeOne(item.id)}>
                        Analyze
                      </button>
                    )}
                    {isTradingStrategies && isPending && <span className="hint">Working…</span>}
                    {isTradingStrategies && isFailed && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleRetryOne(item.id)}>
                        Retry
                      </button>
                    )}
                    {isTradingStrategies && isDone && (
                      <>
                        <button type="button" className="link-button" onClick={() => void openView(item.id)}>
                          View
                        </button>
                        <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeOne(item.id, true)}>
                          Re-analyze
                        </button>
                      </>
                    )}
                    {item.provider === "DISCORD" && (
                      <RowActionsMenu items={[{ label: "Add to Project…", onClick: () => setAddToProjectItem(item) }]} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <ProjectSourceAnalysisDrawer
        source={viewingSourceForDrawer}
        job={viewingStatus?.job ?? null}
        analysis={viewingStatus?.analysis ?? null}
        loading={false}
        onClose={() => setViewingSourceId(null)}
      />

      {addToProjectItem && backendUrl && knoveraToken && resolvedProjectId != null && (
        <AddToProjectDialog
          backendUrl={backendUrl}
          knoveraToken={knoveraToken}
          projectId={resolvedProjectId}
          sourceId={addToProjectItem.id}
          sourceTitle={addToProjectItem.title ?? addToProjectItem.sourceUrl}
          onClose={() => setAddToProjectItem(null)}
        />
      )}
    </div>
  );
}
