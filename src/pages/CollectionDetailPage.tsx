import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectSourceAnalysisDrawer } from "../components/ProjectSourceAnalysisDrawer";
import { useResolvedProject } from "../lib/useResolvedProject";
import {
  getSourceCollection,
  refreshSourceCollection,
  deleteSourceCollection,
  CatalogApiError,
  batchAnalyzeProjectSources,
  type CatalogCollectionSummary,
  type CatalogItemSummary,
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
 * "/projects/:projectId/collections/:collectionId" — Phase 4K. A YouTube
 * channel's (or, if ever populated, a Discord collection's) discovered
 * items: checkbox selection + explicit "Analyze Selected" (never
 * automatic — see the Phase 4K spec's core invariants), individual
 * Analyze/View/Retry per item reusing the exact same
 * project-source-analysis endpoints and ProjectSourceAnalysisDrawer
 * SourcesPage already uses — analysis semantics are completely unchanged
 * here, only where items are browsed from.
 */
export function CollectionDetailPage({ backendUrl, knoveraToken }: CollectionDetailPageProps) {
  const navigate = useNavigate();
  const { collectionId: collectionIdParam } = useParams<{ collectionId: string }>();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewingSourceId, setViewingSourceId] = useState<number | null>(null);
  const [viewingStatus, setViewingStatus] = useState<ProjectSourceAnalysisStatus | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;
  const collectionId = collectionIdParam ? Number(collectionIdParam) : NaN;

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const result = await getSourceCollection(url, token, projectId, collectionId, { limit: 200 });
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
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || !Number.isInteger(collectionId)) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, resolvedProjectId, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, collectionId]);

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

  async function handleRefreshCollection() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setBusy(true);
    setActionError(null);
    try {
      await refreshSourceCollection(backendUrl, knoveraToken, resolvedProjectId, collectionId);
      refresh();
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to refresh collection.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteCollection() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setBusy(true);
    try {
      await deleteSourceCollection(backendUrl, knoveraToken, resolvedProjectId, collectionId);
      navigate(`/projects/${resolvedProjectId}/sources`);
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to remove collection.");
      setBusy(false);
    }
  }

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
      }
    : null;

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      {state.phase === "loading" && <p className="knovera-sources-loading">Loading collection…</p>}

      {state.phase === "not_found" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>This collection doesn't exist.</p>
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
              <h2 className="knovera-section-title">{state.collection.title}</h2>
              <p className="knovera-project-card-source">
                {state.collection.provider === "YOUTUBE" ? "YouTube Channel" : "Discord Collection"} · {state.items.length} item{state.items.length === 1 ? "" : "s"} ·{" "}
                {state.collection.analyzedCount} analyzed
              </p>
            </div>
            <div className="knovera-synthesis-set-detail-actions">
              {/* Phase 4K-B — refresh is now supported for both YouTube and
                  Discord collections (http/routes/sourceCollections.ts's
                  DISCORD dispatch branch), so this is no longer gated to
                  provider === "YOUTUBE". */}
              <button type="button" className="link-button" disabled={busy} onClick={() => void handleRefreshCollection()}>
                {busy ? "Refreshing…" : "Refresh"}
              </button>
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
          </div>
          <p className="hint">Removing a collection only removes the grouping — its items and their analyses are kept.</p>

          {actionError && (
            <div className="kv-card knovera-empty-state" role="alert">
              <p>{actionError}</p>
            </div>
          )}

          <div className="knovera-synthesis-set-detail-actions">
            <button type="button" className="link-button" onClick={selectAllUnanalyzed}>
              Select All Unanalyzed
            </button>
            <button type="button" disabled={busy || selected.size === 0} onClick={() => void handleAnalyzeSelected()}>
              {busy ? "Starting…" : `Analyze Selected (${selected.size})`}
            </button>
          </div>

          <ul className="knovera-youtube-source-list">
            {state.items.map((item) => {
              const isPending = PENDING_STATUSES.has(item.status);
              const isFailed = item.status === "FAILED";
              const isDone = item.status === "ANALYZED";
              const badgeClass = isFailed ? "kv-badge-danger" : isDone ? "kv-badge-accent" : "kv-badge-muted";
              return (
                <li key={item.id} className="kv-card knovera-youtube-source-row">
                  <label className="knovera-synthesis-set-source-checkbox">
                    <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`Select ${item.title ?? item.sourceUrl}`} />
                    <div className="knovera-youtube-source-main">
                      <span className="knovera-youtube-source-title">{item.title ?? item.sourceUrl}</span>
                    </div>
                  </label>
                  <div className="knovera-youtube-source-actions">
                    <span className={`kv-badge ${badgeClass}`}>{STATUS_LABELS[item.status]}</span>
                    {item.status === "NOT_ANALYZED" && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeOne(item.id)}>
                        Analyze
                      </button>
                    )}
                    {isPending && <span className="hint">Working…</span>}
                    {isFailed && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleRetryOne(item.id)}>
                        Retry
                      </button>
                    )}
                    {isDone && (
                      <>
                        <button type="button" className="link-button" onClick={() => void openView(item.id)}>
                          View
                        </button>
                        <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeOne(item.id, true)}>
                          Re-analyze
                        </button>
                      </>
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
    </div>
  );
}
