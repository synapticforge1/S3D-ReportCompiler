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
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** The build's temp Chrome profiles currently in the temp folder. */
const profiles = () =>
  new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("compiled_reports_")));

test("hidden content in one report: set-wide conservation fails", { timeout: TIMEOUT }, () => {
  const before = profiles();
  const r = build(control("control-hidden-content"));
  assert.equal(r.code, 1, tail(r.out));
  // A failed verification still cleans up (it used to exit before the finally).
  assert.deepEqual(
    [...profiles()].filter((n) => !before.has(n)),
    [],
    "a failed build left its temp Chrome profile behind",
  );
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

test("expressions written with &lt; / &gt; render like the baseline", { timeout: TIMEOUT }, () => {
  const r = build(control("control-math-entities"));
  assert.equal(r.code, 0, tail(r.out));
  has(
    r.out,
    /math:\s+169 expressions, 0 failed/, // the custom-delimiters control's count: same report
    /per-report: 1\/1 reports/,
    /PASS: every source word and number present/,
  );
});

test("SVG url(#id) references follow their renamed ids", { timeout: TIMEOUT }, () => {
  const r = build(control("control-svg-references"));
  assert.equal(r.code, 0, tail(r.out));
  has(r.out, /PASS: every source word and number present/);
  const baked = readFileSync(r.html, "utf8");
  for (const ref of ["url(#r0-ctl-grad)", "url(#r0-ctl-clip)", "url('#r0-ctl-grad')"]) {
    assert.ok(baked.includes(ref), `${ref} missing from the bake`);
  }
  assert.ok(baked.includes('id="r0-ctl-arrow"'), "the marker id was not renamed");
  assert.ok(/marker-end[:=]\s*"?url\(#r0-ctl-arrow\)/.test(baked), "marker-end not renamed");
  assert.ok(
    !/url\((?:['"]|&quot;)?#ctl-(grad|clip|arrow)/.test(baked),
    "a reference still names the old id",
  );
  assert.ok(baked.includes("url(#ctl-undefined)"), "a reference to no id was rewritten");
  // The entity-quoted form a browser writes when it saves a page.
  assert.ok(baked.includes("url(&quot;#r0-ctl-clip&quot;)"), "the &quot;-quoted url not renamed");
  // data-id is data: untouched, and not an id that steers other rewrites.
  assert.ok(baked.includes('data-id="ctl-grad"'), "data-id was rewritten");
  assert.ok(!baked.includes('data-id="r0-'), "data-id was namespaced");
  // Unquoted id and href, renamed together.
  assert.ok(/\bid=r0-ctl-bare\b/.test(baked) && /href=#r0-ctl-bare\b/.test(baked), "unquoted pair");
  // "id=" inside a title is text: untouched by the bake, and no id to the reference check.
  assert.ok(baked.includes('title="see id=ctl-t"'), "an attribute's text was read as an id");
  // Two unresolved, both already dangling in the source: ctl-undefined and ctl-t.
  has(r.out, /refs:\s+\d+ id reference\(s\), 2 unresolved, 0 broken by the bake/);
});

test("<style type=…> and media blocks are read like a bare <style>", { timeout: TIMEOUT }, () => {
  const r = build(control("control-style-attributes"));
  assert.equal(r.code, 0, tail(r.out));
  has(
    r.out,
    // The same report as custom delimiters: its stylesheet must be audited the same way.
    /audit:\s+1 loader\(s\) removed, 1 visibility gate\(s\) opened, 3 height:100% relaxed, 0 @page rule\(s\) superseded, 1 stray CSS token\(s\) cleaned/,
    /PASS: every source word and number present/,
  );
  hasNot(r.out, /could not be hoisted/);
  const baked = readFileSync(r.html, "utf8");
  assert.ok(
    baked.includes('font-family="&quot;Arial&quot;, sans-serif"'),
    "quoted value not escaped",
  );
  assert.ok(
    /@media print\s*\{[\s\S]*ctl-print-only/.test(baked),
    "the media block lost its condition",
  );
  assert.ok(!/<svg\b(?:(?!<\/svg>)[\s\S])*<style/i.test(baked), "the SVG <style> was not hoisted");
});

// ── output paths: never drop or overwrite a source report ────────────────────

test(
  "an output named like a report, in another folder, drops nothing",
  { timeout: TIMEOUT },
  () => {
    const input = control("control-custom-delimiters", join(work, "named-like-report"));
    // The report is d_report.html; the baked HTML will be out/d_report.html.
    const r = run([MAIN, input, join(input, "out", "d_report.pdf")]);
    assert.equal(r.code, 0, tail(r.out));
    has(r.out, /Compiling 1 report\(s\)/, /per-report: 1\/1 reports/);
    hasNot(r.out, /skipped:/);
  },
);

test("an output that would overwrite a source report is refused", { timeout: TIMEOUT }, () => {
  const input = control("control-custom-delimiters", join(work, "overwrite"));
  const report = join(input, "d_report.html");
  const original = readFileSync(report, "utf8");
  // As the PDF's name (the baked HTML lands on the report), and as the PDF itself. Another
  // case is the same file only where the filesystem folds case (Windows, by default).
  const outs = ["d_report.pdf", "d_report.html"];
  if (process.platform === "win32") outs.push("D_REPORT.pdf");
  for (const out of outs) {
    const r = run([MAIN, input, join(input, out)]);
    assert.equal(r.code, 1, `${out}:\n${tail(r.out)}`);
    has(r.out, /The output would overwrite a source report/);
    hasNot(r.out, /Compiling/);
    assert.equal(readFileSync(report, "utf8"), original, `${out} changed the source report`);
  }
});

test("a previous run's baked document in the input folder is skipped", { timeout: TIMEOUT }, () => {
  const input = control("control-custom-delimiters", join(work, "rerun"));
  const pdf = join(input, "c.pdf");
  assert.equal(run([MAIN, input, pdf]).code, 0, "the first run failed");
  const r = run([MAIN, input, pdf]);
  assert.equal(r.code, 0, tail(r.out));
  has(r.out, /Compiling 1 report\(s\)/, /skipped:\s+1 tool-owned/, /per-report: 1\/1 reports/);

  // A different output name must not compile the first run's bake as a "report" either --
  // the copy would sit on both sides of the verification and pass.
  const other = run([MAIN, input, join(input, "other.pdf")]);
  assert.equal(other.code, 0, tail(other.out));
  has(
    other.out,
    /Compiling 1 report\(s\)/,
    /skipped:\s+1 tool-owned/,
    /c\.html \(a previous bake\)/,
    /per-report: 1\/1 reports/,
  );
});

test(
  "an output reaching the input folder through a link is still refused",
  { timeout: TIMEOUT },
  () => {
    const input = control("control-custom-delimiters", join(work, "linked"));
    // A junction on Windows (no privilege needed), a directory symlink elsewhere.
    const alias = join(work, "linked-alias");
    symlinkSync(input, alias, "junction");
    const report = join(input, "d_report.html");
    const original = readFileSync(report, "utf8");
    const r = run([MAIN, input, join(alias, "d_report.pdf")]);
    assert.equal(r.code, 1, tail(r.out));
    has(r.out, /The output would overwrite a source report/);
    assert.equal(readFileSync(report, "utf8"), original, "the source report changed");
  },
);

// ── the CLI's own failure paths ──────────────────────────────────────────────

test("an unknown flag is rejected", { timeout: TIMEOUT }, () => {
  const r = run([MAIN, "--no-optimise"]);
  assert.equal(r.code, 1, tail(r.out));
  has(r.out, /Unknown option\(s\): --no-optimise/, /Supported: .*--no-optimize/);
  hasNot(r.out, /Compiling/);
});

test("a third positional argument is rejected, not ignored", { timeout: TIMEOUT }, () => {
  // An unquoted output path with a space: before, "C:\My" became the PDF and the rest vanished.
  const r = run([MAIN, "reports", "C:\\My", "Docs\\out.pdf"]);
  assert.equal(r.code, 1, tail(r.out));
  has(r.out, /Too many arguments \(3\)/, /Docs\\out\.pdf/, /quoted as ONE argument/);
  hasNot(r.out, /Compiling/, /No such folder/);
});

test(
  "a previous PDF that cannot be removed stops the build, never read back as new",
  { timeout: TIMEOUT },
  async () => {
    // Root ignores permissions, so the POSIX lock below would not hold.
    if (process.platform !== "win32" && process.getuid?.() === 0) return;
    const input = control("control-custom-delimiters", join(work, "locked"));
    const out = join(input, "out");
    mkdirSync(out, { recursive: true });
    const pdf = join(out, "c.pdf");
    // A REAL previous PDF: read back, it parses, so only the guard can stop it passing.
    const { PDFDocument } = await import("pdf-lib");
    const old = await PDFDocument.create();
    old.addPage();
    writeFileSync(pdf, await old.save());
    const before = readFileSync(pdf);

    let release: () => Promise<void>;
    if (process.platform === "win32") {
      // A PDF viewer's lock: others may read the file, but not write or delete it.
      const holder = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "$f=[IO.File]::Open($env:S3D_LOCK,'Open','Read','Read'); 'locked'; " +
            "[Console]::In.ReadLine() | Out-Null; $f.Close()",
        ],
        { env: { ...process.env, S3D_LOCK: pdf }, stdio: ["pipe", "pipe", "inherit"] },
      );
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on("data", (d) => String(d).includes("locked") && resolve());
        holder.on("exit", (c) => reject(new Error(`the lock holder exited (${c})`)));
      });
      release = () =>
        new Promise((r) => {
          holder.on("close", () => r());
          holder.stdin.end("\n");
        });
    } else {
      // The POSIX equivalent: a folder whose entries cannot be removed.
      chmodSync(out, 0o555);
      release = async () => chmodSync(out, 0o755);
    }

    try {
      // This runtime as "Chrome", as in the stale-PDF test below: it writes no PDF. With
      // --no-optimize --no-verify nothing else would notice the old file being read back.
      const r = run([MAIN, input, pdf, "--no-optimize", "--no-verify"], {
        env: { ...process.env, CHROME_PATH: process.execPath },
      });
      assert.equal(r.code, 1, tail(r.out));
      has(r.out, /Could not remove the previous PDF/, /open in a PDF viewer/);
      hasNot(r.out, /^Created /m, /Chrome produced no PDF/);
    } finally {
      await release();
    }
    assert.deepEqual(readFileSync(pdf), before, "the previous PDF changed");
  },
);

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

test("the sanitizer refuses a filled field it does not scrub, and short values", () => {
  const sanitize = (dir: string) =>
    run([join(ROOT, "scripts", "sanitize-report.ts"), "--check", "x_report.html"], { cwd: dir });
  const reportOf = (dir: string) => join(dir, "local", "HTMLFilesToBeCompiled", "x_report.html");
  const edit = (dir: string, from: string | RegExp, to: string) => {
    const html = readFileSync(reportOf(dir), "utf8");
    const next = html.replace(from, to);
    assert.notEqual(next, html, `could not plant ${to}`);
    writeFileSync(reportOf(dir), next);
  };

  // Company, Project ID and Client are empty in every real report, so nothing scrubbed them --
  // and the residue check looks only for the values it removed. Filled, the file passed with ✓.
  for (const label of ["Company", "Project ID", "Client"]) {
    const dir = sanitizerInput(`sanitize-${label.replace(/\W/g, "")}`, false);
    edit(
      dir,
      new RegExp(`(${label}:\\s*\\[mathin\\]\\\\text\\{[^}]*\\}\\[mathin\\])<br`),
      "$1Brightwater Holdings<br",
    );
    const r = sanitize(dir);
    assert.equal(r.code, 1, `${label}:\n${r.out}`);
    has(r.out, new RegExp(`field\\(s\\) "${label}:" hold a value this script does not scrub`));
  }

  // A designer written as initials: two letters used to be below the residue check's floor, so
  // the same initials elsewhere in the document survived unseen.
  const initials = sanitizerInput("sanitize-initials", false);
  edit(initials, "]Quentin Vardle<br", "]QV<br");
  edit(initials, /(MEMBER\s*#?\s*\d+\s*DESIGN\s*REPORT)/i, "$1 checked QV");
  const qv = sanitize(initials);
  assert.equal(qv.code, 1, qv.out);
  has(qv.out, /1 removed term\(s\) still present: QV/);

  // A name in non-Latin letters: no ASCII word to look for, so nothing was checked.
  const greek = sanitizerInput("sanitize-greek", false);
  edit(greek, "]Quentin Vardle<br", "]Ζωρμπλαξ<br");
  edit(greek, /(MEMBER\s*#?\s*\d+\s*DESIGN\s*REPORT)/i, "$1 Ζωρμπλαξ");
  const gr = sanitize(greek);
  assert.equal(gr.code, 1, gr.out);
  has(gr.out, /still present: Ζωρμπλαξ/);

  // A value with no word of two characters cannot be verified gone at all: refused.
  const single = sanitizerInput("sanitize-single", false);
  edit(single, "]Quentin Vardle<br", "]Q<br");
  const one = sanitize(single);
  assert.equal(one.code, 1, one.out);
  has(one.out, /1 removed value\(s\) too short to verify absent/);
});

// ── the transcript redactor ──────────────────────────────────────────────────

test("the redactor removes checkout, drive and slug paths, and fails on a residue", () => {
  const redact = join(ROOT, "tests", "controls", "redact-paths.ts");
  // Built from this checkout's real location at run time, so the file names no path. Runs on
  // Windows (a drive checkout) and on Linux CI (a POSIX one) -- both must come out clean.
  const root = ROOT.replace(/[\\/]+$/, "");
  const slug = root.replace(/[:\\/]/g, "-");
  const file = join(work, "transcript.md");
  const lines = [
    `read ${root}\\main.ts`,
    `json ${root.replace(/\\/g, "\\\\")}\\\\src\\\\report_core.ts`,
    `slash ${root.replace(/\\/g, "/")}/cmem/INDEX.md`,
    "home C:\\Users\\zorblax\\AppData\\Local\\Temp\\x.txt",
    "other J:\\Archive\\clients\\job-41\\report.html",
    // A SIBLING of the checkout and of its workspace, sharing their names as a prefix: must not
    // be half-matched (`<workspace>-backup\client-acme` once survived, drive gone).
    ...(/^[A-Za-z]:/.test(root)
      ? [
          `sibling ${root.replace(/[\\/][^\\/]+$/, "")}-backup\\client-acme\\job.html`,
          // Inside the workspace: <workspace>\…-old\… by design (like <project>\src\…), and
          // never half-matched as <project>-old.
          `sibling2 ${root}-old\\notes.txt`,
          `slugsib ~/.claude/projects/${slug}-old/x.jsonl`,
        ]
      : []),
    // The same checkout as Git Bash and WSL print it, when it is on a drive letter.
    ...(/^[A-Za-z]:/.test(root)
      ? [
          `bash cd /${root[0].toLowerCase()}${root.slice(2).replace(/\\/g, "/")}/tests`,
          `wsl /mnt/${root[0].toLowerCase()}${root.slice(2).replace(/\\/g, "/")}/main.ts`,
        ]
      : []),
    "bash2 ls /j/Archive/clients/job-41",
    "spaces C:\\Program Files\\Vendor Tool\\bin\\tool.exe ran",
    "unc \\\\fileserver7\\jobs\\job-41\\report.html",
    'json "\\\\\\\\fileserver7\\\\jobs\\\\job-41"',
    `slug ~/.claude/projects/${slug}/session.jsonl and Q--Elsewhere-thing`,
    "url https://github.com/synapticforge1/S3D-ReportCompiler stays",
  ];
  writeFileSync(file, lines.join("\n"));
  const r = run([redact, file, "--user=zorblax"]);
  assert.equal(r.code, 0, r.out);
  has(r.out, /username:\s+1 occurrence\(s\) before, 0 after/, /paths:\s+0 drive path\(s\) after/);
  const text = readFileSync(file, "utf8");
  assert.ok(
    !/[A-Za-z]:[\\/]/.test(text.replace(/https?:\/\//g, "")),
    `a drive path survived:\n${text}`,
  );
  assert.ok(!text.includes(slug), `the project slug survived:\n${text}`);
  // The checkout itself, as written, on every platform (a POSIX checkout once went through).
  for (const form of [root, root.replace(/\\/g, "/")]) {
    assert.ok(!text.includes(form), `the checkout path survived:\n${text}`);
  }
  assert.ok(text.includes("https://github.com/synapticforge1/S3D-ReportCompiler stays"), text);
  // POSIX drive spellings, a folder name with spaces, network paths.
  for (const leak of [
    "/mnt/",
    "/j/Archive",
    "Vendor Tool",
    "Files\\",
    "fileserver7",
    "job-41",
    "client-acme",
    "-backup",
    "<project>-old",
    "<project-slug>-old",
  ]) {
    assert.ok(!text.includes(leak), `"${leak}" survived:\n${text}`);
  }
  assert.ok(text.includes("tool.exe ran") === false && /<path> ran/.test(text), text);

  // A username outside any path survives redaction by design -- and must fail the run.
  writeFileSync(file, "signed by zorblax\n");
  const residue = run([redact, file, "--user=zorblax"]);
  assert.equal(residue.code, 1, residue.out);
  has(residue.out, /not safe to publish/);
  assert.equal(
    run([redact, file, "--user=zorblax", "--check"]).code,
    1,
    "--check passed a residue",
  );
});

// ── MathJax limitations the bake works around ────────────────────────────────
//
// 🔁 RE-CHECK ON EVERY MATHJAX UPDATE (owner, 2026-11-05; roadmap task 8). Each assertion pins a
// MathJax behaviour the bake depends on, not the bake's own logic; a new MathJax that changes one
// fails here, by name, before a report can render differently.

test("MathJax limitations: entities, non-breaking spaces, ids", { timeout: TIMEOUT }, async () => {
  const core = await import(pathToFileURL(join(ROOT, "src", "report_core.ts")).href);
  // A report shell with the samples' own tex2jax config, so the delimiters are the real ones.
  const sample = readFileSync(join(SAMPLES, "member_0_report.html"), "utf8");
  const head = sample.match(/<head[^>]*>[\s\S]*?<\/head>/i)?.[0] ?? "";
  const bake = (body: string) => {
    const before = core.mathStats.failed;
    const out: string = core.bakeBody(`<html>${head}<body>${body}</body></html>`, "r9-");
    return { out, failed: core.mathStats.failed - before };
  };

  // 1. Named entities beyond MathJax's 406-name core table (&ge; is not in it) decode only
  //    because report_core imports `mathjax-full/js/util/entities/all.js`; MathJax otherwise
  //    loads them asynchronously, which a synchronous convert() never waits for. Case matters.
  //    Pinned as "typesets exactly like the character itself", not by output class: MathJax
  //    restyles some characters (Greek becomes maths italic, U+1D6E5), which is rendering.
  const ent = bake("[mathin]a &ge; b &times; c &Delta; &delta; 5&deg;[mathin]");
  assert.equal(ent.failed, 0, "an entity reached TeX undecoded");
  assert.equal(ent.out, bake("[mathin]a ≥ b × c Δ δ 5°[mathin]").out, "an entity decoded wrongly");
  //    An entity in no table stays as written, so TeX refuses it and the build fails loudly.
  assert.equal(bake("[mathin]a &notarealentity; b[mathin]").failed, 1, "unknown entity passed");

  // 2. MathJax keeps U+00A0 in \text{} but collapses ASCII spaces: &nbsp; must decode to U+00A0
  //    (as the DOM has it), not to a space. Same as &#160;; different from two spaces.
  const nb = bake("[mathin]\\text{A&nbsp;&nbsp;B}[mathin]").out;
  assert.equal(nb, bake("[mathin]\\text{A&#160;&#160;B}[mathin]").out, "&nbsp; is not U+00A0");
  assert.notEqual(nb, bake("[mathin]\\text{A  B}[mathin]").out, "MathJax now collapses U+00A0");

  // 3. CHTML emits no <svg> and no <style> of its own (portableSvg rewrites every <text> and
  //    hoists every SVG <style>, which is safe only while that holds).
  assert.ok(!/<svg|<style/i.test(ent.out), "MathJax's CHTML now emits SVG or a style block");

  // The bake's own side of the same expressions: prose that reads like an attribute is prose.
  const prose = bake("<p>Member id = 4, for = 2</p><g id=x></g><use href=#x />").out;
  assert.ok(prose.includes("Member id = 4, for = 2"), "prose was rewritten as an attribute");
  assert.ok(/id=r9-x\b/.test(prose) && /href=#r9-x\b/.test(prose), "the real tag was not");
  // A data-* attribute on a <style> is data: the sheet is still read, unconditionally.
  const css: string = core.bakeStyle(
    '<html><head><style data-type="theme" data-media="x">.ctl{color:red}</style></head></html>',
    ".rs9",
    "r9-",
  );
  assert.match(css, /color:\s*red/, "a data-type sheet was dropped");
  assert.doesNotMatch(css, /@media x/, "data-media became a media query");
});

test("CSS scoping, SVG sheets, attributes and entities, as a browser reads them", async () => {
  const core = await import(pathToFileURL(join(ROOT, "src", "report_core.ts")).href);
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const scope = (css: string) => flat(core.scopeCss(css, ".rs9", "r9-"));

  // 1. The whole leading chain of html / body / :root is the wrapper. `html body p` used to
  //    become `.rs9 body p`, which nothing inside the wrapper matches.
  assert.equal(scope("html body p { color: red }"), ".rs9 p { color: red }");
  assert.equal(scope("html > body > p {x:y}"), ".rs9 > p {x:y}");
  assert.equal(scope(":root body {x:y}"), ".rs9 {x:y}");
  //    A sibling of <body> exists in no document; kept, `.rs9 + p` reached the next report.
  assert.equal(scope("body + p {x:y}"), "");
  // 2. A selector list splits at its top-level commas only (`.rs9 p:not(.a, .rs9 .b)` before).
  assert.equal(scope("p:not(.a, .b), q {x:y}"), ".rs9 p:not(.a, .b), .rs9 q {x:y}");

  // 3. A qualifier on body is settled against the source's own <body>, which the wrapper is
  //    not: `body.dark p` used to become `.rs9 .dark p`, a descendant's class.
  const qualified = flat(
    core.bakeStyle(
      '<html><head><style>body.dark p{color:red} body.light p{color:blue} body:hover{x:y}</style></head><body class="x dark"><p>t</p></body></html>',
      ".rs9",
      "r9-",
    ),
  );
  assert.match(qualified, /\.rs9 p \{color:red\}/, "the matching qualifier was not settled");
  assert.doesNotMatch(qualified, /light|blue/, "a rule its source never applied survived");
  assert.match(qualified, /\.rs9:hover \{x:y\}/, "a pseudo-class left the wrapper");

  // 4. The page's own <style> in the body moves to the report's scoped sheet; the diagram's
  //    stays in the diagram. Before, it stayed in the body, applying to EVERY report, with its
  //    #report selector matching nothing once the id was renamed.
  const doc =
    '<html><head></head><body><style>#report{color:blue}</style><div id="report">x</div>' +
    "<svg><style>text{fill:red}</style><text>t</text></svg></body></html>";
  const sheet = flat(core.bakeStyle(doc, ".rs9", "r9-"));
  assert.match(sheet, /\.rs9 #r9-report \{color:blue\}/, "the body sheet was not scoped");
  assert.doesNotMatch(sheet, /fill/, "the SVG's sheet leaked into the page's");
  const fragment: string = core.bakeBody(doc, "r9-");
  assert.doesNotMatch(fragment, /#report\{/, "the body sheet stayed, unscoped");
  assert.match(fragment, /<text fill="red">/, "the SVG sheet was not hoisted");

  // 5. What cannot be hoisted is kept, and confined to its own <svg>: a rule under @media is a
  //    condition (it was hoisted as though unconditional), and `font` has no presentation
  //    attribute (it became font="…", which the browser ignores, and the sheet was deleted).
  const svg = (s: string) =>
    flat(
      core.bakeBody(
        `<html><body><svg><style>${s}</style><text id="t">t</text></svg></body></html>`,
        "r9-",
      ),
    );
  const media = svg("@media screen { text { fill: gray } }");
  assert.doesNotMatch(media, /fill="gray"/, "a conditional rule was hoisted");
  assert.match(media, /<svg data-s3d-scope="r9-">/, "the kept sheet's <svg> is not marked");
  assert.match(media, /@media screen \{ svg\[data-s3d-scope="r9-"\] text \{ fill: gray \} \}/);
  const font = svg("text { font: 12px Arial } svg { opacity: .5 } #t { fill: red }");
  assert.doesNotMatch(font, /<text[^>]* font=/, "a CSS-only property became an attribute");
  assert.match(font, /svg\[data-s3d-scope="r9-"\] text \{ font: 12px Arial \}/);
  assert.match(font, /svg\[data-s3d-scope="r9-"\] \{ opacity: \.5 \}/, "`svg` is not the root");
  assert.match(font, /svg\[data-s3d-scope="r9-"\] #r9-t \{ fill: red \}/, "an id not renamed");

  // 6. "id=" inside another attribute's value is that attribute's text.
  const attrs: string = core.bakeBody(
    '<html><body><img alt="Member id = 4" src="data:x"><a title=\'see id=q\' href="#4">x</a><g id=x></g></body></html>',
    "r9-",
  );
  assert.ok(attrs.includes('alt="Member id = 4"'), "alt text was rewritten as an id");
  assert.ok(attrs.includes("title='see id=q'"), "title text was rewritten as an id");
  assert.match(attrs, /<g id=r9-x>/, "the real id was not renamed");

  // 7. The verification's decoder: named symbols and hex references decode; an impossible
  //    reference is U+FFFD, as a browser reads it (it threw a RangeError); one pass only.
  assert.equal(core.decodeEntities("5&deg; &phi; &Delta; &#x3C6; &#966;"), "5° φ Δ φ φ");
  assert.equal(core.decodeEntities("&#99999999; &#0; &#xD800;"), "� � �");
  assert.equal(core.decodeEntities("&amp;#60; &notanentity;"), "&#60; &notanentity;");
});

// ── the release scripts against a fake JSR ───────────────────────────────────
//
// Both scripts take the JSR API's base URL from S3D_JSR_API (a test hook, unset in real use),
// so every verdict can be driven from here. The server runs in THIS process, so the script must
// be spawned asynchronously -- spawnSync would block the event loop the server answers on.

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Serve `handler` on 127.0.0.1 for the duration of `fn`. */
async function withFakeJsr<T>(handler: Handler, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** `run`, without blocking this process. */
function runAsync(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<Result> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: opts.cwd ?? ROOT, env: opts.env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => (out += e.message));
    p.on("close", (code) => resolve({ code, out }));
  });
}

const json =
  (body: unknown, status = 200): Handler =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

test("verify-release: every verdict, from a fake JSR", { timeout: TIMEOUT }, async () => {
  const VR = join(ROOT, "scripts", "verify-release.ts");
  const cases: Array<[string, Handler, number, RegExp]> = [
    ["attested", json({ rekorLogId: "77" }), 0, /published AND attested\.\s+Rekor log ID: 77/],
    [
      "attested, yanked",
      json({ rekorLogId: "77", yanked: true }),
      3,
      /YANKED on JSR \(it was attested, Rekor 77\)/,
    ],
    // Provenance first: a yank must not hide that it was never attested.
    [
      "unattested, yanked",
      json({ rekorLogId: null, yanked: true }),
      1,
      /NO provenance attestation \(and is now YANKED\)/,
    ],
    ["unattested", json({ rekorLogId: null }), 1, /NO provenance attestation\./],
    ["404", json({}, 404), 2, /9\.9\.9 is not on JSR\./],
    [
      "503",
      json({}, 503),
      2,
      /Could not ask JSR whether 9\.9\.9 is published: HTTP 503\.\s+This is not a verdict/,
    ],
    // Never answers: bounded by the timeout instead of hanging the release.
    ["stalled", () => {}, 2, /Could not ask JSR whether 9\.9\.9 is published: \w*Timeout/i],
  ];
  for (const [label, handler, code, pattern] of cases) {
    const r = await withFakeJsr(handler, (base) =>
      runAsync([VR, "9.9.9"], {
        env: { ...process.env, S3D_JSR_API: base, S3D_JSR_TIMEOUT_MS: "500" },
      }),
    );
    assert.equal(r.code, code, `${label}:\n${r.out}`);
    assert.match(r.out, pattern, `${label}:\n${r.out}`);
  }

  // --wait retries a "could not tell" and then reports the real verdict.
  let hits = 0;
  const flaky: Handler = (req, res) =>
    (++hits <= 2 ? json({}, 503) : json({ rekorLogId: "78" }))(req, res);
  const r = await withFakeJsr(flaky, (base) =>
    runAsync([VR, "9.9.9", "--wait"], {
      env: { ...process.env, S3D_JSR_API: base, S3D_JSR_TIMEOUT_MS: "500", S3D_JSR_RETRY_MS: "20" },
    }),
  );
  assert.equal(r.code, 0, r.out);
  has(r.out, /could not ask JSR \(1\/60\): HTTP 503 — retrying/, /Rekor log ID: 78/);
  assert.equal(hits, 3);
});

test("verify-release: arguments, the provenance grace, and npm", { timeout: TIMEOUT }, async () => {
  const VR = join(ROOT, "scripts", "verify-release.ts");
  const fast = { S3D_JSR_TIMEOUT_MS: "500", S3D_JSR_RETRY_MS: "20" };

  // A mistyped flag is a usage error (64), not a silent single look.
  for (const args of [["9.9.9", "--wiat"], ["9.9.9", "1.0.0"], ["v9.9.9"]]) {
    const u = await runAsync([VR, ...args], { env: process.env });
    assert.equal(u.code, 64, `${args.join(" ")}:\n${u.out}`);
    has(u.out, /usage: verify-release\.ts/);
  }

  // deno publish shows the version before it attaches provenance: under --wait, a record with no
  // rekorLogId is looked at again before it is called unattested.
  let hits = 0;
  const late: Handler = (req, res) =>
    (++hits <= 2 ? json({ rekorLogId: null }) : json({ rekorLogId: "79" }))(req, res);
  const g = await withFakeJsr(late, (base) =>
    runAsync([VR, "9.9.9", "--wait"], { env: { ...process.env, ...fast, S3D_JSR_API: base } }),
  );
  assert.equal(g.code, 0, g.out);
  has(g.out, /no provenance record yet \(1\/8\)/, /Rekor log ID: 79/);
  // ...and one that never gets one is still called unattested, after the grace.
  const never = await withFakeJsr(json({ rekorLogId: null }), (base) =>
    runAsync([VR, "9.9.9", "--wait"], { env: { ...process.env, ...fast, S3D_JSR_API: base } }),
  );
  assert.equal(never.code, 1, never.out);
  has(never.out, /no provenance record yet \(8\/8\)/, /NO provenance attestation/);

  // --npm: JSR attested, then npm. The release passes it; it used to ask JSR alone.
  const npmCases: Array<[string, Handler, number, RegExp]> = [
    [
      "with provenance",
      json({ version: "9.9.9", dist: { attestations: { provenance: { predicateType: "x" } } } }),
      0,
      /9\.9\.9 is on npm WITH provenance/,
    ],
    ["without", json({ version: "9.9.9", dist: {} }), 4, /on npm with NO provenance/],
    ["404", json({}, 404), 4, /attested on JSR but NOT on npm/],
    ["503", json({}, 503), 4, /Could not ask npm whether 9\.9\.9 is published: HTTP 503/],
    ["another version", json({ version: "1.0.0" }), 4, /without this version's record/],
  ];
  for (const [label, handler, code, pattern] of npmCases) {
    const n = await withFakeJsr(json({ rekorLogId: "80" }), (jsr) =>
      withFakeJsr(handler, (npm) =>
        runAsync([VR, "9.9.9", "--npm"], {
          env: { ...process.env, ...fast, S3D_JSR_API: jsr, S3D_NPM_API: npm },
        }),
      ),
    );
    assert.equal(n.code, code, `npm ${label}:\n${n.out}`);
    has(n.out, /S3D_NPM_API is set/, pattern);
  }
  // npm is never asked about a version JSR did not attest.
  let npmAsked = false;
  const u = await withFakeJsr(json({ rekorLogId: null }), (jsr) =>
    withFakeJsr(
      (req, res) => {
        npmAsked = true;
        json({}, 404)(req, res);
      },
      (npm) =>
        runAsync([VR, "9.9.9", "--npm"], {
          env: { ...process.env, ...fast, S3D_JSR_API: jsr, S3D_NPM_API: npm },
        }),
    ),
  );
  assert.equal(u.code, 1, u.out);
  assert.equal(npmAsked, false, "npm was asked about an unattested version");
  // The npm hook is fenced like JSR's.
  const away = await runAsync([VR, "9.9.9", "--npm"], {
    env: { ...process.env, S3D_NPM_API: "https://npm.example.invalid" },
  });
  assert.notEqual(away.code, 0, away.out);
});

/**
 * A throwaway clone set up so `bun run release` makes its bump commit: package.json one version
 * behind jsr.json. Pushing is impossible (the push URL is not a remote). Returns the clone.
 */
function releaseClone(name: string): string {
  const dir = join(work, name);
  const git = (...a: string[]) => {
    const g = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    assert.equal(g.status, 0, `git ${a.join(" ")}:\n${g.stderr}`);
    return g.stdout.trim();
  };
  assert.equal(spawnSync("git", ["clone", "-q", ROOT, dir]).status, 0, "clone failed");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  // A release runs only on main tracking origin/main (publish.ts step 0b) -- whatever branch, or
  // detached PR head, this checkout is on. The clone fetches from ITSELF, so the release's
  // `git fetch origin` makes origin/main this clone's main: never behind, whatever ROOT holds.
  git("checkout", "-q", "-B", "main");
  git("remote", "set-url", "origin", dir);
  git("remote", "set-url", "--push", "origin", "NO-PUSH-FROM-TESTS");
  // The release under test is the working tree's, not the last commit's: every script, since
  // they import one another (publish.ts → jsr-api.ts, compat.ts).
  for (const f of readdirSync(join(ROOT, "scripts")).filter((n) => n.endsWith(".ts"))) {
    writeFileSync(join(dir, "scripts", f), readFileSync(join(ROOT, "scripts", f)));
  }
  const version = JSON.parse(readFileSync(join(dir, "jsr.json"), "utf8")).version as string;
  const pkg = readFileSync(join(dir, "package.json"), "utf8");
  const behind = pkg.replace(`"version": "${version}"`, '"version": "0.0.1"');
  assert.notEqual(behind, pkg, "could not set package.json behind");
  writeFileSync(join(dir, "package.json"), behind);
  git("commit", "-qam", "release test setup");
  git("fetch", "-q", "origin");
  git("branch", "-q", "-u", "origin/main");
  return dir;
}

const headOf = (dir: string) =>
  spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

test(
  "release: a JSR that cannot answer refuses, and undoes the bump",
  { timeout: TIMEOUT },
  async () => {
    const dir = releaseClone("release-503");
    const before = headOf(dir);
    const r = await withFakeJsr(json({}, 503), (base) =>
      runAsync([join(dir, "scripts", "publish.ts"), "--no-wait"], {
        cwd: dir,
        env: { ...process.env, S3D_JSR_API: base, S3D_JSR_TIMEOUT_MS: "2000" },
      }),
    );
    assert.equal(r.code, 1, r.out);
    has(
      r.out,
      /Could not ask JSR whether .* is already published \(HTTP 503\)/,
      /undid the local "bump version to v/,
    );
    assert.equal(headOf(dir), before, "the bump commit is still there");
    hasNot(r.out, /tagging /);
  },
);

test("release: an undo that cannot run says so", { timeout: TIMEOUT }, async () => {
  /** A release in a fresh clone, with `lock` (a path under .git) created while JSR is asked. */
  const lockedRelease = async (name: string, lock: string) => {
    const dir = releaseClone(name);
    const before = headOf(dir);
    const r = await withFakeJsr(
      (req, res) => {
        writeFileSync(join(dir, ".git", lock), "");
        json({}, 503)(req, res);
      },
      (base) =>
        runAsync([join(dir, "scripts", "publish.ts"), "--no-wait"], {
          cwd: dir,
          env: { ...process.env, S3D_JSR_API: base, S3D_JSR_TIMEOUT_MS: "2000" },
        }),
    );
    rmSync(join(dir, ".git", lock), { force: true });
    return { r, before, after: headOf(dir) };
  };

  // The reset itself fails (the branch ref is locked): told, not claimed; the commit remains.
  // The clone's branch is always main (releaseClone).
  const refLocked = await lockedRelease("release-ref-locked", "refs/heads/main.lock");
  assert.equal(refLocked.r.code, 1, refLocked.r.out);
  has(refLocked.r.out, /could NOT undo the local "bump version to v/, /do not push it/);
  hasNot(refLocked.r.out, /undid the local/);
  assert.notEqual(refLocked.after, refLocked.before, "expected the bump commit to remain");

  // The commit is undone but the index is locked: said exactly that, with the command to finish.
  const idxLocked = await lockedRelease("release-index-locked", "index.lock");
  assert.equal(idxLocked.r.code, 1, idxLocked.r.out);
  has(
    idxLocked.r.out,
    /undid the local "bump version to v.*" commit, but could not unstage/,
    /git reset -q HEAD --/,
  );
  assert.equal(idxLocked.after, idxLocked.before, "the bump commit should be undone");

  // HEAD moves while JSR is being asked: left alone, and said.
  const moved = releaseClone("release-moved");
  const r2 = await withFakeJsr(
    (req, res) => {
      spawnSync("git", ["-C", moved, "commit", "-q", "--allow-empty", "-m", "someone else"]);
      json({}, 503)(req, res);
    },
    (base) =>
      runAsync([join(moved, "scripts", "publish.ts"), "--no-wait"], {
        cwd: moved,
        env: { ...process.env, S3D_JSR_API: base, S3D_JSR_TIMEOUT_MS: "2000" },
      }),
  );
  assert.equal(r2.code, 1, r2.out);
  has(r2.out, /HEAD is not the bump commit any more; left as is/);
  assert.equal(
    spawnSync("git", ["-C", moved, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).stdout.trim(),
    "someone else",
  );
});

test(
  "release: a file staged beforehand is not swept into the bump",
  { timeout: TIMEOUT },
  async () => {
    const dir = releaseClone("release-staged");
    const before = headOf(dir);
    writeFileSync(
      join(dir, "README.md"),
      `${readFileSync(join(dir, "README.md"), "utf8")}\nstaged\n`,
    );
    assert.equal(spawnSync("git", ["-C", dir, "add", "README.md"]).status, 0);
    // No JSR is needed: the dirty check refuses before the lookup.
    const r = await runAsync([join(dir, "scripts", "publish.ts"), "--no-wait"], { cwd: dir });
    assert.equal(r.code, 1, r.out);
    has(
      r.out,
      /Uncommitted changes — these would NOT be in v/,
      /README\.md/,
      /undid the local "bump/,
    );
    assert.equal(headOf(dir), before, "the bump commit remains");
    const staged = spawnSync("git", ["-C", dir, "diff", "--cached", "--name-only"], {
      encoding: "utf8",
    });
    assert.match(staged.stdout, /README\.md/, "README.md is no longer staged");
  },
);

test("release: only main, tracking origin/main, is released", { timeout: TIMEOUT }, async () => {
  // A feature branch with an upstream used to push itself and its tag: ci.yml runs on every
  // branch, so publish.yml's CI gate passed, and unmerged code reached both registries.
  const dir = releaseClone("release-branch");
  const before = headOf(dir);
  const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("checkout", "-q", "-b", "feature");
  git("branch", "-q", "-u", "origin/main");
  const tags = () => git("tag", "--list").stdout;
  const tagsBefore = tags();
  // No JSR is needed: the branch is refused before anything is committed or asked.
  const r = await runAsync([join(dir, "scripts", "publish.ts"), "--no-wait"], { cwd: dir });
  assert.equal(r.code, 1, r.out);
  has(r.out, /Only main is released; HEAD is on "feature"/);
  hasNot(r.out, /bump version|undid|tagging /);
  assert.equal(headOf(dir), before, "something was committed");
  assert.equal(tags(), tagsBefore, "a tag was made");

  // Detached, as a PR checkout is.
  git("checkout", "-q", "--detach");
  const d = await runAsync([join(dir, "scripts", "publish.ts"), "--no-wait"], { cwd: dir });
  assert.equal(d.code, 1, d.out);
  has(d.out, /HEAD is detached/);

  // main without an upstream: the behind-check used to be skipped in silence.
  git("checkout", "-q", "main");
  git("branch", "-q", "--unset-upstream");
  const u = await runAsync([join(dir, "scripts", "publish.ts"), "--no-wait"], { cwd: dir });
  assert.equal(u.code, 1, u.out);
  has(u.out, /main must track origin\/main to be released; it tracks nothing/);
  assert.equal(headOf(dir), before, "something was committed");
});

test("release: the JSR test hook can never let a release tag", { timeout: TIMEOUT }, async () => {
  // A fake JSR answering "not published" (404): the release still refuses, because it is fake.
  const dir = releaseClone("release-hook-404");
  const before = headOf(dir);
  const r = await withFakeJsr(json({}, 404), (base) =>
    runAsync([join(dir, "scripts", "publish.ts"), "--no-wait"], {
      cwd: dir,
      env: { ...process.env, S3D_JSR_API: base },
    }),
  );
  assert.equal(r.code, 1, r.out);
  has(r.out, /S3D_JSR_API is set — a release never tags against a test JSR/, /undid the local/);
  hasNot(r.out, /tagging /);
  assert.equal(headOf(dir), before);

  // A non-loopback hook is refused outright, by both scripts.
  const away = { ...process.env, S3D_JSR_API: "https://jsr.example.invalid" };
  const r2 = await runAsync([join(dir, "scripts", "publish.ts"), "--no-wait"], {
    cwd: dir,
    env: away,
  });
  assert.equal(r2.code, 1, r2.out);
  has(r2.out, /is not a loopback address/);
  const r3 = await runAsync([join(ROOT, "scripts", "verify-release.ts"), "9.9.9"], { env: away });
  assert.notEqual(r3.code, 0, r3.out);
  has(r3.out, /is not a loopback address/);
  // A typo in a timing hook is an error, not a zero-length (or NaN) wait.
  const r4 = await runAsync([join(ROOT, "scripts", "verify-release.ts"), "9.9.9"], {
    env: { ...process.env, S3D_JSR_RETRY_MS: "abc" },
  });
  assert.notEqual(r4.code, 0, r4.out);
  has(r4.out, /S3D_JSR_RETRY_MS="abc" is not a positive number/);
});

test("compat: a tagged version is refused unless the release says it is unpublished", () => {
  // The newest tag in this checkout is a released version: a stand-alone gate run must not
  // compare it against the tag before it and call re-releasing it "allowed".
  const tag = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  assert.match(tag, /^v\d+\.\d+\.\d+$/, "no release tag in this checkout");
  const r = run([join(ROOT, "scripts", "compat.ts"), "release", tag.slice(1)]);
  assert.equal(r.code, 1, r.out);
  has(r.out, new RegExp(`${tag.replace(/\./g, "\\.")} already exists`));
});

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
