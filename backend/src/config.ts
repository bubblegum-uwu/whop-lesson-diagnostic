/**
 * Central place for reading environment variables.
 *
 * IMPORTANT: `GEMINI_API_KEY` is read here and passed to the Gemini client,
 * but it is NEVER logged (see lib/logger.ts, which is configured to redact
 * it in every process using `registerRuntimeSecret`).
 */

export interface AppConfig {
  port: number;
  allowedOrigin: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiVideoProcessingMode: "agentic" | "static";
  whopApiBase: string;
  nodeEnv: "development" | "production" | "test";
  maxVideoBytes: number;
  ffmpegPath: string;
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
    nodeEnv,
    maxVideoBytes: env.MAX_VIDEO_BYTES ? Number(env.MAX_VIDEO_BYTES) : 2 * 1024 * 1024 * 1024,
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
  };
}
