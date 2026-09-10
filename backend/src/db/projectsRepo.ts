import type { Pool } from "pg";

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
  const [courseCountResult, lessonCountResult, analyzedCountResult, latestSynthesisResult] = await Promise.all([
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
  ]);

  const latest = latestSynthesisResult.rows[0];
  return {
    courseCount: Number(courseCountResult.rows[0].count),
    lessonCount: Number(lessonCountResult.rows[0].count),
    analyzedLessonCount: Number(analyzedCountResult.rows[0].count),
    latestSynthesisStatus: latest?.status ?? null,
    latestSynthesisCompletedAt: latest?.completed_at ?? null,
  };
}
