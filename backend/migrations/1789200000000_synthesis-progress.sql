-- Up Migration

-- Phase 3.4 follow-up: synthesis progress/observability. Purely additive —
-- three new nullable columns on the existing synthesis_runs table so the
-- Course Intelligence UI can show real, persisted progress (stage index,
-- countable item progress, current item) instead of a generic spinner.
-- Reuses every existing ownership/lease/heartbeat column (lease_owner,
-- lease_expires_at, last_heartbeat_at, current_stage, updated_at) as-is —
-- see worker/synthesisLoop.ts and db/synthesisRunsRepo.ts's
-- updateSynthesisProgress(), which is fenced by lease_owner exactly like
-- the existing renewSynthesisLease().
--
-- current_item deliberately stores only a short display label (e.g. a
-- canonical strategy's name) — never prompt content, never raw course
-- material. completed_items/total_items are simple integer counters for
-- whichever stage currently has countable work (normalization instances,
-- clustering batches, or canonical-strategy clusters); both are NULL for
-- stages with a single indeterminate Gemini call (core framework, playbook,
-- decision framework, validating).
ALTER TABLE synthesis_runs
  ADD COLUMN completed_items INTEGER,
  ADD COLUMN total_items     INTEGER,
  ADD COLUMN current_item    TEXT;

-- Down Migration

ALTER TABLE synthesis_runs
  DROP COLUMN completed_items,
  DROP COLUMN total_items,
  DROP COLUMN current_item;
