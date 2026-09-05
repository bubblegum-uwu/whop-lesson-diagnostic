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

export interface RemuxOptions {
  ffmpegPath?: string;
  timeoutMs?: number;
}

/**
 * Attempts a stream-copy remux first. If ffmpeg exits non-zero (e.g. because
 * the container/codec can't be copied directly, or the signed token has
 * expired and Mux rejects the request), this throws FfmpegRemuxError with a
 * sanitized message — it does NOT automatically fall back to re-encoding,
 * per the "no unnecessary re-encoding" requirement. Callers may retry with
 * `forceReencode: true` if they've decided that's appropriate.
 */
export async function remuxToMp4(
  signedUrl: string,
  outputPath: string,
  options: RemuxOptions = {},
  deps: RemuxDeps = defaultDeps,
): Promise<void> {
  const { ffmpegPath = "ffmpeg", timeoutMs = 25 * 60 * 1000 } = options;
  deps.redactor.register(signedUrl);

  const args = ["-y", "-loglevel", "error", "-i", signedUrl, "-c", "copy", outputPath];

  await new Promise<void>((resolve, reject) => {
    const child = deps.spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FfmpegRemuxError("ffmpeg timed out during remux.", null));
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      // Cap buffered stderr to avoid unbounded memory growth on pathological input.
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
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
