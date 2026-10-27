/**
 * Proves `bun run lint` can fail: plants one file inside the lint scope that breaks a rule from
 * each source the gate relies on, and requires every one of them to be reported.
 *
 *   - three from Biome's recommended preset — a config that silently lints nothing (`biome
 *     migrate` once rewrote `"recommended": true` as `"preset": "none"`) fails here;
 *   - `useAwait` and `noVar`, which are NOT in the preset and are enabled by biome.json;
 *   - `noNonNullAssertion`, a WARNING — it must still fail the run (`--error-on-warnings`).
 *
 * The Biome command is read from package.json's `lint` script, so the pinned version lives once.
 * Biome does not need a .gitignore exemption: biome.json leaves VCS integration off.
 *
 * Run via:  bun run lint   (after the real lint)
 * Uses only node: builtins, so it also runs on Node and Deno.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const m = String(pkg.scripts?.lint ?? "").match(/^(bunx \S+ lint --error-on-warnings) &&/);
if (!m)
  fail(
    `package.json "lint" must start "bunx @biomejs/biome@<version> lint --error-on-warnings &&"`,
  );
const [exe, ...args] = m[1].split(" ");

const planted = join(root, "scripts", "__lint_canary.ts");
const expected = [
  "lint/suspicious/noDoubleEquals",
  "lint/suspicious/noDebugger",
  "lint/suspicious/noAssignInExpressions",
  "lint/suspicious/useAwait",
  "lint/suspicious/noVar",
  "lint/style/noNonNullAssertion",
];
const body = `// Planted by check-lint-canary.ts; deleted when it finishes.
export function a(x: number, y: string): boolean {
  return x == Number(y);
}
export function b(): void {
  debugger;
}
export function c(s: string): number {
  let n = 0;
  let hit: RegExpExecArray | null;
  const re = /a/g;
  while ((hit = re.exec(s)) !== null) n += hit.index;
  return n;
}
export async function d(): Promise<number> {
  return 1;
}
export function e(): number {
  var v = 1;
  return v;
}
export function f(o: { p?: string }): string {
  return o.p!;
}
`;

let problems = 0;
try {
  writeFileSync(planted, body);
  const r = spawnSync(exe, [...args, "--max-diagnostics=50"], { cwd: root, encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  if (r.status === 0) {
    problems++;
    console.log("❌ with a planted file, the lint exited 0");
  }
  for (const rule of expected) {
    const fired = new RegExp(`__lint_canary\\.ts:\\d+:\\d+ ${rule.replace(/\//g, "\\/")}\\b`).test(
      out,
    );
    if (!fired) problems++;
    console.log(`${fired ? "✅" : "❌"} ${rule}`);
  }
} finally {
  rmSync(planted, { force: true });
}

console.log(
  problems
    ? `❌ lint canary: ${problems} problem(s)`
    : `✅ lint canary: ${expected.length} rules fire`,
);
process.exit(problems ? 1 : 0);

function fail(msg: string): never {
  console.log(`❌ lint canary: ${msg}`);
  process.exit(1);
}
