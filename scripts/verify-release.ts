/**
 * Confirms a published version actually went out the attested path.
 *
 *   deno task verify-release            # the version in deno.json
 *   deno task verify-release 1.0.2      # a specific version
 *   deno task verify-release --wait     # poll while JSR ingests (after a release)
 *
 * WHY THIS EXISTS
 * ---------------
 * 1.0.2 was published by running `deno publish` from a workstation instead of
 * `deno task release`. The package was fine and JSR scored it 100 — but it has
 * no provenance, no git tag and no GitHub release, and JSR versions are
 * immutable, so it could not be corrected.
 *
 * ⚠️ **Score 100 does not mean the release was done correctly.** Provenance is
 * not a scored criterion, so an unattested release looks identical on jsr.io to
 * an attested one. The only reliable signal is `rekorLogId` on the version, and
 * nothing was asking for it.
 *
 * ⚠️ This cannot PREVENT a direct `deno publish` — Deno has no pre-publish hook,
 * and a subcommand cannot be shadowed by a task. It closes the loop instead: run
 * automatically at the end of `deno task release`, it turns a silent loss into an
 * immediate, loud one.
 *
 * Exit codes: 0 attested · 1 published but NOT attested · 2 not published yet.
 */

import denoJson from "../deno.json" with { type: "json" };

const args = Deno.args.filter((a) => !a.startsWith("-"));
const wait = Deno.args.includes("--wait");
const version = args[0] ?? denoJson.version;

const [scope, name] = denoJson.name.replace(/^@/, "").split("/");
const url = `https://api.jsr.io/scopes/${scope}/packages/${name}/versions/${version}`;

type VersionInfo = { rekorLogId?: string | null; yanked?: boolean };

/**
 * The JSR record for this version, or `null` if it is not published yet.
 *
 * ⚠️ A missing `--allow-net` permission exits rather than returning `null`: that
 * is a broken check, not an absent version, and reporting the two the same way
 * is how a guard ends up unable to fail.
 */
async function fetchVersion(): Promise<VersionInfo | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.json() as VersionInfo;
  } catch (e) {
    if (e instanceof Deno.errors.NotCapable) {
      console.error(`❌ Needs --allow-net=api.jsr.io to check anything. Refusing to`);
      console.error(`   report success from a check that cannot run.`);
      Deno.exit(1);
    }
    return null;
  }
}

console.log(`Checking ${denoJson.name}@${version} …`);

// JSR ingests asynchronously, so a check straight after a release needs to wait.
// Without --wait this is a single look, which is what you want when auditing an
// older version.
const attempts = wait ? 20 : 1;
let info: VersionInfo | null = null;

for (let i = 1; i <= attempts; i++) {
  info = await fetchVersion();
  if (info) break;
  if (i < attempts) {
    console.log(`  not on JSR yet (${i}/${attempts}) — the workflow may still be running`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

if (!info) {
  console.error(`\n⚠️  ${version} is not on JSR${wait ? " yet" : ""}.`);
  console.error(`   If a release is in flight, watch it at:`);
  console.error(`   https://github.com/synapticforge1/S3D-ReportCompiler/actions`);
  Deno.exit(2);
}

if (info.rekorLogId) {
  console.log(`\n✅ ${version} is published AND attested.`);
  console.log(`   Rekor log ID: ${info.rekorLogId}`);
  Deno.exit(0);
}

console.error(`\n❌ ${version} is published but has NO provenance attestation.`);
console.error(`   No Sigstore/Rekor entry — JSR cannot show where this build came from.\n`);
console.error(`   This is what a workstation \`deno publish\` produces. Releases must go`);
console.error(`   through \`deno task release\`, which tags and lets GitHub Actions publish`);
console.error(`   with an OIDC token; that token is the only source of provenance.\n`);
console.error(`   JSR versions are IMMUTABLE, so ${version} cannot be fixed. Bump and`);
console.error(`   release again:\n`);
console.error(`     deno task bump`);
console.error(`     deno task release\n`);
console.error(`   ⚠️  jsr.io may still show score 100 — provenance is not scored.`);
Deno.exit(1);
