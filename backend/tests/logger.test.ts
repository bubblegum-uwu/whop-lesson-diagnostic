import { describe, it, expect, vi, afterEach } from "vitest";
import { createSecretRedactor } from "../src/lib/redact.js";
import { createSafeLogger } from "../src/lib/logger.js";

describe("createSafeLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never writes a registered secret to console.log", () => {
    const redactor = createSecretRedactor();
    const secret = "supersecretwhoptoken1234567890";
    redactor.register(secret);
    const logger = createSafeLogger(redactor);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("Calling Whop", { token: secret });

    expect(spy).toHaveBeenCalledTimes(1);
    const output = spy.mock.calls[0][0] as string;
    expect(output).not.toContain(secret);
  });

  it("never writes a registered secret to console.error", () => {
    const redactor = createSecretRedactor();
    const secret = "GEMINI_API_KEY_abcdefghijklmnop";
    redactor.register(secret);
    const logger = createSafeLogger(redactor);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error(`Gemini init failed with key ${secret}`);

    const output = spy.mock.calls[0][0] as string;
    expect(output).not.toContain(secret);
  });

  it("redacts an Authorization header passed in meta", () => {
    const redactor = createSecretRedactor();
    const logger = createSafeLogger(redactor);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("Incoming request", { authorization: "Bearer abcdefghijklmno.pqrstuvwxyz" });

    const output = spy.mock.calls[0][0] as string;
    expect(output).not.toContain("abcdefghijklmno.pqrstuvwxyz");
  });

  it("passes through non-sensitive messages unchanged", () => {
    const logger = createSafeLogger(createSecretRedactor());
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("Backend listening on port 8080");

    expect(spy.mock.calls[0][0]).toContain("Backend listening on port 8080");
  });
});
