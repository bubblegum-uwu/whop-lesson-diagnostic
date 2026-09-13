import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBuildDir } from "../scripts/verifyBuildLogic.mjs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "companion-build-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(manifest: unknown) {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

const VALID_MANIFEST = {
  background: { service_worker: "serviceWorker.js" },
  content_scripts: [
    { matches: ["https://discord.com/channels/*"], js: ["discordContentScript.js"] },
    { matches: ["http://localhost/*"], js: ["knoveraContentScript.js"] },
  ],
};

describe("verifyBuildDir", () => {
  it("4: passes when every manifest-referenced file exists and is a self-contained bundle", () => {
    writeManifest(VALID_MANIFEST);
    writeFileSync(join(dir, "serviceWorker.js"), '(() => { console.log("sw"); })();');
    writeFileSync(join(dir, "discordContentScript.js"), '(() => { console.log("dcs"); })();');
    writeFileSync(join(dir, "knoveraContentScript.js"), '(() => { console.log("kcs"); })();');

    expect(verifyBuildDir(dir)).toEqual([]);
  });

  it("fails when manifest.json is missing entirely", () => {
    expect(verifyBuildDir(dir)).toEqual(expect.arrayContaining([expect.stringContaining("manifest.json is missing")]));
  });

  it("4: fails when a manifest-referenced file does not exist in the build directory", () => {
    writeManifest(VALID_MANIFEST);
    writeFileSync(join(dir, "serviceWorker.js"), "(() => {})();");
    // discordContentScript.js / knoveraContentScript.js deliberately not written.

    const problems = verifyBuildDir(dir);
    expect(problems.some((p: string) => p.includes("discordContentScript.js"))).toBe(true);
    expect(problems.some((p: string) => p.includes("knoveraContentScript.js"))).toBe(true);
  });

  it("5: fails when a content-script bundle still contains a top-level import/export statement", () => {
    writeManifest(VALID_MANIFEST);
    writeFileSync(join(dir, "serviceWorker.js"), "(() => {})();");
    writeFileSync(join(dir, "discordContentScript.js"), 'import { foo } from "./foo.js";\nfoo();');
    writeFileSync(join(dir, "knoveraContentScript.js"), "(() => {})();");

    const problems = verifyBuildDir(dir);
    expect(problems.some((p: string) => p.includes("discordContentScript.js") && p.includes("import"))).toBe(true);
  });

  it("2: fails when the manifest contains <all_urls>", () => {
    writeManifest({ ...VALID_MANIFEST, host_permissions: ["<all_urls>"] });
    writeFileSync(join(dir, "serviceWorker.js"), "(() => {})();");
    writeFileSync(join(dir, "discordContentScript.js"), "(() => {})();");
    writeFileSync(join(dir, "knoveraContentScript.js"), "(() => {})();");

    const problems = verifyBuildDir(dir);
    expect(problems.some((p: string) => p.includes("<all_urls>"))).toBe(true);
  });
});
