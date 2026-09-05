import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { remuxToMp4, FfmpegRemuxError } from "../src/ffmpeg/remux.js";
import { createSecretRedactor } from "../src/lib/redact.js";

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: (signal: string) => void;
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("remuxToMp4", () => {
  it("resolves when ffmpeg exits with code 0 (successful stream copy)", async () => {
    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0));
      return child as never;
    });
    const redactor = createSecretRedactor();

    await expect(
      remuxToMp4("https://stream.mux.com/pb.m3u8?token=secret", "/tmp/out.mp4", {}, { spawn, redactor }),
    ).resolves.toBeUndefined();
  });

  it("never includes the signed URL in the spawned ffmpeg args logged anywhere (spawn is called with the url as an arg, but that's process-local, not logged)", async () => {
    const child = makeFakeChild();
    const capturedArgs: string[][] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      capturedArgs.push(args);
      queueMicrotask(() => child.emit("close", 0));
      return child as never;
    });
    const redactor = createSecretRedactor();
    const signedUrl = "https://stream.mux.com/pb.m3u8?token=veryveryverysecrettoken";

    await remuxToMp4(signedUrl, "/tmp/out.mp4", {}, { spawn, redactor });

    // ffmpeg does need the real URL as an argument to do its job...
    expect(capturedArgs[0]).toContain(signedUrl);
    // ...but the redactor must have it registered so nothing downstream can log it.
    expect(redactor.redact(signedUrl)).not.toContain("veryveryverysecrettoken");
  });

  it("rejects with a sanitized FfmpegRemuxError on non-zero exit, without leaking the signed URL/token", async () => {
    const child = makeFakeChild();
    const signedUrl = "https://stream.mux.com/pb.m3u8?token=leaky-token-value-123456";
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit(
          "data",
          Buffer.from(`HTTP error 403 Forbidden fetching ${signedUrl}\n`),
        );
        child.emit("close", 1);
      });
      return child as never;
    });
    const redactor = createSecretRedactor();
    redactor.register(signedUrl);

    let caught: unknown;
    try {
      await remuxToMp4(signedUrl, "/tmp/out.mp4", {}, { spawn, redactor });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FfmpegRemuxError);
    const message = (caught as FfmpegRemuxError).message;
    expect(message).not.toContain("leaky-token-value-123456");
    expect(message).not.toContain(signedUrl);
    expect((caught as FfmpegRemuxError).exitCode).toBe(1);
  });

  it("treats a 403 from an expired Mux token as a normal ffmpeg failure (no special-case bypass, no retry loop)", async () => {
    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("Server returned 403 Forbidden\n"));
        child.emit("close", 8);
      });
      return child as never;
    });

    await expect(
      remuxToMp4("https://stream.mux.com/pb.m3u8?token=expired", "/tmp/out.mp4", {}, { spawn, redactor: createSecretRedactor() }),
    ).rejects.toThrow(/ffmpeg exited with code 8/);
  });

  it("rejects with FfmpegRemuxError if the ffmpeg binary itself fails to start", async () => {
    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ffmpeg ENOENT")));
      return child as never;
    });

    await expect(
      remuxToMp4("https://stream.mux.com/pb.m3u8?token=x", "/tmp/out.mp4", {}, { spawn, redactor: createSecretRedactor() }),
    ).rejects.toThrow(/Failed to start ffmpeg/);
  });
});
