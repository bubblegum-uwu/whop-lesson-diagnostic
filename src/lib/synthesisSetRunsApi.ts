/**
 * Phase 4M — client for the Synthesis Set Run endpoints
 * (/api/projects/:projectId/synthesis-sets/:setId/runs...). A Run is the
 * immutable execution snapshot underneath a Synthesis Set — see
 * backend/src/http/routes/synthesisSetRuns.ts's own doc comments for the
 * full model. `kind: "NATIVE" | "LEGACY_WHOP"` on every Run distinguishes a
 * Phase-4M-created Run from a recovered pre-4M Whop course-synthesis run;
 * both are read through this ONE unified shape, never two competing ones.
 */
import { SynthesisSetError } from "./synthesisSetsApi";

function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

async function readErrorBody(res: Response): Promise<{ message?: string; type?: string } | undefined> {
  const body = await res.json().catch(() => undefined);
  return body?.error;
}

async function throwOnError(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  const error = await readErrorBody(res);
  throw new SynthesisSetError(error?.message ?? fallback, error?.type ?? "unknown_error");
}

export type SynthesisSetRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
export type SynthesisSetRunKind = "NATIVE" | "LEGACY_WHOP";

/**
 * One Run's headline shape, native or recovered-legacy alike. `hasOutput`
 * tells the UI whether it's worth calling getSynthesisSetRunOutput — a
 * native Run only has output once COMPLETED (nothing executes it
 * automatically in this phase, so most native Runs sit at QUEUED with
 * `hasOutput: false`); a legacy Run has output iff its historical
 * course_playbooks row was recovered.
 */
export interface SynthesisSetRunSummary {
  runId: string;
  kind: SynthesisSetRunKind;
  status: SynthesisSetRunStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  sourceCount: number;
  readyCount: number;
  skippedNotReadyCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
  processingDurationSeconds: number | null;
  errorType: string | null;
  sanitizedError: string | null;
  hasOutput: boolean;
}

/** GET .../runs — every Run for this set (native + recovered legacy), newest first. Pure read. */
export async function listSynthesisSetRuns(backendUrl: string, knoveraToken: string, projectId: number, setId: number): Promise<SynthesisSetRunSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/runs`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load run history (${res.status}).`);
  const body = (await res.json()) as { runs: SynthesisSetRunSummary[] };
  return body.runs;
}

/** GET .../runs/:runId — one Run's summary. 404s if the run doesn't belong to this exact project+set. */
export async function getSynthesisSetRun(backendUrl: string, knoveraToken: string, projectId: number, setId: number, runId: string): Promise<SynthesisSetRunSummary> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/runs/${runId}`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load run (${res.status}).`);
  return (await res.json()) as SynthesisSetRunSummary;
}

export interface SynthesisSetRunInputRow {
  kind: "SOURCE" | "WHOP_LESSON";
  id: number;
  title: string | null;
  provider: string;
  analysisId: number;
  courseId?: number;
  courseTitle?: string;
}

/** GET .../runs/:runId/inputs — the Run's frozen input provenance: exactly which sources/lessons, at exactly which analysis version, went into it. Never current membership. */
export async function getSynthesisSetRunInputs(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  runId: string,
): Promise<{ kind: SynthesisSetRunKind; inputs: SynthesisSetRunInputRow[] }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/runs/${runId}/inputs`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load run inputs (${res.status}).`);
  return (await res.json()) as { kind: SynthesisSetRunKind; inputs: SynthesisSetRunInputRow[] };
}

export interface SynthesisSetRunOutput {
  runId: string;
  kind: SynthesisSetRunKind;
  result: unknown;
}

/** GET .../runs/:runId/output — the Run's result. 404s (run_output_not_available) if not yet produced — never fabricated. */
export async function getSynthesisSetRunOutput(backendUrl: string, knoveraToken: string, projectId: number, setId: number, runId: string): Promise<SynthesisSetRunOutput> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/runs/${runId}/output`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load run output (${res.status}).`);
  return (await res.json()) as SynthesisSetRunOutput;
}

/** Thrown when POST .../runs comes back 409 — some currently-selected items aren't analyzed yet, and the caller hasn't confirmed running with only the ready subset. */
export class PartialSelectionError extends Error {
  readyCount: number;
  skippedNotReadyCount: number;
  totalSelected: number;

  constructor(readyCount: number, skippedNotReadyCount: number, totalSelected: number) {
    super("Some selected items are not yet analyzed.");
    this.name = "PartialSelectionError";
    this.readyCount = readyCount;
    this.skippedNotReadyCount = skippedNotReadyCount;
    this.totalSelected = totalSelected;
  }
}

/**
 * POST .../runs — "Run Synthesis": the one explicit action that creates an
 * immutable Run out of CURRENT selection. Never called implicitly by any
 * other action on this page. Pass `acknowledgePartial: true` only after the
 * caller has shown the user the ready/skipped breakdown from a
 * PartialSelectionError and they've explicitly chosen to proceed with just
 * the ready subset — never set it preemptively.
 */
export async function createSynthesisSetRun(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  options?: { acknowledgePartial?: boolean },
): Promise<SynthesisSetRunSummary> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/runs`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ acknowledgePartial: options?.acknowledgePartial === true }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => undefined)) as { readyCount?: number; skippedNotReadyCount?: number; totalSelected?: number } | undefined;
    throw new PartialSelectionError(body?.readyCount ?? 0, body?.skippedNotReadyCount ?? 0, body?.totalSelected ?? 0);
  }
  await throwOnError(res, `Failed to start synthesis (${res.status}).`);
  return (await res.json()) as SynthesisSetRunSummary;
}
