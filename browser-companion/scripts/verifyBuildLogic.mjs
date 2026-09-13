/**
 * The actual build-verification checks, as a pure(ish) function over a
 * directory path — separated from verifyBuild.mjs's CLI wrapper so tests
 * can point it at a small fixture directory instead of a real build.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// A real esbuild IIFE bundle never has a top-level import/export
// statement (everything is inlined into the wrapping function) — this is
// a defensive net, not the primary guarantee (esbuild's own bundling is).
const UNRESOLVED_IMPORT_PATTERN = /^\s*(import\s+[^(]|export\s+(default|const|function|class|\{))/m;

export function verifyBuildDir(distDir) {
  const problems = [];
  const manifestPath = resolve(distDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    problems.push(`manifest.json is missing from ${distDir}.`);
    return problems;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    problems.push(`manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return problems;
  }

  if (JSON.stringify(manifest).includes("<all_urls>")) {
    problems.push('manifest.json contains the overly broad "<all_urls>" pattern.');
  }

  const referencedFiles = new Set();
  const serviceWorkerFile = manifest.background?.service_worker;
  if (serviceWorkerFile) referencedFiles.add(serviceWorkerFile);
  for (const entry of manifest.content_scripts ?? []) {
    for (const js of entry.js ?? []) referencedFiles.add(js);
  }

  if (referencedFiles.size === 0) {
    problems.push("manifest.json references no background service worker or content scripts.");
  }

  for (const file of referencedFiles) {
    const filePath = resolve(distDir, file);
    if (!existsSync(filePath)) {
      problems.push(`manifest.json references "${file}", but it does not exist in ${distDir}.`);
      continue;
    }
    const content = readFileSync(filePath, "utf8");
    if (UNRESOLVED_IMPORT_PATTERN.test(content)) {
      problems.push(`"${file}" contains a top-level import/export statement — it is not a self-contained bundle.`);
    }
  }

  return problems;
}
