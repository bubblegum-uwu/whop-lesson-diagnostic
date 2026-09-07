/**
 * Phase 4A — the Knovera Project abstraction, frontend-only for now (no
 * backend /api/projects endpoint exists yet; that's Phase 4B). A typed enum
 * rather than free text, per the Phase 4 spec, so a later real project list
 * (and a real GENERAL_KNOWLEDGE synthesis engine) can be introduced without
 * touching every call site that currently branches on this value.
 */
export const ProjectType = {
  TRADING_STRATEGIES: "TRADING_STRATEGIES",
  GENERAL_KNOWLEDGE: "GENERAL_KNOWLEDGE",
} as const;
export type ProjectType = (typeof ProjectType)[keyof typeof ProjectType];

export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  TRADING_STRATEGIES: "Trading Strategies",
  GENERAL_KNOWLEDGE: "General Knowledge",
};

/** Only TRADING_STRATEGIES has a working synthesis engine (Phase 3.5B) — see CourseIntelligence.tsx. GENERAL_KNOWLEDGE is architecturally selectable but has no synthesis pipeline; nothing here should ever fabricate results for it. */
export const OPERATIONAL_PROJECT_TYPES: ReadonlySet<ProjectType> = new Set([ProjectType.TRADING_STRATEGIES]);

export interface Project {
  /** Stable slug used in routes (e.g. /projects/:projectId/...). Phase 4B will replace this with a real DB id once projects are persisted. */
  id: string;
  name: string;
  type: ProjectType;
}

/**
 * Phase 4A — a single hardcoded project representing everything already
 * built for "The Trading Accelerator" under Phase 3.5B. Phase 4B replaces
 * this with a real `projects` table + `GET /api/projects`; nothing here
 * persists or duplicates data — MasterMind is a label wrapped around the
 * existing single-course backend, which is untouched.
 */
export const MASTERMIND_PROJECT: Project = {
  id: "mastermind",
  name: "MasterMind",
  type: ProjectType.TRADING_STRATEGIES,
};

export const PROJECTS: Project[] = [MASTERMIND_PROJECT];

export function findProject(projectId: string | undefined): Project | null {
  if (!projectId) return null;
  return PROJECTS.find((p) => p.id === projectId) ?? null;
}
