import type { ProjectType } from "./projects";

/**
 * Client for GET /api/usage — Phase 4F's project-aware current-month spend
 * dashboard. Same conventions as projectsApi.ts/synthesisApi.ts: every call
 * needs the Knovera session token as a bearer header, never a Whop token —
 * this is a pure read of persisted Postgres data (analysis/synthesis cost
 * grouped by courses.project_id), unaffected by whether Whop is connected.
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

export interface UsagePeriod {
  start: string;
  end: string;
  label: string;
}

export interface UsageTotal {
  analysisCost: number;
  synthesisCost: number;
  totalCost: number;
}

export interface ProjectUsage {
  projectId: number;
  projectName: string;
  projectType: ProjectType;
  analysisCost: number;
  synthesisCost: number;
  totalCost: number;
  analysisRuns: number;
  lessonsAnalyzed: number;
  /** Phase 4H-B — distinct YouTube project_sources analyzed this period; kept separate from lessonsAnalyzed (a source is not a lesson) even though both roll into analysisCost/analysisRuns. */
  sourcesAnalyzed: number;
  synthesisRuns: number;
}

export interface UsageResponse {
  period: UsagePeriod;
  total: UsageTotal;
  projects: ProjectUsage[];
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => undefined);
  return body?.error?.message ?? fallback;
}

export async function getCurrentMonthUsage(backendUrl: string, knoveraToken: string): Promise<UsageResponse> {
  const res = await fetch(`${backendUrl}/api/usage?period=current_month`, { headers: authHeaders(knoveraToken) });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, `Failed to load usage (${res.status}).`));
  }
  return (await res.json()) as UsageResponse;
}
