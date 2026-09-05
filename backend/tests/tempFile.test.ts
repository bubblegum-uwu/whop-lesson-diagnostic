import { describe, it, expect } from "vitest";
import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withTempMp4File } from "../src/tempFiles/tempFile.js";

describe("withTempMp4File", () => {
  it("provides a writable temp file path and cleans up the directory after success", async () => {
    let capturedDir = "";
    let capturedPath = "";

    const result = await withTempMp4File(async (filePath) => {
      capturedPath = filePath;
      capturedDir = dirname(filePath);
      await writeFile(filePath, "fake mp4 bytes");
      await access(filePath); // should not throw — file exists during fn
      return "done";
    });

    expect(result).toBe("done");
    expect(capturedPath).toMatch(/video\.mp4$/);
    await expect(access(capturedDir)).rejects.toThrow();
  });

  it("still cleans up the directory if fn throws", async () => {
    let capturedDir = "";

    await expect(
      withTempMp4File(async (filePath) => {
        capturedDir = dirname(filePath);
        await writeFile(filePath, "fake mp4 bytes");
        throw new Error("simulated pipeline failure after file was written");
      }),
    ).rejects.toThrow("simulated pipeline failure");

    await expect(access(capturedDir)).rejects.toThrow();
  });

  it("cleans up even if fn never writes the file at all", async () => {
    let capturedDir = "";
    await withTempMp4File(async (filePath) => {
      capturedDir = dirname(filePath);
    });
    await expect(access(capturedDir)).rejects.toThrow();
  });

  it("each invocation gets its own isolated temp directory", async () => {
    const dirs = new Set<string>();
    for (let i = 0; i < 3; i++) {
      await withTempMp4File(async (filePath) => {
        dirs.add(dirname(filePath));
      });
    }
    expect(dirs.size).toBe(3);
  });
});
