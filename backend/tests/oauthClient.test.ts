import { describe, it, expect, vi, afterEach } from "vitest";
import { createWhopOAuthClient, WhopRefreshError } from "../src/whop/oauthClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createWhopOAuthClient.refreshAccessToken", () => {
  it("POSTs grant_type=refresh_token with no client_secret, and returns the new tokens", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.whop.com/oauth/token");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
        client_id: "app_abc123",
      });
      expect(body.client_secret).toBeUndefined();
      return jsonResponse(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "bearer",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createWhopOAuthClient("app_abc123");
    const result = await client.refreshAccessToken("old-refresh");
    expect(result.access_token).toBe("new-access");
    expect(result.refresh_token).toBe("new-refresh");
  });

  it("throws WhopRefreshError on a non-2xx response, without leaking into a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(400, { error: "invalid_grant", error_description: "refresh token revoked" })),
    );
    const client = createWhopOAuthClient("app_abc123");
    await expect(client.refreshAccessToken("revoked-token")).rejects.toBeInstanceOf(WhopRefreshError);
  });
});

describe("createWhopOAuthClient.revokeRefreshToken", () => {
  it("POSTs the token and client_id to the revoke endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.whop.com/oauth/revoke");
      expect(JSON.parse(init.body as string)).toEqual({ token: "refresh-to-revoke", client_id: "app_abc123" });
      return jsonResponse(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createWhopOAuthClient("app_abc123");
    await expect(client.revokeRefreshToken("refresh-to-revoke")).resolves.toBeUndefined();
  });

  it("throws WhopRefreshError when revocation fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, {})));
    const client = createWhopOAuthClient("app_abc123");
    await expect(client.revokeRefreshToken("tok")).rejects.toBeInstanceOf(WhopRefreshError);
  });
});
