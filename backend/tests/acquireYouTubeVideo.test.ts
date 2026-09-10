import { describe, it, expect } from "vitest";
import { acquireYouTubeVideo } from "../src/youtube/acquireYouTubeVideo.js";
import { YouTubeUrlParseError } from "../src/lib/youtubeUrl.js";

describe("acquireYouTubeVideo (Phase 4H-B)", () => {
  it("K: reconstructs the canonical YouTube watch URL from a validated external_id", () => {
    const result = acquireYouTubeVideo("dQw4w9WgXcQ");
    expect(result).toEqual({ uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  });

  it("K: is deterministic — the same external_id always reconstructs the same URI", () => {
    const a = acquireYouTubeVideo("dQw4w9WgXcQ");
    const b = acquireYouTubeVideo("dQw4w9WgXcQ");
    expect(a).toEqual(b);
  });

  it("L: has no parameter through which a stored/raw source_url could ever reach it — only accepts a single string (the external_id)", () => {
    // Structural proof: the function's arity is 1, and that one argument is
    // used as a video ID, not a URL — a caller CANNOT pass a
    // project_sources.source_url value into this function's signature at
    // all, malicious or not. This test documents/locks that contract: if a
    // second parameter were ever added (e.g. accidentally threading
    // source_url through), this test would need to change, and the PR
    // reviewer would see it.
    expect(acquireYouTubeVideo.length).toBe(1);
  });

  it("L: a malicious-looking 'external_id' (which should never occur — Phase 4H-A already validates it at insert time) is rejected, never silently used to build a URL to a different host", () => {
    expect(() => acquireYouTubeVideo("evil.example.com")).toThrow(YouTubeUrlParseError);
    expect(() => acquireYouTubeVideo("../../etc/passwd")).toThrow(YouTubeUrlParseError);
    expect(() => acquireYouTubeVideo("<script>")).toThrow(YouTubeUrlParseError);
  });

  it("only ever returns a youtube.com/watch URI, regardless of a valid id's exact characters", () => {
    const result = acquireYouTubeVideo("AbCdEfGhIjK");
    expect(result.uri.startsWith("https://www.youtube.com/watch?v=")).toBe(true);
    expect(result.uri).not.toContain("youtu.be");
  });

  it("never includes a mimeType — matches the approved live-spike request shape ({ type: 'video', uri }) with no mime_type field", () => {
    const result = acquireYouTubeVideo("dQw4w9WgXcQ");
    expect(result.mimeType).toBeUndefined();
  });
});
