import type { ProjectSummary } from "./projectsApi";

/**
 * The Knovera Project abstraction. A typed enum rather than free text, so a
 * real GENERAL_KNOWLEDGE synthesis engine can be introduced later without
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

/**
 * Phase 4B — the pre-Phase-4B routes used the fixed slug "mastermind"
 * (there was only ever one hardcoded project). Real projects now have a
 * numeric backend id, but old links/bookmarks to `/projects/mastermind/...`
 * should keep working rather than 404ing. Rather than adding a `slug`
 * column to `projects` for this one legacy alias, `resolveProjectRoute`
 * below resolves it by name against the fetched project list; new links
 * (e.g. from the Projects page) use the real numeric id going forward. If a
 * second project is ever added, this alias only ever matches "MasterMind"
 * by name — see the Phase 4B PR description for why a schema field wasn't
 * warranted here.
 */
export const MASTERMIND_ROUTE_SLUG = "mastermind";

/** Resolves a `:projectId` route param (the legacy slug, or a real numeric id as a string) against a fetched project list. Returns null if nothing matches. */
export function resolveProjectRoute(projects: ProjectSummary[], routeParam: string | undefined): ProjectSummary | null {
  if (!routeParam) return null;
  if (routeParam === MASTERMIND_ROUTE_SLUG) {
    return projects.find((p) => p.name === "MasterMind") ?? null;
  }
  const numericId = Number(routeParam);
  if (!Number.isInteger(numericId)) return null;
  return projects.find((p) => p.id === numericId) ?? null;
}
