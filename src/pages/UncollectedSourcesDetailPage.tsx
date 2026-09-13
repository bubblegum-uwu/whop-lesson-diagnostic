import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { ProvenanceLine } from "../components/ProvenanceLine";
import { ProjectSourceAnalysisDrawer } from "../components/ProjectSourceAnalysisDrawer";
import { useResolvedProject } from "../lib/useResolvedProject";
import { getProjectSources, type YouTubeProjectSource, type DiscordProjectSource } from "../lib/sourcesApi";
import {
  analyzeProjectSource,
  getProjectSourceAnalysis,
  retryProjectSourceAnalysis,
  ProjectSourceAnalysisError,
  type ProjectSourceAnalysisStatus,
} from "../lib/projectSourceAnalysisApi";
import { batchAnalyzeProjectSources, CatalogApiError } from "../lib/catalogApi";

export interface UncollectedSourcesDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

type VideoProjectSource = YouTubeProjectSource | DiscordProjectSource;
const VIDEO_SOURCE_LABELS: Record<VideoProjectSource["provider"], string> = { YOUTUBE: "YouTube Video", DISCORD: "Discord Video" };

/** Display labels for the job-status badge on a row. Falls back to the raw status for anything this map doesn't recognize (never blank). */
const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  ANALYZING: "Analyzing",
  VALIDATING: "Validating",
  COMPLETED: "Analyzed",
  NO_STRATEGY: "Analyzed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};
const PENDING_ANALYSIS_STATUSES = new Set(["QUEUED", "ANALYZING", "VALIDATING"]);
const ANALYSIS_POLL_INTERVAL_MS = 4000;

type LoadState = { phase: "idle" } | { phase: "loading" } | { phase: "loaded"; sources: VideoProjectSource[] } | { phase: "error"; message: string };

/**
 * "/projects/:projectId/collections/uncollected" — Phase 4L follow-up. The
 * main Sources page is collection-only (spec: "Project → Collections →
 * Sources", no individual rows on the main page — see SourcesPage.tsx's
 * doc comment). À-la-carte sources (`collection_id IS NULL`) have no real
 * `source_collections` row of their own, so rather than fabricating a
 * persisted "collection" for them (which would misrepresent historical
 * membership — see the Phase 4L spec's explicit rule against inferring
 * collection membership that never existed), they get this ONE virtual,
 * frontend-only detail page instead, reached via a virtual card on the
 * Sources page. `project_sources.collection_id` is never written here —
 * this is purely a presentation/navigation concept, identical in spirit to
 * how CollectionDetailPage browses a real collection's items.
 */
export function UncollectedSourcesDetailPage({ backendUrl, knoveraToken }: UncollectedSourcesDetailPageProps) {
  const navigate = useNavigate();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [analysisStatuses, setAnalysisStatuses] = useState<Record<number, ProjectSourceAnalysisStatus>>({});
  const [analyzingSourceId, setAnalyzingSourceId] = useState<number | null>(null);
  const [analysisActionError, setAnalysisActionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [viewingSourceId, setViewingSourceId] = useState<number | null>(null);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;
  const isTradingStrategies = projectState.phase === "resolved" && projectState.project.projectType === "TRADING_STRATEGIES";

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const result = await getProjectSources(url, token, projectId);
      const uncollected = result.sources.filter(
        (s): s is VideoProjectSource => (s.provider === "YOUTUBE" || s.provider === "DISCORD") && s.collectionId === null,
      );
      if (!cancelledRef.current) setState({ phase: "loaded", sources: uncollected });
    } catch (err) {
      if (!cancelledRef.current) setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load sources." });
    }
  }

  useEffect(() => {
    if (projectState.phase !== "resolved" || !backendUrl || !knoveraToken) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, projectState.project.id, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectState, backendUrl, knoveraToken]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) void load(backendUrl, knoveraToken, resolvedProjectId, { current: false });
  }

  const sources = state.phase === "loaded" ? state.sources : [];

  async function loadAnalysisStatus(sourceId: number) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    try {
      const status = await getProjectSourceAnalysis(backendUrl, knoveraToken, resolvedProjectId, sourceId);
      setAnalysisStatuses((prev) => ({ ...prev, [sourceId]: status }));
    } catch {
      // Best-effort — same convention as SourcesPage's original polling: a
      // transient status-fetch failure leaves the row at its last-known
      // state rather than surfacing a page-level error banner.
    }
  }

  const sourceIdsKey = sources.map((s) => s.id).join(",");
  useEffect(() => {
    if (!isTradingStrategies || sources.length === 0) return;
    sources.forEach((source) => void loadAnalysisStatus(source.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIdsKey, isTradingStrategies, resolvedProjectId]);

  useEffect(() => {
    const pendingIds = sources.filter((s) => PENDING_ANALYSIS_STATUSES.has(analysisStatuses[s.id]?.job?.status ?? "")).map((s) => s.id);
    if (pendingIds.length === 0) return;
    const interval = setInterval(() => {
      pendingIds.forEach((id) => void loadAnalysisStatus(id));
    }, ANALYSIS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIdsKey, JSON.stringify(Object.fromEntries(Object.entries(analysisStatuses).map(([id, s]) => [id, s.job?.status])))]);

  async function handleAnalyze(sourceId: number, force = false) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setAnalysisActionError(null);
    setAnalyzingSourceId(sourceId);
    try {
      await analyzeProjectSource(backendUrl, knoveraToken, resolvedProjectId, sourceId, force);
      await loadAnalysisStatus(sourceId);
    } catch (err) {
      setAnalysisActionError(err instanceof ProjectSourceAnalysisError ? err.message : "Failed to start analysis. Please try again.");
    } finally {
      setAnalyzingSourceId(null);
    }
  }

  async function handleRetry(sourceId: number) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setAnalysisActionError(null);
    setAnalyzingSourceId(sourceId);
    try {
      await retryProjectSourceAnalysis(backendUrl, knoveraToken, resolvedProjectId, sourceId);
      await loadAnalysisStatus(sourceId);
    } catch (err) {
      setAnalysisActionError(err instanceof ProjectSourceAnalysisError ? err.message : "Failed to retry analysis. Please try again.");
    } finally {
      setAnalyzingSourceId(null);
    }
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Mirrors CollectionDetailPage's identical convention: only sources never yet successfully analyzed (no job at all, or their latest job FAILED) — never a source already queued/in-flight/done. */
  function selectAllUnanalyzed() {
    setSelected(
      new Set(
        sources
          .filter((s) => {
            const status = analysisStatuses[s.id];
            if (status?.analysis) return false;
            return !status?.job || status.job.status === "FAILED";
          })
          .map((s) => s.id),
      ),
    );
  }

  async function handleAnalyzeSelected() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || selected.size === 0) return;
    setBatchBusy(true);
    setAnalysisActionError(null);
    try {
      await batchAnalyzeProjectSources(backendUrl, knoveraToken, resolvedProjectId, [...selected]);
      setSelected(new Set());
      refresh();
      sources.forEach((s) => void loadAnalysisStatus(s.id));
    } catch (err) {
      setAnalysisActionError(err instanceof CatalogApiError ? err.message : "Failed to start analysis.");
    } finally {
      setBatchBusy(false);
    }
  }

  const viewingSource = viewingSourceId != null ? (sources.find((s) => s.id === viewingSourceId) ?? null) : null;
  const viewingStatus = viewingSourceId != null ? analysisStatuses[viewingSourceId] : undefined;

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/sources`)}>
        ← Sources
      </button>

      <div className="knovera-page-header">
        <div>
          <h2 className="knovera-section-title">Uncollected Sources</h2>
          <p className="knovera-project-card-source">
            Added individually — not part of a YouTube channel or Discord channel import.
          </p>
        </div>
      </div>

      {state.phase === "loading" && <p className="knovera-sources-loading">Loading sources…</p>}
      {state.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{state.message}</p>
        </div>
      )}

      {state.phase === "loaded" && sources.length === 0 && (
        <div className="kv-card knovera-empty-state">
          <p>No uncollected sources.</p>
        </div>
      )}

      {analysisActionError && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{analysisActionError}</p>
        </div>
      )}

      {state.phase === "loaded" && sources.length > 0 && (
        <>
          {isTradingStrategies && (
            <div className="knovera-synthesis-set-detail-actions">
              <button type="button" className="link-button" onClick={selectAllUnanalyzed}>
                Select All Unanalyzed
              </button>
              <button type="button" disabled={batchBusy || selected.size === 0} onClick={() => void handleAnalyzeSelected()}>
                {batchBusy ? "Starting…" : `Analyze Selected (${selected.size})`}
              </button>
            </div>
          )}

          <ul className="knovera-youtube-source-list">
            {sources.map((source) => {
              const status = analysisStatuses[source.id];
              const job = status?.job ?? null;
              const analysis = status?.analysis ?? null;
              const busy = analyzingSourceId === source.id;
              const isPending = !!job && PENDING_ANALYSIS_STATUSES.has(job.status);
              const isFailed = job?.status === "FAILED";
              const isDone = !!analysis;
              const badgeLabel = !isTradingStrategies ? "Added" : job ? (ANALYSIS_STATUS_LABELS[job.status] ?? "Added") : isDone ? "Analyzed" : "Not analyzed";
              const badgeClass = isFailed ? "kv-badge-danger" : isDone ? "kv-badge-accent" : "kv-badge-muted";

              return (
                <li key={source.id} className="kv-card knovera-youtube-source-row">
                  {isTradingStrategies ? (
                    <label className="knovera-synthesis-set-source-checkbox">
                      <input
                        type="checkbox"
                        checked={selected.has(source.id)}
                        onChange={() => toggleSelected(source.id)}
                        aria-label={`Select ${source.title ?? source.sourceUrl}`}
                      />
                      <div className="knovera-youtube-source-main">
                        <span className="knovera-youtube-source-label">{VIDEO_SOURCE_LABELS[source.provider]}</span>
                        <span className="knovera-youtube-source-title">{source.title ?? source.sourceUrl}</span>
                        {source.provider === "YOUTUBE" && <ProvenanceLine origins={source.origins ?? []} />}
                      </div>
                    </label>
                  ) : (
                    <div className="knovera-youtube-source-main">
                      <span className="knovera-youtube-source-label">{VIDEO_SOURCE_LABELS[source.provider]}</span>
                      <span className="knovera-youtube-source-title">{source.title ?? source.sourceUrl}</span>
                      {source.provider === "YOUTUBE" && <ProvenanceLine origins={source.origins ?? []} />}
                    </div>
                  )}
                  <div className="knovera-youtube-source-actions">
                    <span className={`kv-badge ${badgeClass}`}>{badgeLabel}</span>
                    {isTradingStrategies && !job && !analysis && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyze(source.id)}>
                        {busy ? "Starting…" : "Analyze"}
                      </button>
                    )}
                    {isTradingStrategies && isPending && <span className="hint">Working…</span>}
                    {isTradingStrategies && isFailed && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleRetry(source.id)}>
                        {busy ? "Retrying…" : "Retry"}
                      </button>
                    )}
                    {isTradingStrategies && isDone && (
                      <>
                        <button type="button" className="link-button" onClick={() => setViewingSourceId(source.id)}>
                          View
                        </button>
                        <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyze(source.id, true)}>
                          {busy ? "Starting…" : "Re-analyze"}
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
        source={viewingSource}
        job={viewingStatus?.job ?? null}
        analysis={viewingStatus?.analysis ?? null}
        loading={false}
        onClose={() => setViewingSourceId(null)}
      />
    </div>
  );
}
