/**
 * Confirms a published version actually went out the attested path.
 *
 *   bun run verify-release            # the version in jsr.json
 *   bun run verify-release 1.0.2      # a specific version
 *   bun run verify-release --wait     # poll while JSR ingests (after a release)
 *   bun run verify-release --npm      # npm too: published there WITH provenance (the release
 *                                     # passes this; older versions predate npm, so not default)
 *   bun run verify-release --github   # and the GitHub release for the tag exists (the release
 *                                     # passes this too)
 *
 * WHY THIS EXISTS
 * ---------------
 * 1.0.2 was published by running `deno publish` from a workstation instead of
 * `bun run release`. The package was fine and JSR scored it 100 — but it has
 * no provenance, no git tag and no GitHub release, and JSR versions are
 * immutable, so it could not be corrected.
 *
 * ⚠️ **Score 100 does not mean the release was done correctly.** Provenance is
 * not a scored criterion, so an unattested release looks identical on jsr.io to
 * an attested one. The only reliable signal is `rekorLogId` on the version, and
 * nothing was asking for it.
 *
 * This script does not PREVENT a direct `deno publish` — Deno has no pre-publish
 * hook. JSR does: it requires publishing from GitHub Actions for a package with a
 * linked repository (owner, 2026-10-28). This closes the loop on the release path:
 * run automatically at the end of `bun run release`, it confirms the Actions
 * publish was actually attested.
 *
 * Exit codes: 0 attested (and, with --npm, on npm with provenance) · 1 published but NOT
 * attested (yanked or not) · 2 not published yet, or JSR could not be asked · 3 attested but
 * YANKED · 4 (--npm) attested on JSR, but npm lacks the version, its provenance, or an answer ·
 * 5 (--github) both registries fine, but no GitHub release for the tag, or no answer · 64 a
 * usage error.
 */

import { readFileSync } from "node:fs";
import {
  GITHUB_REPO,
  JSR_RETRY_MS,
  JSR_TIMEOUT_MS,
  type Look,
  lookupGithubCommit,
  lookupGithubRelease,
  lookupNpmVersion,
  lookupVersion,
  NPM_NAME,
  type NpmLook,
  type VersionInfo,
} from "./jsr-api.ts";

const jsrJson = JSON.parse(readFileSync(new URL("../jsr.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith("-"));
// Unknown flags are refused, not ignored: a mistyped `--wiat` straight after a release used to
// become a single look, and report "not on JSR" for a release that was simply still running.
const FLAGS = ["--wait", "--npm", "--github"];
const unknownFlags = argv.filter((a) => a.startsWith("-") && !FLAGS.includes(a));
if (unknownFlags.length > 0 || args.length > 1 || (args[0] && !/^\d+\.\d+\.\d+$/.test(args[0]))) {
  console.error(`usage: verify-release.ts [X.Y.Z] [--wait] [--npm] [--github]`);
  if (unknownFlags.length > 0) console.error(`  unknown option(s): ${unknownFlags.join(", ")}`);
  if (args.length > 1) console.error(`  one version at most; got ${args.join(", ")}`);
  else if (args[0]) console.error(`  not a version: ${args[0]}`);
  process.exit(64);
}
const wait = argv.includes("--wait");
const checkNpm = argv.includes("--npm");
/** The commit npm recorded for the version, read by {@link npmVerdict} ("" for none). */
let npmGitHead = "";
const checkGithub = argv.includes("--github");
const version = args[0] ?? jsrJson.version;

console.log(`Checking ${jsrJson.name}@${version} …`);

// JSR ingests asynchronously, so a check straight after a release needs to wait.
// Without --wait this is a single look, which is what you want when auditing an
// older version. 60 attempts, 15 s apart: since 2026-10-28 publish.yml first waits for CI to pass
// on the tagged commit (~5–6 min), and 1.1.5 outlasted the old 5-minute window. The window is 15
// min while JSR answers promptly, and up to 60 × (15 s + the 20 s request timeout) = 35 min when
// every request stalls -- bounded either way, never a hang.
const attempts = wait ? 60 : 1;
if (wait) {
  const worst = Math.ceil((attempts * (JSR_RETRY_MS + JSR_TIMEOUT_MS)) / 60_000);
  console.log(
    `  (waiting up to ${Math.ceil((attempts * JSR_RETRY_MS) / 60_000)} min; ${worst} if JSR stalls)`,
  );
}
let look: Look = { error: "not asked" };

for (let i = 1; i <= attempts; i++) {
  look = await lookupVersion(jsrJson.name, version);
  if ("info" in look) break;
  if (i < attempts) {
    console.log(
      "missing" in look
        ? `  not on JSR yet (${i}/${attempts}) — the workflow may still be running`
        : `  could not ask JSR (${i}/${attempts}): ${look.error} — retrying`,
    );
    await new Promise((r) => setTimeout(r, JSR_RETRY_MS));
  }
}

if (!("info" in look)) {
  if ("error" in look) {
    console.error(`\n⚠️  Could not ask JSR whether ${version} is published: ${look.error}.`);
    console.error(`   This is not a verdict. Re-run later: bun run verify-release ${version}`);
  } else {
    console.error(`\n⚠️  ${version} is not on JSR${wait ? " yet" : ""}.`);
  }
  console.error(`   If a release is in flight, watch it at:`);
  console.error(`   https://github.com/synapticforge1/S3D-ReportCompiler/actions`);
  process.exit(2);
}

// `deno publish` makes the version visible FIRST and attaches its provenance a moment later (it
// signs and uploads the bundle once the publish task has succeeded). A look in between sees a
// record with no rekorLogId -- and the verdict below says "cannot be fixed, bump and release
// again". So, while waiting, a record without one gets a grace period before it is believed.
const GRACE = wait ? 8 : 0; // 8 more looks: 2 min at the default 15 s
for (let g = 1; g <= GRACE && "info" in look && !look.info.rekorLogId; g++) {
  console.log(
    `  published, no provenance record yet (${g}/${GRACE}) — deno publish attaches it after the upload`,
  );
  await new Promise((r) => setTimeout(r, JSR_RETRY_MS));
  const again = await lookupVersion(jsrJson.name, version);
  if ("info" in again) look = again; // a failed look keeps the last record
}
const info = (look as { info: VersionInfo }).info;

// Provenance first: an unattested version stays exit 1 whether or not it was later yanked --
// "no provenance" is the finding this script exists for, and a yank must not hide it.
if (info.yanked && info.rekorLogId) {
  console.error(`\n⚠️  ${version} is YANKED on JSR (it was attested, Rekor ${info.rekorLogId}).`);
  console.error(`   It no longer resolves for new installs; it is not a live release.`);
  process.exit(3);
}

if (info.rekorLogId) {
  console.log(`\n✅ ${version} is published AND attested.`);
  console.log(`   Rekor log ID: ${info.rekorLogId}`);
  const npm = checkNpm ? await npmVerdict() : 0;
  process.exit(npm !== 0 ? npm : checkGithub ? await githubVerdict() : 0);
}

console.error(
  `\n❌ ${version} is published but has NO provenance attestation${info.yanked ? " (and is now YANKED)" : ""}.`,
);
console.error(`   No Sigstore/Rekor entry — JSR cannot show where this build came from.\n`);
console.error(`   This is what a workstation \`deno publish\` produces. Releases must go`);
console.error(`   through \`bun run release\`, which tags and lets GitHub Actions publish`);
console.error(`   with an OIDC token; that token is the only source of provenance.\n`);
console.error(`   JSR versions are IMMUTABLE, so ${version} cannot be fixed. Bump and`);
console.error(`   release again:\n`);
console.error(`     bun run bump`);
console.error(`     bun run release\n`);
console.error(`   ⚠️  jsr.io may still show score 100 — provenance is not scored.`);
process.exit(1);

/**
 * `--github`: publish.yml's last job makes the GitHub release, after both registries. Returns 0
 * when it exists, else 5 -- waited for under `--wait`, like the registries.
 */
async function githubVerdict(): Promise<number> {
  const tag = `v${version}`;
  console.log(`\nChecking the GitHub release ${tag} …`);
  let g: { found: boolean } | { error: string } = { error: "not asked" };
  for (let i = 1; i <= attempts; i++) {
    g = await lookupGithubRelease(tag);
    if ("found" in g && g.found) break;
    if (i < attempts) {
      console.log(
        "found" in g
          ? `  no GitHub release yet (${i}/${attempts}) — it is made after npm`
          : `  could not ask GitHub (${i}/${attempts}): ${g.error} — retrying`,
      );
      await new Promise((r) => setTimeout(r, JSR_RETRY_MS));
    }
  }
  if ("found" in g && g.found) {
    // ...and its tag names the commit JSR got (release/<tag>, which publish.yml's record job
    // writes): "a release exists" passed whatever commit the tag had moved to (review 4).
    const [atTag, atBranch] = await Promise.all([
      lookupGithubCommit(tag),
      lookupGithubCommit(`release/${tag}`),
    ]);
    if ("error" in atTag || "error" in atBranch) {
      const why = "error" in atTag ? atTag.error : "error" in atBranch ? atBranch.error : "";
      console.error(`\n⚠️  Could not read the commits of ${tag} and release/${tag}: ${why}.`);
      console.error(`   This is not a verdict. Re-run: bun run verify-release ${version} --github`);
      return 5;
    }
    if (atBranch.sha === "" || atTag.sha !== atBranch.sha) {
      console.error(
        atBranch.sha === ""
          ? `\n❌ The GitHub release ${tag} exists, but there is no release/${tag} branch to say which commit JSR got.`
          : `\n❌ ${tag} names ${atTag.sha || "nothing"}, but JSR got ${atBranch.sha} (release/${tag}): the release is of another commit.`,
      );
      return 5;
    }
    // With --npm: npm's copy is of the same commit -- the one npm recorded as `gitHead`. `--npm`
    // checked provenance alone, and the npm job accepts "already on npm" with no commit recorded
    // (review 5). None recorded is no verdict of sameness, so it fails too.
    if (checkNpm && npmGitHead !== atBranch.sha) {
      console.error(
        npmGitHead === ""
          ? `\n❌ npm records no commit for ${version}, so its copy cannot be shown to be JSR's (${atBranch.sha.slice(0, 12)}).`
          : `\n❌ npm's ${version} is from ${npmGitHead}, but JSR got ${atBranch.sha} (release/${tag}): the registries differ.`,
      );
      return 5;
    }
    console.log(
      `✅ the GitHub release ${tag} exists, at the commit JSR got (${atTag.sha.slice(0, 12)})` +
        `${checkNpm ? ", and npm's copy is of it" : ""}.`,
    );
    return 0;
  }
  if ("found" in g) {
    console.error(`\n❌ ${version} is on both registries, but there is NO GitHub release ${tag}.`);
    console.error(`   publish.yml's finalize job makes it; check that run, or run it again with`);
    console.error(
      `   "Run workflow" and the tag ${tag}: https://github.com/${GITHUB_REPO}/actions`,
    );
  } else {
    console.error(`\n⚠️  Could not ask GitHub whether the release ${tag} exists: ${g.error}.`);
    console.error(`   This is not a verdict. Re-run: bun run verify-release ${version} --github`);
  }
  return 5;
}

/**
 * `--npm`: the same tag publishes to npm after JSR (publish.yml's `npm` job). Without this the
 * release reported ✅ on JSR alone, and an npm job that failed -- as 1.1.1's did -- went unseen.
 * Returns 0 when npm holds the version with provenance, else 4.
 */
async function npmVerdict(): Promise<number> {
  console.log(`\nChecking ${NPM_NAME}@${version} on npm …`);
  let n: NpmLook = { error: "not asked" };
  for (let i = 1; i <= attempts; i++) {
    n = await lookupNpmVersion(NPM_NAME, version);
    if ("info" in n) break;
    if (i < attempts) {
      console.log(
        "missing" in n
          ? `  not on npm yet (${i}/${attempts}) — the npm job runs after JSR's`
          : `  could not ask npm (${i}/${attempts}): ${n.error} — retrying`,
      );
      await new Promise((r) => setTimeout(r, JSR_RETRY_MS));
    }
  }
  if ("info" in n) npmGitHead = n.info.gitHead;
  if ("info" in n && n.info.provenance) {
    console.log(`✅ ${version} is on npm WITH provenance.`);
    return 0;
  }
  if ("info" in n) {
    console.error(`\n❌ ${version} is on npm with NO provenance — not published by publish.yml's`);
    console.error(`   trusted (OIDC) job. npm versions are immutable too: bump and release again.`);
  } else if ("missing" in n) {
    console.error(`\n❌ ${version} is attested on JSR but NOT on npm${wait ? " (waited)" : ""}.`);
    console.error(`   One tag releases both: check publish.yml's npm job, then re-run it with`);
    console.error(`   "Run workflow" and the tag v${version} (npm only).`);
  } else {
    console.error(`\n⚠️  Could not ask npm whether ${version} is published: ${n.error}.`);
    console.error(`   This is not a verdict. Re-run: bun run verify-release ${version} --npm`);
  }
  return 4;
}
