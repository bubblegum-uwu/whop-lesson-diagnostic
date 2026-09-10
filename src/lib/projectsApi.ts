import type { ProjectType } from "./projects";

/**
 * Client for GET /api/projects[/:projectId]. Every call needs the caller's
 * Knovera session token as a bearer header (Phase 4D) — never a Whop token;
 * these are pure reads of persisted Knovera data, unaffected by whether
 * Whop is connected.
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

export interface ProjectSummary {
  id: number;
  name: string;
  projectType: ProjectType;
  createdAt: string;
  updatedAt: string;
  courseCount: number;
  lessonCount: number;
  analyzedLessonCount: number;
  latestSynthesisStatus: string | null;
  latestSynthesisCompletedAt: string | null;
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => undefined);
  return body?.error?.message ?? fallback;
}

export async function listProjects(backendUrl: string, knoveraToken: string): Promise<ProjectSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects`, { headers: authHeaders(knoveraToken) });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load projects (${res.status}).`));
  }
  const body = (await res.json()) as { projects: ProjectSummary[] };
  return body.projects;
}

export async function getProject(backendUrl: string, knoveraToken: string, projectId: number): Promise<ProjectSummary | null> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}`, { headers: authHeaders(knoveraToken) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load project (${res.status}).`));
  }
  const body = (await res.json()) as { project: ProjectSummary };
  return body.project;
}

export class CreateProjectError extends Error {
  type: string;

  constructor(message: string, type: string) {
    super(message);
    this.name = "CreateProjectError";
    this.type = type;
  }
}

/**
 * Phase 4G — POST /api/projects. Creates exactly one project row (see
 * backend/src/db/projectsRepo.ts's createProject doc comment) and returns
 * it in the same shape GET returns, so the caller (NewProjectDialog) can
 * navigate straight to `/projects/${project.id}/sources` from the response
 * alone. Throws CreateProjectError (never a generic Error) on a 400 so
 * callers can keep the dialog open and show the backend's exact validation
 * message rather than a generic failure.
 */
export async function createProject(
  backendUrl: string,
  knoveraToken: string,
  name: string,
  projectType: ProjectType,
): Promise<ProjectSummary> {
  const res = await fetch(`${backendUrl}/api/projects`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name, projectType }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new CreateProjectError(
      body?.error?.message ?? `Failed to create project (${res.status}).`,
      body?.error?.type ?? "unknown_error",
    );
  }
  const body = (await res.json()) as { project: ProjectSummary };
  return body.project;
}
