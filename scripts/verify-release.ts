/**
 * Confirms a published version actually went out the attested path.
 *
 *   bun run verify-release            # the version in jsr.json
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
 * This script does not PREVENT a direct `deno publish` — Deno has no pre-publish
 * hook. JSR does: it requires publishing from GitHub Actions for a package with a
 * linked repository (owner, 2026-10-28). This closes the loop on the release path:
 * run automatically at the end of `bun run release`, it confirms the Actions
 * publish was actually attested.
 *
 * Exit codes: 0 attested · 1 published but NOT attested (yanked or not) · 2 not published
 * yet, or JSR could not be asked · 3 attested but YANKED.
 */

import { readFileSync } from "node:fs";

const jsrJson = JSON.parse(readFileSync(new URL("../jsr.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith("-"));
const wait = argv.includes("--wait");
const version = args[0] ?? jsrJson.version;

const [scope, name] = jsrJson.name.replace(/^@/, "").split("/");
// Test hooks, so tests/build.test.ts can stand a fake JSR on 127.0.0.1 and drive every verdict
// (yanked, unattested, 404, 5xx, a stalled request). Unset in real use.
const JSR_API = process.env.S3D_JSR_API ?? "https://api.jsr.io";
const JSR_TIMEOUT_MS = Number(process.env.S3D_JSR_TIMEOUT_MS ?? 20_000);
const JSR_RETRY_MS = Number(process.env.S3D_JSR_RETRY_MS ?? 15_000);
const url = `${JSR_API}/scopes/${scope}/packages/${name}/versions/${version}`;

type VersionInfo = { rekorLogId?: string | null; yanked?: boolean };

/** One look at JSR: the version's record, a definite "not there" (404), or why it failed. */
type Look = { info: VersionInfo } | { missing: true } | { error: string };

/**
 * Look the version up once. Bounded: with no timeout, one stalled request (a proxy, a
 * half-open connection) held the whole poll -- and `bun run release` -- forever. Only a 404
 * means "not published"; a 5xx, a 429 or a network failure is "could not tell", which the
 * poll retries and the verdict reports as such rather than as "not on JSR".
 */
async function fetchVersion(): Promise<Look> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(JSR_TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return { missing: true };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    return { info: (await res.json()) as VersionInfo };
  } catch (e) {
    return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

console.log(`Checking ${jsrJson.name}@${version} …`);

// JSR ingests asynchronously, so a check straight after a release needs to wait.
// Without --wait this is a single look, which is what you want when auditing an
// older version. 60 × 15 s = 15 min: since 2026-10-28 publish.yml first waits for CI to pass on
// the tagged commit (~5–6 min), and 1.1.5 outlasted the old 5-minute window (exit 2, then attested).
const attempts = wait ? 60 : 1;
let look: Look = { error: "not asked" };

for (let i = 1; i <= attempts; i++) {
  look = await fetchVersion();
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

const info = look.info;

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
  process.exit(0);
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
