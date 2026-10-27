/**
 * Increments the `version` field in deno.json, then propagates the new version to
 * package.json + src/report_core.ts (by importing sync-version.ts, which runs after
 * deno.json has already been written here).
 *
 * Run via:  bun run bump            # patch: 1.6.2 → 1.6.3   (fixes only)
 *           bun run bump minor      # minor: 1.6.2 → 1.7.0   (backward-compatible additions)
 *           bun run bump major      # major: 1.6.2 → 2.0.0   (anything breaking)
 *
 * SEMANTIC VERSIONING 2.0.0 (🔒 workspace owner rule, 2026-09-20; letter H6). The bumped
 * component increases by one and every component to its right resets to 0. Components are
 * unbounded and nothing ever carries: 1.9.9 --patch--> 1.9.10, 1.9.9 --minor--> 1.10.0.
 *
 * (Until 2026-10-26 this was an "odometer" carried over from the sibling `wasmtk`: minor and
 * patch capped at 9, carrying into the component on the left, and refusing to bump from a wider
 * version. The workspace retired every such cap on 2026-09-20.)
 *
 * Choosing the right component is the owner's call, made per release; this script does not
 * judge it (the workspace's surface-snapshot bump gate does not exist here yet — roadmap).
 *
 * Unlike `update-version` (which only COPIES the existing deno.json version outward), this RAISES
 * it first. Must be run from the project root (bun run does this automatically).
 */

import { readFile, writeFile } from "node:fs/promises";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string) => readFile(p, "utf8");

const root = process.cwd();
const denoJsonPath = `${root}/deno.json`;

const kind = (process.argv[2] ?? "patch").toLowerCase();
if (kind !== "patch" && kind !== "minor" && kind !== "major") {
  console.error(`❌ bump: unknown release kind "${kind}" — use patch | minor | major`);
  process.exit(1);
}

const text = await readText(denoJsonPath);
const m = text.match(/("version"\s*:\s*)"(\d+)\.(\d+)\.(\d+)"/);
if (!m) {
  console.error('❌ bump: could not find a "version": "X.Y.Z" field in deno.json');
  process.exit(1);
}

let [major, minor, patch] = [Number(m[2]), Number(m[3]), Number(m[4])];
const from = `${major}.${minor}.${patch}`;

if (kind === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (kind === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const to = `${major}.${minor}.${patch}`;

// Targeted replace so the rest of deno.json's formatting is untouched.
const updated = text.replace(/("version"\s*:\s*)"\d+\.\d+\.\d+"/, `$1"${to}"`);
await writeFile(denoJsonPath, updated);
console.log(`✅ deno.json          → ${to}  (${kind} bump from ${from})`);

// Propagate the freshly-written version to package.json + src/report_core.ts.
await import("./sync-version.ts");
