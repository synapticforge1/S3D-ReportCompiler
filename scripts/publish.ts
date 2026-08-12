/**
 * Publish script: syncs the version, commits, tags, and pushes so GitHub Actions
 * can run `deno publish` with OIDC provenance via .github/workflows/publish.yml.
 *
 * Publishing is deliberately NOT done from a workstation: JSR only records a
 * provenance attestation for a publish that comes from GitHub Actions through
 * the native OIDC integration. A local `deno publish` would succeed and produce
 * an unattested release.
 *
 * Usage: deno task publish
 *
 * Steps:
 *   1. Read the current version from deno.json
 *   2. Run scripts/sync-version.ts to propagate it to package.json + src/report_core.ts
 *   3. git add + commit "bump version to vX.Y.Z"
 *   4. Pre-flight — refuse to tag the wrong thing (see below)
 *   5. git tag -f vX.Y.Z
 *   6. git push && git push --force origin vX.Y.Z  ← triggers publish.yml
 *
 * The pre-flight refuses if the working tree has uncommitted tracked changes, if
 * HEAD is behind its upstream, or if the version is already on JSR — and prints
 * the commit it is about to tag. All three exist because 1.0.1 was released from
 * a commit one behind the fix it was meant to ship, and nothing said so.
 */

import denoJson from "../deno.json" with { type: "json" };

const version = denoJson.version;
const tag = `v${version}`;

async function run(cmd: string[]): Promise<void> {
  const p = new Deno.Command(cmd[0], { args: cmd.slice(1) });
  const { code, stderr } = await p.output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr));
    Deno.exit(code);
  }
}

/** stdout of a command, trimmed. Exit status is ignored — callers interpret "". */
async function capture(cmd: string[]): Promise<string> {
  const p = new Deno.Command(cmd[0], { args: cmd.slice(1), stderr: "null" });
  const { stdout } = await p.output();
  return new TextDecoder().decode(stdout).trim();
}

console.log(`Publishing ${tag} via GitHub Actions…`);

// 1. Sync the version out to package.json + src/report_core.ts
await run(["deno", "run", "--allow-read", "--allow-write", "scripts/sync-version.ts"]);

// 2. Stage the three files sync-version touches
await run(["git", "add", "deno.json", "package.json", "src/report_core.ts"]);

// 3. Commit (skip if nothing staged — the version was already synced)
const status = new Deno.Command("git", { args: ["diff", "--cached", "--quiet"] });
const { code: diffCode } = await status.output();
if (diffCode !== 0) {
  await run(["git", "commit", "-m", `bump version to ${tag}`]);
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
  const dirty = await capture(["git", "status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    console.error(`\n❌ Uncommitted changes — these would NOT be in ${tag}:\n`);
    console.error(dirty);
    console.error(`\nCommit or stash them, then re-run.`);
    Deno.exit(1);
  }

  // Behind the remote means someone else's commits — or your own from another
  // machine — are missing from what is about to be published.
  await run(["git", "fetch", "--quiet", "origin"]);
  const upstream = await capture(["git", "rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (upstream) {
    const behind = await capture(["git", "rev-list", "--count", `HEAD..${upstream}`]);
    if (behind !== "0" && behind !== "") {
      console.error(`\n❌ HEAD is ${behind} commit(s) behind ${upstream}.`);
      console.error(`   Pull first — those commits would not be in ${tag}.`);
      Deno.exit(1);
    }
  }

  // Already on the registry? Then this is not a release, it is an accident.
  // Forcing the tag would move the GitHub release off the code JSR actually
  // holds, and `deno publish` would fail anyway. Turning the warning below into
  // a check, because a comment does not stop anyone.
  const [scope, name] = denoJson.name.replace(/^@/, "").split("/");
  try {
    const res = await fetch(
      `https://api.jsr.io/scopes/${scope}/packages/${name}/versions/${version}`,
      { headers: { accept: "application/json" } },
    );
    if (res.ok) {
      await res.body?.cancel();
      console.error(`\n❌ ${denoJson.name}@${version} is ALREADY published on JSR.`);
      console.error(`   JSR versions are immutable — bump instead:\n`);
      console.error(`     deno task bump      # ${version} -> next patch`);
      console.error(`     deno task publish\n`);
      Deno.exit(1);
    }
    await res.body?.cancel();
  } catch {
    // Offline or JSR unreachable. Not a reason to block a release — the publish
    // step would fail on a duplicate anyway; this check only makes it fail early.
    console.warn(`  (could not reach JSR to check whether ${version} exists — continuing)`);
  }

  const sha = await capture(["git", "rev-parse", "--short", "HEAD"]);
  const subject = await capture(["git", "log", "-1", "--pretty=%s"]);
  console.log(`\n  tagging ${sha}  ${subject}`);
  console.log(`  as       ${tag}\n`);
}

// 5. Tag (force-update so a re-run after a failed release still works)
await run(["git", "tag", "-f", tag]);

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
await run(["git", "push"]);
await run(["git", "push", "--force", "origin", tag]);

console.log(`\nTag ${tag} pushed. GitHub Actions will publish to JSR with provenance.`);
console.log(`Watch progress at: https://github.com/jrmarcum/S3D-ReportCompiler/actions`);
