/**
 * Reads `version` and `name` from jsr.json and writes them into:
 *   - package.json          (name + version fields)
 *   - src/report_core.ts    (VERSION constant)
 *
 * jsr.json is the single source of truth for both; everything else is a copy (deno.json until
 * 2026-10-28, bun-migration step 7). The npm package's manifest is generated from it too.
 *
 * Run via:  bun run update-version
 * Must be invoked from the project root (bun run does this automatically).
 */

import { readFile, writeFile } from "node:fs/promises";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string) => readFile(p, "utf8");

const root = process.cwd();

const jsrJson = JSON.parse(await readText(`${root}/jsr.json`));
const { version, name } = jsrJson as { version: string; name: string };

// ── package.json ─────────────────────────────────────────────────────────────
const pkgPath = `${root}/package.json`;
const pkg = JSON.parse(await readText(pkgPath));
pkg.name = name;
pkg.version = version;
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`✅ package.json       → ${version}`);

// ── src/report_core.ts ───────────────────────────────────────────────────────
const corePath = `${root}/src/report_core.ts`;
const core = await readText(corePath);
const updated = core.replace(/(export const VERSION\s*=\s*)"[^"]*"/, `$1"${version}"`);
if (updated === core) {
  // Either already current, or the pattern is gone — those need different fixes,
  // so do not report them the same way.
  if (core.includes(`VERSION = "${version}"`)) {
    console.log(`✅ src/report_core.ts → ${version} (already up to date)`);
  } else {
    console.warn("⚠️  src/report_core.ts VERSION constant not found — skipped");
  }
} else {
  await writeFile(corePath, updated);
  console.log(`✅ src/report_core.ts → ${version}`);
}
