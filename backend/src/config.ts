/**
 * Central place for reading environment variables.
 *
 * IMPORTANT: `GEMINI_API_KEY` is read here and passed to the Gemini client,
 * but it is NEVER logged (see lib/logger.ts, which is configured to redact
 * it in every process using `registerRuntimeSecret`).
 */

/** The one Scarface course this deployment targets — never scattered as raw string literals. */
export interface ScarfaceCourseConfig {
  courseId: string;
  experienceId: string;
  slug: string;
}

export interface DbConfig {
  /** Unix socket directory (Cloud SQL, e.g. "/cloudsql/PROJECT:REGION:INSTANCE") or a TCP host. */
  host: string;
  /** Ignored when `host` is a Cloud SQL unix socket path. */
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface AppConfig {
  port: number;
  allowedOrigin: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiVideoProcessingMode: "agentic" | "static";
  whopApiBase: string;
  whopClientId: string;
  /**
   * The ONLY Whop user allowed to become (or remain) this deployment's
   * operator. The deployment configuration is the root of trust for who
   * may hold `auth_sessions` — never "whoever authenticates first" and
   * never the database's own current contents. See requireOperator and
   * http/routes/auth.ts.
   */
  whopOperatorUserId: string;
  nodeEnv: "development" | "production" | "test";
  maxVideoBytes: number;
  ffmpegPath: string;
  course: ScarfaceCourseConfig;
  db: DbConfig;
  /** Base64-encoded 32-byte key used to encrypt the stored Whop refresh token at rest. */
  refreshTokenEncryptionKey: string;
  /**
   * "api" mounts the public, operator-gated HTTP routes (default — the
   * existing whop-lesson-gemini-backend Cloud Run SERVICE). "worker" runs
   * the PR2 batch-analysis claim loop and mounts NO HTTP routes at all —
   * this is the Cloud Run JOB entrypoint (see workerMain.ts). Both roles
   * ship in the same container image; the image never exposes the worker's
   * code as a public route.
   */
  serviceRole: "api" | "worker";
  /** Only required for serviceRole "api" — used to trigger Cloud Run Job executions and verify the Scheduler's OIDC identity. */
  gcpProjectId: string | undefined;
  gcpRegion: string;
  cloudRunJobName: string | undefined;
  /** The Google service account Cloud Scheduler uses to call POST /internal/ensure-worker-running — the ONLY identity that route trusts. */
  schedulerServiceAccountEmail: string | undefined;
  /** This service's own public URL — the expected `aud` claim on the Scheduler's OIDC token. */
  publicApiBaseUrl: string | undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const WHOP_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;

/**
 * Fails application startup outright — never a runtime fallback to
 * "first authenticated user wins" — if `WHOP_OPERATOR_USER_ID` is missing
 * or doesn't look like a real Whop user id.
 */
function requireWhopOperatorUserId(env: NodeJS.ProcessEnv): string {
  const value = env.WHOP_OPERATOR_USER_ID;
  if (!value) {
    throw new Error(
      "Missing required environment variable: WHOP_OPERATOR_USER_ID. " +
        "This must be set to the Whop user id (e.g. \"user_xxxxxxxxxxxxx\") of the " +
        "one operator allowed to use this deployment — see backend/README.md.",
    );
  }
  if (!WHOP_USER_ID_PATTERN.test(value)) {
    throw new Error(
      `WHOP_OPERATOR_USER_ID must look like a Whop user id ("user_" followed by ` +
        `alphanumeric characters), got: "${value}"`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV as AppConfig["nodeEnv"]) || "development";

  return {
    port: env.PORT ? Number(env.PORT) : 8080,
    allowedOrigin: env.ALLOWED_ORIGIN || requireEnv("ALLOWED_ORIGIN"),
    geminiApiKey: env.GEMINI_API_KEY || requireEnv("GEMINI_API_KEY"),
    geminiModel: env.GEMINI_MODEL || "gemini-3.8-flash",
    geminiVideoProcessingMode:
      (env.GEMINI_VIDEO_PROCESSING_MODE as AppConfig["geminiVideoProcessingMode"]) ||
      "agentic",
    whopApiBase: env.WHOP_API_BASE || "https://api.whop.com/api/v1",
    whopClientId: env.WHOP_CLIENT_ID || requireEnv("WHOP_CLIENT_ID"),
    whopOperatorUserId: requireWhopOperatorUserId(env),
    nodeEnv,
    maxVideoBytes: env.MAX_VIDEO_BYTES ? Number(env.MAX_VIDEO_BYTES) : 2 * 1024 * 1024 * 1024,
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
    course: {
      courseId: env.WHOP_COURSE_ID || requireEnv("WHOP_COURSE_ID"),
      experienceId: env.WHOP_EXPERIENCE_ID || requireEnv("WHOP_EXPERIENCE_ID"),
      slug: env.WHOP_COURSE_SLUG || requireEnv("WHOP_COURSE_SLUG"),
    },
    db: {
      host: env.INSTANCE_CONNECTION_NAME
        ? `/cloudsql/${env.INSTANCE_CONNECTION_NAME}`
        : env.DB_HOST || "localhost",
      port: env.DB_PORT ? Number(env.DB_PORT) : 5432,
      user: env.DB_USER || requireEnv("DB_USER"),
      password: env.DB_PASSWORD || requireEnv("DB_PASSWORD"),
      database: env.DB_NAME || requireEnv("DB_NAME"),
    },
    refreshTokenEncryptionKey:
      env.REFRESH_TOKEN_ENCRYPTION_KEY || requireEnv("REFRESH_TOKEN_ENCRYPTION_KEY"),
    serviceRole: env.SERVICE_ROLE === "worker" ? "worker" : "api",
    gcpProjectId: env.GCP_PROJECT_ID,
    gcpRegion: env.GCP_REGION || "us-central1",
    cloudRunJobName: env.CLOUD_RUN_JOB_NAME,
    schedulerServiceAccountEmail: env.SCHEDULER_SERVICE_ACCOUNT_EMAIL,
    publicApiBaseUrl: env.PUBLIC_API_BASE_URL,
  };
}

/** Only the "api" role needs these — called from app.ts before wiring the batch-processing routes. */
export function requireApiRoleEnv(config: AppConfig): {
  gcpProjectId: string;
  cloudRunJobName: string;
  schedulerServiceAccountEmail: string;
  publicApiBaseUrl: string;
} {
  if (!config.gcpProjectId) throw new Error("Missing required environment variable: GCP_PROJECT_ID");
  if (!config.cloudRunJobName) throw new Error("Missing required environment variable: CLOUD_RUN_JOB_NAME");
  if (!config.schedulerServiceAccountEmail) {
    throw new Error("Missing required environment variable: SCHEDULER_SERVICE_ACCOUNT_EMAIL");
  }
  if (!config.publicApiBaseUrl) throw new Error("Missing required environment variable: PUBLIC_API_BASE_URL");
  return {
    gcpProjectId: config.gcpProjectId,
    cloudRunJobName: config.cloudRunJobName,
    schedulerServiceAccountEmail: config.schedulerServiceAccountEmail,
    publicApiBaseUrl: config.publicApiBaseUrl,
  };
}
