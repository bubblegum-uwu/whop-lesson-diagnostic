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
  nodeEnv: "development" | "production" | "test";
  maxVideoBytes: number;
  ffmpegPath: string;
  course: ScarfaceCourseConfig;
  db: DbConfig;
  /** Base64-encoded 32-byte key used to encrypt the stored Whop refresh token at rest. */
  refreshTokenEncryptionKey: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
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
  };
}
