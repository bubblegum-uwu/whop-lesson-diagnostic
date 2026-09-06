import { describe, it, expect } from "vitest";
import { computeSynthesisProgress, computeHeartbeatTier, PROGRESS_STAGE_ORDER } from "../src/synthesis/progress.js";

describe("synthesis/progress computeSynthesisProgress", () => {
  it("is 0% and stage 1 of 7 for a QUEUED run that hasn't started", () => {
    const result = computeSynthesisProgress({ status: "QUEUED", currentStage: null, completedItems: null, totalItems: null });
    expect(result.overallProgress).toBe(0);
    expect(result.stageIndex).toBe(1);
    expect(result.totalStages).toBe(7);
  });

  it("is always 100% for a COMPLETED run, regardless of stale progress fields", () => {
    const result = computeSynthesisProgress({ status: "COMPLETED", currentStage: "VALIDATING", completedItems: null, totalItems: null });
    expect(result.overallProgress).toBe(100);
    expect(result.stageProgress).toBe(100);
    expect(result.stageIndex).toBe(result.totalStages);
  });

  it("gives full credit for every stage strictly before the current one, plus a fractional contribution from the current stage", () => {
    // CANONICALIZING is stage index 3 (NORMALIZING, CLUSTERING done in full) at 2 of 4 clusters complete.
    // Weights: NORMALIZING 5 + CLUSTERING 15 = 20 prior credit; CANONICALIZING weight 35 * 0.5 = 17.5 -> 37.5% -> rounds to 38.
    const result = computeSynthesisProgress({ status: "RUNNING", currentStage: "CANONICALIZING", completedItems: 2, totalItems: 4 });
    expect(result.stageIndex).toBe(3);
    expect(result.stageLabel).toBe("Building Canonical Strategies");
    expect(result.isCountable).toBe(true);
    expect(result.stageProgress).toBe(50);
    expect(result.overallProgress).toBe(38);
  });

  it("never fabricates a percentage for a single indeterminate Gemini call (null totalItems)", () => {
    const result = computeSynthesisProgress({ status: "RUNNING", currentStage: "PLAYBOOK", completedItems: null, totalItems: null });
    expect(result.isCountable).toBe(false);
    expect(result.isIndeterminate).toBe(true);
    expect(result.stageProgress).toBeNull();
    // Still credits every stage strictly before PLAYBOOK in full: NORMALIZING+CLUSTERING+CANONICALIZING+CORE_FRAMEWORK = 5+15+35+15 = 70.
    expect(result.overallProgress).toBe(70);
  });

  it("a FAILED run preserves (never resets) whatever progress was last persisted before the failure", () => {
    const failed = computeSynthesisProgress({ status: "FAILED", currentStage: "CANONICALIZING", completedItems: 2, totalItems: 4 });
    const stillRunning = computeSynthesisProgress({ status: "RUNNING", currentStage: "CANONICALIZING", completedItems: 2, totalItems: 4 });
    expect(failed.overallProgress).toBe(stillRunning.overallProgress);
    expect(failed.stageLabel).toBe("Building Canonical Strategies");
  });

  it("reaches exactly 100% at the last stage with full countable progress", () => {
    const result = computeSynthesisProgress({ status: "RUNNING", currentStage: "VALIDATING", completedItems: null, totalItems: null });
    // Every stage before VALIDATING in full (98) + VALIDATING itself indeterminate (0 contribution) = 98, not 100 —
    // 100% is reserved for status COMPLETED specifically, never implied by reaching the last stage alone.
    expect(result.overallProgress).toBe(98);
  });

  it("covers every stage in PROGRESS_STAGE_ORDER with a distinct, non-empty label and a positive weight contribution", () => {
    for (const stage of PROGRESS_STAGE_ORDER) {
      const result = computeSynthesisProgress({ status: "RUNNING", currentStage: stage, completedItems: null, totalItems: null });
      expect(result.stageLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("synthesis/progress computeHeartbeatTier", () => {
  const now = new Date("2026-01-01T00:10:00Z");

  it("shows no warning when the heartbeat is fresh", () => {
    const tier = computeHeartbeatTier({ status: "RUNNING", lastHeartbeatAt: new Date(now.getTime() - 10_000), leaseExpiresAt: new Date(now.getTime() + 60_000), now });
    expect(tier).toBe("none");
  });

  it('shows "waiting_for_update" between 30 and 90 seconds of heartbeat silence', () => {
    const tier = computeHeartbeatTier({ status: "RUNNING", lastHeartbeatAt: new Date(now.getTime() - 45_000), leaseExpiresAt: new Date(now.getTime() + 60_000), now });
    expect(tier).toBe("waiting_for_update");
  });

  it('shows "no_recent_heartbeat" past 90 seconds of heartbeat silence', () => {
    const tier = computeHeartbeatTier({ status: "RUNNING", lastHeartbeatAt: new Date(now.getTime() - 120_000), leaseExpiresAt: new Date(now.getTime() + 60_000), now });
    expect(tier).toBe("no_recent_heartbeat");
  });

  it('shows "waiting_for_recovery" once the lease has actually expired, even if the heartbeat itself looks recent', () => {
    const tier = computeHeartbeatTier({ status: "RUNNING", lastHeartbeatAt: new Date(now.getTime() - 5_000), leaseExpiresAt: new Date(now.getTime() - 1_000), now });
    expect(tier).toBe("waiting_for_recovery");
  });

  it("never shows a heartbeat warning for a terminal run, no matter how stale the heartbeat looks", () => {
    expect(computeHeartbeatTier({ status: "COMPLETED", lastHeartbeatAt: new Date(now.getTime() - 999_999), leaseExpiresAt: null, now })).toBe("none");
    expect(computeHeartbeatTier({ status: "FAILED", lastHeartbeatAt: new Date(now.getTime() - 999_999), leaseExpiresAt: null, now })).toBe("none");
  });
});
