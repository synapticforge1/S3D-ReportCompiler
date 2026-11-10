/**
 * Raises the `version` in jsr.json, propagates it to package.json + src/report_core.ts (by
 * importing sync-version.ts), and commits the three as `bump to vX.Y.Z` — the bump is its own
 * commit, made by the tooling and never folded into other work (workspace release-process.md § 5,
 * U1–U3; letter H33, 2026-11-10).
 *
 * Run via:  bun run bump patch      # 1.6.2 → 1.6.3   (fixes only)
 *           bun run bump minor      # 1.6.2 → 1.7.0   (backward-compatible additions)
 *           bun run bump major      # 1.6.2 → 2.0.0   (anything breaking)
 *
 * The level is the owner's, and an ARGUMENT: there is no default (U1). Until 2026-11-10 a bare
 * `bun run bump` meant patch.
 *
 * SEMANTIC VERSIONING 2.0.0 (🔒 workspace owner rule, 2026-09-20; letter H6). The bumped
 * component increases by one and every component to its right resets to 0. Components are
 * unbounded and nothing ever carries: 1.9.9 --patch--> 1.9.10, 1.9.9 --minor--> 1.10.0.
 *
 * (Until 2026-10-26 this was an "odometer" carried over from the sibling `wasmtk`: minor and
 * patch capped at 9, carrying into the component on the left, and refusing to bump from a wider
 * version. The workspace retired every such cap on 2026-09-20.)
 *
 * Refused before anything is written (U3): a tree with ANY change, untracked files included — a
 * dirty tree is how a sibling shipped a bare bump of other code (release-process.md § 3) — and a
 * level below the FLOOR: the compatibility gate (scripts/compat.ts) diffs the committed surface
 * snapshot against the last tag, and for a patch or minor runs the last tag's samples on this
 * code.
 *
 * Next: `bun run release` pushes main with this commit; CI checks, tags, makes the Release page,
 * and publishes. Must be run from the project root (bun run does this automatically).
 */

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string) => readFile(p, "utf8");

const root = process.cwd();
const manifestPath = `${root}/jsr.json`;

/** The three files a version bump touches — the only ones its commit holds. */
const VERSION_FILES = ["jsr.json", "package.json", "src/report_core.ts"];

const LEVELS = ["patch", "minor", "major"];
const args = process.argv.slice(2);
const kind = (args[0] ?? "").toLowerCase();
if (args.length !== 1 || !LEVELS.includes(kind)) {
  console.error(
    args.length === 0
      ? "❌ bump: name the level — bun run bump patch | minor | major (there is no default)"
      : `❌ bump: one level, patch | minor | major; got ${args.join(" ")}`,
  );
  process.exit(64);
}

/** stdout of a git command and its status. */
const git = (...a: string[]) => {
  const p = spawnSync("git", a, { encoding: "utf8" });
  return { code: p.status ?? 1, out: (p.stdout ?? "").trim(), err: (p.stderr ?? "").trim() };
};

// A clean tree, untracked files counted: the bump commit must hold the version and nothing else,
// and what is left over would be released under the next number without being in it.
const status = git("status", "--porcelain", "--untracked-files=all");
if (status.code !== 0) {
  console.error(`❌ bump: git status failed — ${status.err || "no answer"}. Nothing written.`);
  process.exit(1);
}
if (status.out !== "") {
  console.error("❌ bump: the tree is not clean (untracked files count). Nothing written:\n");
  console.error(status.out.split("\n").slice(0, 20).join("\n"));
  console.error("\nCommit, stash or remove them, then re-run.");
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

// The bump commit: the three version files only (a pathspec commit), under the name the release
// script and CI look for.
const subject = `bump to v${to}`;
const commit = git("commit", "-q", "-m", subject, "--", ...VERSION_FILES);
if (commit.code !== 0) {
  console.error(`❌ bump: the version files are written, but the commit failed:\n${commit.err}`);
  console.error(
    `   Commit them yourself: git commit -m "${subject}" -- ${VERSION_FILES.join(" ")}`,
  );
  process.exit(1);
}
const left = git("status", "--porcelain", "--untracked-files=all").out;
if (left !== "") {
  console.error(`❌ bump: committed "${subject}", but the tree is not clean after it:\n${left}`);
  process.exit(1);
}
console.log(`✅ committed          ${subject}`);
console.log(`\nNext, when the owner says "release": bun run release`);
