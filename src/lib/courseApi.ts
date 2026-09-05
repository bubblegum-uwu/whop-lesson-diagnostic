/**
 * Client for the new backend endpoints that give this frontend a
 * persistent, server-side view of the course (§04/§05 of the Phase 3
 * architecture proposal). None of these ever handle a Whop access token
 * directly except `establishAuthSession`, which sends it once, over HTTPS,
 * for the backend to store — the frontend never writes it to localStorage.
 */

export interface EstablishAuthSessionInput {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  idToken?: string;
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
      id_token: input.idToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to establish server-side session (${res.status}).`);
  }
}

export interface AuthStatus {
  connected: boolean;
  status: "active" | "auth_required" | null;
  whopUserId: string | null;
}

export async function getAuthStatus(backendUrl: string): Promise<AuthStatus> {
  const res = await fetch(`${backendUrl}/api/auth/status`);
  if (!res.ok) throw new Error(`Failed to read auth status (${res.status}).`);
  return (await res.json()) as AuthStatus;
}

export async function disconnectAuthSession(backendUrl: string): Promise<void> {
  const res = await fetch(`${backendUrl}/api/auth/disconnect`, { method: "POST" });
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

export async function syncCourse(backendUrl: string): Promise<CourseSyncOutcome> {
  const res = await fetch(`${backendUrl}/api/course/sync`, { method: "POST" });
  const body = await res.json().catch(() => undefined);
  if (res.ok) return { kind: "success", result: body as CourseSyncResult };
  if (res.status === 401) return { kind: "auth_required" };
  return { kind: "error", message: body?.error?.message ?? `Course sync failed (${res.status}).` };
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
}

export interface CourseLessonsResponse {
  course: { title: string; slug: string; lastSyncedAt: string | null } | null;
  lessons: CourseLessonSummary[];
}

export async function getCourseLessons(backendUrl: string): Promise<CourseLessonsResponse> {
  const res = await fetch(`${backendUrl}/api/course/lessons`);
  if (!res.ok) throw new Error(`Failed to load course lessons (${res.status}).`);
  return (await res.json()) as CourseLessonsResponse;
}
