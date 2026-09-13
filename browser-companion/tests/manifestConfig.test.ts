import { describe, it, expect } from "vitest";
import { parseKnoveraMatches, assertNarrowMatchPattern, buildManifest, InvalidMatchPatternError, DEFAULT_KNOVERA_MATCHES } from "../scripts/manifestConfig.mjs";

const TEMPLATE = {
  manifest_version: 3,
  name: "Knovera Browser Companion",
  version: "0.1.0",
  permissions: ["tabs"],
  host_permissions: ["https://discord.com/*"],
  background: { service_worker: "serviceWorker.js" },
  content_scripts: [{ matches: ["https://discord.com/channels/*"], js: ["discordContentScript.js"], run_at: "document_idle" }],
};

describe("parseKnoveraMatches", () => {
  it("falls back to localhost/127.0.0.1 dev defaults when unset", () => {
    expect(parseKnoveraMatches(undefined)).toEqual(DEFAULT_KNOVERA_MATCHES);
    expect(parseKnoveraMatches("")).toEqual(DEFAULT_KNOVERA_MATCHES);
    expect(parseKnoveraMatches("   ")).toEqual(DEFAULT_KNOVERA_MATCHES);
  });

  it("1: parses an explicit comma-separated list, e.g. a Cloud Shell preview origin", () => {
    const result = parseKnoveraMatches("http://localhost/*, https://5175-abc123.cloudshell.dev/*");
    expect(result).toEqual(["http://localhost/*", "https://5175-abc123.cloudshell.dev/*"]);
  });

  it("de-duplicates identical entries", () => {
    expect(parseKnoveraMatches("http://localhost/*,http://localhost/*")).toEqual(["http://localhost/*"]);
  });

  it("2: rejects <all_urls>", () => {
    expect(() => parseKnoveraMatches("<all_urls>")).toThrow(InvalidMatchPatternError);
  });

  it("rejects a bare wildcard scheme+host", () => {
    expect(() => parseKnoveraMatches("*://*/*")).toThrow(InvalidMatchPatternError);
    expect(() => parseKnoveraMatches("http://*/*")).toThrow(InvalidMatchPatternError);
    expect(() => parseKnoveraMatches("https://*/*")).toThrow(InvalidMatchPatternError);
  });

  it("allows a wildcard subdomain of an explicit domain (narrower than 'every website')", () => {
    expect(parseKnoveraMatches("https://*.knovera.example.com/*")).toEqual(["https://*.knovera.example.com/*"]);
  });
});

describe("assertNarrowMatchPattern", () => {
  it("accepts a normal explicit origin", () => {
    expect(assertNarrowMatchPattern("https://app.knovera.example.com/*")).toBe("https://app.knovera.example.com/*");
  });
  it("rejects an empty string", () => {
    expect(() => assertNarrowMatchPattern("")).toThrow(InvalidMatchPatternError);
  });
  it("rejects something that isn't a match-pattern shape at all", () => {
    expect(() => assertNarrowMatchPattern("not-a-pattern")).toThrow(InvalidMatchPatternError);
  });
});

describe("buildManifest", () => {
  it("3: the generated manifest contains the fixed Discord match plus the configured Knovera match(es)", () => {
    const manifest = buildManifest(TEMPLATE, ["https://5175-abc123.cloudshell.dev/*"]);
    expect(manifest.content_scripts[0].matches).toEqual(["https://discord.com/channels/*"]);
    expect(manifest.content_scripts[1].matches).toEqual(["https://5175-abc123.cloudshell.dev/*"]);
    expect(manifest.content_scripts[1].js).toEqual(["knoveraContentScript.js"]);
  });

  it("2: never contains <all_urls> anywhere in the generated manifest", () => {
    const manifest = buildManifest(TEMPLATE, ["http://localhost/*"]);
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>");
  });

  it("leaves every other template field untouched (permissions, host_permissions, Discord content script)", () => {
    const manifest = buildManifest(TEMPLATE, ["http://localhost/*"]);
    expect(manifest.permissions).toEqual(["tabs"]);
    expect(manifest.host_permissions).toEqual(["https://discord.com/*"]);
    expect(manifest.content_scripts[0]).toEqual(TEMPLATE.content_scripts[0]);
  });

  it("throws rather than emit a manifest with zero Knovera origins", () => {
    expect(() => buildManifest(TEMPLATE, [])).toThrow(InvalidMatchPatternError);
  });
});
