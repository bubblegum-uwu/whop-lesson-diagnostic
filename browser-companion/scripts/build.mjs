#!/usr/bin/env node
/**
 * Produces ONE self-contained, loadable extension directory at
 * browser-companion/dist/ — everything Chrome's "Load unpacked" needs and
 * nothing else (no src/, no tests/, no node_modules/).
 *
 * Each of the three runtime entry points is bundled with esbuild to a
 * single IIFE file (format: "iife") — so a content script or the service
 * worker never contains an unresolved top-level `import`/`export`
 * statement; every module it depends on (discordAdapter.ts,
 * discordScanner.ts, bridgeProtocol.ts, ...) is inlined into that one
 * file. IIFE (not "type": "module") keeps the service worker and both
 * content scripts loadable as plain classic scripts, which is what
 * manifest.template.json's `background.service_worker` (no `"type":
 * "module"`) and `content_scripts[].js` entries both expect.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = resolve(root, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const entryPoints = ["serviceWorker", "discordContentScript", "knoveraContentScript"];

await build({
  entryPoints: entryPoints.map((name) => resolve(root, "src", `${name}.ts`)),
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  outdir: distDir,
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

execFileSync(process.execPath, [resolve(here, "generateManifest.mjs"), resolve(distDir, "manifest.json")], {
  stdio: "inherit",
  env: process.env,
});

execFileSync(process.execPath, [resolve(here, "verifyBuild.mjs"), distDir], { stdio: "inherit" });

if (!existsSync(resolve(distDir, "manifest.json"))) {
  throw new Error("Build finished but dist/manifest.json is missing — this should be unreachable.");
}

console.log(`\nBuild complete: ${distDir}`);
console.log('Load it via chrome://extensions -> Developer mode -> "Load unpacked" -> select this directory.');
