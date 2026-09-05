import { describe, it, expect } from "vitest";
import { createSecretRedactor } from "../src/lib/redact.js";

describe("createSecretRedactor", () => {
  it("redacts an exact registered secret wherever it appears", () => {
    const redactor = createSecretRedactor();
    const token = "whop_access_token_abcdef1234567890";
    redactor.register(token);

    const out = redactor.redact(`Using token ${token} to call the API`);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts an Authorization: Bearer header value via the backstop pattern even if not pre-registered", () => {
    const redactor = createSecretRedactor();
    const out = redactor.redact("Authorization: Bearer sk_live_abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("sk_live_abcdefghijklmnopqrstuvwxyz123456");
    expect(out).toMatch(/Bearer \[REDACTED\]/);
  });

  it("redacts a Whop access token registered as a secret from a log line", () => {
    const redactor = createSecretRedactor();
    const whopToken = "whop_1a2b3c4d5e6f7g8h9i0j";
    redactor.register(whopToken);
    const out = redactor.redact(`fetching lesson with token=${whopToken}`);
    expect(out).not.toContain(whopToken);
  });

  it("redacts a registered signed_video_playback_token value", () => {
    const redactor = createSecretRedactor();
    const signedToken = "eyJhbGciOiJSUzI1NiJ9.somepayload.somesignature";
    redactor.register(signedToken);
    const json = JSON.stringify({ signed_video_playback_token: signedToken });
    const out = redactor.redact(json);
    expect(out).not.toContain(signedToken);
  });

  it("redacts the signed_video_playback_token field via the JSON backstop pattern even if unregistered", () => {
    const redactor = createSecretRedactor();
    const json = '{"signed_video_playback_token":"totallyUnregisteredSecretValue123"}';
    const out = redactor.redact(json);
    expect(out).not.toContain("totallyUnregisteredSecretValue123");
    expect(out).toContain('"signed_video_playback_token":"[REDACTED]"');
  });

  it("redacts a full signed Mux HLS URL registered as a secret", () => {
    const redactor = createSecretRedactor();
    const url = "https://stream.mux.com/signedPlaybackId123.m3u8?token=superSecretTokenValue987654";
    redactor.register(url);
    const out = redactor.redact(`Fetching ${url} now`);
    expect(out).not.toContain(url);
    expect(out).not.toContain("superSecretTokenValue987654");
  });

  it("redacts an unregistered Mux URL's token query param via the backstop pattern", () => {
    const redactor = createSecretRedactor();
    const out = redactor.redact(
      "GET https://stream.mux.com/pb_abc123.m3u8?token=unregisteredMuxToken0001 -> 200",
    );
    expect(out).not.toContain("unregisteredMuxToken0001");
    expect(out).toMatch(/token=\[REDACTED\]/);
  });

  it("redacts a registered GEMINI_API_KEY wherever it appears", () => {
    const redactor = createSecretRedactor();
    const apiKey = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLan_Maqhb1nkE";
    redactor.register(apiKey);
    const out = redactor.redact(`Initializing Gemini client with key ${apiKey}`);
    expect(out).not.toContain(apiKey);
  });

  it("does not redact ordinary short/common strings", () => {
    const redactor = createSecretRedactor();
    redactor.register("ok"); // too short, should be ignored
    const out = redactor.redact("status: ok, all good");
    expect(out).toBe("status: ok, all good");
  });

  it("redactJson stringifies then redacts", () => {
    const redactor = createSecretRedactor();
    const secret = "superLongSecretValueThatShouldBeHidden";
    redactor.register(secret);
    const out = redactor.redactJson({ token: secret, other: "fine" });
    expect(out).not.toContain(secret);
    expect(out).toContain("fine");
  });

  it("leaves non-sensitive text completely unchanged", () => {
    const redactor = createSecretRedactor();
    const out = redactor.redact("Lesson title: Understanding Candlestick Patterns");
    expect(out).toBe("Lesson title: Understanding Candlestick Patterns");
  });
});
