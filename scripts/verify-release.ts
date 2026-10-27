/**
 * Confirms a published version actually went out the attested path.
 *
 *   bun run verify-release            # the version in deno.json
 *   bun run verify-release 1.0.2      # a specific version
 *   bun run verify-release --wait     # poll while JSR ingests (after a release)
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
 * ⚠️ This cannot PREVENT a direct `deno publish` — Deno has no pre-publish hook,
 * and a subcommand cannot be shadowed by a task. It closes the loop instead: run
 * automatically at the end of `bun run release`, it turns a silent loss into an
 * immediate, loud one.
 *
 * Exit codes: 0 attested · 1 published but NOT attested · 2 not published yet.
 */

import { readFileSync } from "node:fs";

const denoJson = JSON.parse(readFileSync(new URL("../deno.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith("-"));
const wait = argv.includes("--wait");
const version = args[0] ?? denoJson.version;

const [scope, name] = denoJson.name.replace(/^@/, "").split("/");
const url = `https://api.jsr.io/scopes/${scope}/packages/${name}/versions/${version}`;

type VersionInfo = { rekorLogId?: string | null; yanked?: boolean };

/**
 * The JSR record for this version, or `null` if it is not published yet.
 *
 * (Under Deno a missing `--allow-net` permission exited here rather than
 * returning `null`. Bun and Node have no permission system, so that case no
 * longer exists; a network failure still reads as "not published yet".)
 */
async function fetchVersion(): Promise<VersionInfo | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as VersionInfo;
  } catch {
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
  process.exit(2);
}

if (info.rekorLogId) {
  console.log(`\n✅ ${version} is published AND attested.`);
  console.log(`   Rekor log ID: ${info.rekorLogId}`);
  process.exit(0);
}

console.error(`\n❌ ${version} is published but has NO provenance attestation.`);
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
