#!/usr/bin/env node
/**
 * Generates the final, loadable manifest.json from manifest.template.json
 * plus the Knovera-bridge content script's allowed origins. See
 * manifestConfig.mjs for the actual (unit-tested) validation/build logic —
 * this file is just the thin CLI/env/filesystem wiring around it.
 *
 * Usage:
 *   node scripts/generateManifest.mjs [outputPath]
 *
 * Origins come from the KNOVERA_COMPANION_MATCHES env var — a
 * comma-separated list of explicit match patterns, e.g.:
 *
 *   KNOVERA_COMPANION_MATCHES="http://localhost/*,https://5175-abc123.cloudshell.dev/*" \
 *     npm run build
 *
 * Falls back to localhost/127.0.0.1 (safe local-dev defaults) when unset.
 * Never accepts "<all_urls>" or a wildcard scheme/host — see
 * manifestConfig.mjs's assertNarrowMatchPattern.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKnoveraMatches, buildManifest } from "./manifestConfig.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(here, "../manifest.template.json");
const outputPath = resolve(process.cwd(), process.argv[2] ?? "dist/manifest.json");

const template = JSON.parse(readFileSync(templatePath, "utf8"));
const knoveraMatches = parseKnoveraMatches(process.env.KNOVERA_COMPANION_MATCHES);
const manifest = buildManifest(template, knoveraMatches);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`Wrote ${outputPath}`);
console.log(`  Knovera bridge content script matches: ${knoveraMatches.join(", ")}`);
