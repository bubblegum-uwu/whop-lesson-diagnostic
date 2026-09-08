/**
 * Client for GET /api/projects/:projectId/sources (Phase 4C). Same shape as
 * courseApi.ts/projectsApi.ts: requires the operator's Whop access token,
 * same as every other course/analysis/project route.
 */
function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
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

export async function getProjectSources(backendUrl: string, accessToken: string, projectId: number): Promise<ProjectSourcesResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources`, { headers: authHeaders(accessToken) });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load sources (${res.status}).`));
  }
  return (await res.json()) as ProjectSourcesResult;
}
