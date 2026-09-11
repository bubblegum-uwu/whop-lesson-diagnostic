import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { useResolvedProject } from "../lib/useResolvedProject";
import { getProjectSources, type ProjectSource, type YouTubeProjectSource, type DiscordProjectSource } from "../lib/sourcesApi";
import {
  getSynthesisSet,
  updateSynthesisSet,
  deleteSynthesisSet,
  addSourceToSynthesisSet,
  removeSourceFromSynthesisSet,
  SynthesisSetError,
  type SynthesisSetDetail,
} from "../lib/synthesisSetsApi";

export interface SynthesisSetDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; set: SynthesisSetDetail; allSources: ProjectSource[] }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

type VideoProjectSource = YouTubeProjectSource | DiscordProjectSource;
const VIDEO_SOURCE_LABELS: Record<VideoProjectSource["provider"], string> = { YOUTUBE: "YouTube Video", DISCORD: "Discord Video" };

function readinessSummary(set: SynthesisSetDetail): string {
  return `${set.sourceCount} selected · ${set.analyzedSourceCount} analyzed · ${set.needsAnalysisCount} needs analysis`;
}

/**
 * "/projects/:projectId/synthesis-sets/:setId" — Phase 4J. Manage one
 * Synthesis Set: rename/delete it, and toggle which of this project's
 * sources belong to it via checkboxes. A checkbox here ONLY changes
 * membership (POST/DELETE .../sources) — it never calls the analysis API,
 * never enqueues a job, never triggers synthesis. Whop lessons are
 * deliberately excluded from this list: Whop lessons do not live in
 * project_sources today (see the Phase 4J PR description's Whop-boundary
 * section) — only YouTube/Discord video sources are selectable, same
 * "video source" set SourcesPage already renders (see VIDEO_SOURCE_LABELS).
 */
export function SynthesisSetDetailPage({ backendUrl, knoveraToken }: SynthesisSetDetailPageProps) {
  const navigate = useNavigate();
  const { setId: setIdParam } = useParams<{ setId: string }>();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [togglingSourceId, setTogglingSourceId] = useState<number | null>(null);
  const [membershipError, setMembershipError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;
  const setId = setIdParam ? Number(setIdParam) : NaN;

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const [set, sourcesResult] = await Promise.all([getSynthesisSet(url, token, projectId, setId), getProjectSources(url, token, projectId)]);
      if (!cancelledRef.current) setState({ phase: "loaded", set, allSources: sourcesResult.sources });
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
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || !Number.isInteger(setId)) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, resolvedProjectId, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, setId]);

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

  async function toggleMembership(source: ProjectSource, isMember: boolean) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    const sourceId = "id" in source ? source.id : null;
    if (sourceId == null) return;
    setMembershipError(null);
    setTogglingSourceId(sourceId);
    try {
      if (isMember) {
        await removeSourceFromSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, sourceId);
      } else {
        await addSourceToSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, sourceId);
      }
      refresh();
    } catch (err) {
      setMembershipError(err instanceof SynthesisSetError ? err.message : "Failed to update selection. Please try again.");
    } finally {
      setTogglingSourceId(null);
    }
  }

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      {state.phase === "loading" && <p className="knovera-sources-loading">Loading synthesis set…</p>}

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

      {state.phase === "loaded" && (
        <>
          <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/synthesis-sets`)}>
            ← Synthesis Sets
          </button>

          {!renaming ? (
            <div className="knovera-page-header">
              <div>
                <h2 className="knovera-section-title">{state.set.name}</h2>
                <p className="knovera-project-card-source">{state.set.description || "No description"}</p>
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
            {readinessSummary(state.set)}
          </p>

          {membershipError && (
            <div className="kv-card knovera-empty-state" role="alert">
              <p>{membershipError}</p>
            </div>
          )}

          <h2 className="knovera-section-title">Sources</h2>
          {state.allSources.filter((s) => s.provider === "YOUTUBE" || s.provider === "DISCORD").length === 0 ? (
            <div className="kv-card knovera-empty-state">
              <p>No YouTube or Discord sources in this project yet.</p>
              <p>Add sources on the Sources page, then come back here to select them for this set.</p>
            </div>
          ) : (
            <ul className="knovera-youtube-source-list">
              {state.allSources
                .filter((s): s is VideoProjectSource => s.provider === "YOUTUBE" || s.provider === "DISCORD")
                .map((source) => {
                  const memberEntry = state.set.sources.find((m) => "id" in m && m.id === source.id);
                  const isMember = memberEntry != null;
                  const analyzed = memberEntry?.analyzed ?? false;
                  const busy = togglingSourceId === source.id;
                  return (
                    <li key={source.id} className="kv-card knovera-youtube-source-row">
                      <label className="knovera-synthesis-set-source-checkbox">
                        <input
                          type="checkbox"
                          checked={isMember}
                          disabled={busy}
                          onChange={() => void toggleMembership(source, isMember)}
                          aria-label={`Include ${source.title ?? source.sourceUrl} in ${state.set.name}`}
                        />
                        <div className="knovera-youtube-source-main">
                          <span className="knovera-youtube-source-label">{VIDEO_SOURCE_LABELS[source.provider]}</span>
                          <span className="knovera-youtube-source-title">{source.title ?? source.sourceUrl}</span>
                        </div>
                      </label>
                      <div className="knovera-youtube-source-actions">
                        {isMember && (
                          <span className={`kv-badge ${analyzed ? "kv-badge-accent" : "kv-badge-muted"}`}>
                            {analyzed ? "Analyzed" : "Not analyzed"}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
