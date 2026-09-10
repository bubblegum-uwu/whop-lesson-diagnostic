/**
 * Client for Phase 4H-B's project-source (YouTube) analysis endpoints.
 * Every call needs the caller's Knovera session token — never a Whop
 * token; analysis is never gated on Whop's connection state (see
 * backend/src/http/routes/projectSourceAnalysis.ts).
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

export type ProjectSourceAnalysisJobStatus = "QUEUED" | "ANALYZING" | "VALIDATING" | "COMPLETED" | "NO_STRATEGY" | "FAILED" | "CANCELLED";

export interface ProjectSourceAnalysisJob {
  jobId: string;
  projectSourceId: number;
  status: ProjectSourceAnalysisJobStatus;
  attemptCount: number;
  sanitizedError: string | null;
}

/**
 * The exact same LessonStrategyAnalysis shape lesson analyses already use
 * (see src/lib/courseApi.ts's LessonKnowledge/KnowledgeItem/etc, reused
 * here rather than redefined) — Phase 3.5A extraction semantics are
 * provider-neutral.
 */
export interface ProjectSourceAnalysisValidatedJson {
  lesson: { title: string; duration_seconds: number | null };
  strategy_found: boolean;
  strategies: unknown[];
  knowledge: unknown;
}

export interface ProjectSourceAnalysis {
  analysisId: number;
  projectSourceId: number;
  status: "completed" | "no_strategy";
  strategyFound: boolean;
  validatedJson: ProjectSourceAnalysisValidatedJson;
  analysisSummary: string;
  processingDurationSeconds: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
  completedAt: string;
}

export interface ProjectSourceAnalysisStatus {
  sourceId: number;
  job: ProjectSourceAnalysisJob | null;
  analysis: ProjectSourceAnalysis | null;
}

export class ProjectSourceAnalysisError extends Error {
  type: string;

  constructor(message: string, type: string) {
    super(message);
    this.name = "ProjectSourceAnalysisError";
    this.type = type;
  }
}

async function readErrorBody(res: Response): Promise<{ message?: string; type?: string } | undefined> {
  const body = await res.json().catch(() => undefined);
  return body?.error;
}

export interface AnalyzeProjectSourceResult {
  alreadyQueued?: boolean;
  skipped?: boolean;
  job?: ProjectSourceAnalysisJob;
  analysis?: ProjectSourceAnalysis;
}

/** POST /api/projects/:projectId/sources/:sourceId/analyze — idempotent: a repeated call while a job is in flight returns the same job, never a duplicate. */
export async function analyzeProjectSource(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  sourceId: number,
  force = false,
): Promise<AnalyzeProjectSourceResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/${sourceId}/analyze`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  if (!res.ok) {
    const error = await readErrorBody(res);
    throw new ProjectSourceAnalysisError(error?.message ?? `Failed to start analysis (${res.status}).`, error?.type ?? "unknown_error");
  }
  return (await res.json()) as AnalyzeProjectSourceResult;
}

/** GET /api/projects/:projectId/sources/:sourceId/analysis — the combined status/result view; pure read. */
export async function getProjectSourceAnalysis(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  sourceId: number,
): Promise<ProjectSourceAnalysisStatus> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/${sourceId}/analysis`, {
    headers: authHeaders(knoveraToken),
  });
  if (!res.ok) {
    const error = await readErrorBody(res);
    throw new ProjectSourceAnalysisError(error?.message ?? `Failed to load analysis (${res.status}).`, error?.type ?? "unknown_error");
  }
  return (await res.json()) as ProjectSourceAnalysisStatus;
}

/** POST /api/projects/:projectId/sources/:sourceId/retry — only valid while the latest job is FAILED. */
export async function retryProjectSourceAnalysis(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  sourceId: number,
): Promise<{ job: ProjectSourceAnalysisJob }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/${sourceId}/retry`, {
    method: "POST",
    headers: authHeaders(knoveraToken),
  });
  if (!res.ok) {
    const error = await readErrorBody(res);
    throw new ProjectSourceAnalysisError(error?.message ?? `Failed to retry analysis (${res.status}).`, error?.type ?? "unknown_error");
  }
  return (await res.json()) as { job: ProjectSourceAnalysisJob };
}
