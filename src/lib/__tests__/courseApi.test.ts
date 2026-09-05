import { describe, it, expect, vi, afterEach } from "vitest";
import {
  establishAuthSession,
  getAuthStatus,
  disconnectAuthSession,
  syncCourse,
  getCourseLessons,
} from "../courseApi";

const BACKEND_URL = "https://backend.example.com";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("establishAuthSession", () => {
  it("POSTs the tokens under snake_case keys the backend expects", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/auth/session`);
      expect(JSON.parse(init.body as string)).toEqual({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        id_token: "id",
      });
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await establishAuthSession(BACKEND_URL, { accessToken: "a", refreshToken: "r", expiresIn: 3600, idToken: "id" });
  });

  it("throws when the backend rejects the session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, {})));
    await expect(
      establishAuthSession(BACKEND_URL, { accessToken: "a", refreshToken: "r", expiresIn: 3600 }),
    ).rejects.toThrow();
  });
});

describe("getAuthStatus", () => {
  it("returns the parsed status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { connected: true, status: "active", whopUserId: "user_1" })),
    );
    expect(await getAuthStatus(BACKEND_URL)).toEqual({ connected: true, status: "active", whopUserId: "user_1" });
  });
});

describe("disconnectAuthSession", () => {
  it("POSTs to the disconnect endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/auth/disconnect`);
      expect(init.method).toBe("POST");
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(disconnectAuthSession(BACKEND_URL)).resolves.toBeUndefined();
  });
});

describe("syncCourse", () => {
  it("returns a success outcome with the sync result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { courseTitle: "Scarface Trades Mastermind", upserted: 3, archived: 0 })),
    );
    const outcome = await syncCourse(BACKEND_URL);
    expect(outcome).toEqual({
      kind: "success",
      result: { courseTitle: "Scarface Trades Mastermind", upserted: 3, archived: 0 },
    });
  });

  it("returns an auth_required outcome on a 401, without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: { type: "auth_required" } })));
    expect(await syncCourse(BACKEND_URL)).toEqual({ kind: "auth_required" });
  });

  it("returns a sanitized error outcome on other failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(502, { error: { message: "Whop API error (500): timeout" } })),
    );
    expect(await syncCourse(BACKEND_URL)).toEqual({ kind: "error", message: "Whop API error (500): timeout" });
  });
});

describe("getCourseLessons", () => {
  it("returns the course + lessons payload", async () => {
    const payload = {
      course: { title: "Scarface Trades Mastermind", slug: "scarface-trades-mastermind", lastSyncedAt: "2026-01-01T00:00:00Z" },
      lessons: [{ id: 1, title: "Intro", chapterTitle: null, chapterOrder: null, courseOrder: 1, durationSeconds: 900, videoAvailable: true, sourceUrl: "https://whop.com/x", lastSyncedAt: "2026-01-01T00:00:00Z" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, payload)));
    expect(await getCourseLessons(BACKEND_URL)).toEqual(payload);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));
    await expect(getCourseLessons(BACKEND_URL)).rejects.toThrow();
  });
});
