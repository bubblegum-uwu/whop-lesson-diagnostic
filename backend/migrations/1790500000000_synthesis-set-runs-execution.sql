-- Up Migration

-- Phase 4M follow-up: adds the minimal lease/claim mechanism needed to
-- safely execute native Synthesis Set Runs (see worker/synthesisSetRunLoop.ts,
-- db/synthesisSetRunsRepo.ts's claimNextEligibleSynthesisSetRun). Purely
-- additive — two nullable columns on the existing synthesis_set_runs table,
-- no other table touched, no existing row's meaning changed. Never touches
-- synthesis_runs/course_playbooks or any recovered legacy Whop run.
--
-- Mirrors synthesis_runs' own lease_owner/lease_expires_at columns
-- (1789100000000_course-synthesis.sql) and claimNextEligibleSynthesisRun's
-- FOR UPDATE SKIP LOCKED claim pattern — a deliberately SIMPLER version
-- without a renewed heartbeat: this phase's executor does not renew the
-- lease mid-run (see synthesisSetRunLoop.ts's own doc comment on why), so
-- the lease duration used at claim time is generous (15 minutes) rather
-- than the 5-minute heartbeat-renewed lease the legacy engine uses. This is
-- a deliberate, documented simplification — "smallest additive mechanism
-- needed" — not an oversight; a future phase can add heartbeat renewal the
-- same way synthesis_runs has it, if a real run ever needs longer than 15
-- minutes.
ALTER TABLE synthesis_set_runs ADD COLUMN lease_owner TEXT;
ALTER TABLE synthesis_set_runs ADD COLUMN lease_expires_at TIMESTAMPTZ;

-- Speeds up the claim query's `WHERE status = 'QUEUED' OR (status = 'RUNNING' AND lease_expires_at < now())`
-- scan — mirrors the equivalent index pattern used for analysis_jobs/synthesis_runs claiming.
CREATE INDEX synthesis_set_runs_claimable_idx ON synthesis_set_runs (status, lease_expires_at);

-- Down Migration

DROP INDEX synthesis_set_runs_claimable_idx;
ALTER TABLE synthesis_set_runs DROP COLUMN lease_expires_at;
ALTER TABLE synthesis_set_runs DROP COLUMN lease_owner;
