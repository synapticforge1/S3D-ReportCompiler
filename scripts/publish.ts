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
 *   3. git add the changed files
 *   4. git commit "bump version to vX.Y.Z"
 *   5. git tag vX.Y.Z
 *   6. git push && git push --tags  ← triggers the publish.yml workflow
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

// 4. Tag (force-update so a re-run after a failed release still works)
await run(["git", "tag", "-f", tag]);

// 5. Push commit + tag — triggers publish.yml, which publishes with provenance.
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
