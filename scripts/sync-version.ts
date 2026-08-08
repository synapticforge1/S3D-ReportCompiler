/**
 * Reads `version` and `name` from deno.json and writes them into:
 *   - package.json          (name + version fields)
 *   - src/report_core.ts    (VERSION constant)
 *
 * deno.json is the single source of truth for both; everything else is a copy.
 *
 * Run via:  deno task update-version
 * Must be invoked from the project root (deno task does this automatically).
 */

const root = Deno.cwd();

const denoJson = JSON.parse(await Deno.readTextFile(`${root}/deno.json`));
const { version, name } = denoJson as { version: string; name: string };

// ── package.json ─────────────────────────────────────────────────────────────
const pkgPath = `${root}/package.json`;
const pkg = JSON.parse(await Deno.readTextFile(pkgPath));
pkg.name = name;
pkg.version = version;
await Deno.writeTextFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`✅ package.json       → ${version}`);

// ── src/report_core.ts ───────────────────────────────────────────────────────
const corePath = `${root}/src/report_core.ts`;
const core = await Deno.readTextFile(corePath);
const updated = core.replace(
  /(export const VERSION\s*=\s*)"[^"]*"/,
  `$1"${version}"`,
);
if (updated === core) {
  // Either already current, or the pattern is gone — those need different fixes,
  // so do not report them the same way.
  if (core.includes(`VERSION = "${version}"`)) {
    console.log(`✅ src/report_core.ts → ${version} (already up to date)`);
  } else {
    console.warn("⚠️  src/report_core.ts VERSION constant not found — skipped");
  }
} else {
  await Deno.writeTextFile(corePath, updated);
  console.log(`✅ src/report_core.ts → ${version}`);
}
