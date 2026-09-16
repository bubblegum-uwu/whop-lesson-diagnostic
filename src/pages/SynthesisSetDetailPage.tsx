import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { ProvenanceLine } from "../components/ProvenanceLine";
import { useResolvedProject } from "../lib/useResolvedProject";
import { OPERATIONAL_PROJECT_TYPES } from "../lib/projects";
import type { ProjectSourceOriginSummary } from "../lib/sourcesApi";
import {
  listSourceCollections,
  getSourceCollection,
  catalogGroupTypeLabel,
  catalogGroupOriginLine,
  listWhopCourses,
  listWhopCourseLessons,
  listAlaCarteWhopLessons,
  type CatalogCollectionSummary,
  type WhopCourseSummary,
} from "../lib/catalogApi";
import {
  getSynthesisSet,
  updateSynthesisSet,
  deleteSynthesisSet,
  addSourceToSynthesisSet,
  removeSourceFromSynthesisSet,
  bulkAddCollectionToSynthesisSet,
  bulkRemoveCollectionFromSynthesisSet,
  bulkUpdateSynthesisSetSources,
  addLessonToSynthesisSet,
  removeLessonFromSynthesisSet,
  bulkUpdateSynthesisSetLessons,
  bulkAddCourseToSynthesisSet,
  bulkRemoveCourseFromSynthesisSet,
  SynthesisSetError,
  type SynthesisSetDetail,
} from "../lib/synthesisSetsApi";
import {
  listSynthesisSetRuns,
  createSynthesisSetRun,
  getSynthesisSetRunInputs,
  getSynthesisSetRunOutput,
  PartialSelectionError,
  type SynthesisSetRunSummary,
  type SynthesisSetRunInputRow,
} from "../lib/synthesisSetRunsApi";
import { SynthesisResultViewer } from "../components/synthesisResult/SynthesisResultViewer";
import { formatCost, formatDurationSeconds, slugify } from "../components/synthesisResult/format";

export interface SynthesisSetDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

/** A project_source-backed fine-tune row — a member of some YouTube/Discord collection/group. */
interface SourceFineTuneRow {
  kind: "SOURCE";
  id: number;
  provider: "YOUTUBE" | "DISCORD";
  title: string;
  eligible: boolean;
  collectionTitle: string | null;
  /** Phase 4K-C provenance — always empty for DISCORD rows. */
  origins: ProjectSourceOriginSummary[];
}

/**
 * Pre-4M — a Whop lesson fine-tune row (course-connected or à-la-carte).
 * Deliberately its OWN kind, never flattened into SourceFineTuneRow — a
 * Whop lesson lives in `lessons`, never `project_sources` (see
 * synthesisSetsApi.ts's SynthesisSetMemberLesson doc comment), and its id
 * space is disjoint from project_source ids, so every membership check
 * below dispatches on `kind` rather than assuming one shared id space.
 */
interface LessonFineTuneRow {
  kind: "LESSON";
  id: number;
  courseId: number;
  provider: "WHOP";
  title: string;
  eligible: boolean;
  collectionTitle: string;
}

type FineTuneRow = SourceFineTuneRow | LessonFineTuneRow;

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | {
      phase: "loaded";
      set: SynthesisSetDetail;
      collections: CatalogCollectionSummary[];
      /** Every item of every collection/group, keyed by groupKey — the source of both the tri-state rollups and the fine-tune list's source rows. */
      itemsByCollection: Map<string, SourceFineTuneRow[]>;
      /** Pre-4M — every Whop course fully connected to this project (courses.project_id), for the "WHOP · COURSE" tri-state Collections row. */
      whopCourses: WhopCourseSummary[];
      /** Pre-4M — every course's lessons, keyed by courseId — the lesson-membership sibling of itemsByCollection. */
      lessonsByCourse: Map<number, LessonFineTuneRow[]>;
      /** Pre-4M — this project's à-la-carte Whop lessons (no fully-connected course) — individually fine-tunable, never a bulk "Collections" row (there's no "whole à-la-carte" snapshot concept, mirroring WhopAlaCarteDetailPage). */
      alaCarteLessonRows: LessonFineTuneRow[];
      /**
       * Phase 4M — every immutable Run for this set (native Runs created via
       * "Run Synthesis" here, AND recovered legacy Whop runs), unified and
       * newest first. This is RUN HISTORY — completely distinct from the
       * CURRENT SELECTION rendered by the Collections/Fine-Tune sections
       * above; changing selection never rewrites anything in this list, and
       * nothing in this list ever reflects back onto current membership.
       */
      runs: SynthesisSetRunSummary[];
    }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

type SelectionFilter = "all" | "selected" | "not_selected" | "eligible";
type ProviderFilter = "all" | "YOUTUBE" | "DISCORD" | "WHOP";

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

async function loadFineTuneRowsForCollection(backendUrl: string, knoveraToken: string, projectId: number, groupKey: string): Promise<SourceFineTuneRow[]> {
  const detail = await getSourceCollection(backendUrl, knoveraToken, projectId, groupKey, { limit: 200 });
  return detail.items.map((item) => ({
    kind: "SOURCE" as const,
    id: item.id,
    provider: item.provider,
    title: item.title ?? item.sourceUrl,
    eligible: item.eligibleForSynthesis,
    collectionTitle: catalogGroupOriginLine(detail.collection),
    origins: item.origins,
  }));
}

async function loadFineTuneRowsForCourse(backendUrl: string, knoveraToken: string, projectId: number, course: WhopCourseSummary): Promise<LessonFineTuneRow[]> {
  const detail = await listWhopCourseLessons(backendUrl, knoveraToken, projectId, course.courseId, { limit: 200 });
  return detail.items.map((item) => ({
    kind: "LESSON" as const,
    id: item.id,
    courseId: course.courseId,
    provider: "WHOP" as const,
    title: item.title,
    eligible: item.eligibleForSynthesis,
    collectionTitle: course.name,
  }));
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Run Summary's compact metadata — date AND time, unlike formatDate's date-only collapsed-card label above. */
function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Phase 4M follow-up — compact Run metadata, shown once a Run's detail is
 * expanded. Never renders a raw object: every field here is one already-
 * named value on SynthesisSetRunSummary, formatted plainly.
 */
function RunSummaryPanel({ run, isLatestCompleted }: { run: SynthesisSetRunSummary; isLatestCompleted: boolean }) {
  return (
    <div className="dashboard-tiles">
      <div className="dashboard-tile">
        <div className="dashboard-tile-value">{run.status}</div>
        <div className="dashboard-tile-label">Status</div>
      </div>
      <div className="dashboard-tile">
        <div className="dashboard-tile-value">
          {run.kind === "LEGACY_WHOP" ? "Legacy" : "Native"}
          {isLatestCompleted && " · Latest"}
        </div>
        <div className="dashboard-tile-label">Kind</div>
      </div>
      <div className="dashboard-tile">
        <div className="dashboard-tile-value">{formatDateTime(run.createdAt)}</div>
        <div className="dashboard-tile-label">Created</div>
      </div>
      {run.startedAt && (
        <div className="dashboard-tile">
          <div className="dashboard-tile-value">{formatDateTime(run.startedAt)}</div>
          <div className="dashboard-tile-label">Started</div>
        </div>
      )}
      {run.completedAt && (
        <div className="dashboard-tile">
          <div className="dashboard-tile-value">{formatDateTime(run.completedAt)}</div>
          <div className="dashboard-tile-label">Completed</div>
        </div>
      )}
      <div className="dashboard-tile">
        <div className="dashboard-tile-value">{run.readyCount}</div>
        <div className="dashboard-tile-label">Inputs</div>
      </div>
      {run.skippedNotReadyCount > 0 && (
        <div className="dashboard-tile">
          <div className="dashboard-tile-value">{run.skippedNotReadyCount}</div>
          <div className="dashboard-tile-label">Skipped (not ready)</div>
        </div>
      )}
      <div className="dashboard-tile">
        <div className="dashboard-tile-value">{run.model ?? "—"}</div>
        <div className="dashboard-tile-label">Model</div>
      </div>
      <div className="dashboard-tile">
        <div className="dashboard-tile-value">{run.promptVersion ?? "—"}</div>
        <div className="dashboard-tile-label">Prompt Version</div>
      </div>
      <div className="dashboard-tile">
        <div className="dashboard-tile-value">{formatDurationSeconds(run.processingDurationSeconds)}</div>
        <div className="dashboard-tile-label">Duration</div>
      </div>
      <div className="dashboard-tile">
        <div className="dashboard-tile-value">{formatCost(run.estimatedCost)}</div>
        <div className="dashboard-tile-label">Estimated Cost</div>
      </div>
    </div>
  );
}

/**
 * Phase 4M follow-up — the Run's frozen input provenance, collapsed by
 * default (a completed native Run may freeze dozens of inputs — showing
 * every row immediately would dwarf the Synthesis Result above it). Purely
 * a display toggle: the exact immutable rows underneath never change.
 */
function FrozenInputsSection({ inputs, loading }: { inputs: SynthesisSetRunInputRow[] | undefined; loading: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="kv-card knovera-empty-state">
      <div className="knovera-page-header">
        <h3 className="knovera-section-title">Frozen Inputs / Provenance</h3>
        <button type="button" className="link-button" onClick={() => setOpen((v) => !v)} disabled={loading}>
          {open ? "Hide Inputs" : "Show Inputs"}
        </button>
      </div>
      <p className="hint">{loading && !inputs ? "Loading…" : `${inputs?.length ?? 0} input${(inputs?.length ?? 0) === 1 ? "" : "s"}`}</p>
      {open && inputs && (
        <ul className="knovera-youtube-source-list">
          {inputs.map((input) => (
            <li key={`${input.kind}-${input.id}`} className="kv-card knovera-youtube-source-row">
              <div className="knovera-youtube-source-main">
                <span className="knovera-youtube-source-label">{input.kind === "WHOP_LESSON" ? (input.courseTitle ?? "Whop") : input.provider}</span>
                <span className="knovera-youtube-source-title">{input.title ?? "Untitled"}</span>
              </div>
              <span className="hint">analysis #{input.analysisId}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
 * membership action here is membership only — it never analyzes anything,
 * never enqueues a job, never runs synthesis (Phase 4M's concern, not this
 * page's — see the Run History placeholder at the bottom).
 *
 * Pre-4M follow-up — also renders Whop lesson membership (WHOP · COURSE
 * Collections rows, individually-fine-tunable course/à-la-carte lesson
 * rows) and, when present, a recovered legacy Whop synthesis history
 * section (view-only — see synthesisSetsApi.ts's "Pre-4M" section). Whop
 * lessons are never flattened into the YouTube/Discord source rows or
 * their id space — see FineTuneRow's doc comments.
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

  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runInputsByRun, setRunInputsByRun] = useState<Map<string, SynthesisSetRunInputRow[]>>(new Map());
  const [runOutputByRun, setRunOutputByRun] = useState<Map<string, unknown>>(new Map());
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);

  const [runSynthesisBusy, setRunSynthesisBusy] = useState(false);
  const [runSynthesisError, setRunSynthesisError] = useState<string | null>(null);
  const [partialConfirm, setPartialConfirm] = useState<{ readyCount: number; skippedNotReadyCount: number; totalSelected: number } | null>(null);

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
      const [set, collections, whopCourses, alaCarteLessons, runs] = await Promise.all([
        getSynthesisSet(url, token, projectId, setId),
        listSourceCollections(url, token, projectId),
        listWhopCourses(url, token, projectId),
        listAlaCarteWhopLessons(url, token, projectId),
        listSynthesisSetRuns(url, token, projectId, setId),
      ]);

      const itemsByCollection = new Map<string, SourceFineTuneRow[]>();
      await Promise.all(
        collections.map(async (c) => {
          itemsByCollection.set(c.groupKey, await loadFineTuneRowsForCollection(url, token, projectId, c.groupKey));
        }),
      );

      const lessonsByCourse = new Map<number, LessonFineTuneRow[]>();
      await Promise.all(
        whopCourses.map(async (course) => {
          lessonsByCourse.set(course.courseId, await loadFineTuneRowsForCourse(url, token, projectId, course));
        }),
      );

      const alaCarteLessonRows: LessonFineTuneRow[] = alaCarteLessons.map((lesson) => ({
        kind: "LESSON" as const,
        id: lesson.id,
        courseId: lesson.courseId,
        provider: "WHOP" as const,
        title: lesson.title,
        eligible: lesson.eligibleForSynthesis,
        collectionTitle: `Whop · ${lesson.courseTitle} (à la carte)`,
      }));

      if (!cancelledRef.current) setState({ phase: "loaded", set, collections, itemsByCollection, whopCourses, lessonsByCourse, alaCarteLessonRows, runs });
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
    setBusyKey(`collection:${collection.groupKey}`);
    try {
      if (currentState === "all") {
        await bulkRemoveCollectionFromSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, collection.groupKey);
      } else {
        await bulkAddCollectionToSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, collection.groupKey);
      }
      refresh();
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : "Failed to update this collection's selection.");
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleCourse(course: WhopCourseSummary, currentState: "none" | "partial" | "all") {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    setMembershipError(null);
    setBusyKey(`course:${course.courseId}`);
    try {
      if (currentState === "all") {
        await bulkRemoveCourseFromSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, course.courseId);
      } else {
        await bulkAddCourseToSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, course.courseId);
      }
      refresh();
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : "Failed to update this course's selection.");
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleRow(row: FineTuneRow, isMember: boolean) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    setMembershipError(null);
    setBusyKey(`${row.kind}:${row.id}`);
    try {
      if (row.kind === "SOURCE") {
        if (isMember) await removeSourceFromSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, row.id);
        else await addSourceToSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, row.id);
      } else {
        if (isMember) await removeLessonFromSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, row.id);
        else await addLessonToSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, state.set.id, row.id);
      }
      refresh();
    } catch (err) {
      setMembershipError(err instanceof SynthesisSetError ? err.message : "Failed to update selection. Please try again.");
    } finally {
      setBusyKey(null);
    }
  }

  /**
   * Opens/closes a Run's detail panel — its frozen input provenance
   * (always fetched) plus its output, if it has one. This is a pure,
   * read-only inspection of an already-immutable Run: it never re-derives
   * inputs from current membership (see synthesisSetRunsApi.ts's doc
   * comment) and never mutates anything.
   */
  async function toggleViewRunDetail(run: SynthesisSetRunSummary) {
    if (expandedRunId === run.runId) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(run.runId);
    setRunDetailError(null);
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    const needsInputs = !runInputsByRun.has(run.runId);
    const needsOutput = run.hasOutput && !runOutputByRun.has(run.runId);
    if (!needsInputs && !needsOutput) return;
    setRunDetailLoading(true);
    try {
      const tasks: Promise<void>[] = [];
      if (needsInputs) {
        tasks.push(
          getSynthesisSetRunInputs(backendUrl, knoveraToken, resolvedProjectId, state.set.id, run.runId).then((res) => {
            setRunInputsByRun((prev) => new Map(prev).set(run.runId, res.inputs));
          }),
        );
      }
      if (needsOutput) {
        tasks.push(
          getSynthesisSetRunOutput(backendUrl, knoveraToken, resolvedProjectId, state.set.id, run.runId).then((res) => {
            setRunOutputByRun((prev) => new Map(prev).set(run.runId, res.result));
          }),
        );
      }
      await Promise.all(tasks);
    } catch (err) {
      setRunDetailError(err instanceof Error ? err.message : "Failed to load run details.");
    } finally {
      setRunDetailLoading(false);
    }
  }

  async function refreshRuns() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    const runs = await listSynthesisSetRuns(backendUrl, knoveraToken, resolvedProjectId, state.set.id);
    setState((prev) => (prev.phase === "loaded" ? { ...prev, runs } : prev));
  }

  /**
   * "Run Synthesis" — the ONE explicit action on this page that creates an
   * immutable Run. Never invoked implicitly by any membership/selection
   * change above. The first call never sets `acknowledgePartial`; if the
   * backend responds that some currently-selected items aren't analyzed
   * yet, this surfaces the exact ready/skipped breakdown and waits for an
   * explicit second, confirmed call rather than silently omitting anything.
   */
  async function handleRunSynthesis(acknowledgePartial: boolean) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || state.phase !== "loaded") return;
    setRunSynthesisBusy(true);
    setRunSynthesisError(null);
    try {
      await createSynthesisSetRun(backendUrl, knoveraToken, resolvedProjectId, state.set.id, { acknowledgePartial });
      setPartialConfirm(null);
      await refreshRuns();
    } catch (err) {
      if (err instanceof PartialSelectionError) {
        setPartialConfirm({ readyCount: err.readyCount, skippedNotReadyCount: err.skippedNotReadyCount, totalSelected: err.totalSelected });
      } else {
        setRunSynthesisError(err instanceof Error ? err.message : "Failed to start synthesis.");
      }
    } finally {
      setRunSynthesisBusy(false);
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

  const { set, collections, itemsByCollection, whopCourses, lessonsByCourse, alaCarteLessonRows, runs } = state;
  const memberIds = new Set(set.sources.map((s) => ("id" in s ? s.id : -1)));
  const lessonMemberIds = new Set(set.lessons.map((l) => l.id));

  const allSourceRows: SourceFineTuneRow[] = collections.flatMap((c) => itemsByCollection.get(c.groupKey) ?? []);
  const allLessonRows: LessonFineTuneRow[] = [...whopCourses.flatMap((c) => lessonsByCourse.get(c.courseId) ?? []), ...alaCarteLessonRows];
  const allRows: FineTuneRow[] = [...allSourceRows, ...allLessonRows];

  function isRowMember(row: FineTuneRow): boolean {
    return row.kind === "SOURCE" ? memberIds.has(row.id) : lessonMemberIds.has(row.id);
  }

  const visibleRows = allRows.filter((row) => {
    if (providerFilter !== "all" && row.provider !== providerFilter) return false;
    const isMember = isRowMember(row);
    if (selectionFilter === "selected" && !isMember) return false;
    if (selectionFilter === "not_selected" && isMember) return false;
    if (selectionFilter === "eligible" && !row.eligible) return false;
    if (search.trim().length > 0 && !row.title.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  async function selectAllVisibleEligible() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    const sourceIds = visibleRows.filter((r): r is SourceFineTuneRow => r.kind === "SOURCE" && r.eligible && !memberIds.has(r.id)).map((r) => r.id);
    const lessonIds = visibleRows.filter((r): r is LessonFineTuneRow => r.kind === "LESSON" && r.eligible && !lessonMemberIds.has(r.id)).map((r) => r.id);
    if (sourceIds.length === 0 && lessonIds.length === 0) return;
    setBusyKey("bulk-select-visible");
    setMembershipError(null);
    try {
      if (sourceIds.length > 0) await bulkUpdateSynthesisSetSources(backendUrl, knoveraToken, resolvedProjectId, set.id, { add: sourceIds });
      if (lessonIds.length > 0) await bulkUpdateSynthesisSetLessons(backendUrl, knoveraToken, resolvedProjectId, set.id, { add: lessonIds });
      refresh();
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : "Failed to select visible sources.");
    } finally {
      setBusyKey(null);
    }
  }

  async function deselectAllVisible() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    const sourceIds = visibleRows.filter((r): r is SourceFineTuneRow => r.kind === "SOURCE" && memberIds.has(r.id)).map((r) => r.id);
    const lessonIds = visibleRows.filter((r): r is LessonFineTuneRow => r.kind === "LESSON" && lessonMemberIds.has(r.id)).map((r) => r.id);
    if (sourceIds.length === 0 && lessonIds.length === 0) return;
    setBusyKey("bulk-deselect-visible");
    setMembershipError(null);
    try {
      if (sourceIds.length > 0) await bulkUpdateSynthesisSetSources(backendUrl, knoveraToken, resolvedProjectId, set.id, { remove: sourceIds });
      if (lessonIds.length > 0) await bulkUpdateSynthesisSetLessons(backendUrl, knoveraToken, resolvedProjectId, set.id, { remove: lessonIds });
      refresh();
    } catch (err) {
      setMembershipError(err instanceof Error ? err.message : "Failed to deselect visible sources.");
    } finally {
      setBusyKey(null);
    }
  }

  const latestCompletedRunId = runs.filter((r) => r.status === "COMPLETED").sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0]?.runId;

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

      <h2 className="knovera-section-title">Current Selection</h2>
      <p className="hint" aria-label="Readiness summary">
        {readinessSummary(set)}
      </p>

      {membershipError && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{membershipError}</p>
        </div>
      )}

      <div className="knovera-synthesis-set-detail-actions">
        <button type="button" className="link-button" onClick={() => setFineTuneOpen((v) => !v)}>
          {fineTuneOpen ? "Hide Fine Tune Sources" : "Fine Tune Sources"}
        </button>
        <button type="button" onClick={() => void handleRunSynthesis(false)} disabled={runSynthesisBusy || set.sourceCount === 0}>
          {runSynthesisBusy ? "Starting…" : "Run Synthesis"}
        </button>
      </div>

      {runSynthesisError && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{runSynthesisError}</p>
        </div>
      )}

      {partialConfirm && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>
            {partialConfirm.readyCount} of {partialConfirm.totalSelected} selected items are ready ({partialConfirm.skippedNotReadyCount} still need analysis).
          </p>
          <p className="hint">Running now will create a Run using only the {partialConfirm.readyCount} ready item(s); the rest will be recorded as skipped, not silently included later.</p>
          <div className="knovera-dialog-actions">
            <button type="button" className="link-button" onClick={() => setPartialConfirm(null)} disabled={runSynthesisBusy}>
              Cancel
            </button>
            <button type="button" onClick={() => void handleRunSynthesis(true)} disabled={runSynthesisBusy}>
              {runSynthesisBusy ? "Starting…" : `Run With ${partialConfirm.readyCount} Ready`}
            </button>
          </div>
        </div>
      )}

      <h2 className="knovera-section-title">Collections</h2>
      {collections.length === 0 && whopCourses.length === 0 ? (
        <div className="kv-card knovera-empty-state">
          <p>No collections in this project yet.</p>
          <p>Add a YouTube channel or import a Discord channel on the Sources page, then come back here to select them.</p>
        </div>
      ) : (
        <ul className="knovera-youtube-source-list">
          {collections.map((collection) => {
            const items = itemsByCollection.get(collection.groupKey) ?? [];
            const eligibleIds = items.filter((i) => i.eligible).map((i) => i.id);
            const selectedEligibleCount = eligibleIds.filter((id) => memberIds.has(id)).length;
            const triState: "none" | "partial" | "all" =
              eligibleIds.length === 0 || selectedEligibleCount === 0 ? "none" : selectedEligibleCount === eligibleIds.length ? "all" : "partial";
            const availableToAdd = eligibleIds.length - selectedEligibleCount;
            const busy = busyKey === `collection:${collection.groupKey}`;
            const originLine = catalogGroupOriginLine(collection);
            return (
              <li key={collection.groupKey} className="kv-card knovera-youtube-source-row">
                <label className="knovera-synthesis-set-source-checkbox">
                  <TriStateCheckbox
                    state={triState}
                    disabled={busy || eligibleIds.length === 0}
                    onChange={() => void toggleCollection(collection, triState)}
                    ariaLabel={`Select all eligible sources in ${originLine}`}
                  />
                  <div className="knovera-youtube-source-main">
                    <span className="knovera-youtube-source-label">{catalogGroupTypeLabel(collection)}</span>
                    <span className="knovera-youtube-source-title">{originLine}</span>
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
          {whopCourses.map((course) => {
            const items = lessonsByCourse.get(course.courseId) ?? [];
            const eligibleIds = items.filter((i) => i.eligible).map((i) => i.id);
            const selectedEligibleCount = eligibleIds.filter((id) => lessonMemberIds.has(id)).length;
            const triState: "none" | "partial" | "all" =
              eligibleIds.length === 0 || selectedEligibleCount === 0 ? "none" : selectedEligibleCount === eligibleIds.length ? "all" : "partial";
            const availableToAdd = eligibleIds.length - selectedEligibleCount;
            const busy = busyKey === `course:${course.courseId}`;
            return (
              <li key={`whop-course-${course.courseId}`} className="kv-card knovera-youtube-source-row">
                <label className="knovera-synthesis-set-source-checkbox">
                  <TriStateCheckbox
                    state={triState}
                    disabled={busy || eligibleIds.length === 0}
                    onChange={() => void toggleCourse(course, triState)}
                    ariaLabel={`Select all eligible lessons in ${course.name}`}
                  />
                  <div className="knovera-youtube-source-main">
                    <span className="knovera-youtube-source-label">WHOP · COURSE</span>
                    <span className="knovera-youtube-source-title">{course.name}</span>
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
              <option value="WHOP">Whop</option>
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
                const isMember = isRowMember(row);
                const busy = busyKey === `${row.kind}:${row.id}`;
                return (
                  <li key={`${row.kind}-${row.id}`} className="kv-card knovera-youtube-source-row">
                    <label className="knovera-synthesis-set-source-checkbox">
                      <input
                        type="checkbox"
                        checked={isMember}
                        disabled={busy || !row.eligible}
                        onChange={() => void toggleRow(row, isMember)}
                        aria-label={`Include ${row.title} in ${set.name}`}
                      />
                      <div className="knovera-youtube-source-main">
                        <span className="knovera-youtube-source-label">{row.kind === "SOURCE" ? (row.collectionTitle ?? "Uncollected") : row.collectionTitle}</span>
                        <span className="knovera-youtube-source-title">{row.title}</span>
                        {row.kind === "SOURCE" && row.provider === "YOUTUBE" && <ProvenanceLine origins={row.origins} />}
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

      <div className="knovera-page-header">
        <h2 className="knovera-section-title">Run History</h2>
        <button type="button" className="link-button" onClick={() => void refreshRuns()}>
          Refresh
        </button>
      </div>
      <p className="hint">
        Every Run below is an immutable snapshot, frozen the moment it was created. Changing Current Selection above never rewrites a past Run, and no Run
        here was ever created automatically. A Run queued just now may still show Queued or Running here until you refresh.
      </p>
      {runs.length === 0 ? (
        <div className="kv-card knovera-empty-state">
          <p>No runs yet.</p>
          <p>Use &ldquo;Run Synthesis&rdquo; above to create the first immutable Run from the current selection.</p>
        </div>
      ) : (
        <ul className="knovera-youtube-source-list">
          {runs.map((run) => {
            const isLatestCompleted = run.runId === latestCompletedRunId;
            const expanded = expandedRunId === run.runId;
            const inputs = runInputsByRun.get(run.runId);
            const output = runOutputByRun.get(run.runId);
            return (
              <li key={run.runId} className="kv-card knovera-youtube-source-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <div className="knovera-youtube-source-main">
                  <span
                    className={`kv-badge ${
                      run.status === "COMPLETED" ? "kv-badge-success" : run.status === "FAILED" ? "kv-badge-danger" : run.status === "RUNNING" ? "kv-badge-accent" : "kv-badge-muted"
                    }`}
                  >
                    {run.status}
                  </span>
                  {isLatestCompleted && <span className="kv-badge kv-badge-accent">Latest</span>}
                  {run.kind === "LEGACY_WHOP" && <span className="kv-badge kv-badge-muted">Legacy</span>}
                  <span className="knovera-youtube-source-title">
                    Created {formatDate(run.createdAt)} · Completed {formatDate(run.completedAt)}
                  </span>
                </div>
                <p className="hint">
                  {run.readyCount} input{run.readyCount === 1 ? "" : "s"}
                  {run.skippedNotReadyCount > 0 ? ` · ${run.skippedNotReadyCount} skipped (not ready)` : ""}
                  {run.estimatedCost != null ? ` · $${run.estimatedCost.toFixed(2)}` : ""}
                  {run.model ? ` · Model: ${run.model}` : ""}
                </p>
                {run.kind === "LEGACY_WHOP" && (
                  <p className="hint">Recovered from this project&rsquo;s pre-Synthesis-Set course synthesis engine — historical, view-only.</p>
                )}
                {run.status === "FAILED" && (
                  <p className="hint" role="alert">
                    {run.errorType ? `${run.errorType}: ` : ""}
                    {run.sanitizedError ?? "This run failed."}
                  </p>
                )}
                <div className="knovera-synthesis-set-detail-actions">
                  <button type="button" className="link-button" onClick={() => void toggleViewRunDetail(run)}>
                    {expanded ? "Hide Details" : "View Details"}
                  </button>
                </div>
                {expanded && (
                  <div className="knovera-synthesis-run-detail">
                    <div className="kv-card knovera-empty-state">
                      <RunSummaryPanel run={run} isLatestCompleted={isLatestCompleted} />
                    </div>
                    {runDetailError && (
                      <p role="alert" className="hint">
                        {runDetailError}
                      </p>
                    )}
                    {run.status === "FAILED" ? null : !run.hasOutput ? (
                      <p className="hint">No output yet.</p>
                    ) : runDetailLoading && output == null ? (
                      <p className="hint">Loading run details…</p>
                    ) : output != null ? (
                      <>
                        <h3 className="knovera-section-title">Synthesis Result</h3>
                        <SynthesisResultViewer
                          run={run}
                          rawOutput={output}
                          filenameBase={`${slugify(set.name)}-${(run.completedAt ?? run.createdAt).slice(0, 10)}-synthesis`}
                        />
                      </>
                    ) : null}
                    <FrozenInputsSection inputs={inputs} loading={runDetailLoading} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
