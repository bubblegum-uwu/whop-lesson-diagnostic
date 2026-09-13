import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A regression guard for knoveraContentScript.ts's entire reason for
 * existing: it must stay a narrow, auditable postMessage<->chrome.runtime
 * relay. Static source-scanning is deliberately blunt (this is not a full
 * taint analysis) — its job is to fail loudly if a future edit
 * accidentally introduces exactly the capabilities the Phase 4K-C spec
 * says this file must never have, not to catch every conceivable misuse.
 */
const here = dirname(fileURLToPath(import.meta.url));
const rawSource = readFileSync(resolve(here, "../src/knoveraContentScript.ts"), "utf8");
// Strip comments before scanning — this file's own doc comment explains
// what it must NEVER do, in prose that names the exact forbidden
// APIs/terms, which would otherwise read as a false positive against the
// checks below (they must apply to actual code, not to comments about it).
const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("knoveraContentScript.ts trust boundary", () => {
  it("never reads document.cookie", () => {
    expect(source).not.toMatch(/document\.cookie/);
  });

  it("never touches localStorage or sessionStorage", () => {
    expect(source).not.toMatch(/\b(localStorage|sessionStorage)\b/);
  });

  it("never calls fetch or XMLHttpRequest", () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest/);
  });

  it("never reads the page's DOM (no querySelector/getElementById/innerHTML)", () => {
    expect(source).not.toMatch(/document\.(querySelector|getElementById|getElementsBy)/);
    expect(source).not.toMatch(/\.innerHTML\b/);
  });

  it("never references an Authorization header or a bearer/JWT token", () => {
    expect(source).not.toMatch(/Authorization/i);
    expect(source).not.toMatch(/\bbearer\b/i);
    expect(source).not.toMatch(/\bjwt\b/i);
  });

  it("its only DOM/browser API surface is window.postMessage, window.addEventListener, and chrome.runtime", () => {
    const apiCalls = source.match(/\b(window|document|chrome)\.[a-zA-Z]+/g) ?? [];
    const allowed = new Set(["window.postMessage", "window.addEventListener", "window.location", "chrome.runtime"]);
    for (const call of apiCalls) {
      expect(allowed.has(call), `Unexpected API surface in knoveraContentScript.ts: ${call}`).toBe(true);
    }
  });
});
