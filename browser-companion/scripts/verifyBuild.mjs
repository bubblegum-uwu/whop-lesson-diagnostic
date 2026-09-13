#!/usr/bin/env node
/**
 * Post-build sanity check for a generated extension directory (invoked
 * automatically at the end of `npm run build`, and reusable standalone).
 * Fails loudly (non-zero exit) rather than silently shipping a directory
 * Chrome can't actually load.
 */
import { verifyBuildDir } from "./verifyBuildLogic.mjs";
import { resolve } from "node:path";

const distDir = resolve(process.cwd(), process.argv[2] ?? "dist");
const problems = verifyBuildDir(distDir);

if (problems.length > 0) {
  console.error(`Build verification FAILED for ${distDir}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Build verification passed for ${distDir}.`);
