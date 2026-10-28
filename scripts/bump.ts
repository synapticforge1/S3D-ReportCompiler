/**
 * Increments the `version` field in jsr.json, then propagates the new version to
 * package.json + src/report_core.ts (by importing sync-version.ts, which runs after
 * jsr.json has already been written here).
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
 * Which component is the owner's call, but never below the FLOOR: the compatibility gate
 * (scripts/compat.ts) diffs the committed surface snapshot against the last tag and refuses a
 * lower bump, before anything is written.
 *
 * Unlike `update-version` (which only COPIES the existing jsr.json version outward), this RAISES
 * it first. Must be run from the project root (bun run does this automatically).
 */

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string) => readFile(p, "utf8");

const root = process.cwd();
const manifestPath = `${root}/jsr.json`;

const kind = (process.argv[2] ?? "patch").toLowerCase();
if (kind !== "patch" && kind !== "minor" && kind !== "major") {
  console.error(`❌ bump: unknown release kind "${kind}" — use patch | minor | major`);
  process.exit(1);
}

// The compatibility gate (scripts/compat.ts, workspace letter H6): refuses a stale api-surface.txt,
// a bump below the surface floor since the last tag, and — for patch / minor — a previous tag whose
// sample reports no longer PASS on this code. Nothing is written unless it passes.
const gate = spawnSync(process.execPath, [...process.execArgv, "scripts/compat.ts", "gate", kind], {
  stdio: "inherit",
});
if (gate.status !== 0) {
  console.error(`❌ bump: the compatibility gate refused a ${kind} bump — nothing written.`);
  process.exit(1);
}

const text = await readText(manifestPath);
const m = text.match(/("version"\s*:\s*)"(\d+)\.(\d+)\.(\d+)"/);
if (!m) {
  console.error('❌ bump: could not find a "version": "X.Y.Z" field in jsr.json');
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

// Targeted replace so the rest of jsr.json's formatting is untouched.
const updated = text.replace(/("version"\s*:\s*)"\d+\.\d+\.\d+"/, `$1"${to}"`);
await writeFile(manifestPath, updated);
console.log(`✅ jsr.json           → ${to}  (${kind} bump from ${from})`);

// Propagate the freshly-written version to package.json + src/report_core.ts.
await import("./sync-version.ts");
