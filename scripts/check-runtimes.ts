/**
 * Builds the committed sample reports from THIS clone on every supported runtime and requires
 * every build to PASS its own verification with a byte-identical baked document.
 *
 *   - Node: the floor named in package.json `engines.node`, every line Node's own release schedule
 *     lists as LTS today, and a line that becomes LTS within 30 days. Each runs through
 *     `fnm exec --using=<version>`, so nothing switches globally and no path is machine-specific.
 *   - Bun: whichever `bun` is on PATH. Deno: whichever `deno` is on PATH (expected: the LTS line).
 *
 * A Node version fnm has not installed FAILS with the `fnm install` that fixes it; it is never
 * skipped. `--also=<version>` adds a Node version (used to show a version below the floor fails).
 *
 * Run via:  bun run runtimes
 * Uses only node: builtins and web APIs, so it also runs on Node and Deno.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEDULE = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
const UPCOMING_DAYS = 30;

const root = fileURLToPath(new URL("..", import.meta.url));
const samples = join(root, "tests", "HTMLFilesToBeCompiled");
const main = join(root, "main.ts");

const also = process.argv.filter((a) => a.startsWith("--also=")).map((a) => a.slice(7));

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const floor = String(pkg.engines?.node ?? "").replace(/^>=\s*/, "");
if (!/^\d+\.\d+\.\d+$/.test(floor)) {
  console.error(
    `❌ package.json engines.node must be ">=X.Y.Z"; found ${JSON.stringify(pkg.engines?.node)}`,
  );
  process.exit(1);
}

const res = await fetch(SCHEDULE);
if (!res.ok) {
  console.error(
    `❌ cannot read Node's release schedule (HTTP ${res.status}) — refusing to guess the LTS lines`,
  );
  process.exit(1);
}
const schedule = (await res.json()) as Record<string, { lts?: string; end: string }>;
const now = Date.now();
const lines: string[] = [];
for (const [line, v] of Object.entries(schedule)) {
  if (!v.lts || Date.parse(v.end) < now) continue;
  const lts = Date.parse(v.lts);
  if (lts <= now) lines.push(line.slice(1));
  else if (lts - now <= UPCOMING_DAYS * 86_400_000) lines.push(`${line.slice(1)} (LTS ${v.lts})`);
}
if (lines.length === 0) {
  console.error("❌ the schedule lists no current LTS line — the parse is wrong, not the world");
  process.exit(1);
}

type Run = { name: string; cmd: string[] };
const runs: Run[] = [
  { name: `node ${floor} (floor)`, cmd: ["fnm", "exec", `--using=${floor}`, "--", "node", main] },
  ...lines.map((l) => ({
    name: `node ${l}`,
    cmd: ["fnm", "exec", `--using=${l.split(" ")[0]}`, "--", "node", main],
  })),
  ...also.map((v) => ({
    name: `node ${v} (--also)`,
    cmd: ["fnm", "exec", `--using=${v}`, "--", "node", main],
  })),
  { name: "bun", cmd: ["bun", main] },
  { name: "deno", cmd: ["deno", "run", "-A", main] },
];

const work = mkdtempSync(join(tmpdir(), "s3d-runtimes-"));
const hashes = new Map<string, string>();
let failed = 0;
try {
  for (const [i, run] of runs.entries()) {
    const out = join(work, String(i), "combined_report.pdf");
    const r = spawnSync(run.cmd[0], [...run.cmd.slice(1), samples, out], {
      env: process.env,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // The CLI names the runtime it detected; a mismatch would mean the wrong binary ran.
    const detected = (text.match(/Compiling \d+ report\(s\) on (\S+)/) ?? [])[1] ?? "?";
    const html = join(work, String(i), "combined_report.html");
    const expected = run.name.split(" ")[0];
    const pass =
      r.status === 0 &&
      /PASS: every source word and number present/.test(text) &&
      existsSync(html) &&
      detected === expected;
    if (!pass) {
      failed++;
      const hint = /Can't find version|Requested version .* is not currently installed/i.test(text)
        ? ` — run: fnm install ${run.cmd[2]?.slice(8)}`
        : r.error
          ? ` — ${r.error.message}`
          : detected !== expected && r.status === 0
            ? ` — the CLI reported running on ${detected}, not ${expected}`
            : ` — ${
                (text.match(/\b(ERR_[A-Z_]+|[A-Za-z]*Error): [^\n]*/) ??
                  text.trim().split("\n").slice(-1))[0]
              }`;
      console.log(`❌ ${run.name.padEnd(28)} exit=${r.status}${hint}`);
      continue;
    }
    const hash = createHash("sha256").update(readFileSync(html)).digest("hex").slice(0, 12);
    hashes.set(run.name, hash);
    console.log(`✅ ${run.name.padEnd(28)} PASS  html ${hash}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const distinct = new Set(hashes.values());
if (distinct.size > 1) {
  failed++;
  console.log(`❌ the baked document differs between runtimes: ${[...distinct].join(", ")}`);
}
if (hashes.size < 4) failed++;
console.log(
  failed
    ? `\n❌ ${failed} problem(s) across ${runs.length} runtime(s)`
    : `\n✅ ${runs.length} runtime(s), one baked document (${[...distinct][0]})`,
);
process.exit(failed ? 1 : 0);
