import { JobsClient } from "@google-cloud/run";

/**
 * Triggers a Cloud Run Job execution asynchronously (fire-and-forget — the
 * caller must never await lesson processing itself). Authenticates using
 * Application Default Credentials: on Cloud Run this is the calling
 * service's own runtime service account, which must be granted
 * `roles/run.invoker` scoped to ONLY this Job resource (see backend/README.md).
 */
export interface JobTrigger {
  triggerRun(): Promise<void>;
}

export interface JobTriggerConfig {
  projectId: string;
  region: string;
  jobName: string;
}

export function createJobTrigger(config: JobTriggerConfig): JobTrigger {
  const client = new JobsClient();
  const name = client.jobPath(config.projectId, config.region, config.jobName);

  async function triggerRun(): Promise<void> {
    // runJob() resolves once the execution is *accepted*, not once it
    // finishes — this is what makes triggering here safe to call from a
    // request handler without blocking the HTTP response on lesson work.
    await client.runJob({ name });
  }

  return { triggerRun };
}
