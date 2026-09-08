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
