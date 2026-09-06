/**
 * Client for the new backend endpoints that give this frontend a
 * persistent, server-side view of the course (§04/§05 of the Phase 3
 * architecture proposal, hardened per the PR #4 security review).
 *
 * Every route except `establishAuthSession` requires the caller's own,
 * currently-held Whop access token as a bearer header — the backend
 * verifies it against Whop and checks it belongs to the one authorized
 * operator. This frontend never persists that token to localStorage; it's
 * held only in React state for the lifetime of the loaded page (see
 * App.tsx), which means these calls only work in the same browser session
 * that just completed a Whop sign-in — a page reload requires signing in
 * again before the Course view can load, by design.
 */

function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

export interface EstablishAuthSessionInput {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function establishAuthSession(
  backendUrl: string,
  input: EstablishAuthSessionInput,
): Promise<void> {
  const res = await fetch(`${backendUrl}/api/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      expires_in: input.expiresIn,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error(body?.error?.message ?? `Failed to establish server-side session (${res.status}).`);
  }
}

export interface AuthStatus {
  connected: boolean;
  status: "active" | "auth_required" | null;
  whopUserId: string | null;
}

export async function getAuthStatus(backendUrl: string, accessToken: string): Promise<AuthStatus> {
  const res = await fetch(`${backendUrl}/api/auth/status`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`Failed to read auth status (${res.status}).`);
  return (await res.json()) as AuthStatus;
}

export async function disconnectAuthSession(backendUrl: string, accessToken: string): Promise<void> {
  const res = await fetch(`${backendUrl}/api/auth/disconnect`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) throw new Error(`Failed to disconnect (${res.status}).`);
}

export interface CourseSyncResult {
  courseTitle: string;
  upserted: number;
  archived: number;
}

export type CourseSyncOutcome =
  | { kind: "success"; result: CourseSyncResult }
  | { kind: "auth_required" }
  | { kind: "error"; message: string };

export async function syncCourse(backendUrl: string, accessToken: string): Promise<CourseSyncOutcome> {
  const res = await fetch(`${backendUrl}/api/course/sync`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  const body = await res.json().catch(() => undefined);
  if (res.ok) return { kind: "success", result: body as CourseSyncResult };
  if (res.status === 401) return { kind: "auth_required" };
  return { kind: "error", message: body?.error?.message ?? `Course sync failed (${res.status}).` };
}

export type AnalysisJobStatus =
  | "NOT_ANALYZED"
  | "QUEUED"
  | "RETRIEVING"
  | "PREPARING_VIDEO"
  | "UPLOADING"
  | "GEMINI_PROCESSING"
  | "ANALYZING"
  | "VALIDATING"
  | "COMPLETED"
  | "NO_STRATEGY"
  | "FAILED"
  | "AUTH_REQUIRED"
  | "CANCELLED";

export const PROCESSING_STATUSES: AnalysisJobStatus[] = [
  "RETRIEVING",
  "PREPARING_VIDEO",
  "UPLOADING",
  "GEMINI_PROCESSING",
  "ANALYZING",
  "VALIDATING",
];

export interface LessonJobSummary {
  jobId: string | null;
  status: AnalysisJobStatus;
  currentStage?: string | null;
  stageProgress?: number | null;
  overallProgress?: number | null;
  lastHeartbeatAt?: string | null;
  leaseExpiresAt?: string | null;
  attemptCount?: number;
  sanitizedError?: string | null;
  errorType?: string | null;
}

export interface RuleCount {
  label: string;
  count: number;
}

export interface LessonAnalysisSummary {
  analysisId: number;
  strategyFound: boolean;
  extractedStrategiesLabel: string | null;
  ruleCounts: RuleCount[];
  confidence: number | null;
  summary: string;
  estimatedCost: number | null;
  processingDurationSeconds: number | null;
  completedAt: string;
}

export interface CourseLessonSummary {
  id: number;
  title: string;
  chapterTitle: string | null;
  chapterOrder: number | null;
  courseOrder: number | null;
  durationSeconds: number | null;
  videoAvailable: boolean;
  sourceUrl: string;
  lastSyncedAt: string;
  /** Absent when a backend predates PR2 — the Course table treats a missing job as NOT_ANALYZED. */
  job?: LessonJobSummary;
  analysis?: LessonAnalysisSummary | null;
}

export interface CourseLessonsResponse {
  course: { title: string; slug: string; lastSyncedAt: string | null } | null;
  lessons: CourseLessonSummary[];
}

export async function getCourseLessons(
  backendUrl: string,
  accessToken: string,
): Promise<CourseLessonsResponse> {
  const res = await fetch(`${backendUrl}/api/course/lessons`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`Failed to load course lessons (${res.status}).`);
  return (await res.json()) as CourseLessonsResponse;
}

/** Full validated JSON for one lesson's latest analysis — used by [ View Analysis ] / Download JSON. */
export async function getLessonAnalysisJson(
  backendUrl: string,
  accessToken: string,
  lessonId: number,
): Promise<unknown | null> {
  const res = await fetch(`${backendUrl}/api/course/lessons/${lessonId}/analysis`, { headers: authHeaders(accessToken) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load lesson analysis (${res.status}).`);
  const body = (await res.json()) as { validatedJson: unknown };
  return body.validatedJson;
}

export interface AnalysisSummary {
  totalLessons: number;
  analyzed: number;
  strategyLessons: number;
  noStrategy: number;
  processing: number;
  queued: number;
  failed: number;
  authRequired: number;
  remaining: number;
  totalCost: number | null;
  averageCostPerLesson: number | null;
  averageProcessingSeconds: number | null;
}

export async function getAnalysisSummary(backendUrl: string, accessToken: string): Promise<AnalysisSummary | null> {
  const res = await fetch(`${backendUrl}/api/analysis/summary`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`Failed to load analysis summary (${res.status}).`);
  const body = (await res.json()) as { summary: AnalysisSummary | null };
  return body.summary;
}

export interface EnqueueResult {
  queued: { lessonId: number; jobId: string }[];
  skipped: { lessonId: number; reason: string }[];
}

/** Queues batch analysis for the given lessons. Never waits on lesson processing — returns as soon as the jobs are durably queued. */
export async function enqueueAnalysisJobs(
  backendUrl: string,
  accessToken: string,
  lessonIds: number[],
  force = false,
): Promise<EnqueueResult> {
  const res = await fetch(`${backendUrl}/api/analysis/jobs`, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ lessonIds, force }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error(body?.error?.message ?? `Failed to queue analysis (${res.status}).`);
  }
  return (await res.json()) as EnqueueResult;
}

export async function retryAnalysisJob(backendUrl: string, accessToken: string, jobId: string): Promise<void> {
  const res = await fetch(`${backendUrl}/api/analysis/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new Error(body?.error?.message ?? `Failed to retry job (${res.status}).`);
  }
}

/** Only ever succeeds while the job is still QUEUED — in-flight processing cannot be reliably cancelled (documented limitation). */
export async function cancelAnalysisJob(backendUrl: string, accessToken: string, jobId: string): Promise<boolean> {
  const res = await fetch(`${backendUrl}/api/analysis/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  return res.ok;
}

/**
 * Subscribes to live job-progress notifications. Uses the same fetch() +
 * ReadableStream pattern as analyzeLessonClient.ts (never native
 * EventSource), so the operator's bearer token stays in a header, never a
 * URL. This stream is a notification layer only: Postgres (via
 * getCourseLessons) remains the source of truth, and the caller should
 * reload full state on (re)connect, not rely on this alone.
 */
export function subscribeAnalysisEvents(
  backendUrl: string,
  accessToken: string,
  onEvents: () => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(`${backendUrl}/api/analysis/events`, {
          headers: authHeaders(accessToken),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sepIndex: number;
          while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);
            const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
            if (dataLine) onEvents();
          }
        }
      } catch {
        // fall through to reconnect below unless aborted
      }
      if (!controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  })();

  return () => controller.abort();
}
