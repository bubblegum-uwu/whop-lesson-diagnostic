import { spawn } from "node:child_process";
import { globalRedactor, type SecretRedactor } from "../lib/redact.js";

/**
 * Remuxes an authorized (signed) Mux HLS stream into an MP4 file, preferring
 * a plain container remux (`-c copy`) with no re-encoding. Never logs, and
 * never includes, the signed URL in any output — only sanitized ffmpeg
 * stderr (itself passed through the redactor as a backstop) is surfaced on
 * failure.
 */

export class FfmpegRemuxError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "FfmpegRemuxError";
  }
}

export interface RemuxDeps {
  spawn: typeof spawn;
  redactor: SecretRedactor;
}

const defaultDeps: RemuxDeps = { spawn, redactor: globalRedactor };

export interface RemuxProgress {
  elapsedSeconds: number;
  /** null when no duration could be determined (Whop metadata absent AND ffprobe failed) — indeterminate. */
  totalSeconds: number | null;
}

export interface RemuxOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  /** Skips the ffprobe pre-flight when the caller already knows the duration (e.g. from Whop's video_asset). */
  knownDurationSeconds?: number | null;
  /** When provided, ffmpeg is run with real `-progress pipe:1` tracking instead of the plain fire-and-forget mode. */
  onProgress?: (progress: RemuxProgress) => void;
}

/**
 * Best-effort duration probe via `ffprobe`, used only to compute real
 * `PREPARING_VIDEO` percentage when Whop hasn't reported `duration_seconds`
 * for a lesson yet. Never throws — a probe failure just means progress stays
 * indeterminate (elapsed-only), never a fabricated percentage.
 */
export async function probeDurationSeconds(
  signedUrl: string,
  ffprobePath = "ffprobe",
  deps: RemuxDeps = defaultDeps,
): Promise<number | null> {
  deps.redactor.register(signedUrl);
  return new Promise((resolve) => {
    const child = deps.spawn(
      ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", signedUrl],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const seconds = Number.parseFloat(stdout.trim());
      resolve(Number.isFinite(seconds) ? Math.round(seconds) : null);
    });
  });
}

/**
 * Attempts a stream-copy remux first. If ffmpeg exits non-zero (e.g. because
 * the container/codec can't be copied directly, or the signed token has
 * expired and Mux rejects the request), this throws FfmpegRemuxError with a
 * sanitized message — it does NOT automatically fall back to re-encoding,
 * per the "no unnecessary re-encoding" requirement. Callers may retry with
 * `forceReencode: true` if they've decided that's appropriate.
 *
 * When `onProgress` is given, ffmpeg is asked for real `-progress pipe:1`
 * output and the elapsed media time is parsed from it — never a fabricated
 * percentage. `totalSeconds` comes from `knownDurationSeconds` if the caller
 * has it, else a best-effort `ffprobe` pre-flight (itself allowed to fail
 * into indeterminate progress).
 */
export async function remuxToMp4(
  signedUrl: string,
  outputPath: string,
  options: RemuxOptions = {},
  deps: RemuxDeps = defaultDeps,
): Promise<void> {
  const { ffmpegPath = "ffmpeg", ffprobePath = "ffprobe", timeoutMs = 25 * 60 * 1000, onProgress } = options;
  deps.redactor.register(signedUrl);

  let totalSeconds = options.knownDurationSeconds ?? null;
  if (onProgress && totalSeconds == null) {
    totalSeconds = await probeDurationSeconds(signedUrl, ffprobePath, deps);
  }

  const args = onProgress
    ? ["-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i", signedUrl, "-c", "copy", outputPath]
    : ["-y", "-loglevel", "error", "-i", signedUrl, "-c", "copy", outputPath];

  await new Promise<void>((resolve, reject) => {
    const child = deps.spawn(ffmpegPath, args, { stdio: ["ignore", onProgress ? "pipe" : "ignore", "pipe"] });

    let stderr = "";
    let stdoutBuffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FfmpegRemuxError("ffmpeg timed out during remux.", null));
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      // Cap buffered stderr to avoid unbounded memory growth on pathological input.
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (!onProgress) return;
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) continue;
        const key = line.slice(0, separatorIndex);
        const value = line.slice(separatorIndex + 1);
        if (key === "out_time_us" || key === "out_time_ms") {
          const raw = Number(value);
          if (Number.isFinite(raw)) {
            const elapsedSeconds = key === "out_time_us" ? raw / 1_000_000 : raw / 1_000;
            onProgress({ elapsedSeconds, totalSeconds });
          }
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new FfmpegRemuxError(
          `Failed to start ffmpeg: ${deps.redactor.redact(err.message)}`,
          null,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const sanitizedStderr = deps.redactor.redact(stderr).trim();
      reject(
        new FfmpegRemuxError(
          `ffmpeg exited with code ${code}.${
            sanitizedStderr ? ` Details: ${sanitizedStderr}` : ""
          }`,
          code,
        ),
      );
    });
  });
}
