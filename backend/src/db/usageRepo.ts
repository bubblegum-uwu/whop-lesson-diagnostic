import type { Pool } from "pg";

export interface UsageDateRange {
  start: Date;
  /** Exclusive upper bound. */
  end: Date;
}

/**
 * Phase 4F — per-project spend for a date range, resolved through the same
 * ownership path as everywhere else in Knovera (`courses.project_id`), never
 * a globally configured course. Two grouped queries rather than one row per
 * project (avoids N+1 as the project count grows) — analysis and synthesis
 * are summed independently since they're genuinely different tables/events,
 * then merged with the caller's full project list in usage.ts so a project
 * with zero activity this period still gets a zero row instead of being
 * silently absent.
 *
 * Cost source of truth: `lesson_analyses.estimated_cost` for analysis (see
 * lessonAnalysesRepo.getCourseSpendSummary — the SAME column the existing
 * lifetime "Course Gemini Spend" figure already reads; `usage_records` is a
 * 1:1, always-identical duplicate of this same value written in the same
 * transaction — see worker/mainLoop.ts — so summing it too would double the
 * total). `synthesis_runs.estimated_cost` for synthesis, regardless of run
 * status: unlike analysis (all-or-nothing — a FAILED analysis_jobs row
 * never gets a lesson_analyses/cost row at all), a synthesis run's
 * estimated_cost is updated incrementally as it progresses (see
 * synthesisRunsRepo.updateSynthesisProgress) and deliberately preserved on
 * FAILED (see markSynthesisFailed's doc comment) — so a failed or
 * still-RUNNING run can genuinely represent real, already-incurred Gemini
 * spend that must count toward usage, not just COMPLETED runs.
 *
 * Month attribution timestamp: `lesson_analyses.completed_at` (always
 * NOT NULL) for analysis; `COALESCE(synthesis_runs.completed_at,
 * synthesis_runs.created_at)` for synthesis, since a RUNNING/QUEUED run has
 * no completed_at yet but its cost was still incurred starting when the run
 * was created.
 */
export interface ProjectUsageRow {
  projectId: number;
  analysisCost: number;
  analysisRuns: number;
  lessonsAnalyzed: number;
  synthesisCost: number;
  synthesisRuns: number;
}

interface AnalysisUsageDbRow {
  project_id: string;
  analysis_cost: string;
  analysis_runs: string;
  lessons_analyzed: string;
}

interface SynthesisUsageDbRow {
  project_id: string;
  synthesis_cost: string;
  synthesis_runs: string;
}

export async function getMonthlyUsageByProject(pool: Pool, range: UsageDateRange): Promise<ProjectUsageRow[]> {
  const [analysisResult, synthesisResult] = await Promise.all([
    pool.query<AnalysisUsageDbRow>(
      `SELECT c.project_id AS project_id,
              COALESCE(SUM(la.estimated_cost), 0) AS analysis_cost,
              COUNT(*) AS analysis_runs,
              COUNT(DISTINCT la.lesson_id) AS lessons_analyzed
       FROM lesson_analyses la
       JOIN lessons l ON l.id = la.lesson_id
       JOIN courses c ON c.id = l.course_id
       WHERE c.project_id IS NOT NULL
         AND la.completed_at >= $1 AND la.completed_at < $2
       GROUP BY c.project_id`,
      [range.start, range.end],
    ),
    pool.query<SynthesisUsageDbRow>(
      `SELECT c.project_id AS project_id,
              COALESCE(SUM(sr.estimated_cost), 0) AS synthesis_cost,
              COUNT(*) AS synthesis_runs
       FROM synthesis_runs sr
       JOIN courses c ON c.id = sr.course_id
       WHERE c.project_id IS NOT NULL
         AND COALESCE(sr.completed_at, sr.created_at) >= $1 AND COALESCE(sr.completed_at, sr.created_at) < $2
       GROUP BY c.project_id`,
      [range.start, range.end],
    ),
  ]);

  const byProject = new Map<number, ProjectUsageRow>();
  function ensure(projectId: number): ProjectUsageRow {
    let row = byProject.get(projectId);
    if (!row) {
      row = { projectId, analysisCost: 0, analysisRuns: 0, lessonsAnalyzed: 0, synthesisCost: 0, synthesisRuns: 0 };
      byProject.set(projectId, row);
    }
    return row;
  }

  for (const row of analysisResult.rows) {
    const usage = ensure(Number(row.project_id));
    usage.analysisCost = Number(row.analysis_cost);
    usage.analysisRuns = Number(row.analysis_runs);
    usage.lessonsAnalyzed = Number(row.lessons_analyzed);
  }
  for (const row of synthesisResult.rows) {
    const usage = ensure(Number(row.project_id));
    usage.synthesisCost = Number(row.synthesis_cost);
    usage.synthesisRuns = Number(row.synthesis_runs);
  }

  return Array.from(byProject.values());
}
