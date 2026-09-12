/**
 * Client for POST /api/projects/:projectId/sources/:sourceId/add-to-projects
 * (Phase 4K-B revised) — makes an already-captured Discord source's durable
 * content available in one or more OTHER projects, of any project type,
 * without copying media or re-analyzing. The source stays exactly where it
 * was (e.g. in Discord Knowledge) — this only creates additional
 * references. See backend/src/http/routes/projectSources.ts's
 * createAddProjectSourceToProjectsHandler doc comment for the full
 * semantics (per-target `added`/`already_present`/`unauthorized`/`invalid`
 * results, never a partial top-level failure).
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

export class AddToProjectError extends Error {
  type: string;
  constructor(message: string, type: string) {
    super(message);
    this.name = "AddToProjectError";
    this.type = type;
  }
}

export type AddToProjectResultKind = "added" | "already_present" | "unauthorized" | "invalid";

export interface AddToProjectResultEntry {
  projectId: number;
  kind: AddToProjectResultKind;
}

export interface AddToProjectResponse {
  results: AddToProjectResultEntry[];
}

export async function addProjectSourceToProjects(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  sourceId: number,
  targetProjectIds: number[],
): Promise<AddToProjectResponse> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/${sourceId}/add-to-projects`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ targetProjectIds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new AddToProjectError(body?.error?.message ?? `Failed to add to project (${res.status}).`, body?.error?.type ?? "unknown_error");
  }
  return (await res.json()) as AddToProjectResponse;
}
