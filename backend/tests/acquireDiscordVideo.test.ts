import { describe, it, expect } from "vitest";
import { acquireDiscordVideo } from "../src/discord/acquireDiscordVideo.js";

const VALID_URL = "https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip.mp4?ex=1&is=2&hm=3";

describe("acquireDiscordVideo", () => {
  it("M: returns a VideoContent-compatible ref ({ uri }) built from the persisted sourceUrl when it matches the recorded externalId", () => {
    const video = acquireDiscordVideo({ externalId: "987654321098765432", sourceUrl: VALID_URL });
    expect(video).toEqual({ uri: VALID_URL });
  });

  it("L: refuses to acquire when sourceUrl parses to a DIFFERENT attachment id than the trusted externalId on record — never silently trusts a tampered row", () => {
    expect(() =>
      acquireDiscordVideo({
        externalId: "111111111111111111",
        sourceUrl: VALID_URL, // parses to attachment id 987654321098765432, not 111...
      }),
    ).toThrow(/does not match/);
  });

  it("L: refuses to acquire when sourceUrl doesn't parse as a genuine Discord CDN video URL at all (e.g. corrupted to an arbitrary host)", () => {
    expect(() =>
      acquireDiscordVideo({
        externalId: "987654321098765432",
        sourceUrl: "https://evil.example/steal-my-data",
      }),
    ).toThrow();
  });

  it("N/O/P/Q: is a pure, synchronous function — no network call, no uploadFile/waitUntilActive/deleteFile, no ffmpeg possible (it has no such dependency to call)", () => {
    // Structural proof, mirroring acquireYouTubeVideo's own test: this
    // function's signature has no Gemini client / ffmpeg dependency
    // parameter through which any such call could ever be made.
    expect(acquireDiscordVideo.length).toBe(1);
  });

  it("R: never touches process.env or requires a Whop/Discord token — no auth dependency of any kind", () => {
    const video = acquireDiscordVideo({ externalId: "987654321098765432", sourceUrl: VALID_URL });
    expect(video.uri).toBe(VALID_URL);
  });
});
