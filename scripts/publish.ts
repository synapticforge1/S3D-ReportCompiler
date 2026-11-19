/**
 * The release script: checks that `main` holds exactly one new commit, the bump `bun run bump`
 * made, then pushes `main` — and nothing else. GitHub Actions does the rest, in the owner's order
 * (🔒 2026-11-10, workspace release-process.md § 5, letter H33): "the CI to check first, then push
 * the tag, and then create the release page from the tag, then publish the package to the
 * registry". publish.yml runs on every push to main; a commit whose jsr.json version has no tag is
 * a release.
 *
 * Usage: bun run release [--dry-run] [--no-wait]      (this file; there is no `publish` task)
 *
 *   --dry-run   every guard and the cold gate, then stop: nothing is pushed
 *   --no-wait   push, and do not wait for CI to publish (check later: bun run verify-release)
 *
 * ⚠️ **`bun run release`, never `deno publish`.** Those two differ by one word and do completely
 * different things: this one lets GitHub Actions publish with an OIDC token, the only source of
 * provenance; `deno publish` uploads straight from the workstation and produces an unattested
 * release that cannot be corrected, because JSR versions are immutable. 1.0.2 and 1.0.3 were both
 * lost that way. The task is called `release` and **no `publish` task exists**, deliberately; the
 * file keeps its name because that is what it causes.
 *
 * NO TAG IS MADE OR PUSHED FROM A MACHINE (U4). Until 2026-11-10 this script committed the bump
 * itself, ran `git tag -f`, pushed main, then force-pushed the tag; a refusal had to undo its own
 * commit. Now the bump commit is `bun run bump`'s, CI makes the tag after its checks, and a
 * published tag never moves.
 *
 * Guards, in order (each refuses with nothing pushed):
 *   1. the tree is clean, untracked files included
 *   2. HEAD is on main, tracking origin/main, and after a fetch HEAD^ IS origin/main: exactly one
 *      new commit (1.0.1 was released one commit behind the fix it existed to ship)
 *   3. that commit is `bump to vX.Y.Z` for jsr.json's version, touches only the three version
 *      files and `npm-dist.sha256` and only their version / digest lines (known-issues #30: other
 *      edits once went out as a "bump"), records the digest, and the three versions agree
 *   4. the tag vX.Y.Z exists neither here nor on origin
 *   4b. the review set (H37 (d), the release's first step): `Review complete: <commit>` in the
 *      git-ignored cmem/review-issues.md, an ancestor of HEAD, and only bump / memory files
 *      changed since it (scripts/review-gate.ts)
 *   5. JSR answers 404 for the version and npm can still take the number; a registry that cannot
 *      answer refuses (no test hook may stand in for one, except under --dry-run)
 *   6. every gate, locally (H37 (e): CI only publishes): compat, types, format, lint, privacy,
 *      memory size, the suite on Bun and on each Node line, the runtime matrix, the npm package
 *      built, matched to the digest bump recorded, and proven; the suite in WSL (linux-x64) when
 *      it is set up. It prints the release's "Tested on:" lines.
 * Then `git push origin main` (never forced) and a read-back with `git ls-remote`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { lookupNpmTaken, lookupVersion, NPM_NAME, testHooksSet, usingTestApi } from "./jsr-api.ts";
import { BUMP_FILES, ISSUES_FILE, reviewedCommit, unreviewedFiles } from "./review-gate.ts";

const manifest = JSON.parse(readFileSync(new URL("../jsr.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

// Unknown arguments are refused before anything is done: `--no-wiat` used to be ignored (the #12 /
// #43 class; verify-release refuses them, this did not) (2026-11-07 review).
const KNOWN_ARGS = ["--no-wait", "--dry-run"];
const argv = process.argv.slice(2);
const unknownArgs = argv.filter((a) => !KNOWN_ARGS.includes(a));
if (unknownArgs.length > 0) {
  console.error(
    `Unknown argument(s): ${unknownArgs.join(", ")}. Supported: ${KNOWN_ARGS.join(", ")}`,
  );
  process.exit(64);
}
const dryRun = argv.includes("--dry-run");

const version = manifest.version;
const tag = `v${version}`;

/** This same runtime, with its own flags — how the release runs its sibling scripts. */
const self = [process.execPath, ...process.execArgv];

/**
 * What the bump commit holds: the three version files and `npm-dist.sha256`, the digest of the npm
 * package bump built (CI publishes only a build with that digest; scripts/npm-digest.ts).
 */
const VERSION_FILES = BUMP_FILES;

/** stdout of a command, trimmed, and its status. */
function sh(cmd: string[]): { code: number; out: string } {
  const p = spawnSync(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  return {
    code: p.status ?? 1,
    out: new TextDecoder().decode(p.stdout ?? new Uint8Array()).trim(),
  };
}

/** stdout of a command that must succeed; a failure refuses with git's own words. */
function must(cmd: string[], what: string): string {
  const p = spawnSync(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  if (p.status !== 0) {
    const err = p.error ? p.error.message : new TextDecoder().decode(p.stderr).trim();
    refuse(`${what} failed: ${err || `exit ${p.status}`}`);
  }
  return new TextDecoder().decode(p.stdout ?? new Uint8Array()).trim();
}

function refuse(why: string, ...more: string[]): never {
  console.error(`\n❌ ${why}`);
  for (const l of more) console.error(`   ${l}`);
  console.error(`\nNothing was pushed.`);
  process.exit(1);
}

/** This machine's platform ID (workspace platforms.md: the six IDs). */
function platformId(): string {
  const os = { win32: "win", darwin: "mac", linux: "linux" }[process.platform as string];
  const arch = { x64: "x64", arm64: "arm64" }[process.arch as string];
  return os && arch ? `${os}-${arch}` : `${process.platform}-${process.arch}`;
}

/** The OS and its version, for the release's "Tested on:" line. */
function osName(): string {
  const release = osRelease();
  if (process.platform === "win32") {
    const build = Number(release.split(".")[2] ?? 0);
    return `Windows ${build >= 22000 ? "11" : "10"} (build ${build})`;
  }
  return `${process.platform === "darwin" ? "macOS (Darwin" : "Linux (kernel"} ${release})`;
}

/** WSL is ready for the suite: Bun where publish.yml's pin put it, and a Chrome on its PATH. */
const WSL_PROBE =
  'test -x ~/.bun/bin/bun || { echo "no Bun at ~/.bun/bin"; exit 0; }; ' +
  "for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do " +
  'command -v "$c" >/dev/null && { echo ready; exit 0; }; done; echo "no Chrome on its PATH"';
/** The WSL distro and version, as its os-release names it. */
const WSL_OS = '. /etc/os-release && echo "$PRETTY_NAME"';

console.log(`Releasing ${tag}${dryRun ? " (dry run: nothing is pushed)" : ""} …`);

// 1. A clean tree, untracked files counted: what is not committed is not in the release.
{
  const dirty = must(["git", "status", "--porcelain", "--untracked-files=all"], "git status");
  if (dirty) {
    refuse(
      `The tree is not clean — these would NOT be in ${tag}:`,
      ...dirty.split("\n").slice(0, 20),
      `Commit, stash or remove them first.`,
    );
  }
}

// 2. Only main, tracking origin/main, exactly one commit ahead of it. A push of any other branch
//    starts no release (publish.yml runs on main), but its unmerged code would then be what the
//    next bump sits on; and a main behind or diverged from origin is refused by the push anyway,
//    later and less clearly.
{
  const branch = sh(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]).out;
  if (branch !== "main") {
    refuse(
      `Only main is released; HEAD is ${branch ? `on "${branch}"` : "detached"}.`,
      `Merge into main, switch to it, then re-run.`,
    );
  }
  const upstream = sh(["git", "rev-parse", "--abbrev-ref", "main@{upstream}"]).out;
  if (upstream !== "origin/main") {
    refuse(
      `main must track origin/main to be released; it tracks ${upstream || "nothing"}.`,
      `Run: git branch -u origin/main`,
    );
  }
  must(["git", "fetch", "--quiet", "origin"], "git fetch origin");
  const head = must(["git", "rev-parse", "HEAD"], "git rev-parse HEAD");
  const remote = must(["git", "rev-parse", "origin/main"], "git rev-parse origin/main");
  const parent = sh(["git", "rev-parse", "--verify", "--quiet", "HEAD^"]).out;
  if (head === remote) {
    refuse(
      `main is already origin/main: there is no bump commit to push.`,
      `Make one with: bun run bump patch | minor | major`,
      `(If ${tag}'s bump is already pushed, CI is releasing it: bun run verify-release -- --wait --npm --github)`,
    );
  }
  if (parent !== remote) {
    const ahead = sh(["git", "rev-list", "--count", "origin/main..HEAD"]).out;
    const behind = sh(["git", "rev-list", "--count", "HEAD..origin/main"]).out;
    refuse(
      `main must be origin/main plus ONE commit, the bump; it is ${ahead || "?"} ahead and ${behind || "?"} behind.`,
      `Push the work first ("push"), pull what is missing, then bump and release.`,
    );
  }
}

// 3. That one commit is the bump of jsr.json's version, and nothing else.
{
  const subject = must(["git", "log", "-1", "--pretty=%s"], "git log");
  if (subject !== `bump to ${tag}`) {
    refuse(
      `HEAD is "${subject}", not "bump to ${tag}".`,
      `The release commit is the one \`bun run bump <level>\` makes.`,
    );
  }
  const files = must(
    ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    "git diff-tree",
  )
    .split("\n")
    .filter(Boolean);
  const others = files.filter((f) => !VERSION_FILES.includes(f));
  if (others.length > 0) {
    refuse(
      `"bump to ${tag}" changes more than the version files:`,
      ...others.slice(0, 10),
      `Commit those on their own, then bump again.`,
    );
  }
  if (!files.includes("npm-dist.sha256")) {
    refuse(
      `"bump to ${tag}" does not record the npm package's digest (npm-dist.sha256).`,
      `bun run bump writes it; re-make the bump.`,
    );
  }
  const VERSION_LINE: Record<string, RegExp> = {
    "jsr.json": /^"version"\s*:\s*"[^"]*",?$/,
    "package.json": /^"version"\s*:\s*"[^"]*",?$/,
    "src/report_core.ts": /^export const VERSION = "[^"]*";$/,
    "npm-dist.sha256": /^[0-9a-f]{64}$/,
  };
  for (const [file, ok] of Object.entries(VERSION_LINE)) {
    const diff = sh(["git", "diff", "HEAD^", "HEAD", "--unified=0", "--", file]).out;
    const other = diff
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .map((l) => l.slice(1).trim())
      .filter((l) => !ok.test(l));
    if (other.length > 0) {
      refuse(`${file} changes besides its version line in "bump to ${tag}":`, ...other.slice(0, 5));
    }
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  const core = readFileSync(new URL("../src/report_core.ts", import.meta.url), "utf8");
  const coreVersion = /export const VERSION = "([^"]*)";/.exec(core)?.[1];
  if (pkg.version !== version || coreVersion !== version) {
    refuse(
      `The version files disagree: jsr.json ${version}, package.json ${pkg.version}, src/report_core.ts ${coreVersion}.`,
      `bun run bump writes all three; re-make the bump.`,
    );
  }
  const before = sh(["git", "show", "HEAD^:jsr.json"]).out;
  const was = /"version"\s*:\s*"([^"]*)"/.exec(before)?.[1];
  if (was === version) refuse(`"bump to ${tag}" does not change jsr.json's version.`);
}

// 4. The tag is CI's to make: it must exist nowhere yet. A tag here would be pushed by nothing,
//    and one on origin means this version was released (or is being). Origin first: step 2's
//    fetch copies a remote tag here, and that is not a leftover to delete.
{
  const onOrigin = must(
    ["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`],
    "git ls-remote --tags origin",
  );
  if (onOrigin !== "") {
    refuse(
      `origin already has ${tag} — this version is released, or being released.`,
      `A release tag never moves: bump again.`,
    );
  }
  if (sh(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).code === 0) {
    refuse(
      `A local tag ${tag} exists. Tags are made by CI after its checks, never on a machine.`,
      `If it is a leftover: git tag -d ${tag}`,
    );
  }
}

// 4b. The review set -- the release's first step once the tree is known to be the bump (workspace
//    review standard § 9, letter H37 (d)). The five required reviews are agent work: this reads
//    their RESULT, `Review complete: <commit>` in the git-ignored cmem/review-issues.md, and
//    refuses when there is none, when that commit is not in this branch, or when code the review
//    did not read changed since (only the bump's files and cmem/ may). See scripts/review-gate.ts.
{
  let text: string;
  try {
    text = readFileSync(new URL(`../${ISSUES_FILE}`, import.meta.url), "utf8");
  } catch {
    refuse(
      `No ${ISSUES_FILE}: no review of this code is recorded.`,
      `Run the review ("review": the five required classes); it ends with "Review complete: <commit>".`,
    );
  }
  const reviewed = reviewedCommit(text);
  if ("refusal" in reviewed) {
    refuse(`The review gate refused ${tag}: ${reviewed.refusal}.`, `Run the review, then release.`);
  }
  const full = sh(["git", "rev-parse", "--verify", "--quiet", `${reviewed.commit}^{commit}`]);
  if (full.code !== 0) refuse(`The reviewed commit ${reviewed.commit} is not in this repository.`);
  if (sh(["git", "merge-base", "--is-ancestor", full.out, "HEAD"]).code !== 0) {
    refuse(
      `The reviewed commit ${reviewed.commit} is not an ancestor of HEAD: another line of work.`,
    );
  }
  const changed = must(["git", "diff", "--name-only", full.out, "HEAD"], "git diff")
    .split("\n")
    .filter(Boolean);
  const unreviewed = unreviewedFiles(changed);
  if (unreviewed.length > 0) {
    refuse(
      `Code changed since the review (${reviewed.commit}) — the review did not read:`,
      ...unreviewed.slice(0, 10),
      `Re-review those changes, then update "Review complete:".`,
    );
  }
  console.log(
    `  review:  complete at ${reviewed.commit}; since then only ${changed.length} bump/memory file(s)`,
  );
}

// 5. Both registries can take the number. Three answers, not two: 404 is "not published" and the
//    only one that lets the release on; a record is "already published"; anything else -- a 5xx,
//    a 429, a timeout, no network -- is "could not tell", and refuses: continuing past a check
//    that could not run is what made this guard useless the first time (under Deno: no
//    --allow-net, the catch swallowed it, a tag was force-pushed onto a published version).
{
  let answer: string;
  try {
    const look = await lookupVersion(manifest.name, version);
    answer = "missing" in look ? "missing" : "info" in look ? "published" : look.error;
  } catch (e) {
    answer = e instanceof Error ? e.message : String(e); // the test hook's fence refused
  }
  if (answer === "published") {
    refuse(`${manifest.name}@${version} is ALREADY published on JSR.`, `Bump instead.`);
  }
  if (answer !== "missing") {
    refuse(
      `Could not ask JSR whether ${version} is already published (${answer}).`,
      `Re-run when https://api.jsr.io answers.`,
    );
  }
  // npm must still be able to take the number: it never reuses one, even an unpublished one, and
  // JSR used to get a version npm could not (review 5). Answered or refused, as JSR's is.
  const npm = await lookupNpmTaken(NPM_NAME, version);
  if ("error" in npm || npm.taken) {
    refuse(
      "error" in npm
        ? `Could not ask npm whether ${version} can still be published (${npm.error}). Re-run when it answers.`
        : `${NPM_NAME}@${version} is, or once was, on npm — npm never takes a number twice. Bump instead.`,
    );
  }
  // A "not published" from a fake registry is not one from the registry: never push on it. (The
  // test hooks only ever drive refusals -- and a dry run, which pushes nothing; a hook left set in
  // a shell must not be what lets a release through.)
  const hooks = testHooksSet();
  if (!dryRun && (usingTestApi() || hooks.length > 0)) {
    refuse(
      `${hooks.join(", ") || "S3D_JSR_API"} is set — a release never runs against a test registry. Unset it.`,
    );
  }
}

// 6. Every gate, LOCALLY, on exactly this commit (workspace review standard § 10: "every gate, the
//    test suites included, runs locally and is not repeated on GitHub"; letter H37 (e), owner
//    2026-11-19). CI only checks what belongs to publishing. Per ENGINE (letter H39): Bun (JSC) and
//    Node (V8; the floor and each LTS line, through fnm) — Deno is V8 too and is not run here
//    (owner, 2026-10-28: no Deno on this machine); JSR's own checks run in publish.yml's `checks`.
//    The compatibility gate (letter H6): api-surface.txt current, the bump not below the surface
//    floor since the last tag, and for a patch or minor the last tag's samples PASS here.
const NODE_LINES = ["22.18.0", "24", "26"]; // the suite's Node lines (CI's node-suite until H37)
const lastTag = sh(["git", "describe", "--tags", "--match", "v*", "--abbrev=0", "HEAD^"]).out;
const gates: [string, string[]][] = [
  ["The compatibility gate", [...self, "scripts/compat.ts", "release", version]],
  ["The type check", [...self, "run", "check"]],
  ["Formatting", [...self, "run", "format:check"]],
  ["Lint", [...self, "run", "lint"]],
  [
    "The privacy gate",
    [...self, "scripts/check-privacy.ts", ...(lastTag ? ["--commits", `${lastTag}..HEAD`] : [])],
  ],
  ["The memory size check", [...self, "scripts/check-cmem.ts", "--summary"]],
  ["The suite on Bun", [...self, "run", "test"]],
  ...NODE_LINES.map((v): [string, string[]] => [
    `The suite on Node ${v}`,
    [
      "fnm",
      "exec",
      `--using=${v}`,
      "node",
      "--test",
      "--test-concurrency=1",
      "tests/build.test.ts",
    ],
  ]),
  ["The runtime matrix (Node lines, Bun)", [...self, "scripts/check-runtimes.ts"]],
  ["The npm package build", [...self, "run", "npm:build"]],
  ["The npm package is the one bump recorded", [...self, "scripts/npm-digest.ts", "--check"]],
  ["The npm package proven (Node lines, Bun)", [...self, "scripts/npm-prove.ts"]],
];
const testedOn = [`Tested on: ${osName()} (${platformId()})`];
for (const [what, cmd] of gates) {
  console.log(`\n── ${what}`);
  const p = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (p.status !== 0) refuse(`${what} refused ${tag}.`);
}
// linux-x64 through the dev machine's WSL (owner, 2026-11-19: "WSL Ubuntu locally"), when it is set
// up: Bun at ~/.bun/bin and a Chrome on its PATH. Not set up is not a failure (the interim rule,
// owner 2026-11-19: no release waits for a platform without a test run); it is not claimed either.
if (process.platform === "win32") {
  const probe = sh(["wsl.exe", "-e", "bash", "-lc", WSL_PROBE]);
  if (probe.code === 0 && probe.out.includes("ready")) {
    console.log("\n── The suite on Bun in WSL (linux-x64)");
    const wslRoot = sh(["wsl.exe", "-e", "wslpath", "-a", process.cwd()]).out;
    const p = spawnSync(
      "wsl.exe",
      [
        "-e",
        "bash",
        "-lc",
        `cd '${wslRoot}' && ~/.bun/bin/bun test --timeout 300000 tests/build.test.ts`,
      ],
      { stdio: "inherit" },
    );
    if (p.status !== 0) refuse(`The suite in WSL refused ${tag}.`);
    testedOn.push(
      `Tested on: ${sh(["wsl.exe", "-e", "bash", "-lc", WSL_OS]).out} in WSL (linux-x64)`,
    );
  } else {
    console.log(
      `\n·  linux-x64: WSL not set up (${probe.out || "no answer"}) — not run, not claimed`,
    );
  }
}
console.log(`\n${testedOn.join("\n")}\nOther platforms: not yet tested.`);
console.log("   (Put these lines in the release's cmem/release.md entry and on its Release page.)");

const head = must(["git", "rev-parse", "HEAD"], "git rev-parse HEAD");
console.log(`\n  pushing main = ${head.slice(0, 12)}  bump to ${tag}`);
if (dryRun) {
  console.log(`\n✅ Dry run: every guard passed for ${tag}. Nothing was pushed.`);
  process.exit(0);
}

// 7. Push main -- never forced -- and read it back. CI takes it from here: checks, then the tag,
//    then the Release page, then JSR and npm.
must(["git", "push", "origin", "main"], "git push origin main");
const pushed = must(
  ["git", "ls-remote", "origin", "refs/heads/main"],
  "git ls-remote origin",
).split(/\s+/)[0];
if (pushed !== head) {
  console.error(`\n❌ origin's main reads back as ${pushed || "nothing"}, not ${head}.`);
  console.error(`   Check: git ls-remote origin refs/heads/main`);
  process.exit(1);
}

console.log(
  `\nmain pushed (${head.slice(0, 12)}). publish.yml: checks → tag ${tag} → Release page → JSR → npm.`,
);
console.log(`Watch progress at: https://github.com/synapticforge1/S3D-ReportCompiler/actions`);

// 8. Wait for the release to land, and confirm it is ATTESTED.
//
// Pushing is not the finish line — it is the point where the outcome stops being visible. 1.0.2
// went out unattested and that was only noticed days later, because a successful publish and an
// attested publish look identical everywhere except one field on the JSR API (known-issues #26).
// CI now reads both attestations back itself, fatally; this is the same check, as a user.
if (argv.includes("--no-wait")) {
  console.log(
    `\n--no-wait: not waiting. Confirm with:  bun run verify-release -- --wait --npm --github`,
  );
} else {
  console.log(`\nWaiting for the workflow to publish, then checking provenance…`);
  console.log(
    `(Ctrl-C is safe — the release continues; check later with bun run verify-release)\n`,
  );
  const check = spawnSync(
    self[0],
    [...self.slice(1), "scripts/verify-release.ts", version, "--wait", "--npm", "--github"],
    { stdio: "inherit" },
  );
  const code = check.status ?? 1;
  // Propagate the verdict: an unattested release should not exit 0.
  if (code !== 0) process.exit(code);
}
