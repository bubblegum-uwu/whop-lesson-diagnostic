import type { SynthesisStatus } from "../db/synthesisRunsRepo.js";

/**
 * The full pipeline as shown to the user — one entry per stage in the
 * "Stage N of 7" / stage-timeline UI. Mirrors runSynthesis.ts's
 * SynthesisStage values (NORMALIZING through DECISION_FRAMEWORK) plus
 * VALIDATING, the persistence step that happens in worker/synthesisLoop.ts
 * after runSynthesis() returns and before the run is marked COMPLETED —
 * not itself a Gemini stage, but real work worth its own line in the
 * timeline ("Finalizing").
 */
export const PROGRESS_STAGE_ORDER = [
  "NORMALIZING",
  "CLUSTERING",
  "CANONICALIZING",
  "CORE_FRAMEWORK",
  "PLAYBOOK",
  "DECISION_FRAMEWORK",
  "VALIDATING",
] as const;
export type ProgressStage = (typeof PROGRESS_STAGE_ORDER)[number];

export function isProgressStage(value: string | null): value is ProgressStage {
  return value != null && (PROGRESS_STAGE_ORDER as readonly string[]).includes(value);
}

/**
 * Deterministic stage weights summing to 100 — chosen from the actual
 * pipeline shape, not arbitrary: CANONICALIZING does one Gemini call per
 * cluster (often the most total work), PLAYBOOK is usually the single
 * largest prompt, VALIDATING is fast pure persistence.
 */
const STAGE_WEIGHTS: Record<ProgressStage, number> = {
  NORMALIZING: 5,
  CLUSTERING: 15,
  CANONICALIZING: 35,
  CORE_FRAMEWORK: 15,
  PLAYBOOK: 20,
  DECISION_FRAMEWORK: 8,
  VALIDATING: 2,
};

const STAGE_LABELS: Record<ProgressStage, string> = {
  NORMALIZING: "Normalizing Strategy Instances",
  CLUSTERING: "Clustering Similar Strategies",
  CANONICALIZING: "Building Canonical Strategies",
  CORE_FRAMEWORK: "Extracting Core Framework",
  PLAYBOOK: "Building Comprehensive Playbook",
  DECISION_FRAMEWORK: "Building Decision Framework",
  VALIDATING: "Validating & Persisting Results",
};

export interface ComputeProgressInput {
  status: SynthesisStatus;
  currentStage: string | null;
  completedItems: number | null;
  totalItems: number | null;
}

export interface ComputedProgress {
  /** 1-based, out of totalStages — "Stage 3 of 7". */
  stageIndex: number;
  totalStages: number;
  stageLabel: string;
  /** 0-100, deterministic stage-weighted — never a fabricated per-second estimate. */
  overallProgress: number;
  /** 0-100 within the current stage, or null when that stage has no countable work (see isIndeterminate). */
  stageProgress: number | null;
  /** True when the current stage has real completed/total counts to show (e.g. "2 of 4 complete"). */
  isCountable: boolean;
  /** True when the current stage is a single indeterminate Gemini call — UI must not invent a percentage for it. */
  isIndeterminate: boolean;
}

/**
 * Deterministic stage-weighted overall progress: full credit for every
 * stage strictly before the current one, plus the current stage's weight
 * scaled by its own completed/total fraction (0 when not countable — never
 * interpolated mid-call). QUEUED is always 0%; COMPLETED is always 100%;
 * FAILED freezes at whatever was last persisted (current_stage/
 * completed_items/total_items are never reset on failure — see
 * markSynthesisFailed), which is exactly the "progress reached" a failed
 * run should show.
 */
export function computeSynthesisProgress(input: ComputeProgressInput): ComputedProgress {
  if (input.status === "COMPLETED") {
    return {
      stageIndex: PROGRESS_STAGE_ORDER.length,
      totalStages: PROGRESS_STAGE_ORDER.length,
      stageLabel: "Completed",
      overallProgress: 100,
      stageProgress: 100,
      isCountable: false,
      isIndeterminate: false,
    };
  }

  if (input.status === "QUEUED" || !isProgressStage(input.currentStage)) {
    return {
      stageIndex: 1,
      totalStages: PROGRESS_STAGE_ORDER.length,
      stageLabel: STAGE_LABELS.NORMALIZING,
      overallProgress: 0,
      stageProgress: null,
      isCountable: false,
      isIndeterminate: false,
    };
  }

  const stage = input.currentStage;
  const stageOrdinal = PROGRESS_STAGE_ORDER.indexOf(stage);
  // A stage "has countable work" exactly when the worker has published a
  // positive total_items for it (normalizing instances, clustering
  // batches, canonicalizing clusters) — a stage that's a single Gemini
  // call (core framework/playbook/decision framework) or a fast
  // deterministic step (validating) never gets a total, so it's always
  // indeterminate here rather than needing its own hardcoded list.
  const isCountable = input.totalItems != null && input.totalItems > 0;
  const fraction = isCountable ? Math.min(1, Math.max(0, (input.completedItems ?? 0) / input.totalItems!)) : 0;
  const stageProgress = isCountable ? Math.round(fraction * 100) : null;

  let overall = 0;
  for (let i = 0; i < stageOrdinal; i++) overall += STAGE_WEIGHTS[PROGRESS_STAGE_ORDER[i]];
  overall += STAGE_WEIGHTS[stage] * fraction;

  return {
    stageIndex: stageOrdinal + 1,
    totalStages: PROGRESS_STAGE_ORDER.length,
    stageLabel: STAGE_LABELS[stage],
    overallProgress: Math.min(100, Math.round(overall)),
    stageProgress,
    isCountable,
    isIndeterminate: !isCountable,
  };
}

export type HeartbeatTier = "none" | "waiting_for_update" | "no_recent_heartbeat" | "waiting_for_recovery";

const WAITING_FOR_UPDATE_SECONDS = 30;
const NO_RECENT_HEARTBEAT_SECONDS = 90;

/**
 * Non-alarming heartbeat semantics, deliberately mirroring the existing
 * lesson-processing UI's tiers: a browser that simply hasn't polled
 * recently must never read as FAILED. "waiting_for_recovery" (the lease
 * itself expired — a worker execution died mid-run) is checked first since
 * it's a stronger, more specific signal than heartbeat age alone. Terminal
 * runs (COMPLETED/FAILED) never show a heartbeat warning — there's nothing
 * left to wait for.
 */
export function computeHeartbeatTier(input: {
  status: SynthesisStatus;
  lastHeartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  now?: Date;
}): HeartbeatTier {
  if (input.status === "COMPLETED" || input.status === "FAILED") return "none";
  const now = input.now ?? new Date();

  if (input.leaseExpiresAt && input.leaseExpiresAt.getTime() < now.getTime()) return "waiting_for_recovery";
  if (!input.lastHeartbeatAt) return "none";

  const ageSeconds = (now.getTime() - input.lastHeartbeatAt.getTime()) / 1000;
  if (ageSeconds < WAITING_FOR_UPDATE_SECONDS) return "none";
  if (ageSeconds < NO_RECENT_HEARTBEAT_SECONDS) return "waiting_for_update";
  return "no_recent_heartbeat";
}
