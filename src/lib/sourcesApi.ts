/**
 * Client for GET /api/projects/:projectId/sources. Requires the caller's
 * Knovera session token (Phase 4D) — never a Whop token; a project's
 * sources are readable regardless of whether Whop is currently connected.
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

/** Only WHOP is ever returned by the backend today — see lib/providers.ts for the full conceptual provider set (including YouTube/Discord, which have no connected data yet). */
export type SourceProvider = "WHOP";
export type SourceType = "COURSE";

export interface ProjectSource {
  provider: SourceProvider;
  sourceType: SourceType;
  courseId: number;
  externalId: string;
  name: string;
  lessonCount: number;
  analyzedLessonCount: number;
  queuedCount: number;
  processingCount: number;
  failedCount: number;
  remainingCount: number;
  lastSyncedAt: string | null;
  totalCost: number | null;
}

export interface ProjectSourcesResult {
  projectId: number;
  sources: ProjectSource[];
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => undefined);
  return body?.error?.message ?? fallback;
}

export async function getProjectSources(backendUrl: string, knoveraToken: string, projectId: number): Promise<ProjectSourcesResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources`, { headers: authHeaders(knoveraToken) });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load sources (${res.status}).`));
  }
  return (await res.json()) as ProjectSourcesResult;
}
