/**
 * Proves `bun run format:check` can fail, and that it can only touch what it should.
 *
 * The path list is read from package.json's `format` script, so there is one list. Then:
 *   - the list must not reach cmem/, the byte-checked sample reports, or the whole tree;
 *   - every listed path must exist (a typo would otherwise check nothing and pass);
 *   - planted files INSIDE the scope must be reported: a misformatted one, a CRLF one, and a line
 *     one character over the width; a line exactly at the width must NOT be reported.
 *
 * Run via:  bun run format:check   (after the real check)
 * Uses only node: builtins, so it also runs on Node and Deno.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const script = String(pkg.scripts?.format ?? "");
const m = script.match(/^bun fmt (.+)$/);
if (!m) fail(`package.json "format" must be "bun fmt <paths>"; found ${JSON.stringify(script)}`);
const paths = m[1].split(/\s+/);
const checkScript = String(pkg.scripts?.["format:check"] ?? "");
if (!checkScript.startsWith(`bun fmt --check ${paths.join(" ")} &&`)) {
  fail(
    `"format:check" must start "bun fmt --check ${paths.join(" ")} &&" — the two path lists differ`,
  );
}

const forbidden = paths.filter((p) => p === "." || /^(\.\/)?(cmem|tests)(\/|$)/.test(p));
if (forbidden.length) fail(`the format scope reaches ${forbidden.join(", ")}`);
const missing = paths.filter((p) => !existsSync(join(root, p)));
if (missing.length) fail(`listed path(s) do not exist: ${missing.join(", ")}`);

const WIDTH = 100;
const dir = "scripts";
const canaries: Record<string, { body: string; expect: boolean }> = {
  "__canary_misformat.ts": { body: "export const   x = {a:1,  b : 2}\n", expect: true },
  "__canary_crlf.ts": { body: 'export const y = "crlf";\r\n', expect: true },
  "__canary_wide.ts": { body: line(WIDTH + 1), expect: true },
  "__canary_fits.ts": { body: line(WIDTH), expect: false },
};

// `export const w = fn("…");` padded to exactly n characters, which bun fmt can only shorten
// by breaking the call across lines.
function line(n: number): string {
  const head = 'export const w = fn("';
  const tail = '");';
  return `declare function fn(s: string): string;\n${head}${"a".repeat(n - head.length - tail.length)}${tail}\n`;
}

let problems = 0;
try {
  for (const [name, c] of Object.entries(canaries)) writeFileSync(join(root, dir, name), c.body);
  const r = spawnSync("bun", ["fmt", "--check", ...paths], { cwd: root, encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  if (r.status !== 1) {
    problems++;
    console.log(`❌ with planted misformats, bun fmt --check exited ${r.status}, not 1`);
  }
  for (const [name, c] of Object.entries(canaries)) {
    const reported = out.includes(name);
    const ok = reported === c.expect;
    if (!ok) problems++;
    console.log(
      `${ok ? "✅" : "❌"} ${name.padEnd(24)} ${reported ? "reported" : "not reported"}${ok ? "" : ` (expected ${c.expect ? "reported" : "not reported"})`}`,
    );
  }
} finally {
  for (const name of Object.keys(canaries)) rmSync(join(root, dir, name), { force: true });
}

console.log(
  problems
    ? `❌ format canary: ${problems} problem(s)`
    : `✅ format canary: scope ${paths.join(" ")}`,
);
process.exit(problems ? 1 : 0);

function fail(msg: string): never {
  console.log(`❌ format canary: ${msg}`);
  process.exit(1);
}
