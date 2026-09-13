-- Up Migration

-- Live-validation Fix 4 — `force=true` re-analyze was not actually
-- re-analyzing. The HTTP route correctly bypasses its OWN cache check
-- (findLatestByFingerprint) when `force` is set, and creates a genuinely
-- new project_source_analysis_jobs row — but that row carried nothing to
-- tell the WORKER this was a forced re-run. The worker's own idempotency
-- short-circuit (processOneProjectSourceJob in
-- worker/projectSourceAnalysisLoop.ts) then re-derived the exact same
-- "already have a completed analysis under this fingerprint" answer and
-- immediately marked the new job succeeded WITHOUT ever calling Gemini or
-- persisting a second project_source_analyses row — so "Re-analyze"
-- silently did nothing beyond relabeling the same first result.
--
-- The fix is this one additive column: the job itself now records whether
-- it was force-requested, so the worker can apply its fingerprint
-- short-circuit ONLY to non-forced jobs — never by weakening or salting
-- analysis_fingerprint, which must keep meaning "analyzer/model/input-
-- version identity," not "this particular execution."
--
-- NOT NULL DEFAULT false: every pre-existing row (and every future
-- non-forced Analyze) is unambiguously "not forced" — no backfill
-- ambiguity, no behavior change for the existing idempotent-Analyze path.
ALTER TABLE project_source_analysis_jobs ADD COLUMN force_reanalysis BOOLEAN NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE project_source_analysis_jobs DROP COLUMN force_reanalysis;
