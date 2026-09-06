import { describe, it, expect, vi } from "vitest";

const runJob = vi.fn().mockResolvedValue([{}]);
const jobPath = vi.fn((project: string, location: string, job: string) => `projects/${project}/locations/${location}/jobs/${job}`);
vi.mock("@google-cloud/run", () => ({
  JobsClient: vi.fn(function MockJobsClient(this: { runJob: typeof runJob; jobPath: typeof jobPath }) {
    this.runJob = runJob;
    this.jobPath = jobPath;
  }),
}));

const { createJobTrigger } = await import("../src/jobs/runJobTrigger.js");

describe("createJobTrigger", () => {
  it("triggers a run against the correctly-built Job resource name", async () => {
    const trigger = createJobTrigger({ projectId: "scarface-video-ai", region: "us-central1", jobName: "whop-lesson-gemini-worker" });
    await trigger.triggerRun();

    expect(jobPath).toHaveBeenCalledWith("scarface-video-ai", "us-central1", "whop-lesson-gemini-worker");
    expect(runJob).toHaveBeenCalledWith({
      name: "projects/scarface-video-ai/locations/us-central1/jobs/whop-lesson-gemini-worker",
    });
  });

  it("resolves as soon as the execution is accepted (fire-and-forget — never awaits lesson processing)", async () => {
    // The mock resolves immediately regardless of any lesson-processing time,
    // which is exactly the contract triggerRun() depends on: runJob() only
    // waits for the Cloud Run Admin API to ACCEPT the execution request.
    const trigger = createJobTrigger({ projectId: "p", region: "us-central1", jobName: "j" });
    await expect(trigger.triggerRun()).resolves.toBeUndefined();
  });
});
