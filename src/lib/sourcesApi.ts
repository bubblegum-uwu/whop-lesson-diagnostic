/**
 * Client for GET /api/projects/:projectId/sources and (Phase 4H-A) POST
 * /api/projects/:projectId/sources/youtube. Requires the caller's Knovera
 * session token — never a Whop token; a project's sources are readable
 * (and, for YouTube, writable) regardless of whether Whop is currently
 * connected.
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

export type SourceProvider = "WHOP" | "YOUTUBE" | "DISCORD";
export type SourceType = "COURSE" | "VIDEO";

export interface WhopProjectSource {
  provider: "WHOP";
  sourceType: "COURSE";
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

/**
 * Phase 4H-A — the first non-Whop project source. Deliberately its own
 * shape rather than forced into WhopProjectSource's fields (no fake
 * courseId/lessonCount/etc.). `status` is source-record readiness, never
 * analysis readiness — Phase 4H-A never analyzes anything, so this is
 * never an analysis-progress indicator.
 */
export interface YouTubeProjectSource {
  provider: "YOUTUBE";
  sourceType: "VIDEO";
  id: number;
  externalId: string;
  sourceUrl: string;
  title: string | null;
  durationSeconds: number | null;
  status: string;
  createdAt: string;
  /** Phase 4K — the source_collections row (a YouTube channel) this video was discovered through, or null for an à-la-carte add. */
  collectionId: number | null;
}

/**
 * Phase 4I — the second non-Whop project source, same shape/reasoning as
 * YouTubeProjectSource. `sourceUrl` is the exact Discord CDN attachment
 * link (signature included), not a normalized form — see
 * lib/discordUrl.ts's doc comment.
 */
export interface DiscordProjectSource {
  provider: "DISCORD";
  sourceType: "VIDEO";
  id: number;
  externalId: string;
  sourceUrl: string;
  title: string | null;
  durationSeconds: number | null;
  status: string;
  createdAt: string;
  /** Phase 4K — always null today (Discord collection discovery is not implemented). */
  collectionId: number | null;
}

export type ProjectSource = WhopProjectSource | YouTubeProjectSource | DiscordProjectSource;

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

export class AddYouTubeSourceError extends Error {
  type: string;

  constructor(message: string, type: string) {
    super(message);
    this.name = "AddYouTubeSourceError";
    this.type = type;
  }
}

export interface AddYouTubeSourceResult {
  source: YouTubeProjectSource;
  /** True when this exact video was already a source of this project — the existing row is returned, nothing new was created. */
  duplicate: boolean;
}

/**
 * Phase 4H-A — POST /api/projects/:projectId/sources/youtube. Adds a
 * public YouTube video's canonical identity as a project source; never
 * fetches the video itself (see backend/src/http/routes/projectSources.ts
 * for the server-side scope). Throws AddYouTubeSourceError (never a
 * generic Error) on a non-2xx response so the caller (AddYouTubeVideoDialog)
 * can show the backend's exact validation message.
 */
export async function addYouTubeSource(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  url: string,
): Promise<AddYouTubeSourceResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/youtube`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new AddYouTubeSourceError(
      body?.error?.message ?? `Failed to add YouTube video (${res.status}).`,
      body?.error?.type ?? "unknown_error",
    );
  }
  return (await res.json()) as AddYouTubeSourceResult;
}

export class AddDiscordSourceError extends Error {
  type: string;

  constructor(message: string, type: string) {
    super(message);
    this.name = "AddDiscordSourceError";
    this.type = type;
  }
}

export interface AddDiscordSourceResult {
  source: DiscordProjectSource;
  /** True when this exact attachment was already a source of this project — the existing row is returned, nothing new was created. */
  duplicate: boolean;
}

/**
 * Phase 4I — POST /api/projects/:projectId/sources/discord. Adds a Discord
 * video attachment's identity as a project source; never fetches the
 * attachment itself (see backend/src/http/routes/projectSources.ts for the
 * server-side scope). Throws AddDiscordSourceError (never a generic Error)
 * on a non-2xx response so the caller (AddDiscordVideoDialog) can show the
 * backend's exact validation message.
 */
export async function addDiscordSource(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  url: string,
): Promise<AddDiscordSourceResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/discord`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new AddDiscordSourceError(
      body?.error?.message ?? `Failed to add Discord video (${res.status}).`,
      body?.error?.type ?? "unknown_error",
    );
  }
  return (await res.json()) as AddDiscordSourceResult;
}
