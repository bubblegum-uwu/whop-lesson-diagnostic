import { describe, it, expect, vi, afterEach } from "vitest";
import {
  establishAuthSession,
  getAuthStatus,
  disconnectAuthSession,
  syncCourse,
  getCourseLessons,
} from "../courseApi";

const BACKEND_URL = "https://backend.example.com";
const TOKEN = "operator-access-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("establishAuthSession", () => {
  it("POSTs the tokens under snake_case keys the backend expects, with no id_token field", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/auth/session`);
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ access_token: "a", refresh_token: "r", expires_in: 3600 });
      expect(body.id_token).toBeUndefined();
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await establishAuthSession(BACKEND_URL, { accessToken: "a", refreshToken: "r", expiresIn: 3600 });
  });

  it("throws when the backend rejects the session (e.g. a different operator, or a bad token)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: { message: "A different Whop account already owns this deployment's operator session." } })),
    );
    await expect(
      establishAuthSession(BACKEND_URL, { accessToken: "a", refreshToken: "r", expiresIn: 3600 }),
    ).rejects.toThrow(/different Whop account/);
  });
});

describe("getAuthStatus", () => {
  it("sends the caller's access token as a bearer header and returns the parsed status", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return jsonResponse(200, { connected: true, status: "active", whopUserId: "user_1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getAuthStatus(BACKEND_URL, TOKEN)).toEqual({ connected: true, status: "active", whopUserId: "user_1" });
  });
});

describe("disconnectAuthSession", () => {
  it("POSTs to the disconnect endpoint with the bearer token", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/auth/disconnect`);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(disconnectAuthSession(BACKEND_URL, TOKEN)).resolves.toBeUndefined();
  });
});

describe("syncCourse", () => {
  it("sends the bearer token and returns a success outcome with the sync result", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return jsonResponse(200, { courseTitle: "Scarface Trades Mastermind", upserted: 3, archived: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await syncCourse(BACKEND_URL, TOKEN);
    expect(outcome).toEqual({
      kind: "success",
      result: { courseTitle: "Scarface Trades Mastermind", upserted: 3, archived: 0 },
    });
  });

  it("returns an auth_required outcome on a 401, without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: { type: "auth_required" } })));
    expect(await syncCourse(BACKEND_URL, TOKEN)).toEqual({ kind: "auth_required" });
  });

  it("returns a sanitized error outcome on other failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(502, { error: { message: "Whop API error (500): timeout" } })),
    );
    expect(await syncCourse(BACKEND_URL, TOKEN)).toEqual({ kind: "error", message: "Whop API error (500): timeout" });
  });
});

describe("getCourseLessons", () => {
  it("sends the bearer token and returns the course + lessons payload", async () => {
    const payload = {
      course: { title: "Scarface Trades Mastermind", slug: "scarface-trades-mastermind", lastSyncedAt: "2026-01-01T00:00:00Z" },
      lessons: [{ id: 1, title: "Intro", chapterTitle: null, chapterOrder: null, courseOrder: 1, durationSeconds: 900, videoAvailable: true, sourceUrl: "https://whop.com/x", lastSyncedAt: "2026-01-01T00:00:00Z" }],
    };
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return jsonResponse(200, payload);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getCourseLessons(BACKEND_URL, TOKEN)).toEqual(payload);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));
    await expect(getCourseLessons(BACKEND_URL, TOKEN)).rejects.toThrow();
  });
});
