import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SourcesPage, type SourcesPageProps } from "../SourcesPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PROJECT = {
  id: 7,
  name: "MasterMind",
  projectType: "TRADING_STRATEGIES",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  courseCount: 0,
  lessonCount: 0,
  analyzedLessonCount: 0,
  latestSynthesisStatus: null,
  latestSynthesisCompletedAt: null,
};

const GUILD = { id: 1, guildId: "999888777", guildName: "Trading Community", status: "CONNECTED", connectedAt: "2026-01-01T00:00:00.000Z" };

function baseProps(overrides: Partial<SourcesPageProps> = {}): SourcesPageProps {
  return {
    courseTitle: null,
    lessons: [],
    connected: true,
    syncing: false,
    authRequired: false,
    lastSyncedAt: null,
    summary: null,
    courseErrorMessage: null,
    onSignIn: () => {},
    onSync: () => {},
    onDisconnect: () => {},
    onEnqueue: () => {},
    onRetry: () => {},
    onCancel: () => {},
    onLoadAnalysis: async () => null,
    identifyState: { phase: "idle" },
    onFindUserId: () => {},
    backendUrl: "https://backend.example.com",
    knoveraToken: "token",
    diagnosticState: { phase: "config", errorMessage: null, submitting: false },
    redirectUri: "https://example.com/",
    onDiagnosticSubmit: () => {},
    onDiagnosticReset: () => {},
    ...overrides,
  };
}

function renderSources(props: Partial<SourcesPageProps> = {}) {
  return render(
    <MemoryRouter initialEntries={["/projects/7/sources"]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<SourcesPage {...baseProps(props)} />} />
        <Route path="/projects/:projectId/collections/:collectionId" element={<div>COLLECTION_DETAIL_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function discordCard(): HTMLElement {
  return screen.getByRole("heading", { name: "Discord" }).closest(".kv-card") as HTMLElement;
}

describe("SourcesPage — authenticated Discord collections (Phase 4K-B)", () => {
  it("shows a Connect Discord entry point when no server is connected yet, alongside the existing à-la-carte actions", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/api/discord/guilds")) return jsonResponse(200, { guilds: [] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(within(discordCard()).getByText("Not Connected")).toBeInTheDocument());
    expect(within(discordCard()).getByRole("button", { name: "Connect Discord" })).toBeInTheDocument();
    // Existing individual/bulk à-la-carte affordances must remain untouched.
    expect(within(discordCard()).getByRole("button", { name: "Add Discord Video" })).toBeInTheDocument();
    expect(within(discordCard()).getByRole("button", { name: "Bulk Import" })).toBeInTheDocument();
  });

  it("Connect Discord starts the OAuth flow and navigates the browser to Discord's authorize URL", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/api/discord/guilds")) return jsonResponse(200, { guilds: [] });
      if (url.endsWith("/api/discord/connect/start") && init?.method === "POST") {
        return jsonResponse(200, { authorizeUrl: "https://discord.com/oauth2/authorize?client_id=abc&scope=bot" });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(within(discordCard()).getByRole("button", { name: "Connect Discord" })).toBeInTheDocument());
    const originalHref = window.location.href;
    let assignedHref: string | undefined;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, set href(v: string) { assignedHref = v; }, get href() { return assignedHref ?? originalHref; } },
    });

    fireEvent.click(within(discordCard()).getByRole("button", { name: "Connect Discord" }));
    await waitFor(() => expect(assignedHref).toBe("https://discord.com/oauth2/authorize?client_id=abc&scope=bot"));
  });

  it("shows a connected server with Import Channels / Disconnect actions and a '+ Connect Another Server' button", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/api/discord/guilds")) return jsonResponse(200, { guilds: [GUILD] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(within(discordCard()).getByText("Trading Community")).toBeInTheDocument());
    expect(within(discordCard()).getByText("1 Server Connected")).toBeInTheDocument();
    expect(within(discordCard()).getByRole("button", { name: "Import Channels" })).toBeInTheDocument();
    expect(within(discordCard()).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(within(discordCard()).getByRole("button", { name: "+ Connect Another Server" })).toBeInTheDocument();
  });

  it("Import Channels opens the channel picker, loads channels, and explicit selection imports only the chosen ones", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections") && (!init || init.method === undefined)) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/api/discord/guilds")) return jsonResponse(200, { guilds: [GUILD] });
      if (url.endsWith("/api/discord/guilds/1/channels")) {
        return jsonResponse(200, {
          guildId: GUILD.guildId,
          guildName: GUILD.guildName,
          channels: [
            { id: "100", name: "trade-reviews", type: 0, parentId: null, readable: true },
            { id: "200", name: "private-mods", type: 0, parentId: null, readable: false },
          ],
        });
      }
      if (url.endsWith("/collections/discord/import") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ guildId: 1, channelIds: ["100"] });
        return jsonResponse(201, { results: [{ channelId: "100", kind: "imported", collection: { id: 5, title: "#trade-reviews" }, discoveredCount: 2, importedCount: 2, adoptedCount: 0 }] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(within(discordCard()).getByRole("button", { name: "Import Channels" })).toBeInTheDocument());
    fireEvent.click(within(discordCard()).getByRole("button", { name: "Import Channels" }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("#trade-reviews")).toBeInTheDocument());
    expect(within(dialog).getByText("#private-mods")).toBeInTheDocument();
    expect(within(dialog).getByText("Not accessible")).toBeInTheDocument();

    // The inaccessible channel's checkbox must be disabled — never selectable.
    const privateCheckbox = within(dialog).getByText("#private-mods").closest("li")!.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(privateCheckbox).toBeDisabled();

    const readableCheckbox = within(dialog).getByText("#trade-reviews").closest("li")!.querySelector("input[type=checkbox]") as HTMLInputElement;
    fireEvent.click(readableCheckbox);
    fireEvent.click(within(dialog).getByRole("button", { name: "Import Selected Channel" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/collections/discord/import", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Disconnect removes the server from the connected list", async () => {
    let disconnected = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/api/discord/guilds")) return jsonResponse(200, { guilds: disconnected ? [] : [GUILD] });
      if (url.endsWith("/api/discord/guilds/1/disconnect") && init?.method === "POST") {
        disconnected = true;
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(within(discordCard()).getByRole("button", { name: "Disconnect" })).toBeInTheDocument());
    fireEvent.click(within(discordCard()).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/discord/guilds/1/disconnect", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(within(discordCard()).getByText("Not Connected")).toBeInTheDocument());
  });

  it("a 501 (DISCORD_BOT_TOKEN not configured) on Connect Discord shows an inline error, never crashing the page", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [PROJECT] });
      if (url.endsWith("/sources")) return jsonResponse(200, { projectId: 7, sources: [] });
      if (url.endsWith("/collections")) return jsonResponse(200, { projectId: 7, collections: [] });
      if (url.endsWith("/api/discord/guilds")) return jsonResponse(200, { guilds: [] });
      if (url.endsWith("/api/discord/connect/start") && init?.method === "POST") {
        return jsonResponse(501, { error: { message: "Discord authenticated collections require DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN to be configured on this deployment.", type: "discord_api_not_configured" } });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSources();

    await waitFor(() => expect(within(discordCard()).getByRole("button", { name: "Connect Discord" })).toBeInTheDocument());
    fireEvent.click(within(discordCard()).getByRole("button", { name: "Connect Discord" }));

    await waitFor(() => expect(within(discordCard()).getByText(/DISCORD_CLIENT_ID and DISCORD_BOT_TOKEN/)).toBeInTheDocument());
  });
});
