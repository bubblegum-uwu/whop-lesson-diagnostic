import { describe, it, expect } from "vitest";
import { isLikelyYouTubeVideoUrl, extractYouTubeUrls } from "../src/youtubeLinkExtractor.js";

describe("isLikelyYouTubeVideoUrl", () => {
  it("accepts a youtube.com/watch URL", () => {
    expect(isLikelyYouTubeVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
  });
  it("accepts a youtu.be URL", () => {
    expect(isLikelyYouTubeVideoUrl("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(true);
  });
  it("accepts a /shorts/ URL", () => {
    expect(isLikelyYouTubeVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true);
  });
  it("accepts a /live/ URL", () => {
    expect(isLikelyYouTubeVideoUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe(true);
  });
  it("accepts an m.youtube.com URL", () => {
    expect(isLikelyYouTubeVideoUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
  });
  it("rejects a Discord CDN link", () => {
    expect(isLikelyYouTubeVideoUrl("https://cdn.discordapp.com/attachments/1/2/clip.mp4")).toBe(false);
  });
  it("rejects a non-YouTube host lookalike", () => {
    expect(isLikelyYouTubeVideoUrl("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toBe(false);
  });
  it("rejects a malformed URL", () => {
    expect(isLikelyYouTubeVideoUrl("not a url")).toBe(false);
  });
  it("rejects a YouTube channel URL", () => {
    expect(isLikelyYouTubeVideoUrl("https://www.youtube.com/@somechannel")).toBe(false);
  });
});

describe("extractYouTubeUrls", () => {
  it("2: extracts every supported form present among a message's anchors", () => {
    const hrefs = [
      "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      "https://cdn.discordapp.com/attachments/1/2/clip.mp4",
      "https://youtu.be/bbbbbbbbbbb",
      "https://www.youtube.com/shorts/ccccccccccc",
      "https://www.youtube.com/live/ddddddddddd",
      "https://example.com/",
    ];
    expect(extractYouTubeUrls(hrefs)).toEqual([
      "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      "https://youtu.be/bbbbbbbbbbb",
      "https://www.youtube.com/shorts/ccccccccccc",
      "https://www.youtube.com/live/ddddddddddd",
    ]);
  });

  it("never duplicates the exact same href within one message", () => {
    const hrefs = ["https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://www.youtube.com/watch?v=aaaaaaaaaaa"];
    expect(extractYouTubeUrls(hrefs)).toEqual(["https://www.youtube.com/watch?v=aaaaaaaaaaa"]);
  });

  it("returns an empty array when a message has no YouTube links", () => {
    expect(extractYouTubeUrls(["https://example.com/", "https://discord.com/channels/1/2"])).toEqual([]);
  });
});
