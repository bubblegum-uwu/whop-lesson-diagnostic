import { describe, it, expect, vi, afterEach } from "vitest";
import { getDiscordLinkStatus, consumeDiscordLinkToken, unlinkDiscord, DiscordLinkApiError } from "../discordAccountLinkApi";

const BACKEND_URL = "https://backend.example.com";
const TOKEN = "knovera-session-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("getDiscordLinkStatus", () => {
  it("GETs /api/discord/link with the Knovera bearer token and returns the parsed status", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/discord/link`);
      expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return jsonResponse(200, { linked: true, discordUserIds: ["1234567890"] });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getDiscordLinkStatus(BACKEND_URL, TOKEN)).toEqual({ linked: true, discordUserIds: ["1234567890"] });
  });
});

describe("consumeDiscordLinkToken", () => {
  it("POSTs the token in the body, never as a query param or header", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/discord/link`);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(init.body as string)).toEqual({ token: "one-time-token" });
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await consumeDiscordLinkToken(BACKEND_URL, TOKEN, "one-time-token");
  });

  it("throws DiscordLinkApiError with the backend's exact message/type on an invalid/expired token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          error: { message: "This link is invalid, expired, or has already been used.", type: "invalid_link_token" },
        }),
      ),
    );

    const err = await consumeDiscordLinkToken(BACKEND_URL, TOKEN, "bad-token").catch((e) => e);
    expect(err).toBeInstanceOf(DiscordLinkApiError);
    expect((err as DiscordLinkApiError).type).toBe("invalid_link_token");
    expect((err as DiscordLinkApiError).message).toMatch(/invalid, expired/);
  });
});

describe("unlinkDiscord", () => {
  it("DELETEs /api/discord/link with the bearer token", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BACKEND_URL}/api/discord/link`);
      expect(init.method).toBe("DELETE");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await unlinkDiscord(BACKEND_URL, TOKEN);
  });
});
