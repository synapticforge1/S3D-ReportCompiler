/**
 * Increments the `version` field in deno.json, then propagates the new version to
 * package.json + src/report_core.ts (by importing sync-version.ts, which runs after
 * deno.json has already been written here).
 *
 * Run via:  deno task bump            # rightmost: 1.6.2 → 1.6.3
 *           deno task bump minor      # middle:    1.6.2 → 1.7.0
 *           deno task bump major      # leftmost:  1.6.2 → 2.0.0
 *
 * VERSIONS ARE A SEQUENTIAL COUNTER, NOT A COMPATIBILITY SIGNAL (owner directive, carried over
 * from the sibling `wasmtk` project). `patch` / `minor` / `major` name the POSITION to increment —
 * rightmost, middle, leftmost — and carry no semver meaning on their own.
 *
 * ODOMETER SEQUENCING: the minor and patch components are single digits and MUST NOT exceed 9.
 * Reaching 9 rolls the component back to 0 and carries 1 into the component to its left:
 *
 *     1.2.9  --patch-->  1.3.0        patch rolls over, minor carries
 *     1.9.9  --patch-->  2.0.0        both roll over, major carries
 *     1.9.4  --minor-->  2.0.0        minor rolls over, major carries
 *
 * Only `major` is unbounded — it just keeps counting (9 → 10 → 11 …).
 *
 * This is intentionally NARROWER than semver, which permits multi-digit components. A version
 * carrying a minor or patch above 9 cannot be produced by this script, so it REFUSES to bump from
 * one rather than guessing — no carry rule reproduces the intended next version.
 *
 * Unlike `update-version` (which only COPIES the existing deno.json version outward), this RAISES
 * it first. Must be run from the project root (deno task does this automatically).
 */

import { readFile, writeFile } from "node:fs/promises";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string) => readFile(p, "utf8");

/** Highest permitted value for the minor and patch components. */
const MAX_COMPONENT = 9;

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

// Refuse to bump from a version this scheme could never have produced. Carrying from, say,
// 1.11.12 is ambiguous (1.12.0? 2.0.0? 2.2.3?), and every answer is a guess that would silently
// pick the wrong release number — so stop and make the owner state the intent.
if (minor > MAX_COMPONENT || patch > MAX_COMPONENT) {
  console.error(
    `❌ bump: ${from} has a minor/patch component above ${MAX_COMPONENT}, which the odometer ` +
      `sequencing rule cannot carry from unambiguously.\n` +
      `   Edit "version" in deno.json by hand to the intended next release, run ` +
      `\`deno task update-version\`, then use \`deno task bump\` from there.`,
  );
  process.exit(1);
}

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

// Odometer carry: a component that reaches 10 rolls to 0 and adds 1 to the one on its left.
// Applied patch-first so a patch bump from x.9.9 carries all the way through to (x+1).0.0.
if (patch > MAX_COMPONENT) {
  patch = 0;
  minor += 1;
}
if (minor > MAX_COMPONENT) {
  minor = 0;
  major += 1;
}

const to = `${major}.${minor}.${patch}`;

// Targeted replace so the rest of deno.json's formatting is untouched.
const updated = text.replace(/("version"\s*:\s*)"\d+\.\d+\.\d+"/, `$1"${to}"`);
await writeFile(denoJsonPath, updated);
console.log(`✅ deno.json          → ${to}  (${kind} bump from ${from})`);

// Propagate the freshly-written version to package.json + src/report_core.ts.
await import("./sync-version.ts");
