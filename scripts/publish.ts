/**
 * Publish script: syncs the version, commits, tags, and pushes so GitHub Actions
 * can run `deno publish` with OIDC provenance via .github/workflows/publish.yml.
 *
 * Publishing is deliberately NOT done from a workstation: JSR only records a
 * provenance attestation for a publish that comes from GitHub Actions through
 * the native OIDC integration. A local `deno publish` would succeed and produce
 * an unattested release.
 *
 * Usage: bun run release      (this file; there is no `publish` task)
 *
 * ⚠️ **`bun run release`, never `deno publish`.** Those two differ by one word
 * and do completely different things: this one tags and lets GitHub Actions
 * publish with an OIDC token, which is the only source of provenance;
 * `deno publish` uploads straight from the workstation and produces an
 * unattested release that cannot be corrected, because JSR versions are
 * immutable. 1.0.2 and 1.0.3 were both lost that way.
 *
 * The task is called `release` and **no `publish` task exists**, deliberately —
 * so the word "publish" never appears as something you can type here, and the
 * near-collision with `deno publish` has nowhere to start. The file keeps its
 * name because that is what it does; only the entry point is named `release`.
 *
 * Steps:
 *   0. Refuse if jsr.json / package.json / src/report_core.ts differ from HEAD in anything
 *      but their version lines (step 3 would otherwise commit those edits as a "bump")
 *   1. Read the current version from jsr.json
 *   2. Run scripts/sync-version.ts to propagate it to package.json + src/report_core.ts
 *   3. git add + commit "bump version to vX.Y.Z"
 *   4. Pre-flight — refuse to tag the wrong thing (see below); a refusal undoes step 3's commit
 *   5. git tag -f vX.Y.Z
 *   6. git push && git push --force origin vX.Y.Z  ← triggers publish.yml
 *
 * The pre-flight refuses if the working tree has uncommitted tracked changes, if
 * HEAD is behind its upstream, or if the version is already on JSR — and prints
 * the commit it is about to tag. All three exist because 1.0.1 was released from
 * a commit one behind the fix it was meant to ship, and nothing said so.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lookupVersion, usingTestApi } from "./jsr-api.ts";

const manifest = JSON.parse(readFileSync(new URL("../jsr.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

const version = manifest.version;
const tag = `v${version}`;

/** This same runtime, with its own flags — how the release runs its sibling scripts. */
const self = [process.execPath, ...process.execArgv];

/**
 * Run a command, and abort the whole release if it fails.
 *
 * Every step here is load-bearing — a failed `git push` must not be followed by
 * a tag push — so there is deliberately no "continue on error" path.
 */
function run(cmd: string[]): void {
  const p = spawnSync(cmd[0], cmd.slice(1));
  const code = p.status ?? 1;
  if (code !== 0) {
    console.error(p.error ? p.error.message : new TextDecoder().decode(p.stderr));
    refuse(code);
  }
}

/**
 * The "bump version" commit step 3 made, while it is still only local; null once the push
 * starts, or when step 3 had nothing to commit.
 */
let bumpCommit: string | null = null;

/** The three files a version bump touches — the only ones step 3 may commit. */
const VERSION_FILES = ["jsr.json", "package.json", "src/report_core.ts"];

/**
 * Stop the release. Before the push, a refusal also takes back step 3's commit: until
 * 2026-11-05 a release the pre-flight refused left "bump version to vX" on main, and the next
 * plain push published it -- the stray-bump history step 0 exists to prevent. A soft reset, then
 * the three version files unstaged, puts the tree AND the index back exactly as they were (step
 * 0 proved those files differ from the previous commit only in their version lines; anything
 * the developer had staged stays staged). Only when HEAD is still that commit.
 */
function refuse(code: number): never {
  if (bumpCommit !== null) {
    const head = capture(["git", "rev-parse", "HEAD"]);
    const subject = capture(["git", "log", "-1", "--pretty=%s"]);
    // All three must hold, and an empty capture (git failed) never counts as a match.
    if (
      /^[0-9a-f]{40}$/.test(bumpCommit) &&
      head === bumpCommit &&
      subject === `bump version to ${tag}`
    ) {
      // --soft, then unstage only the three version files: exactly the state before the release.
      // A --mixed reset cleared the WHOLE index, so a file the developer had staged themselves
      // came back unstaged.
      const reset = spawnSync("git", ["reset", "--quiet", "--soft", "HEAD~1"]);
      const unstage =
        reset.status === 0
          ? spawnSync("git", ["reset", "--quiet", "HEAD", "--", ...VERSION_FILES])
          : reset;
      const after = capture(["git", "rev-parse", "HEAD"]);
      const undone = reset.status === 0 && after !== bumpCommit && after !== "";
      if (undone && unstage.status !== 0) {
        // The commit is gone; only the index is left as the bump commit had it.
        console.error(`   (undid the local "bump version to ${tag}" commit, but could not unstage`);
        console.error(
          `    ${VERSION_FILES.join(", ")}: ${new TextDecoder().decode(unstage.stderr ?? new Uint8Array()).trim() || "git failed"}.`,
        );
        console.error(`    Run: git reset -q HEAD -- ${VERSION_FILES.join(" ")})`);
      } else if (undone) {
        console.error(`   (undid the local "bump version to ${tag}" commit; the bump is unstaged)`);
      } else {
        console.error(`   ⚠️ could NOT undo the local "bump version to ${tag}" commit`);
        console.error(
          `      (${new TextDecoder().decode(reset.stderr ?? new Uint8Array()).trim() || "HEAD unchanged"}).`,
        );
        console.error(
          `      It is still on this branch — do not push it: git reset --mixed HEAD~1`,
        );
      }
    } else {
      console.error(
        `   ⚠️ HEAD is not the bump commit any more; left as is. Check before pushing:`,
      );
      console.error(`      git log -2 --oneline`);
    }
  }
  process.exit(code);
}

/** stdout of a command, trimmed. Exit status is ignored — callers interpret "". */
function capture(cmd: string[]): string {
  const p = spawnSync(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
  return new TextDecoder().decode(p.stdout ?? new Uint8Array()).trim();
}

console.log(`Publishing ${tag} via GitHub Actions…`);

// 0. The three files step 2 stages may differ from HEAD ONLY in their version lines — what
//    `bun run bump` leaves behind. Anything else would be swept into the "bump version" commit
//    and released under that title (cmem/known-issues.md #30: it happened on 2026-10-26). The
//    dirty-tree check in step 4 cannot see it, because by then these files are committed.
{
  const VERSION_LINE: Record<string, RegExp> = {
    "jsr.json": /^"version"\s*:\s*"[^"]*",?$/,
    "package.json": /^"version"\s*:\s*"[^"]*",?$/,
    "src/report_core.ts": /^export const VERSION = "[^"]*";$/,
  };
  for (const [file, ok] of Object.entries(VERSION_LINE)) {
    const diff = capture(["git", "diff", "HEAD", "--unified=0", "--", file]);
    const changed = diff
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .map((l) => l.slice(1).trim());
    const other = changed.filter((l) => !ok.test(l));
    if (other.length > 0) {
      console.error(`\n❌ ${file} has uncommitted changes besides its version line.`);
      console.error(`   The release would commit them as "bump version to ${tag}":\n`);
      for (const l of other.slice(0, 5)) console.error(`     ${l}`);
      if (other.length > 5) console.error(`     … ${other.length - 5} more`);
      console.error(`\nCommit them on their own first, then re-run.`);
      process.exit(1);
    }
  }
}

// 1. Sync the version out to package.json + src/report_core.ts
run([...self, "scripts/sync-version.ts"]);

// 2. Stage the three files sync-version touches
run(["git", "add", "jsr.json", "package.json", "src/report_core.ts"]);

// 3. Commit THE THREE FILES ONLY (skip if they hold nothing new — the version was already synced).
//    A pathspec commit, because a plain `git commit` takes everything staged: a file staged
//    beforehand went out under "bump version to vX", unseen by step 0 (three files only) and by
//    step 4's dirty check (it was committed by then) — the known-issues #30 class again. Now
//    anything else staged stays staged, and step 4 refuses it.
const diffCode = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...VERSION_FILES]).status;
if (diffCode !== 0) {
  run(["git", "commit", "-m", `bump version to ${tag}`, "--", ...VERSION_FILES]);
  bumpCommit = capture(["git", "rev-parse", "HEAD"]);
}

// 4. PRE-FLIGHT — what exactly is about to be released?
//
// `git tag` silently tags whatever HEAD happens to be. On the 1.0.1 release that
// was one commit behind the fix the release existed to ship: the tag landed on
// the previous commit, the workflow published from it, and JSR versions are
// IMMUTABLE — so the mistake could only be corrected by burning a version
// number. Nothing warned, because nothing looked.
{
  // Uncommitted tracked changes are not in the commit being tagged, so they will
  // not be in the release however clearly they exist on disk.
  const dirty = capture(["git", "status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    console.error(`\n❌ Uncommitted changes — these would NOT be in ${tag}:\n`);
    console.error(dirty);
    console.error(`\nCommit or stash them, then re-run.`);
    refuse(1);
  }

  // Behind the remote means someone else's commits — or your own from another
  // machine — are missing from what is about to be published.
  run(["git", "fetch", "--quiet", "origin"]);
  const upstream = capture(["git", "rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (upstream) {
    const behind = capture(["git", "rev-list", "--count", `HEAD..${upstream}`]);
    if (behind !== "0" && behind !== "") {
      console.error(`\n❌ HEAD is ${behind} commit(s) behind ${upstream}.`);
      console.error(`   Pull first — those commits would not be in ${tag}.`);
      refuse(1);
    }
  }

  // Already on the registry? Then this is not a release, it is an accident.
  // Forcing the tag would move the GitHub release off the code JSR actually
  // holds, and `deno publish` would fail anyway. Turning the warning below into
  // a check, because a comment does not stop anyone.
  // Three answers, not two: 404 is "not published" and the only one that lets the release on;
  // a record is "already published"; anything else -- a 5xx, a 429, a timeout, no network --
  // is "could not tell". That used to read as "not published" (a 503 silently, a network
  // failure with a warning), and the fetch had no timeout, so a stalled connection hung the
  // release. ⚠️ "Could not tell" now REFUSES: continuing past a check that could not run is
  // what made this guard useless the first time (under Deno: no --allow-net, the catch
  // swallowed it, a tag was force-pushed onto a published version), and `deno publish` SKIPS
  // an already-published version with exit 0 and runs on into the release steps
  // (roadmap task 11). A release can wait for JSR to answer. The lookup is shared with
  // verify-release (scripts/jsr-api.ts).
  let answer: string;
  try {
    const look = await lookupVersion(manifest.name, version);
    answer = "missing" in look ? "missing" : "info" in look ? "published" : look.error;
  } catch (e) {
    answer = e instanceof Error ? e.message : String(e); // the test hook's fence refused
  }
  if (answer === "published") {
    console.error(`\n❌ ${manifest.name}@${version} is ALREADY published on JSR.`);
    console.error(`   JSR versions are immutable — bump instead:\n`);
    console.error(`     bun run bump      # ${version} -> next patch`);
    console.error(`     bun run release\n`);
    refuse(1);
  }
  if (answer !== "missing") {
    console.error(`\n❌ Could not ask JSR whether ${version} is already published (${answer}).`);
    console.error(`   Tagging blind could move the tag of a published version. Re-run when`);
    console.error(`   https://api.jsr.io answers.`);
    refuse(1);
  }
  // A "not published" from a fake JSR is not one from JSR: never tag on it. (The test hook only
  // ever drives refusals; a hook left set in a shell must not be what lets a release through.)
  if (usingTestApi()) {
    console.error(`\n❌ S3D_JSR_API is set — a release never tags against a test JSR. Unset it.`);
    refuse(1);
  }

  // The compatibility gate on the version about to be tagged (workspace letter H6): the committed
  // api-surface.txt must be current, the bump since the last tag must not be below the surface
  // floor, and for a patch or minor the previous tag's samples must PASS on this code.
  // `--unpublished`: JSR just answered 404, so a v<version> tag that exists is a stranded retry
  // (publish.ts moves it, by design), not a release — the gate may set it aside as a baseline.
  console.log("");
  const gate = spawnSync(
    self[0],
    [...self.slice(1), "scripts/compat.ts", "release", version, "--unpublished"],
    { stdio: "inherit" },
  );
  if (gate.status !== 0) {
    console.error(`\n❌ The compatibility gate refused ${tag} — nothing tagged.`);
    refuse(1);
  }

  const sha = capture(["git", "rev-parse", "--short", "HEAD"]);
  const subject = capture(["git", "log", "-1", "--pretty=%s"]);
  console.log(`\n  tagging ${sha}  ${subject}`);
  console.log(`  as       ${tag}\n`);
}

// 5. Tag (force-update so a re-run after a failed release still works)
run(["git", "tag", "-f", tag]);

// From the push on, the commit is shared: a failure must not rewrite it. (A failed push of
// main leaves the commit and the tag local; re-running the release retries them.)
bumpCommit = null;

// 6. Push commit + tag — triggers publish.yml, which publishes with provenance.
//
// The tag push is forced to match the `-f` above. Without it, retrying a failed
// release is stuck: the local tag moves to the fix commit, the remote tag still
// points at the broken one, and a plain push is rejected as non-fast-forward —
// so re-running the workflow just rebuilds the commit that already failed.
//
// ⚠️ Safe only while the version is unpublished. JSR versions are IMMUTABLE, so
// once a version exists on the registry, moving its tag changes what the GitHub
// release points at while the published code stays put — the two then disagree
// permanently. If `deno publish` has already succeeded for this version, bump
// instead of retrying.
run(["git", "push"]);
run(["git", "push", "--force", "origin", tag]);

console.log(`\nTag ${tag} pushed. GitHub Actions will publish to JSR with provenance.`);
console.log(`Watch progress at: https://github.com/synapticforge1/S3D-ReportCompiler/actions`);

// 7. Wait for the release to land, and confirm it is ATTESTED.
//
// Pushing the tag is not the finish line — it is the point where the outcome
// stops being visible. 1.0.2 went out unattested and that was only noticed days
// later, because a successful publish and an attested publish look identical
// everywhere except one field on the JSR API (see cmem/known-issues.md #26).
//
// Skip with --no-wait when you do not want to hold the terminal; the check is
// then `bun run verify-release` whenever you like.
if (process.argv.slice(2).includes("--no-wait")) {
  console.log(`\n--no-wait: not waiting. Confirm with:  bun run verify-release`);
} else {
  console.log(`\nWaiting for the workflow to publish, then checking provenance…`);
  console.log(
    `(Ctrl-C is safe — the release continues; check later with bun run verify-release)\n`,
  );

  // `stdio: "inherit"`: the progress and the verdict are the point of this step. Until
  // 2026-10-26 the output was captured and never printed (Deno's `.output()`), so a release
  // showed nothing here and an unattested one was visible only as an exit code.
  const check = spawnSync(
    self[0],
    [...self.slice(1), "scripts/verify-release.ts", version, "--wait"],
    { stdio: "inherit" },
  );
  const code = check.status ?? 1;
  // Propagate the verdict: an unattested release should not exit 0, or CI and
  // shell chains would treat it as a clean run.
  if (code !== 0) process.exit(code);
}
