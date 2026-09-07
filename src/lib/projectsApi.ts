import type { ProjectType } from "./projects";

/**
 * Client for GET /api/projects[/:projectId] (Phase 4B). Same shape as
 * courseApi.ts: every call needs the caller's own Whop access token as a
 * bearer header — these routes sit behind the same operatorAuth middleware
 * as every course/analysis route, so there is no unauthenticated project
 * data.
 */
function authHeaders(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
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

export async function listProjects(backendUrl: string, accessToken: string): Promise<ProjectSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects`, { headers: authHeaders(accessToken) });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load projects (${res.status}).`));
  }
  const body = (await res.json()) as { projects: ProjectSummary[] };
  return body.projects;
}

export async function getProject(backendUrl: string, accessToken: string, projectId: number): Promise<ProjectSummary | null> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}`, { headers: authHeaders(accessToken) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load project (${res.status}).`));
  }
  const body = (await res.json()) as { project: ProjectSummary };
  return body.project;
}
