import type { Request, Response } from "express";
import type { Pool } from "pg";
import { listProjects, type ProjectType } from "../../db/projectsRepo.js";
import { getMonthlyUsageByProject, type UsageDateRange } from "../../db/usageRepo.js";

export interface UsageRouteDeps {
  pool: Pool;
}

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Phase 4F — the current UTC calendar month, [start, end) with `end`
 * exclusive. UTC (not the server's local time, and not "the last 30 days")
 * per the repo's existing backend/DB convention — every timestamp column
 * here is already TIMESTAMPTZ compared in UTC.
 */
function currentMonthRange(now: Date = new Date()): UsageDateRange & { label: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end, label: MONTH_LABEL_FORMATTER.format(start) };
}

/** Rounds to 2dp for display only — the underlying NUMERIC(10,4) columns and their sums are never truncated before this final serialization step. */
function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * GET /api/usage?period=current_month — project-aware spend for the
 * requested period (only "current_month" is implemented in Phase 4F; any
 * other value is a deterministic 400 rather than silently falling back).
 * Every project this operator owns is included, even with zero spend (see
 * projectsRepo.listProjects + getMonthlyUsageByProject's zero-row merge) —
 * a project is never hidden just because nothing was spent on it this
 * month. Gated by Knovera auth only: this reads persisted Postgres data
 * and never calls Whop.
 */
export function createGetUsageHandler(deps: UsageRouteDeps) {
  return async function getUsageHandler(req: Request, res: Response): Promise<void> {
    const period = typeof req.query.period === "string" ? req.query.period : "current_month";
    if (period !== "current_month") {
      res.status(400).json({
        error: { message: `Unsupported usage period "${period}". Only "current_month" is available today.`, type: "unsupported_period" },
      });
      return;
    }

    const { start, end, label } = currentMonthRange();
    const [projects, usageRows] = await Promise.all([listProjects(deps.pool), getMonthlyUsageByProject(deps.pool, { start, end })]);
    const usageByProject = new Map(usageRows.map((row) => [row.projectId, row]));

    let totalAnalysisCost = 0;
    let totalSynthesisCost = 0;

    const projectUsage = projects.map((project) => {
      const usage = usageByProject.get(project.id);
      const analysisCost = usage?.analysisCost ?? 0;
      const synthesisCost = usage?.synthesisCost ?? 0;
      totalAnalysisCost += analysisCost;
      totalSynthesisCost += synthesisCost;

      return {
        projectId: project.id,
        projectName: project.name,
        projectType: project.projectType as ProjectType,
        analysisCost: roundCurrency(analysisCost),
        synthesisCost: roundCurrency(synthesisCost),
        totalCost: roundCurrency(analysisCost + synthesisCost),
        analysisRuns: usage?.analysisRuns ?? 0,
        lessonsAnalyzed: usage?.lessonsAnalyzed ?? 0,
        synthesisRuns: usage?.synthesisRuns ?? 0,
      };
    });

    res.status(200).json({
      period: { start: start.toISOString(), end: end.toISOString(), label },
      total: {
        analysisCost: roundCurrency(totalAnalysisCost),
        synthesisCost: roundCurrency(totalSynthesisCost),
        totalCost: roundCurrency(totalAnalysisCost + totalSynthesisCost),
      },
      projects: projectUsage,
    });
  };
}
