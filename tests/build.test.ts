/**
 * The build and every control, as tests (bun-migration step 5; 🔒 owner 2026-10-26: "yes add the
 * test suite"). `node:test` + `node:assert` only, so the same file runs on both runners:
 *
 *   bun run test        # bun test
 *   bun run test:node   # node --test
 *
 * Each case runs the build with the runtime that runs the test (`process.execPath`) and asserts
 * the outcome AND its reason — a negative control caught by a different check is a bad control
 * (★ 2.1). Needs Chrome (it renders). The last test refuses a control file no test exercises.
 *
 * Expected values are the build's own output, measured 2026-10-28 on the 13 committed samples
 * (cmem/testing.md § Test suite); a change to them is a finding, re-recorded on purpose.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(ROOT, "main.ts");
const CONTROLS = join(ROOT, "tests", "controls");
const SAMPLES = join(ROOT, "tests", "HTMLFilesToBeCompiled");
const TIMEOUT = 300_000;

const work = mkdtempSync(join(tmpdir(), "s3d-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

const exercised = new Set<string>();

type Result = { code: number | null; out: string };

/** Run a TypeScript entry point on this runtime. */
function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Result {
  const r = spawnSync(process.execPath, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}` };
}

/** Generate a control's input folder; returns it. */
function control(name: string, dir = join(work, name)): string {
  exercised.add(name);
  const g = run([join(CONTROLS, `${name}.ts`), dir]);
  assert.equal(g.code, 0, `the ${name} generator failed:\n${g.out}`);
  return dir;
}

/** Build `input` into `<input>/out/c.pdf`. */
function build(input: string, extra: { env?: NodeJS.ProcessEnv } = {}) {
  const pdf = join(input, "out", "c.pdf");
  return { pdf, html: pdf.replace(/\.pdf$/, ".html"), ...run([MAIN, input, pdf], extra) };
}

function has(out: string, ...patterns: RegExp[]) {
  for (const p of patterns)
    assert.match(out, p, `expected ${p} in the build output:\n${tail(out)}`);
}
function hasNot(out: string, ...patterns: RegExp[]) {
  for (const p of patterns) assert.doesNotMatch(out, p, `did not expect ${p}:\n${tail(out)}`);
}
const tail = (s: string) => s.trim().split("\n").slice(-25).join("\n");

/**
 * The page count is LAYOUT, not content: it follows the platform's fonts (the 13 samples are 100
 * pages on Windows, 103 on GitHub's Ubuntu runner — measured 2026-10-28), so it is never pinned.
 * What holds everywhere: every report starts on its own page.
 */
function atLeastOnePagePerReport(out: string, reports: number) {
  const pages = Number(/^(\d+) pages,/m.exec(out)?.[1] ?? Number.NaN);
  assert.ok(pages >= reports, `${pages} page(s) for ${reports} report(s):\n${tail(out)}`);
}

// ── the committed samples ────────────────────────────────────────────────────

test("the 13 samples build, verify and PASS at their baseline", { timeout: TIMEOUT }, () => {
  const pdf = join(work, "samples", "c.pdf");
  const r = run([MAIN, SAMPLES, pdf]);
  assert.equal(r.code, 0, tail(r.out));
  has(
    r.out,
    /Compiling 13 report\(s\)/,
    /math:\s+2203 expressions, 0 failed/,
    /missing:\s+0 word\(s\), 0 number\(s\)/,
    /per-report: 13\/13 reports hold all their own words and numbers/,
    /graphics: 13 image paint\(s\), 13 expected; 13 diagram\(s\) checked, intact/,
    /latex:\s+0 surviving, 13\/13 reports, 0 blank page\(s\)/,
    /PASS: every source word and number present/,
  );
  atLeastOnePagePerReport(r.out, 13);
  assert.ok(existsSync(pdf), "no PDF");
});

// ── negative controls: each must FAIL, for its own reason ────────────────────

test("unknown delimiter: the guard refuses, no PDF", { timeout: TIMEOUT }, () => {
  const r = build(control("control-unknown-delimiter"));
  assert.equal(r.code, 1, tail(r.out));
  has(
    r.out,
    /math:\s+97 expressions, 0 failed/, // "0 failed" while LaTeX survives: the point of the guard
    /ERROR: unrendered mathematics reached the baked document/,
    /250 TeX command\(s\)/,
  );
  hasNot(r.out, /Verifying against the source reports/);
  assert.ok(!existsSync(r.pdf), "a PDF was written");
});

test("colliding {{..}} delimiters: the guard refuses, no PDF", { timeout: TIMEOUT }, () => {
  const r = build(control("control-custom-delimiters-colliding"));
  assert.equal(r.code, 1, tail(r.out));
  has(
    r.out,
    /delims:.*\{\{\.\.\}\}/,
    /ERROR: unrendered mathematics reached the baked document/,
    /205 TeX command\(s\)/,
  );
  assert.ok(!existsSync(r.pdf), "a PDF was written");
});

test("hidden content in one report: set-wide conservation fails", { timeout: TIMEOUT }, () => {
  const r = build(control("control-hidden-content"));
  assert.equal(r.code, 1, tail(r.out));
  has(
    r.out,
    /missing:\s+171 word\(s\), 114 number\(s\)/,
    /1 blank page\(s\)/,
    /VERIFICATION FAILED/,
    /- content missing from the PDF/,
    /does not faithfully reproduce its sources/,
  );
});

test(
  "a row hidden in the 2nd of two copies: only the per-report check fails it",
  {
    timeout: TIMEOUT,
  },
  () => {
    const r = build(control("control-hidden-row-two-reports"));
    assert.equal(r.code, 1, tail(r.out));
    has(
      r.out,
      // The set-wide check alone still passes this — the intact copy supplies the tokens.
      /missing:\s+0 word\(s\), 0 number\(s\)/,
      /per-report: 1 of 2 report\(s\) missing their own content/,
      /b_report\.html: 5 word\(s\), 0 number\(s\) -- internal, forces, absolute, force, bending/,
      /VERIFICATION FAILED/,
      /- content missing from its own report: b_report\.html/,
    );
    hasNot(r.out, /- content missing from the PDF/);
  },
);

// ── positive controls: each must PASS at its baseline ────────────────────────

test(
  "custom delimiters declared in the config render like the baseline",
  {
    timeout: TIMEOUT,
  },
  () => {
    const r = build(control("control-custom-delimiters"));
    assert.equal(r.code, 0, tail(r.out));
    has(
      r.out,
      /delims:.*@@\.\.@@.*%%\.\.%%/,
      /math:\s+169 expressions, 0 failed/,
      /per-report: 1\/1 reports/,
      /PASS: every source word and number present/,
    );
    atLeastOnePagePerReport(r.out, 1);
  },
);

test("a second report on $$..$$ renders, with no stray $ left", { timeout: TIMEOUT }, () => {
  const r = build(control("control-dollar-delimiters"));
  assert.equal(r.code, 0, tail(r.out));
  has(
    r.out,
    /math:\s+338 expressions, 0 failed/,
    /reports declare 2 different delimiter sets/,
    /per-report: 2\/2 reports/,
    /PASS: every source word and number present/,
  );
  const baked = readFileSync(r.html, "utf8");
  assert.equal((baked.match(/\$\$/g) ?? []).length, 0, "a $$ delimiter survived into the bake");
});

// ── the CLI's own failure paths ──────────────────────────────────────────────

test("an unknown flag is rejected", { timeout: TIMEOUT }, () => {
  const r = run([MAIN, "--no-optimise"]);
  assert.equal(r.code, 1, tail(r.out));
  has(r.out, /Unknown option\(s\): --no-optimise/, /Supported: .*--no-optimize/);
  hasNot(r.out, /Compiling/);
});

test("a render that writes nothing does not pass off a stale PDF", { timeout: TIMEOUT }, () => {
  const input = control("control-custom-delimiters", join(work, "stale"));
  const stale = join(input, "out", "c.pdf");
  mkdirSync(join(input, "out"), { recursive: true });
  writeFileSync(stale, "%PDF-1.7 stale");
  // This runtime as "Chrome": it rejects Chrome's flags and writes no PDF.
  const r = build(input, { env: { ...process.env, CHROME_PATH: process.execPath } });
  assert.notEqual(r.code, 0, tail(r.out));
  has(r.out, /Chrome produced no PDF/);
  hasNot(r.out, /^Created /m, /PASS/);
  assert.ok(!existsSync(stale), "the stale PDF is still there");
});

test(
  "relative input and output paths still produce the PDF and HTML (bug #22)",
  {
    timeout: TIMEOUT,
  },
  () => {
    const dir = join(work, "relative");
    control("control-custom-delimiters", join(dir, "reports"));
    const r = run([MAIN, "reports", "out/custom-name.pdf"], { cwd: dir });
    assert.equal(r.code, 0, tail(r.out));
    assert.ok(existsSync(join(dir, "out", "custom-name.pdf")), "no out/custom-name.pdf");
    assert.ok(existsSync(join(dir, "out", "custom-name.html")), "no out/custom-name.html");
  },
);

// ── the sample sanitizer's residue check ─────────────────────────────────────

function sanitizerInput(name: string, leak: boolean): string {
  const dir = join(work, name);
  const src = join(dir, "local", "HTMLFilesToBeCompiled");
  mkdirSync(src, { recursive: true });
  // The sample is already sanitized: its fields hold the very placeholders the sanitizer writes,
  // which would read as leaks. Plant invented values in all three instead.
  let html = readFileSync(join(SAMPLES, "member_0_report.html"), "utf8");
  for (const [placeholder, value] of [
    ["Example Structure", "Zorblax Quarry"],
    ["Example Engineer", "Quentin Vardle"],
    ["Sample report — synthetic project metadata", "Kestrel Brumby"],
  ]) {
    const next = html.replace(`]${placeholder}<br`, `]${value}<br`);
    assert.notEqual(next, html, `could not plant ${value} in the sample`);
    html = next;
  }
  html = leak ? html.replace(/(MEMBER\s*#?\s*\d+\s*DESIGN\s*REPORT)/i, "$1 Zorblax") : html;
  if (leak) assert.match(html, /REPORT Zorblax/i, "could not plant the leak");
  writeFileSync(join(src, "x_report.html"), html);
  return dir;
}

test(
  "the sanitizer passes a report whose project name is only in its field",
  {
    timeout: TIMEOUT,
  },
  () => {
    const r = run([join(ROOT, "scripts", "sanitize-report.ts"), "--check", "x_report.html"], {
      cwd: sanitizerInput("sanitize-clean", false),
    });
    assert.equal(r.code, 0, r.out);
    has(
      r.out,
      /✓ x_report\.html: would remove "Zorblax Quarry", "Quentin Vardle", "Kestrel Brumby"; 6 token\(s\) verified absent/,
    );
  },
);

test(
  "the sanitizer fails a project name that also appears outside its field",
  {
    timeout: TIMEOUT,
  },
  () => {
    const r = run([join(ROOT, "scripts", "sanitize-report.ts"), "--check", "x_report.html"], {
      cwd: sanitizerInput("sanitize-leak", true),
    });
    assert.equal(r.code, 1, r.out);
    has(r.out, /❌ x_report\.html: 1 removed term\(s\) still present: Zorblax/);
  },
);

// ── "a run of nothing is not a pass" ─────────────────────────────────────────

test("every control in tests/controls/ is exercised by a test above", () => {
  const all = readdirSync(CONTROLS)
    .filter((f) => /^control-.*\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ""));
  assert.ok(all.length >= 6, `only ${all.length} control file(s) found`);
  assert.deepEqual(
    all.filter((c) => !exercised.has(c)),
    [],
    "control file(s) no test runs — add a test or retire the file",
  );
});
