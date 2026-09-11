import type { Pool } from "pg";

/**
 * Phase 4K — a LIGHTWEIGHT, batched analysis-readiness summary for
 * catalog/collection list views (source-collections detail, Whop course
 * lesson lists). Deliberately its own small query, not a reuse of
 * projectSourceAnalysesRepo.getLatestByProjectSource /
 * projectSourceAnalysisJobsRepo.getLatestJobForProjectSource in a loop —
 * those are exactly right for a single-source detail view (Phase 4H-B's
 * SourcesPage row), but a collection can hold hundreds of items (spec
 * section 46/63's N+1 warning), so this does the whole batch in one round
 * trip and returns status only — never the full `validated_json` analysis
 * payload (spec section 47).
 *
 * Mirrors SourcesPage.tsx's own existing status derivation exactly, as a
 * SQL batch instead of N client-side per-item derivations: "analyzed"
 * means a completed/no_strategy analysis exists at all (independent of
 * the latest job — the same definition Phase 4J's readiness computation
 * and the Whop canSynthesizeNow check both already use); otherwise the
 * latest job's own status (QUEUED/ANALYZING/VALIDATING/FAILED/CANCELLED)
 * if one was ever attempted, or "NOT_ANALYZED" if never attempted at all.
 */
export type CatalogAnalysisStatus = "NOT_ANALYZED" | "QUEUED" | "ANALYZING" | "VALIDATING" | "ANALYZED" | "FAILED" | "CANCELLED";

export interface CatalogAnalysisStatusEntry {
  status: CatalogAnalysisStatus;
  /** True only for a usable completed/no_strategy analysis — the exact "future synthesis eligibility" signal (Phase 4K spec section 33). */
  eligibleForSynthesis: boolean;
}

const EMPTY_ENTRY: CatalogAnalysisStatusEntry = { status: "NOT_ANALYZED", eligibleForSynthesis: false };

/** Batched over an arbitrary list of project_source ids — safe to call with zero, one, or hundreds. */
export async function getCatalogAnalysisStatusForSources(pool: Pool, projectSourceIds: number[]): Promise<Map<number, CatalogAnalysisStatusEntry>> {
  if (projectSourceIds.length === 0) return new Map();

  const [analyzedResult, latestJobResult] = await Promise.all([
    pool.query<{ project_source_id: string }>(
      `SELECT DISTINCT project_source_id FROM project_source_analyses WHERE project_source_id = ANY($1) AND status IN ('completed', 'no_strategy')`,
      [projectSourceIds],
    ),
    pool.query<{ project_source_id: string; status: string }>(
      `SELECT DISTINCT ON (project_source_id) project_source_id, status
       FROM project_source_analysis_jobs
       WHERE project_source_id = ANY($1)
       ORDER BY project_source_id, created_at DESC`,
      [projectSourceIds],
    ),
  ]);

  const analyzedIds = new Set(analyzedResult.rows.map((r) => Number(r.project_source_id)));
  const latestJobBySource = new Map(latestJobResult.rows.map((r) => [Number(r.project_source_id), r.status]));

  const result = new Map<number, CatalogAnalysisStatusEntry>();
  for (const id of projectSourceIds) {
    if (analyzedIds.has(id)) {
      result.set(id, { status: "ANALYZED", eligibleForSynthesis: true });
      continue;
    }
    const jobStatus = latestJobBySource.get(id);
    if (!jobStatus) {
      result.set(id, EMPTY_ENTRY);
      continue;
    }
    result.set(id, { status: jobStatus as CatalogAnalysisStatus, eligibleForSynthesis: false });
  }
  return result;
}
