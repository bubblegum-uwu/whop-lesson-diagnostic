import { describe, it, expect, vi } from "vitest";
import { isAllowedOrigin, corsMiddleware } from "../src/lib/cors.js";

const ALLOWED = "https://bubblegum-uwu.github.io";

describe("isAllowedOrigin", () => {
  it("allows the exact configured origin", () => {
    expect(isAllowedOrigin("https://bubblegum-uwu.github.io", ALLOWED)).toBe(true);
  });

  it("rejects a different origin entirely", () => {
    expect(isAllowedOrigin("https://evil.example.com", ALLOWED)).toBe(false);
  });

  it("rejects the origin with the GitHub Pages sub-path appended (Origin headers never include a path, but we still must not match if one sneaks in)", () => {
    expect(isAllowedOrigin("https://bubblegum-uwu.github.io/whop-lesson-diagnostic", ALLOWED)).toBe(
      false,
    );
  });

  it("rejects http (non-https) even for the same host", () => {
    expect(isAllowedOrigin("http://bubblegum-uwu.github.io", ALLOWED)).toBe(false);
  });

  it("rejects a subdomain of the allowed origin", () => {
    expect(isAllowedOrigin("https://evil.bubblegum-uwu.github.io", ALLOWED)).toBe(false);
  });

  it("rejects a missing origin", () => {
    expect(isAllowedOrigin(undefined, ALLOWED)).toBe(false);
    expect(isAllowedOrigin(null, ALLOWED)).toBe(false);
  });

  it("tolerates a trailing slash on either side", () => {
    expect(isAllowedOrigin("https://bubblegum-uwu.github.io/", ALLOWED)).toBe(true);
    expect(isAllowedOrigin("https://bubblegum-uwu.github.io", ALLOWED + "/")).toBe(true);
  });
});

describe("corsMiddleware", () => {
  function mockRes() {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      status: vi.fn(() => ({ end: vi.fn() })),
      headers,
    };
    return res;
  }

  it("sets Access-Control-Allow-Origin only for the exact allowed origin", () => {
    const middleware = corsMiddleware(ALLOWED);
    const req = { headers: { origin: ALLOWED }, method: "POST" };
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(res.headers["Access-Control-Allow-Origin"]).toBe(ALLOWED);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not set CORS headers for a disallowed origin", () => {
    const middleware = corsMiddleware(ALLOWED);
    const req = { headers: { origin: "https://not-allowed.example.com" }, method: "POST" };
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    // Still calls next() — the browser (not our server) is what enforces the block
    // when no CORS header is present.
    expect(next).toHaveBeenCalledOnce();
  });

  it("short-circuits OPTIONS preflight requests with 204", () => {
    const middleware = corsMiddleware(ALLOWED);
    const req = { headers: { origin: ALLOWED }, method: "OPTIONS" };
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });
});
