import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportDiscordChannelDialog } from "../ImportDiscordChannelDialog";
import * as bridge from "../../lib/discordCompanionBridge";

vi.mock("../../lib/discordCompanionBridge", async () => {
  const actual = await vi.importActual<typeof import("../../lib/discordCompanionBridge")>("../../lib/discordCompanionBridge");
  return {
    ...actual,
    detectDiscordCompanion: vi.fn(),
    scanDiscordChannel: vi.fn(),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CHANNEL_URL = "https://discord.com/channels/1218766394997346395/1219022089252503632";

function renderDialog(overrides: Partial<React.ComponentProps<typeof ImportDiscordChannelDialog>> = {}) {
  return render(
    <ImportDiscordChannelDialog
      backendUrl="https://backend.example.com"
      knoveraToken="token"
      projectId={7}
      existingYouTubeExternalIds={new Set()}
      onClose={() => {}}
      onImported={() => {}}
      {...overrides}
    />,
  );
}

describe("ImportDiscordChannelDialog (Phase 4K-C)", () => {
  it("1: missing browser companion shows an install-required state, never a fake working scanner", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: false });
    renderDialog();

    expect(await screen.findByText("Knovera Browser Companion is required to scan Discord channels.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Discord Channel URL")).not.toBeInTheDocument();
  });

  it("2: once the companion is available, the dialog accepts a Discord channel URL only (no YouTube-link field)", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: true });
    renderDialog();

    expect(await screen.findByLabelText("Discord Channel URL")).toBeInTheDocument();
    expect(screen.queryByText(/youtube/i, { selector: "label" })).not.toBeInTheDocument();
  });

  it("3: an invalid channel URL is rejected client-side with a clear message, and never starts a scan", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: true });
    renderDialog();

    fireEvent.change(await screen.findByLabelText("Discord Channel URL"), { target: { value: "https://example.com/not-discord" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan Channel" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/discord.com\/channels/);
    expect(bridge.scanDiscordChannel).not.toHaveBeenCalled();
  });

  it("4: scan results preview distinguishes occurrences found vs unique videos vs new vs already-existing", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: true });
    vi.mocked(bridge.scanDiscordChannel).mockReturnValue({
      requestId: "req-1",
      cancel: vi.fn(),
      result: Promise.resolve({
        channel: { guildId: "g1", channelId: "c1", channelName: "pre-market-live" },
        occurrences: [
          { youtubeUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", messageId: "m1", messageUrl: null, postedAt: "2026-09-12T14:30:00.000Z" },
          { youtubeUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", messageId: "m2", messageUrl: null, postedAt: "2026-09-12T15:00:00.000Z" },
          { youtubeUrl: "https://www.youtube.com/watch?v=bbbbbbbbbbb", messageId: "m3", messageUrl: null, postedAt: "2026-09-12T15:10:00.000Z" },
        ],
        messagesScanned: 125,
        cancelled: false,
      }),
    });

    renderDialog({ existingYouTubeExternalIds: new Set(["bbbbbbbbbbb"]) });
    fireEvent.change(await screen.findByLabelText("Discord Channel URL"), { target: { value: CHANNEL_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Scan Channel" }));

    expect(await screen.findByText("Channel: #pre-market-live")).toBeInTheDocument();
    expect(screen.getByText("125 Discord messages scanned")).toBeInTheDocument();
    expect(screen.getByText("3 YouTube occurrences found")).toBeInTheDocument();
    expect(screen.getByText("2 unique YouTube videos")).toBeInTheDocument();
    expect(screen.getByText("1 new YouTube source")).toBeInTheDocument();
    expect(screen.getByText("1 already exists in this project")).toBeInTheDocument();
  });

  it("5: Import sends every scanned occurrence to the discord-import endpoint and never touches an analysis endpoint", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: true });
    vi.mocked(bridge.scanDiscordChannel).mockReturnValue({
      requestId: "req-1",
      cancel: vi.fn(),
      result: Promise.resolve({
        channel: { guildId: "g1", channelId: "c1", channelName: "pre-market-live" },
        occurrences: [{ youtubeUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", messageId: "m1", messageUrl: null, postedAt: "2026-09-12T14:30:00.000Z" }],
        messagesScanned: 10,
        cancelled: false,
      }),
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://backend.example.com/api/projects/7/sources/youtube/discord-import");
      const body = JSON.parse(init!.body as string);
      expect(body.channel).toEqual({ guildId: "g1", channelId: "c1", channelName: "pre-market-live" });
      expect(body.occurrences).toHaveLength(1);
      return jsonResponse(200, {
        results: [{ youtubeUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", messageId: "m1", kind: "added" }],
        occurrencesProcessed: 1,
        newSourceCount: 1,
        newOriginCount: 0,
        enrichedOriginCount: 0,
        duplicateOriginCount: 0,
        invalidCount: 0,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn();

    renderDialog({ onImported });
    fireEvent.change(await screen.findByLabelText("Discord Channel URL"), { target: { value: CHANNEL_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Scan Channel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByText(/1 added/)).toBeInTheDocument());
    expect(onImported).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/analyze"), expect.anything());
  });

  it("6: Stop Scan calls the scan handle's cancel(), and a cancelled scan still shows a usable preview of partial results", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: true });
    const cancel = vi.fn();
    let resolveScan: (value: { channel: { guildId: string; channelId: string; channelName: string | null }; occurrences: unknown[]; messagesScanned: number; cancelled: boolean }) => void;
    const scanPromise = new Promise<{ channel: { guildId: string; channelId: string; channelName: string | null }; occurrences: unknown[]; messagesScanned: number; cancelled: boolean }>((resolve) => {
      resolveScan = resolve;
    });
    vi.mocked(bridge.scanDiscordChannel).mockReturnValue({ requestId: "req-1", cancel, result: scanPromise as never });

    renderDialog();
    fireEvent.change(await screen.findByLabelText("Discord Channel URL"), { target: { value: CHANNEL_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Scan Channel" }));

    fireEvent.click(await screen.findByRole("button", { name: "Stop Scan" }));
    expect(cancel).toHaveBeenCalledOnce();

    resolveScan!({ channel: { guildId: "g1", channelId: "c1", channelName: null }, occurrences: [], messagesScanned: 40, cancelled: true });
    expect(await screen.findByText("Scan stopped early — showing results found so far.")).toBeInTheDocument();
    expect(screen.getByText("Channel: Channel c1")).toBeInTheDocument();
  });

  it("Cancel from the channel-URL screen never starts a scan", async () => {
    vi.mocked(bridge.detectDiscordCompanion).mockResolvedValue({ available: true });
    const onClose = vi.fn();
    renderDialog({ onClose });

    fireEvent.change(await screen.findByLabelText("Discord Channel URL"), { target: { value: CHANNEL_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(bridge.scanDiscordChannel).not.toHaveBeenCalled();
  });
});
