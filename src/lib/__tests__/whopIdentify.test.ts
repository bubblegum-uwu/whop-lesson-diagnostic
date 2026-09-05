import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWhopUserInfo, WhopIdentifyError } from "../whopIdentify";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchWhopUserInfo", () => {
  it("calls Whop's userinfo endpoint directly (never this app's backend) with the bearer token", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.whop.com/oauth/userinfo");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my-access-token");
      return jsonResponse(200, { sub: "user_abc123", name: "Riyanna" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await fetchWhopUserInfo("my-access-token");
    expect(info.sub).toBe("user_abc123");
  });

  it("throws WhopIdentifyError on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));
    await expect(fetchWhopUserInfo("bad-token")).rejects.toBeInstanceOf(WhopIdentifyError);
  });

  it("throws WhopIdentifyError when the response has no sub claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { name: "No Sub" })));
    await expect(fetchWhopUserInfo("token")).rejects.toBeInstanceOf(WhopIdentifyError);
  });
});
