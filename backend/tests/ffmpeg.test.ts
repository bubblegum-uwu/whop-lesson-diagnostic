import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { remuxToMp4, probeDurationSeconds, FfmpegRemuxError, type RemuxProgress } from "../src/ffmpeg/remux.js";
import { createSecretRedactor } from "../src/lib/redact.js";

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
    kill: (signal: string) => void;
  };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
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

  describe("real progress reporting (PR2)", () => {
    it("parses out_time_us lines from -progress pipe:1 and reports elapsed/total seconds", async () => {
      const child = makeFakeChild();
      const spawn = vi.fn((_cmd: string, args: string[]) => {
        expect(args).toContain("-progress");
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("out_time_us=5000000\nprogress=continue\n"));
          child.stdout.emit("data", Buffer.from("out_time_us=10000000\nprogress=continue\n"));
          child.emit("close", 0);
        });
        return child as never;
      });

      const progressEvents: RemuxProgress[] = [];
      await remuxToMp4(
        "https://stream.mux.com/pb.m3u8?token=secret",
        "/tmp/out.mp4",
        { knownDurationSeconds: 100, onProgress: (p) => progressEvents.push(p) },
        { spawn, redactor: createSecretRedactor() },
      );

      expect(progressEvents).toEqual([
        { elapsedSeconds: 5, totalSeconds: 100 },
        { elapsedSeconds: 10, totalSeconds: 100 },
      ]);
    });

    it("does not add -progress args or read stdout when no onProgress callback is given (unchanged default behavior)", async () => {
      const child = makeFakeChild();
      const spawn = vi.fn((_cmd: string, args: string[]) => {
        expect(args).not.toContain("-progress");
        queueMicrotask(() => child.emit("close", 0));
        return child as never;
      });

      await remuxToMp4("https://stream.mux.com/pb.m3u8?token=secret", "/tmp/out.mp4", {}, { spawn, redactor: createSecretRedactor() });
    });

    it("falls back to ffprobe for total duration when knownDurationSeconds is not given", async () => {
      const remuxChild = makeFakeChild();
      const probeChild = makeFakeChild();
      const spawn = vi.fn((cmd: string) => {
        if (cmd === "ffprobe") {
          queueMicrotask(() => {
            probeChild.stdout.emit("data", Buffer.from("120.5\n"));
            probeChild.emit("close", 0);
          });
          return probeChild as never;
        }
        queueMicrotask(() => {
          remuxChild.stdout.emit("data", Buffer.from("out_time_us=1000000\n"));
          remuxChild.emit("close", 0);
        });
        return remuxChild as never;
      });

      const progressEvents: RemuxProgress[] = [];
      await remuxToMp4(
        "https://stream.mux.com/pb.m3u8?token=secret",
        "/tmp/out.mp4",
        { onProgress: (p) => progressEvents.push(p) },
        { spawn, redactor: createSecretRedactor() },
      );

      expect(progressEvents).toEqual([{ elapsedSeconds: 1, totalSeconds: 121 }]);
    });
  });
});

describe("probeDurationSeconds", () => {
  it("returns the rounded duration on success", async () => {
    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("43.6\n"));
        child.emit("close", 0);
      });
      return child as never;
    });
    await expect(probeDurationSeconds("https://x/pb.m3u8", "ffprobe", { spawn, redactor: createSecretRedactor() })).resolves.toBe(44);
  });

  it("resolves null (never throws) when ffprobe fails", async () => {
    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("close", 1));
      return child as never;
    });
    await expect(probeDurationSeconds("https://x/pb.m3u8", "ffprobe", { spawn, redactor: createSecretRedactor() })).resolves.toBeNull();
  });

  it("resolves null when the ffprobe binary fails to start", async () => {
    const child = makeFakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child as never;
    });
    await expect(probeDurationSeconds("https://x/pb.m3u8", "ffprobe", { spawn, redactor: createSecretRedactor() })).resolves.toBeNull();
  });
});
