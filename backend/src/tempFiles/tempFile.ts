import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs `fn` with the path to a fresh temp MP4 file inside a dedicated temp
 * directory, and guarantees the temp directory (and everything in it) is
 * removed afterwards — whether `fn` succeeds or throws.
 */
export async function withTempMp4File<T>(
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "whop-lesson-"));
  const filePath = join(dir, "video.mp4");
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
