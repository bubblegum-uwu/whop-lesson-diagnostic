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

export async function getCourseLessons(
  backendUrl: string,
  accessToken: string,
): Promise<CourseLessonsResponse> {
  const res = await fetch(`${backendUrl}/api/course/lessons`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw new Error(`Failed to load course lessons (${res.status}).`);
  return (await res.json()) as CourseLessonsResponse;
}
