import type { Pool } from "pg";
import { listSourceCollectionsByProjectId, listSourceCollectionsByProjectIds } from "./sourceCollectionsRepo.js";
import { listDerivedGroupsForProject, listDerivedGroupsForProjects } from "./derivedSourceGroupsRepo.js";
import { getCoursesByProjectId, getCourseCountsByProjectIds } from "./coursesRepo.js";
import { listAlaCarteWhopLessonsByProjectId, getAlaCarteWhopLessonCountsByProjectIds } from "./whopLessonImportsRepo.js";

export type ProjectType = "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE";

export interface Project {
  id: number;
  name: string;
  projectType: ProjectType;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cheap, per-project rollup used by the Projects list/detail views. Derived
 * entirely from existing courses/lessons/lesson_analyses/synthesis_runs via
 * project_id — never a new denormalized counter column (see the Phase 4B
 * migration's comment: project ownership is derived through `courses`, not
 * stored redundantly on every downstream table).
 */
export interface ProjectStats {
  courseCount: number;
  lessonCount: number;
  analyzedLessonCount: number;
  latestSynthesisStatus: string | null;
  latestSynthesisCompletedAt: Date | null;
  /**
   * Live-validation cleanup — a generic count of this project's
   * `project_sources` rows (YouTube/Discord — see projectSourcesRepo.ts),
   * independent of `courseCount`/`lessonCount` (which are Whop-only, via
   * `courses`). Added so the Projects page can show an accurate source
   * signal for a project whose only sources are YouTube/Discord, instead
   * of falling back to "No sources yet" just because courseCount is 0.
   */
  projectSourceCount: number;
}

export type ProjectWithStats = Project & ProjectStats;

interface ProjectRow {
  id: string;
  name: string;
  project_type: ProjectType;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ProjectRow): Project {
  return {
    id: Number(row.id),
    name: row.name,
    projectType: row.project_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = "id, name, project_type, created_at, updated_at";

export async function listProjects(pool: Pool): Promise<Project[]> {
  const result = await pool.query(`SELECT ${COLUMNS} FROM projects ORDER BY created_at ASC`);
  return result.rows.map(mapRow);
}

/**
 * Phase 4G — inserts exactly ONE `projects` row and nothing else: no course,
 * lesson, analysis, synthesis_runs, or usage_records row is ever created
 * alongside it. Isolation from every other project (including MasterMind)
 * falls out for free from how ownership is derived everywhere else in this
 * codebase — `courses.project_id`, and everything joined through it — so a
 * brand-new project with no course row legitimately has zero sources, zero
 * lessons, zero synthesis, and zero usage from the moment this INSERT
 * commits, with no separate cleanup or seeding required here.
 */
export async function createProject(pool: Pool, name: string, projectType: ProjectType): Promise<Project> {
  const result = await pool.query(
    `INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [name, projectType],
  );
  return mapRow(result.rows[0]);
}

export async function getProjectById(pool: Pool, id: number): Promise<Project | null> {
  const result = await pool.query(`SELECT ${COLUMNS} FROM projects WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Pre-4M — a stable-identifier lookup (name + type, rather than a hardcoded PK) for the legacy Whop synthesis recovery script (scripts/recoverLegacyWhopSynthesis.ts), which must never assume a particular project's database id. `name` is not globally unique by schema, so this returns the first match by id (deterministic, not "latest") — good enough for a single-operator deployment's one MasterMind project. */
export async function getProjectByName(pool: Pool, name: string, projectType: ProjectType): Promise<Project | null> {
  const result = await pool.query(`SELECT ${COLUMNS} FROM projects WHERE name = $1 AND project_type = $2 ORDER BY id ASC LIMIT 1`, [name, projectType]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function getProjectForCourse(pool: Pool, courseId: number): Promise<Project | null> {
  const result = await pool.query(
    `SELECT p.id, p.name, p.project_type, p.created_at, p.updated_at
     FROM projects p
     JOIN courses c ON c.project_id = p.id
     WHERE c.id = $1`,
    [courseId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Four small, independently-indexed reads rather than one large join — each
 * mirrors an existing query shape elsewhere in this codebase (e.g.
 * analysisSummary's per-course counts, synthesisRunsRepo's latest-run
 * lookup), kept separate so this stays easy to reason about even though a
 * project has at most one course today.
 */
export async function getProjectStats(pool: Pool, projectId: number): Promise<ProjectStats> {
  const [courseCountResult, lessonCountResult, analyzedCountResult, latestSynthesisResult, projectSourceCountResult] = await Promise.all([
    pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM courses WHERE project_id = $1`, [projectId]),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM lessons l JOIN courses c ON c.id = l.course_id WHERE c.project_id = $1`,
      [projectId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT la.lesson_id) AS count
       FROM lesson_analyses la
       JOIN lessons l ON l.id = la.lesson_id
       JOIN courses c ON c.id = l.course_id
       WHERE c.project_id = $1`,
      [projectId],
    ),
    pool.query<{ status: string; completed_at: Date | null }>(
      `SELECT sr.status, sr.completed_at
       FROM synthesis_runs sr
       JOIN courses c ON c.id = sr.course_id
       WHERE c.project_id = $1
       ORDER BY sr.created_at DESC
       LIMIT 1`,
      [projectId],
    ),
    pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_sources WHERE project_id = $1`, [projectId]),
  ]);

  const latest = latestSynthesisResult.rows[0];
  return {
    courseCount: Number(courseCountResult.rows[0].count),
    lessonCount: Number(lessonCountResult.rows[0].count),
    analyzedLessonCount: Number(analyzedCountResult.rows[0].count),
    latestSynthesisStatus: latest?.status ?? null,
    latestSynthesisCompletedAt: latest?.completed_at ?? null,
    projectSourceCount: Number(projectSourceCountResult.rows[0].count),
  };
}

/**
 * Phase 4L follow-up — the canonical "N collections" count for ONE project:
 * every card that would render on that project's Sources page — persisted
 * `source_collections` rows, derived groups (YouTube-via-Discord-channel,
 * YouTube à-la-carte, Unclassified) with at least one current member, Whop
 * courses, and the Whop à-la-carte group counted once if it has any
 * members. Reuses the EXACT SAME resolvers the Sources page, Analyze
 * Collection, and Synthesis Set selection already share (see
 * derivedSourceGroupsRepo.ts's doc comment) — never a second, independently
 * reconstructed definition of "collection". For the Projects LIST (many
 * projects at once), use getCollectionCountsForProjects below instead — it
 * batches every one of these four lookups into one round trip each rather
 * than looping this function once per project.
 */
export async function getCollectionCountForProject(pool: Pool, projectId: number): Promise<number> {
  const [persisted, derived, courses, alaCarteLessons] = await Promise.all([
    listSourceCollectionsByProjectId(pool, projectId),
    listDerivedGroupsForProject(pool, projectId),
    getCoursesByProjectId(pool, projectId),
    listAlaCarteWhopLessonsByProjectId(pool, projectId),
  ]);
  return persisted.length + derived.length + courses.length + (alaCarteLessons.length > 0 ? 1 : 0);
}

/**
 * Batched sibling of getCollectionCountForProject — computes the SAME
 * canonical collection count for every one of `projectIds` using exactly
 * four round trips total (never one set of queries per project), so the
 * Projects list page never N+1s to show its "N collections" cards. A
 * project with zero collections/groups simply gets 0 (Map.get's default),
 * never a missing entry that would render as blank.
 */
export async function getCollectionCountsForProjects(pool: Pool, projectIds: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (projectIds.length === 0) return result;

  const [persistedByProject, derivedByProject, courseCounts, alaCarteCounts] = await Promise.all([
    listSourceCollectionsByProjectIds(pool, projectIds),
    listDerivedGroupsForProjects(pool, projectIds),
    getCourseCountsByProjectIds(pool, projectIds),
    getAlaCarteWhopLessonCountsByProjectIds(pool, projectIds),
  ]);

  for (const projectId of projectIds) {
    const persistedCount = persistedByProject.get(projectId)?.length ?? 0;
    const derivedCount = derivedByProject.get(projectId)?.length ?? 0;
    const courseCount = courseCounts.get(projectId) ?? 0;
    const alaCarteCount = alaCarteCounts.get(projectId) ?? 0;
    result.set(projectId, persistedCount + derivedCount + courseCount + (alaCarteCount > 0 ? 1 : 0));
  }
  return result;
}
