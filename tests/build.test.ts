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
  linkSync,
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
import { deflateRawSync, inflateRawSync } from "node:zlib";
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
    // "0 failed" while LaTeX survives: the point of the guard. 87, not 97, since 2026-11-06: the
    // fallback (no config) no longer has a bare `$` -- MathJax's own defaults do not either -- so
    // the sample's ten `$…$` expressions stay unrendered too, and the guard counts 270 commands.
    /math:\s+87 expressions, 0 failed/,
    /ERROR: unrendered mathematics reached the baked document/,
    /270 TeX command\(s\)/,
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

test("--help names every environment variable the CLI reads", () => {
  // A setting a user can only learn from an error message is not documented. main.ts's own
  // rt.env("…") reads are the list, so a new one cannot be added without saying so here.
  const vars = [
    ...new Set(
      [...readFileSync(MAIN, "utf8").matchAll(/rt\.env\("([A-Z0-9_]+)"\)/g)]
        .map((m) => m[1])
        .filter((v) => !v.startsWith("S3D_FONT_")), // test hooks, deliberately unadvertised
    ),
  ];
  assert.ok(vars.includes("S3D_CHROME_NO_SANDBOX"), `the scan found ${vars.join(", ")}`);
  const help = run([MAIN, "--help"]);
  assert.equal(help.code, 0, help.out);
  for (const v of vars) assert.ok(help.out.includes(v), `--help does not mention ${v}`);
  // CHROME_PATH is read by the runtime adapter, not main.ts; it is documented all the same.
  assert.ok(help.out.includes("CHROME_PATH"), "--help does not mention CHROME_PATH");
});

test("an unknown flag is rejected", { timeout: TIMEOUT }, () => {
  const r = run([MAIN, "--no-optimise"]);
  assert.equal(r.code, 1, tail(r.out));
  has(r.out, /Unknown option\(s\): --no-optimise/, /Supported: .*--no-optimize/);
  hasNot(r.out, /Compiling/);
});

test("an empty path argument is rejected, not read as the working directory", () => {
  // `s3d-reportcompiler "$DIR" out.pdf` with DIR unset. Run from a folder WITH a report, so the old
  // behaviour (compile what is here) would show as a build.
  const dir = control("control-custom-delimiters", join(work, "empty-arg"));
  for (const args of [
    ["", join(dir, "out", "c.pdf")],
    [dir, " "],
  ]) {
    const r = run([MAIN, ...args], { cwd: dir });
    assert.equal(r.code, 1, tail(r.out));
    has(r.out, /An empty path argument was given/);
    hasNot(r.out, /Compiling/);
  }
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
  {
    timeout: TIMEOUT,
    // Root ignores permissions, so the POSIX lock below cannot hold: SKIPPED, visibly. It used to
    // `return` -- and report a PASS that had tested nothing (2026-11-06 review).
    skip:
      process.platform !== "win32" && process.getuid?.() === 0
        ? "running as root: a read-only folder cannot stop root, so the lock cannot be set up"
        : false,
  },
  async () => {
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
  // This runtime as "Chrome". It does not "reject Chrome's flags" (an earlier comment said so):
  // Bun and Node ignore them, then fail to open the file:// URL given as their entry point, and
  // exit without writing a PDF -- which is the only thing this test needs from it.
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

  // A template without the [mathin] spacer: the scrub still works there, but the field guard read
  // only the spacer layout, saw no row at all, and passed a filled Company with ✓.
  const bare = sanitizerInput("sanitize-nospacer", false);
  edit(bare, /\[mathin\]\\text\{ {2}\}\[mathin\]/g, "");
  edit(bare, /(Company:\s*)<br/, "$1Brightwater Holdings<br");
  const ns = sanitize(bare);
  assert.equal(ns.code, 1, ns.out);
  has(ns.out, /cannot read the project-details layout/);

  // A value with no word of two characters cannot be verified gone at all: refused.
  const single = sanitizerInput("sanitize-single", false);
  edit(single, "]Quentin Vardle<br", "]Q<br");
  const one = sanitize(single);
  assert.equal(one.code, 1, one.out);
  has(one.out, /1 removed value\(s\) too short to verify absent/);

  // Notes split by <br> (client / job number / scope) are scrubbed WHOLE, to the next field row
  // -- a line that merely looks like a label ("Ref: 4471") included. They used to be cut at the
  // first <br>, and the rest passed unseen (group D, 2026-11-06).
  const notes = sanitizerInput("sanitize-notes", false);
  edit(notes, "]Kestrel Brumby<br", "]Kestrel Brumby<br>Ref: QX4471<br>Wharfton warehouse<br");
  const sn = run([join(ROOT, "scripts", "sanitize-report.ts"), "x_report.html"], { cwd: notes });
  assert.equal(sn.code, 0, sn.out);
  const written = readFileSync(
    join(notes, "tests", "HTMLFilesToBeCompiled", "x_report.html"),
    "utf8",
  );
  for (const leak of ["QX4471", "Wharfton", "Kestrel"]) {
    assert.ok(!written.includes(leak), `"${leak}" survived the sanitizer`);
  }
  assert.match(written, /Project Units:/, "the next field went with the notes");
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
    // Planted on EVERY platform, in its own separator: these used to be Windows-only while the
    // "must not survive" checks below ran everywhere, so on Linux CI they passed testing nothing
    // (2026-11-06 review).
    ...(/^[A-Za-z]:/.test(root)
      ? [
          `sibling ${root.replace(/[\\/][^\\/]+$/, "")}-backup\\client-acme\\job.html`,
          // Inside the workspace: <workspace>\…-old\… by design (like <project>\src\…), and
          // never half-matched as <project>-old.
          `sibling2 ${root}-old\\notes.txt`,
        ]
      : [
          `sibling ${root.replace(/\/[^/]+$/, "")}-backup/client-acme/job.html`,
          `sibling2 ${root}-old/notes.txt`,
        ]),
    `slugsib ~/.claude/projects/${slug}-old/x.jsonl`,
    // The same checkout as Git Bash and WSL print it, when it is on a drive letter; on a POSIX
    // checkout, a WSL view of a Windows drive (no checkout of this machine's to translate).
    ...(/^[A-Za-z]:/.test(root)
      ? [
          `bash cd /${root[0].toLowerCase()}${root.slice(2).replace(/\\/g, "/")}/tests`,
          `wsl /mnt/${root[0].toLowerCase()}${root.slice(2).replace(/\\/g, "/")}/main.ts`,
        ]
      : ["wsl /mnt/d/Work/client-acme/main.ts"]),
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

  // Email addresses are redacted (they used to pass as clean): plain, URL-encoded and
  // JSON-escaped; the ones that name no one stay. The address is never echoed.
  writeFileSync(
    file,
    [
      "Author: Kestrel Brumby <kestrel.brumby@brumby-mail.org>",
      "url mailto:kestrel%40brumby-mail.org",
      'json "kestrel\\u0040brumby-mail.org"',
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "remote git@github.com:synapticforge1/S3D-ReportCompiler.git",
      "test@example.invalid and a@b.example",
      "pkg @jrmarcum/s3d-reportcompiler@1.1.7 and actions/checkout@v5",
    ].join("\n"),
  );
  const mail = run([redact, file, "--user=zorblax"]);
  assert.equal(mail.code, 0, mail.out);
  has(mail.out, /emails:\s+3 redacted, 0 left/);
  assert.ok(!mail.out.includes("brumby-mail"), "the address was echoed");
  const mailed = readFileSync(file, "utf8");
  assert.ok(!mailed.includes("brumby-mail"), `an address survived:\n${mailed}`);
  for (const kept of [
    "noreply@anthropic.com",
    "git@github.com",
    "test@example.invalid",
    "a@b.example",
    "@jrmarcum/s3d-reportcompiler@1.1.7",
    "checkout@v5",
  ]) {
    assert.ok(mailed.includes(kept), `"${kept}" was redacted:\n${mailed}`);
  }

  // Any absolute POSIX path, not only home folders, and an HTML-entity "@" (group D, 2026-11-06).
  writeFileSync(
    file,
    [
      "out /srv/clients/acme-steel/job-41/report.html",
      "mac /Volumes/Work/acme-steel/report.html",
      "tmp /tmp/acme-steel-job/out.pdf",
      "entity kestrel&#64;brumby-mail.org",
      "code /^#./.test(v) and https://github.com/synapticforge1/S3D-ReportCompiler/actions stay",
    ].join("\n"),
  );
  const posix = run([redact, file, "--user=zorblax"]);
  assert.equal(posix.code, 0, posix.out);
  const posixText = readFileSync(file, "utf8");
  for (const leak of ["acme-steel", "/srv/", "/Volumes/", "/tmp/", "brumby-mail"]) {
    assert.ok(!posixText.includes(leak), `"${leak}" survived:\n${posixText}`);
  }
  assert.ok(
    posixText.includes("/^#./.test(v)"),
    `a regex literal was redacted as a path:\n${posixText}`,
  );
  assert.ok(
    posixText.includes("https://github.com/synapticforge1/S3D-ReportCompiler/actions"),
    posixText,
  );

  // The residue check looks WIDER than the redaction: a spelling no rule redacts fails the run,
  // without echoing it. (It used to re-apply the redaction's own pattern: 0 by construction.)
  writeFileSync(file, "contact kestrel (at) brumby-mail.org\n");
  const loose = run([redact, file, "--user=zorblax"]);
  assert.equal(loose.code, 1, loose.out);
  has(loose.out, /emails:\s+0 redacted, 1 left/, /not safe to publish/);
  assert.ok(!loose.out.includes("brumby-mail"), "the residue was echoed");
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
      '<html><head><style>body.dark p{color:red} body.light p{color:blue} body:hover{x:y} body:has(p){z:1}</style></head><body class="x dark"><p>t</p></body></html>',
      ".rs9",
      "r9-",
    ),
  );
  assert.match(qualified, /\.rs9 p \{color:red\}/, "the matching qualifier was not settled");
  assert.doesNotMatch(qualified, /light|blue/, "a rule its source never applied survived");
  //    A printed page is never hovered: `body:hover` holds for no source and is dropped (it used to
  //    stay on the wrapper). `:has()` depends on content, which the wrapper holds: it stays.
  assert.doesNotMatch(qualified, /hover|x:y/, "a state a printed page never has was kept");
  assert.match(qualified, /\.rs9:has\(p\) \{z:1\}/, ":has() did not stay on the wrapper");
  //    Attribute qualifiers are settled too, and read whole: the `~` inside `[class~=…]` is not
  //    a sibling combinator (the rule used to be dropped), and `html[lang=en]` is decided by the
  //    source's <html> (it used to land on the wrapper, which has no lang, and match nothing).
  const attrQualified = flat(
    core.bakeStyle(
      '<html lang="en-GB"><head><style>' +
        'body[class~="dark"] p{a:1} html[lang|=en] q{b:2} html[lang=fr] s{c:3} ' +
        "body[data-x] u{d:4} body.dark:not(.y) i{e:5} " +
        // As Chrome compares: lang's value is caseless, unless `s`; class's never is.
        'html[lang=EN-gb] b{f:6} html[lang="EN-GB" s] em{g:7} body[class="X DARK"] a{h:8}' +
        '</style></head><body class="x dark"><p>t</p></body></html>',
      ".rs9",
      "r9-",
    ),
  );
  assert.match(attrQualified, /\.rs9 p \{a:1\}/, "[class~=…] was not settled");
  assert.match(attrQualified, /\.rs9 q \{b:2\}/, "[lang|=en] was not settled");
  assert.doesNotMatch(attrQualified, /c:3|d:4/, "a rule its source never applied survived");
  //    `:not(.y)` is decided against the source <body> too (it has no `y`): it holds, and leaves
  //    nothing on the wrapper (it used to stay there, judged against the wrong element).
  assert.match(attrQualified, /\.rs9 i \{e:5\}/, "a pseudo-class after a class");
  assert.match(attrQualified, /\.rs9 b \{f:6\}/, "[lang=EN-gb] is caseless in HTML, as in Chrome");
  assert.doesNotMatch(attrQualified, /g:7|h:8/, "the s flag, or class, compared without case");

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
  //    Confined inside :where(), which weighs nothing: each rule keeps the specificity it had.
  //    Prefixed plainly (`svg[data-s3d-scope] text`), a diagram's bare `text` rule began to beat
  //    the report's own `.rs0 svg text` it used to lose to -- measured in Chrome, 2026-11-06.
  assert.match(
    media,
    /@media screen \{ :where\(svg\[data-s3d-scope="r9-"\]\) text \{ fill: gray \} \}/,
  );
  const font = svg("text { font: 12px Arial } svg { opacity: .5 } #t { fill: red }");
  assert.doesNotMatch(font, /<text[^>]* font=/, "a CSS-only property became an attribute");
  assert.match(font, /:where\(svg\[data-s3d-scope="r9-"\]\) text \{ font: 12px Arial \}/);
  //    A rule on `svg` itself is that <svg>, and keeps its type selector's weight.
  assert.match(
    font,
    /svg:where\(\[data-s3d-scope="r9-"\]\) \{ opacity: \.5 \}/,
    "`svg` is not the root",
  );
  assert.match(
    font,
    /:where\(svg\[data-s3d-scope="r9-"\]\) #r9-t \{ fill: red \}/,
    "an id not renamed",
  );
  assert.doesNotMatch(font, /[^(]svg\[data-s3d-scope/, "a selector carries the scope's weight");

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

test("a second batch starts clean, and the reference guard is the core's", async () => {
  // A FRESH process: the counters under test are module-level, and other tests here bake too.
  const probe = join(work, "state-probe.mjs");
  const coreUrl = pathToFileURL(join(ROOT, "src", "report_core.ts")).href;
  const config =
    "<script type=\"text/x-mathjax-config\">MathJax.Hub.Config({tex2jax:{inlineMath:[['[mathin]','[mathin]']],displayMath:[['[math]','[math]']]}});</script>";
  writeFileSync(
    probe,
    [
      `import * as core from ${JSON.stringify(coreUrl)};`,
      // Batch 1: a config declaring `$` (the fallback no longer does) and one bad expression.
      `core.bakeBody(${JSON.stringify(`<html><head><script type="text/x-mathjax-config">MathJax.Hub.Config({tex2jax:{inlineMath:[['$','$']]}});</script></head><body>$\\frac{1}{$</body></html>`)}, "r0-");`,
      `const before = core.mathStats.failed;`,
      `const batch2 = () => core.bakeBody(${JSON.stringify(`<html><head>${config}</head><body>Cost: $5 per bolt. [mathin]x^2[mathin]</body></html>`)}, "r0-");`,
      `const inherited = { failed: core.mathStats.failed, leftovers: core.findLeftoverMath(batch2()) };`,
      `core.resetBakeState();`,
      `const clean = { failed: core.mathStats.failed, leftovers: core.findLeftoverMath(batch2()), converted: core.mathStats.converted,`,
      `  sets: core.delimSignatures.size + core.skippedDelims.size + core.svgStyleWarnings.size, audit: Object.values(core.audit).reduce((a, b) => a + b, 0) };`,
      `console.log(JSON.stringify({ before, inherited, clean }));`,
      "",
    ].join("\n"),
  );
  const p = run([probe]);
  assert.equal(p.code, 0, p.out);
  const { before, inherited, clean } = JSON.parse(p.out.trim().split("\n").pop() ?? "{}");
  assert.equal(before, 1, "batch 1 should have one failure");
  // Without the reset, the clean batch is refused for the earlier batch's state (measured).
  assert.equal(inherited.failed, 1);
  assert.deepEqual(inherited.leftovers, ['1 x "$"']);
  // After it, the same batch is clean: no failure carried over, no "$" it never declared.
  assert.equal(clean.failed, 0);
  assert.deepEqual(clean.leftovers, []);
  assert.equal(clean.converted, 1, "the counters restart from zero");
  assert.equal(clean.audit, 0, "an audit counter survived the reset");
  assert.equal(clean.sets, 1, "only batch 2's own delimiter signature remains");

  // The reference guard, now exported. A correct bake: nothing broken.
  const core = await import(coreUrl);
  const src =
    '<html><body><svg><defs><linearGradient id="g"></linearGradient></defs>' +
    '<rect fill="url(#g)"/><use href="#gone"/></svg></body></html>';
  const ok = core.findBrokenReferences([
    {
      source: src,
      style: core.bakeStyle(src, ".rs0", "r0-"),
      body: core.bakeBody(src, "r0-"),
      prefix: "r0-",
    },
  ]);
  // #gone dangles in the source already: excused under its prefix, not counted as broken.
  assert.deepEqual(ok, { references: 2, unresolved: 1, broken: [] });
  // A bake whose sheet still names the old id: broken, named by report and target.
  const bad = core.findBrokenReferences([
    {
      source: src,
      style: ".rs0 rect { fill: url(#g) }",
      body: core.bakeBody(src, "r0-"),
      prefix: "r0-",
    },
  ]);
  assert.deepEqual(bad.broken, [{ report: 0, target: "g" }]);
  // Per report: report 0's dangling #grad does not excuse report 1's broken #grad.
  const two = core.findBrokenReferences([
    { source: '<a href="#grad"></a>', style: "", body: '<a href="#r0-grad"></a>', prefix: "r0-" },
    {
      source: '<g id="grad"></g><a href="#grad"></a>',
      style: "",
      body: '<g id="r1-grad"></g><a href="#grad"></a>',
      prefix: "r1-",
    },
  ]);
  assert.deepEqual(two.broken, [{ report: 1, target: "grad" }]);
});

test("full review, group A: no wrong content passes -- maths, body, tags, CSS, labels", async () => {
  const core = await import(pathToFileURL(join(ROOT, "src", "report_core.ts")).href);
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const cfg = (inline: string, display = "") =>
    `<script type="text/x-mathjax-config">MathJax.Hub.Config({tex2jax:{${inline}${display}}});</script>`;
  const page = (head: string, body: string) =>
    `<html><head>${head}</head><body>${body}</body></html>`;

  // A1. Maths can no longer pass as prose.
  //  - The config read in every JavaScript spelling: quoted keys, \u / \x escapes.
  core.resetBakeState();
  const quoted = `<script>MathJax.Hub.Config({"tex2jax":{"inlineMath":[["\\\\(","\\\\)"]]}});</script>`;
  assert.deepEqual(
    core.parseDelimiters(page(quoted, "")).map((d: { open: string }) => d.open),
    ["\\("],
  );
  assert.deepEqual(
    core
      .parseDelimiters(page(cfg("inlineMath:[['\\u0024','\\x24']]"), ""))
      .map((d: { open: string }) => d.open),
    ["$"],
  );
  //  - A config whose every pair is refused uses NO delimiters, not the fallback: prose stays prose.
  core.resetBakeState();
  const refused = cfg("inlineMath:[['\\(','\\)']],", "displayMath:[['\\[','\\]']]");
  assert.deepEqual(core.parseDelimiters(page(refused, "")), []);
  const prose = core.bakeBody(page(refused, "<p>Cost $5 per bolt, total $10 each</p>"), "r0-");
  assert.ok(prose.includes("Cost $5 per bolt, total $10 each"), "prose was typeset as maths");
  //  - The fallback has no bare $, so a report with no config keeps its costs as prose too.
  assert.ok(!core.FALLBACK_DELIMS.some((d: { open: string }) => d.open === "$"));
  //  - The guard looks for every standard delimiter, declared or not, and for failures.
  core.resetBakeState();
  const unread = core.bakeBody(page(refused, "<p>\\(a+b=12.5\\)</p>"), "r0-");
  assert.ok(
    core.findLeftoverMath(unread).some((l: string) => l.includes('"\\("')),
    "\\( passed the guard",
  );
  core.resetBakeState();
  const failed = core.bakeBody(
    page(cfg("inlineMath:[['[mathin]','[mathin]']]"), "[mathin]x^^2[mathin]"),
    "r0-",
  );
  assert.ok(
    core.findLeftoverMath(failed).some((l: string) => /failed to typeset/.test(l)),
    "a failure with no TeX command passed the guard",
  );
  //  - And the PDF check does too.
  const pdfObs = {
    text: "the result \\(a+b\\) here",
    pages: 1,
    imagePaints: 0,
    diagramTitlePages: [],
    diagramAxisPages: [],
    headingPages: [1],
    blankPages: [],
  };
  assert.ok(
    core.compareAgainstPdf({ words: new Set(), numbers: new Set(), expectedImages: 0 }, pdfObs, 1)
      .leftoverLatex.length > 0,
    "\\( in the PDF text passed",
  );

  // A3. Text after </body> (or before <body>) is the reader's: in the bake AND the verification.
  core.resetBakeState();
  const tail = "<html><head></head>Before 41.5<body><p>Kept 12.5</p></body><p>Lost 99.9</p></html>";
  const tailBody = core.bakeBody(tail, "r0-");
  assert.ok(
    tailBody.includes("99.9") && tailBody.includes("41.5"),
    "the bake dropped text outside <body>",
  );
  const tokens = core.extractSourceTokens([tail]);
  assert.ok(
    tokens.numbers.has("99.9") && tokens.numbers.has("41.5"),
    "the verification dropped it too",
  );

  // A4. Tags are read quote-aware: a ">" inside a value no longer hides what follows it.
  core.resetBakeState();
  const gt = core.bakeBody(
    page(
      "",
      '<svg><linearGradient title="ratio > 1" id="g"></linearGradient>' +
        '<rect title="a > b" onclick="void 0" fill="url(#g)"/><use title="x > y" href="#g"/>' +
        '<meta title="p > q" http-equiv="refresh"></svg>',
    ),
    "r0-",
  );
  assert.match(gt, /id="r0-g"/, "an id after a quoted > was not renamed");
  assert.match(gt, /href="#r0-g"/, "an href after a quoted > was not renamed");
  assert.doesNotMatch(gt, /onclick|<meta/, "a handler or <meta> after a quoted > survived");
  const brokenSrc =
    '<svg><linearGradient id="g"></linearGradient><use title="a > b" href="#g"/></svg>';
  const broken = core.findBrokenReferences([
    {
      source: brokenSrc,
      style: "",
      body: '<svg><linearGradient id="r0-g"></linearGradient><use title="a > b" href="#g"/></svg>',
      prefix: "r0-",
    },
  ]);
  assert.deepEqual(
    broken.broken,
    [{ report: 0, target: "g" }],
    "the guard missed a reference after a quoted >",
  );
  // An \eqref href is percent-encoded; the guard decodes it as a browser does.
  assert.deepEqual(
    core.findBrokenReferences([
      {
        source: "",
        style: "",
        body: '<mjx-x id="r0-mjx-eqn:t1"></mjx-x><a href="#r0-mjx-eqn%3At1">(1)</a>',
        prefix: "r0-",
      },
    ]).broken,
    [],
    "a correct \\eqref was called broken",
  );

  // A5. CSS keeps applying exactly where it applied.
  const scoped = (
    css: string,
    html = '<html lang="en"><head></head><body class="dark"></body></html>',
  ) => {
    core.resetBakeState();
    return flat(
      core.bakeStyle(html.replace("</head>", `<style>${css}</style></head>`), ".rs0", "r0-"),
    );
  };
  assert.match(
    scoped('rect[fill="#ffcc00"]{a:1}'),
    /\[fill="#ffcc00"\]/,
    "a hex colour was renamed as an id",
  );
  assert.match(
    scoped('[id="x"]{a:1} a[href^="#top"]{b:2}'),
    /\[id="r0-x"\].*\[href\^="#r0-top"\]/,
    "id-valued attributes not renamed",
  );
  assert.equal(scoped("html > p {a:1}"), "", "html > p reached the report's top-level elements");
  assert.equal(scoped("body:not(.dark) p {a:1}"), "", ":not was judged against the wrapper");
  assert.match(scoped("body:not(.light) p {a:1}"), /^\.rs0 p \{a:1\}$/);
  assert.equal(
    scoped("body:first-child p {a:1} body:hover p {b:2}"),
    "",
    "structural / dynamic states",
  );
  assert.match(
    scoped("html:lang(en) p {a:1} body:nth-child(2) q {b:2}"),
    /\.rs0 p \{a:1\}.*\.rs0 q \{b:2\}/,
  );
  assert.match(
    scoped("@scope (.card) { p {a:1} }"),
    /^@scope \(\.rs0 \.card\) \{ p \{a:1\} \}$/,
    "@scope was not scoped",
  );
  assert.match(scoped("@starting-style { p {a:1} }"), /^@starting-style \{ \.rs0 p \{a:1\} \}$/);
  const unknown = scoped("@document url-prefix() { p {a:1} } q {b:2}");
  assert.equal(unknown, ".rs0 q {b:2}", "an unknown at-rule passed through unscoped");
  assert.ok(
    [...core.cssWarnings].some((w: string) => w.startsWith("@document")),
    "the dropped at-rule was not named",
  );
  assert.equal(core.bakeRemovals.atRules, 1, "the dropped at-rule was not counted");

  // A6. Equation labels are per report, and reset per batch.
  core.resetBakeState();
  const label = page(
    cfg("inlineMath:[['[mathin]','[mathin]']],", "displayMath:[['[math]','[math]']]"),
    "[math]x=1 \\label{eq}\\tag{1}[math]",
  );
  core.bakeBody(label, "r0-");
  core.bakeBody(label, "r1-");
  assert.equal(core.mathStats.failed, 0, "the same \\label in two reports failed");
  core.resetBakeState();
  core.bakeBody(label, "r0-");
  assert.equal(core.mathStats.failed, 0, "a \\label failed after a reset");

  // Every removal is counted.
  core.resetBakeState();
  core.bakeBody(page("", '<meta charset="x"><p onclick="void 0">x</p><style>p{}</style>'), "r0-");
  core.bakeStyle(page("<style>@import url(x.css); p{}</style>", ""), ".rs0", "r0-");
  assert.deepEqual(
    { ...core.bakeRemovals },
    {
      activeAttributes: 1,
      metaBaseTags: 1,
      blocklessAtRules: 1,
      atRules: 0,
      bodySheetsMoved: 1,
      noscript: 0,
    },
  );
});

test(
  "full review, group A: linked and odd report entries are never dropped",
  { timeout: TIMEOUT },
  () => {
    const input = control("control-custom-delimiters", join(work, "links"));
    const elsewhere = join(work, "links-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    // A report that is a symbolic link: compiled, not dropped (it was: 12 of 13, PASS).
    writeFileSync(join(elsewhere, "e_report.html"), readFileSync(join(input, "d_report.html")));
    symlinkSync(join(elsewhere, "e_report.html"), join(input, "e_report.html"), "file");
    const r = run([MAIN, input, join(work, "links-out", "c.pdf")]);
    assert.equal(r.code, 0, tail(r.out));
    has(r.out, /Compiling 2 report\(s\)/, /per-report: 2\/2/);

    // A broken link or a folder named *.html: refused, named.
    const odd = control("control-custom-delimiters", join(work, "links-odd"));
    symlinkSync(join(elsewhere, "missing.html"), join(odd, "gone_report.html"), "file");
    mkdirSync(join(odd, "folder_report.html"));
    const o = run([MAIN, odd, join(work, "links-odd-out", "c.pdf")]);
    assert.equal(o.code, 1, tail(o.out));
    has(o.out, /Not a readable report file/, /gone_report\.html/, /folder_report\.html/);
    hasNot(o.out, /Compiling/);

    // An output that is a HARD link to a report: refused (realpath cannot see it).
    const hl = control("control-custom-delimiters", join(work, "links-hard"));
    const outDir = join(work, "links-hard-out");
    mkdirSync(outDir, { recursive: true });
    linkSync(join(hl, "d_report.html"), join(outDir, "x.html"));
    const original = readFileSync(join(hl, "d_report.html"), "utf8");
    const h = run([MAIN, hl, join(outDir, "x.pdf")]);
    assert.equal(h.code, 1, tail(h.out));
    has(h.out, /The output would overwrite a source report/);
    assert.equal(
      readFileSync(join(hl, "d_report.html"), "utf8"),
      original,
      "the report was overwritten",
    );
  },
);

test("full review, group C: a build says what happened", { timeout: TIMEOUT }, async () => {
  const input = control("control-custom-delimiters", join(work, "c-input"));
  const out = (name: string) => join(work, name, "c.pdf");

  // A setting that is set but cannot be honoured stops the build, named, before anything runs.
  for (const [env, why] of [
    [{ CHROME_PATH: join(work, "no-such-chrome.exe") }, /CHROME_PATH names no file/],
    [{ S3D_CHROME_NO_SANDBOX: "maybe" }, /S3D_CHROME_NO_SANDBOX="maybe" is not/],
    [{ S3D_CHROME_TIMEOUT_MS: "soon" }, /S3D_CHROME_TIMEOUT_MS="soon" is not a positive/],
  ] as const) {
    const r = run([MAIN, input, out("c-settings")], { env: { ...process.env, ...env } });
    assert.equal(r.code, 1, tail(r.out));
    has(r.out, why);
    hasNot(r.out, /Compiling/);
  }

  // A folder as the output: refused up front, not a Chrome stack trace and a stray .html.
  const folder = join(work, "c-folder-out");
  mkdirSync(folder, { recursive: true });
  const f = run([MAIN, input, folder]);
  assert.equal(f.code, 1, tail(f.out));
  has(f.out, /The output is a folder, not a PDF file/);
  assert.ok(!existsSync(`${folder}.html`), "a stray .html was left beside the folder");

  // A failed verification: the PDF is NOT given its final name, and --no-keep-html keeps the HTML.
  const hidden = control("control-hidden-content", join(work, "c-hidden"));
  const pdf = out("c-failed");
  const v = run([MAIN, hidden, pdf, "--no-keep-html"]);
  assert.equal(v.code, 1, tail(v.out));
  has(v.out, /VERIFICATION FAILED/, /NOT given its/);
  hasNot(v.out, /^Created /m);
  assert.ok(!existsSync(pdf), "an unverified PDF sat under the final name");
  assert.ok(
    existsSync(pdf.replace(/\.pdf$/, ".unverified.pdf")),
    "the unverified PDF was not kept",
  );
  assert.ok(
    existsSync(pdf.replace(/\.pdf$/, ".html")),
    "--no-keep-html deleted the HTML of a failed build",
  );

  // A good build: the final name, and only it.
  const goodPdf = out("c-good");
  const g = run([MAIN, input, goodPdf]);
  assert.equal(g.code, 0, tail(g.out));
  assert.ok(existsSync(goodPdf) && !existsSync(goodPdf.replace(/\.pdf$/, ".unverified.pdf")));

  // The wall-clock bound kills a process that outlives it (Chrome's budget bounds only the page).
  const rt = await import(pathToFileURL(join(ROOT, "src", "report_runtime.ts")).href);
  const t0 = Date.now();
  const slow = await rt.runWithTimeout(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60000)"],
    500,
  );
  assert.equal(slow.timedOut, true, "the process was not stopped");
  assert.ok(Date.now() - t0 < 20_000, `it took ${Date.now() - t0} ms to stop`);
});

test("the bake carries no event handlers or javascript: URLs", async () => {
  // A report is user-supplied HTML; the render must not execute anything from it (#55).
  const core = await import(pathToFileURL(join(ROOT, "src", "report_core.ts")).href);
  const out: string = core.bakeBody(
    '<html><body><p onclick="void 0" title="onclick=text">x</p>' +
      '<a href=" javascript:void 0">y</a><a href="#ok">z</a><g id="ok"></g></body></html>',
    "r9-",
  );
  assert.doesNotMatch(out, /<p[^>]*\sonclick=/i, "an event-handler attribute survived");
  assert.ok(out.includes('title="onclick=text"'), "another attribute's text was touched");
  assert.ok(out.includes('href="#"'), "a javascript: URL survived");
  assert.ok(out.includes('href="#r9-ok"'), "an ordinary link was changed");
  // And the assembled document forbids scripting AND outside loads itself, whatever the bake might
  // miss: images and fonts from embedded data only (plus MathJax's font origin, for the browser).
  const csp =
    /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(
      core.assembleDocument([out], [""], ""),
    )?.[1] ?? "";
  for (const directive of [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "img-src data:",
    // MathJax's font folder only, not the whole jsDelivr host (group E, 2026-11-06).
    "font-src data: https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/output/chtml/fonts/woff-v2/",
    "style-src 'unsafe-inline'",
  ]) {
    assert.ok(csp.split(/;\s*/).includes(directive), `the policy lacks "${directive}": ${csp}`);
  }
  // <meta http-equiv> (a refresh navigates; no policy stops it) and <base> leave a report's body.
  const headless: string = core.bakeBody(
    '<html><body><meta http-equiv="refresh" content="0"><base href="https://example.invalid/"><p>kept</p></body></html>',
    "r9-",
  );
  assert.doesNotMatch(headless, /<meta|<base/i, "a <meta> or <base> survived in the body");
  assert.ok(headless.includes("<p>kept</p>"), "content went with it");
});

test("the render loads nothing from another host", { timeout: TIMEOUT }, async () => {
  // A report pointing at a counting server on 127.0.0.1 in six spellings. The document's policy
  // must block every load (0 requests), and the build must count all six, not 1 of them.
  let hits = 0;
  const counting: Handler = (_req, res) => {
    hits++;
    res.writeHead(404);
    res.end();
  };
  const r = await withFakeJsr(counting, (origin) => {
    const src = readFileSync(join(SAMPLES, "member_0_report.html"), "utf8");
    // alt="": a broken <img> otherwise draws Chrome's broken-image icon, which counts as an
    // image paint (blocked and 404 alike) and fails the build for a reason this test is not about.
    const refs =
      `<img alt="" src="${origin}/a.png"><img alt="" src='${origin}/b.png'>` +
      `<img alt="" src=${origin}/c.png><img alt="" srcset="${origin}/d.png 2x">` +
      `<p style="background:url(${origin}/e.png)">ref</p>`;
    let v = src.replace(/<body([^>]*)>/i, (m) => `${m}${refs}`);
    v = v.replace("</head>", `<style>.x{background:url("${origin}/f.png")}</style></head>`);
    assert.notEqual(v, src, "could not plant the references");
    const dir = join(work, "external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x_report.html"), v);
    return runAsync([MAIN, dir, join(dir, "out", "c.pdf")], { env: process.env });
  });
  assert.equal(r.code, 0, r.out);
  has(r.out, /baked HTML still has 0 script\(s\) and 6 external ref\(s\)/, /PASS/);
  assert.equal(hits, 0, `the render made ${hits} request(s) to another host`);
});

test(
  "maths fonts: cached per MathJax version, adopted once, kept only if they are fonts",
  {
    timeout: TIMEOUT,
  },
  async () => {
    // The real fonts, wherever this checkout's cache holds them (flat before 2026-11-06, a version
    // folder after). Seeded by one sample build if the cache is empty.
    const fontsRoot = join(ROOT, ".mathjax-fonts");
    const fontFiles = () => {
      if (!existsSync(fontsRoot)) return [] as string[];
      const out: string[] = [];
      for (const e of readdirSync(fontsRoot, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(".woff")) out.push(join(fontsRoot, e.name));
        if (e.isDirectory()) {
          for (const f of readdirSync(join(fontsRoot, e.name))) {
            if (f.endsWith(".woff")) out.push(join(fontsRoot, e.name, f));
          }
        }
      }
      return out;
    };
    if (fontFiles().length === 0) run([MAIN, SAMPLES, join(work, "fonts-seed", "c.pdf")]);
    const real = new Map(fontFiles().map((p) => [p.replace(/^.*[\\/]/, ""), p]));
    assert.ok(real.size > 0, "no cached fonts to serve");
    const serveReal: Handler = (req, res) => {
      const p = real.get(decodeURIComponent((req.url ?? "").replace(/^.*\//, "")));
      if (!p) return json({}, 404)(req, res);
      res.writeHead(200, { "content-type": "font/woff" });
      res.end(readFileSync(p));
    };
    const input = control("control-custom-delimiters", join(work, "fonts-in"));
    const buildIn = (name: string, origin: string) => {
      const cwd = join(work, name);
      mkdirSync(cwd, { recursive: true });
      return runAsync([MAIN, input, join(cwd, "out", "c.pdf")], {
        cwd,
        env: { ...process.env, S3D_FONT_ORIGIN: origin },
      }).then((r) => ({ ...r, cwd }));
    };
    const versioned = (cwd: string) => {
      const root = join(cwd, ".mathjax-fonts");
      if (!existsSync(root)) return { dirs: [] as string[], flat: [] as string[] };
      const all = readdirSync(root, { withFileTypes: true });
      return {
        dirs: all.filter((e) => e.isDirectory()).map((e) => e.name),
        flat: all.filter((e) => e.isFile()).map((e) => e.name),
      };
    };

    // 1. A fresh folder: fetched, kept under a folder that names the MathJax version.
    const fresh = await withFakeJsr(serveReal, (o) => buildIn("fonts-fresh", o));
    assert.equal(fresh.code, 0, fresh.out);
    has(fresh.out, /PASS/);
    const v = versioned(fresh.cwd);
    assert.deepEqual(v.flat, [], "a font was cached flat, without its version");
    assert.ok(v.dirs.length === 1 && /mathjax@3\.2\.2/.test(v.dirs[0]), `cache folders: ${v.dirs}`);
    //    Bytes from the test hook are kept apart from the real cache (group C).
    assert.ok(
      v.dirs[0].startsWith("test-hook_"),
      `the hook's fonts went into the real cache: ${v.dirs}`,
    );

    // 2. A 200 that is not a font (a captive portal's page): refused, nothing cached.
    const portal: Handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>Please sign in to the network</body></html>");
    };
    const p = await withFakeJsr(portal, (o) => buildIn("fonts-portal", o));
    assert.equal(p.code, 1, p.out);
    has(p.out, /the maths fonts could not be loaded/, /did not return a font \(text\/html/);
    assert.ok(
      versioned(p.cwd).dirs.every(
        (d) => readdirSync(join(p.cwd, ".mathjax-fonts", d)).length === 0,
      ),
      "a page was cached as a font",
    );

    // 3. An earlier release's FLAT cache is adopted -- the server fails, so nothing may be fetched.
    const adoptCwd = join(work, "fonts-adopt");
    mkdirSync(join(adoptCwd, ".mathjax-fonts"), { recursive: true });
    for (const [n, path] of real)
      writeFileSync(join(adoptCwd, ".mathjax-fonts", n), readFileSync(path));
    const a = await withFakeJsr(json({}, 500), (o) => buildIn("fonts-adopt", o));
    assert.equal(a.code, 0, a.out);
    assert.deepEqual(
      versioned(adoptCwd).flat,
      [],
      "the flat files were not moved into the version folder",
    );

    // 2b. A download cut short still starts `wOFF`: refused by its header's recorded length.
    const truncated: Handler = (req, res) => {
      const p = real.get(decodeURIComponent((req.url ?? "").replace(/^.*\//, "")));
      if (!p) return json({}, 404)(req, res);
      const bytes = readFileSync(p);
      res.writeHead(200, { "content-type": "font/woff" });
      res.end(bytes.subarray(0, bytes.length >> 1));
    };
    const cut = await withFakeJsr(truncated, (o) => buildIn("fonts-cut", o));
    assert.equal(cut.code, 1, cut.out);
    has(cut.out, /did not return a font \(font\/woff, \d+ bytes\)/);

    // 4. A cached file that is not a font is fetched again, not embedded.
    const dir = join(adoptCwd, ".mathjax-fonts", versioned(adoptCwd).dirs[0]);
    const victim = readdirSync(dir)[0];
    writeFileSync(join(dir, victim), "not a font");
    const r = await withFakeJsr(serveReal, (o) => buildIn("fonts-adopt", o));
    assert.equal(r.code, 0, r.out);
    assert.equal(
      readFileSync(join(dir, victim)).subarray(0, 4).toString(),
      "wOFF",
      "not re-fetched",
    );
  },
);

test("the verification does not expect TeX settings in the PDF, only what prints", async () => {
  // Found by the first real SkyCiv zip (2026-11-06): `\color{blue}{\text{ NONCOMPACT}}` made
  // "blue" missing from a correct PDF. Each member of the class, and each printed argument kept.
  const core = await import(pathToFileURL(join(ROOT, "src", "report_core.ts")).href);
  const tex = [
    String.raw`\rightarrow\color{blue}{\text{ NONCOMPACT}}`,
    String.raw`\color[rgb]{0.25,0.75,1}{\text{shaded}}`,
    String.raw`\textcolor{crimson}{\text{flagged}}`,
    String.raw`\colorbox{yellow}{\text{boxed}}`,
    String.raw`\fcolorbox{magenta}{orange}{\text{framed}}`,
    String.raw`\hspace{17em} \hspace*{19pt} \mspace{23mu} \kern29pt \mkern 31mu \raise 37pt\hbox{lifted}`,
    String.raw`\rule[41pt]{43pt}{47pt} \raisebox{53pt}{\text{raised}}`,
    String.raw`a \\[59pt] b \\ [kept]`,
    String.raw`\phantom{invisible} \hphantom{6100} \vphantom{ghost}`,
    String.raw`\label{eqlabel} \require{cancel} \style{font-weight:bold}{\text{styled}}`,
    String.raw`\class{marker}{\text{classed}} \cssId{anchor}{\text{identified}}`,
    String.raw`\unicode[Arial]{8710} \enclose{circle}[mathcolor="teal"]{\text{circled}}`,
    String.raw`\bbox[violet,5px]{\text{bboxed}} \href{https://example.org/xyz}{\text{linked}}`,
    String.raw`\begin{array}{clr} 67 \end{array} \begin{aligned} 71 \end{aligned}`,
  ].join(" ");
  const tokens = core.extractSourceTokens([`<body>[math]${tex}[math] 2.5</body>`]);
  for (const gone of [
    "blue",
    "rgb",
    "crimson",
    "yellow",
    "magenta",
    "orange",
    "invisible",
    "ghost",
    "eqlabel",
    "cancel",
    "font",
    "weight",
    "bold",
    "marker",
    "anchor",
    "arial",
    "circle",
    "mathcolor",
    "teal",
    "violet",
    "https",
    "example",
    "xyz",
    "array",
    "clr",
    "aligned",
  ]) {
    assert.ok(!tokens.words.has(gone), `"${gone}" is a setting, but is expected in the PDF`);
  }
  for (const gone of [
    "0.25",
    "0.75",
    "17",
    "19",
    "23",
    "29",
    "31",
    "37",
    "41",
    "43",
    "47",
    "53",
    "59",
    "6100",
    "8710",
  ]) {
    assert.ok(!tokens.numbers.has(gone), `${gone} is a setting, but is expected in the PDF`);
  }
  for (const kept of [
    "noncompact",
    "shaded",
    "flagged",
    "boxed",
    "framed",
    "lifted",
    "raised",
    "kept",
    "styled",
    "classed",
    "identified",
    "circled",
    "bboxed",
    "linked",
  ]) {
    assert.ok(tokens.words.has(kept), `"${kept}" prints, but is no longer checked`);
  }
  for (const kept of ["67", "71", "2.5"]) assert.ok(tokens.numbers.has(kept), `${kept} prints`);
});

test("review 2, group A: the bake and the verification read markup as a browser does", async () => {
  const core = await import(pathToFileURL(join(ROOT, "src", "report_core.ts")).href);
  const cfg = `<script>MathJax={tex2jax:{inlineMath:[['[mathin]','[mathin]']]}}</script>`;
  const doc = (body: string, head = "") =>
    `<html><head>${cfg}${head}</head><body>${body}</body></html>`;
  const bake = (src: string) => {
    core.resetBakeState();
    const body: string = core.bakeBody(src, "r0-");
    const style: string = core.bakeStyle(src, ".rs0", "r0-");
    return { body, style, guard: core.findLeftoverMath(body) as string[] };
  };
  const expects = (src: string) => core.extractSourceTokens([src]);

  // Maths pairs within one text run, as MathJax does: two strays across cells are NOT one
  // expression (it typeset the cells between, tags and values), and the guard refuses them.
  const cells = bake(
    doc("<table><tr><td>a [mathin] b</td><td>Pn = 1234.5</td><td>[mathin] c</td></tr></table>"),
  );
  assert.ok(cells.body.includes("<td>Pn = 1234.5</td>"), "cells typeset as one expression");
  assert.ok(cells.guard.length > 0, "stray delimiters passed the guard");
  // ...never inside an attribute (it broke the tag open into the page)...
  const attr = bake(doc(`<span title="[mathin]x[mathin]">t</span>`));
  assert.ok(attr.body.includes(`title="[mathin]x[mathin]"`), "maths typeset inside an attribute");
  // ...nor in pre / code; but across a <br>, which MathJax reads as a newline, not as "<br>".
  assert.ok(!bake(doc("<pre>[mathin]x[mathin]</pre>")).body.includes("mjx-container"));
  const br = bake(doc("<p>[mathin]a<br>b[mathin]</p>"));
  assert.equal(br.guard.length, 0, br.guard.join("; "));
  assert.ok(!/mjx-c3C/.test(br.body), `"<br>" was typeset as a "<" relation`);
  // `<L_p` in maths reads as a tag to a browser and to the verifier: the bake must not typeset
  // across it either, or the verifier skips what it covers. Refused, loudly.
  assert.ok(bake(doc("<p>[mathin]L_b<L_p[mathin] so 55.5 and <b>66.6</b></p>")).guard.length > 0);

  // Comments and scripts end where the HTML parser ends them, in the bake AND the verification.
  for (const [what, src, kept] of [
    ["<!-->", doc("<!--><p>Moment 321.5</p><!-- x -->"), "321.5"],
    ["<!--->", doc("<!---><p>Moment 321.6</p><!-- x -->"), "321.6"],
    ["</script >", doc("<script>x</script ><p>Shear 77.7</p><script>y</script>"), "77.7"],
  ] as const) {
    assert.ok(bake(src).body.includes(kept), `${what}: the bake dropped the text after it`);
    assert.ok(expects(src).numbers.has(kept), `${what}: the verification does not expect it`);
  }
  // <noscript> is not drawn (scripting is on; the policy only blocks scripts): neither printed
  // nor expected.
  const ns = doc("<noscript>Enable JavaScript 999.1</noscript><p>x</p>");
  assert.ok(!bake(ns).body.includes("999.1"), "<noscript> left in the bake");
  assert.equal(core.bakeRemovals.noscript, 1);
  assert.ok(!expects(ns).numbers.has("999.1"), "<noscript> text expected in the PDF");

  // The spinner goes only while it holds no text; an element sharing its id is content.
  const spinner = doc(`<div id="loading"><img src="x.gif" alt="Loading"></div><p>r</p>`);
  assert.ok(!bake(spinner).body.includes("x.gif"));
  assert.equal(core.audit.loadersRemoved, 1);
  const section = doc(`<div id="loading"><h2>Loading</h2><p>Dead load 12.5</p></div>`);
  assert.ok(bake(section).body.includes("12.5"), "a section with the spinner's id was removed");
  assert.equal(core.audit.loadersRemoved, 0);
  assert.ok([...core.bakeWarnings].some((w: string) => w.includes(`id="loading"`)));
  assert.ok(expects(section).numbers.has("12.5"), "its values are not expected");

  // Only the gate the report's script opens is made visible; other hidden rules stay hidden.
  const reveal = `<script>jQuery('#report').css('visibility', 'visible');</script>`;
  const gated = bake(
    doc(
      `<div id="report">r</div>${reveal}`,
      "<style>#report{visibility:hidden} .old{visibility:hidden} td{line-height:100%} img{max-height:100%} #report{height:100%}</style>",
    ),
  );
  assert.match(gated.style, /#r0-report\s*\{\s*visibility: visible/);
  assert.match(gated.style, /\.old\s*\{\s*visibility:\s*hidden/, "a hidden rule was made visible");
  assert.match(gated.style, /line-height:\s*100%/, "line-height rewritten");
  assert.match(gated.style, /max-height:\s*100%/, "max-height rewritten");
  assert.match(gated.style, /height: auto/);
  assert.ok([...core.bakeWarnings].some((w: string) => w.includes(".old")));
  // A sheet wrapped in <!-- --> (CSS ignores them) keeps its rules.
  assert.match(
    bake(doc("<p class='a'>x</p>", "<style><!-- .a{color:red} --></style>")).style,
    /\.rs0 \.a/,
  );

  // The verification: an escaped \\ is a line break, not \color; an unclosed group drops nothing.
  assert.ok(expects(doc(String.raw`<p>\\color{red} 12.5</p>`)).words.has("color"));
  assert.ok(expects(doc(String.raw`<p>\color{red x 4567.8</p>`)).numbers.has("4567.8"));

  // A TeX error says what it was, not "[object Object]".
  bake(doc(String.raw`<p>[mathin]\frac{1}[mathin]</p>`));
  assert.ok(core.mathStats.failed > 0);
  assert.doesNotMatch(core.mathStats.firstFailure, /object Object/);

  // A zip entry with a second name (Info-ZIP Unicode Path, 0x7075) is refused: readers differ.
  const unicodePath = new Uint8Array([0x75, 0x70, 5, 0, 1, 0, 0, 0, 0x41]);
  await assert.rejects(
    core.readZipReports(
      testZip([{ name: "member_1_report.html", data: new Uint8Array([60]), extra: unicodePath }]),
      "p.pdf",
    ),
    /second, different name/,
  );
});

// ── SkyCiv's zip (roadmap task 16) ───────────────────────────────────────────
//
// The test zips come from the writer below, NOT from the tool's own: a reader checked only against
// its own writer shares its blind spots. It writes what the real export is (deflate, flags 2,
// made-by Unix, no extras; measured 2026-11-06 on a 75-report export) and the other legal shapes a
// zip tool produces (stored entries, data descriptors, a comment), plus each shape to be refused.

const TEST_CRC = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return (b: Uint8Array) => {
    let c = ~0;
    for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  };
})();

type TestEntry = {
  name: string | Uint8Array;
  data: Uint8Array;
  method?: number;
  flags?: number;
  /** sizes and CRC after the data (bit 3), zero in the local header */
  descriptor?: boolean;
  crc?: number;
  /** an extra field, written into both headers */
  extra?: Uint8Array;
};

function testZip(
  entries: TestEntry[],
  opts: { comment?: string; gap?: boolean; zip64?: boolean } = {},
): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const name = typeof e.name === "string" ? Buffer.from(e.name, "utf8") : Buffer.from(e.name);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : Buffer.from(e.data);
    const crc = e.crc ?? TEST_CRC(e.data);
    const flags = (e.flags ?? 2) | (e.descriptor ? 8 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(e.descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(e.descriptor ? 0 : e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const extra = Buffer.from(e.extra ?? new Uint8Array(0));
    local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(e.descriptor ? 16 : 0);
    if (e.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(e.data.length, 12);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x033f, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(0x81a40000, 38);
    c.writeUInt32LE(at, 42);
    central.push(c, name, extra);
    parts.push(local, name, extra, body, descriptor);
    at += 30 + name.length + extra.length + body.length + descriptor.length;
  }
  if (opts.gap) {
    parts.push(Buffer.from("stray bytes"));
    at += 11;
  }
  const cd = Buffer.concat(central);
  const comment = Buffer.from(opts.comment ?? "", "utf8");
  const locator = Buffer.alloc(opts.zip64 ? 20 : 0);
  if (opts.zip64) locator.writeUInt32LE(0x07064b50, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(at, 16);
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...parts, cd, locator, end, comment]));
}

/** An independent read of a zip's entries: name -> unpacked bytes (zlib, not the tool's reader). */
function testUnzip(zip: Uint8Array): Map<string, Uint8Array> {
  const b = Buffer.from(zip);
  let end = b.length - 22;
  while (b.readUInt32LE(end) !== 0x06054b50) end--;
  const out = new Map<string, Uint8Array>();
  let p = b.readUInt32LE(end + 16);
  for (let i = 0; i < b.readUInt16LE(end + 10); i++) {
    const [n, e, c] = [b.readUInt16LE(p + 28), b.readUInt16LE(p + 30), b.readUInt16LE(p + 32)];
    const local = b.readUInt32LE(p + 42);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const body = b.subarray(start, start + b.readUInt32LE(p + 20));
    const data = b.readUInt16LE(p + 10) === 8 ? inflateRawSync(body) : body;
    assert.equal(TEST_CRC(data), b.readUInt32LE(p + 16), "CRC");
    out.set(b.toString("utf8", p + 46, p + 46 + n), new Uint8Array(data));
    p += 46 + n + e + c;
  }
  return out;
}

const filesOf = (dir: string) =>
  readdirSync(dir)
    .filter((n) => n.endsWith(".html"))
    .map((n) => ({ name: n, data: new Uint8Array(readFileSync(join(dir, n))) }));

test(
  "a SkyCiv zip: the verified PDF is added to it, the reports untouched; a re-run replaces it",
  { timeout: TIMEOUT },
  () => {
    const dir = join(work, "zip-pass");
    mkdirSync(dir, { recursive: true });
    const zipPath = join(dir, "pack.zip");
    const samples = filesOf(SAMPLES);
    // Half the entries with data descriptors and one stored, as other zip tools write them.
    writeFileSync(
      zipPath,
      testZip(
        samples.map((s, i) => ({ ...s, descriptor: i % 2 === 1, method: i === 0 ? 0 : 8 })),
        { comment: "kept" },
      ),
    );
    const r = run([MAIN, zipPath]);
    assert.equal(r.code, 0, tail(r.out));
    has(
      r.out,
      /zip:\s+pack\.zip, 13 report entries/,
      /per-report: 13\/13 reports/,
      /PASS: every source word/,
      /Added pack\.pdf to .*pack\.zip/,
    );
    const after = readFileSync(zipPath);
    const entries = testUnzip(after);
    assert.equal(entries.size, 14);
    for (const s of samples) {
      assert.ok(Buffer.from(entries.get(s.name) ?? []).equals(Buffer.from(s.data)), s.name);
    }
    const pdf = entries.get("pack.pdf");
    assert.ok(pdf && Buffer.from(pdf.subarray(0, 5)).toString() === "%PDF-", "no PDF in the zip");
    assert.equal(after.subarray(after.length - 4).toString(), "kept", "the comment was lost");
    // Beside the zip: the baked HTML, and no loose or unverified PDF, and no partial zip.
    assert.deepEqual(readdirSync(dir).sort(), ["pack.html", "pack.zip"]);

    const again = run([MAIN, zipPath, "--no-keep-html"]);
    assert.equal(again.code, 0, tail(again.out));
    has(
      again.out,
      /pack\.pdf from an earlier run \(it will be replaced\)/,
      /replacing the earlier/,
    );
    assert.equal(testUnzip(readFileSync(zipPath)).size, 14, "the PDF was added twice");
    assert.deepEqual(readdirSync(dir), ["pack.zip"]);
  },
);

test("a zip whose build FAILS is left byte-identical", { timeout: TIMEOUT }, () => {
  const src = control("control-hidden-content", join(work, "zip-fail-src"));
  const dir = join(work, "zip-fail");
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, "pack.zip");
  const bytes = testZip(filesOf(src));
  writeFileSync(zipPath, bytes);
  const r = run([MAIN, zipPath]);
  assert.equal(r.code, 1, tail(r.out));
  has(r.out, /VERIFICATION FAILED/, /The zip is unchanged/);
  assert.ok(readFileSync(zipPath).equals(Buffer.from(bytes)), "a failed build changed the zip");
});

test("a zip that is not a flat set of reports is refused, unchanged, naming why", async () => {
  const core = await import(pathToFileURL(join(ROOT, "src", "report_core.ts")).href);
  const page = new TextEncoder().encode("<html><body>MEMBER 1 DESIGN REPORT</body></html>");
  const ok: TestEntry = { name: "member_1_report.html", data: page };
  const cases: [string, Uint8Array, RegExp][] = [
    [
      "a folder",
      testZip([ok, { name: "sub/", data: new Uint8Array(0), method: 0 }]),
      /is a folder/,
    ],
    ["a nested report", testZip([ok, { name: "sub/b.html", data: page }]), /inside a folder/],
    [
      "a non-report",
      testZip([ok, { name: "notes.txt", data: page }]),
      /"notes\.txt" is not a report/,
    ],
    ["a case twin", testZip([ok, { name: "MEMBER_1_report.html", data: page }]), /same name/],
    ["encryption", testZip([{ ...ok, flags: 1 }]), /is encrypted/],
    ["another method", testZip([{ ...ok, method: 12 }]), /compression method 12/],
    ["a bad CRC", testZip([{ ...ok, crc: 1 }]), /fails its CRC check/],
    ["a bad CRC, stored", testZip([{ ...ok, method: 0, crc: 1 }]), /fails its CRC check/],
    [
      "a code-page name",
      testZip([{ ...ok, name: new Uint8Array([0x63, 0xe9, 0x2e, 0x68, 0x74, 0x6d, 0x6c]) }]),
      /not in UTF-8/,
    ],
    ["bytes no entry claims", testZip([ok], { gap: true }), /belong to no entry/],
    [
      "a stub before the zip",
      new Uint8Array([...new TextEncoder().encode("MZ stub"), ...testZip([ok])]),
      /not where the end record puts it|no local header/,
    ],
    [
      "a descriptor that disagrees",
      (() => {
        const z = testZip([{ ...ok, descriptor: true }]);
        const at = Buffer.from(z).indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
        z[at + 8] ^= 1; // its compressed size
        return z;
      })(),
      /data descriptor disagrees/,
    ],
    ["zip64", testZip([ok], { zip64: true }), /zip64/],
    ["a truncated file", testZip([ok]).subarray(0, 60), /no end-of-archive record|damaged/],
    ["not a zip", new TextEncoder().encode("<html></html>"), /too short|no end-of-archive/],
  ];
  for (const [what, zip, reason] of cases) {
    await assert.rejects(core.readZipReports(zip, "pack.pdf"), reason, what);
  }
  // Damaged deflate data under a right size and CRC: refused as damage, not unpacked as garbage.
  const broken = testZip([ok]);
  broken[30 + "member_1_report.html".length] ^= 0xff;
  await assert.rejects(core.readZipReports(broken, "pack.pdf"), /damaged|CRC|size/, "bad deflate");
  // The real shape reads, its own PDF is not a report, and nothing else is needed.
  const fine = await core.readZipReports(
    testZip([ok, { name: "Pack.PDF", data: page, method: 0 }]),
    "pack.pdf",
  );
  assert.equal(fine.reports.length, 1);
  assert.equal(fine.hasOwn, true);

  // Through the CLI: one refusal end to end, and the argument rules. None may touch the zip.
  const dir = join(work, "zip-refuse");
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, "pack.zip");
  const bad = testZip([ok, { name: "notes.txt", data: page }]);
  writeFileSync(zipPath, bad);
  const refusals: [string[], RegExp][] = [
    [[MAIN, zipPath], /"notes\.txt" is not a report[\s\S]*Nothing was changed/],
    [[MAIN, zipPath, join(dir, "out.pdf")], /A zip takes no output argument/],
    [[MAIN, zipPath, "--no-verify"], /--no-verify cannot be used with a zip/],
    [[MAIN, join(dir, "absent.zip")], /No such zip file/],
  ];
  for (const [args, reason] of refusals) {
    const r = run(args);
    assert.equal(r.code, 1, tail(r.out));
    has(r.out, reason);
  }
  writeFileSync(zipPath, testZip([ok]));
  writeFileSync(join(dir, "pack.html"), "<p>the user's own file</p>");
  const mine = run([MAIN, zipPath]);
  assert.equal(mine.code, 1, tail(mine.out));
  has(mine.out, /already beside the zip/);
  assert.equal(readFileSync(join(dir, "pack.html"), "utf8"), "<p>the user's own file</p>");
  assert.deepEqual(readdirSync(dir).sort(), ["pack.html", "pack.zip"]);
});

test("the zip update is checked independently: any change but the PDF is caught", async () => {
  const core = await import(pathToFileURL(join(ROOT, "src", "report_core.ts")).href);
  const samples = filesOf(SAMPLES).slice(0, 3);
  const original = testZip(samples, { comment: "c" });
  const pdf = new TextEncoder().encode("%PDF-1.7 test\n");
  const updated: Uint8Array = core.zipWithFile(original, "pack.pdf", pdf, new Date(2026, 10, 6));
  assert.deepEqual(await core.checkZipUpdate(original, updated, "pack.pdf", pdf), []);
  // The independent reader agrees: the same reports, byte for byte, and the PDF.
  const read = testUnzip(updated);
  for (const s of samples)
    assert.ok(Buffer.from(read.get(s.name) ?? []).equals(Buffer.from(s.data)));
  assert.ok(Buffer.from(read.get("pack.pdf") ?? []).equals(Buffer.from(pdf)));

  // Tampering anywhere is a failure: a report's bytes, the PDF's, the comment, a dropped entry.
  const flip = (at: number) => {
    const z = updated.slice();
    z[at] ^= 0xff;
    return z;
  };
  const firstData = 30 + samples[0].name.length + 5;
  const pdfAt = Buffer.from(updated).indexOf("%PDF-1.7");
  for (const [what, z, file] of [
    ["a report byte", flip(firstData), pdf],
    ["a PDF byte", flip(pdfAt + 3), pdf],
    ["another PDF", updated, new TextEncoder().encode("%PDF-1.7 other\n")],
    ["the comment", flip(updated.length - 1), pdf],
    [
      "an entry dropped",
      core.zipWithFile(testZip(samples.slice(1), { comment: "c" }), "pack.pdf", pdf, new Date()),
      pdf,
    ],
  ] as [string, Uint8Array, Uint8Array][]) {
    const failures = await core.checkZipUpdate(original, z, "pack.pdf", file);
    assert.ok(failures.length > 0, `${what} was not caught`);
  }
  // Replacing: a second update holds one PDF, the new one.
  const pdf2 = new TextEncoder().encode("%PDF-1.7 second\n");
  const twice: Uint8Array = core.zipWithFile(updated, "PACK.pdf", pdf2, new Date());
  assert.deepEqual(await core.checkZipUpdate(updated, twice, "PACK.pdf", pdf2), []);
  assert.equal(testUnzip(twice).size, 4);
});

test("private paths stay ignored by git", () => {
  // Client data, transcripts, build output, and the workspace's private memory folder. cmem/local/
  // was missing: `/local/` covers the top-level folder only, and the workspace rules put machine
  // facts in cmem/local/ (2026-11-06).
  for (const path of [
    "local/HTMLFilesToBeCompiled/member_0_report.html",
    "cmem/local/environment.md",
    "cmem/transcript/session-transcript.md",
    "CompiledPDF/combined_report.pdf",
    "tests/CompiledPDF/combined_report.html",
    "local/CompiledPDF/combined_report.pdf",
    ".mathjax-fonts/MathJax_Main-Regular.woff",
    "dist/package.json",
  ]) {
    const r = spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: ROOT });
    assert.equal(r.status, 0, `${path} is NOT ignored by git`);
  }
  // ...and the committed samples are not.
  const s = spawnSync(
    "git",
    ["check-ignore", "-q", "--no-index", "tests/HTMLFilesToBeCompiled/member_0_report.html"],
    { cwd: ROOT },
  );
  assert.equal(s.status, 1, "the committed samples are ignored");
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
  // The npm hook is fenced like JSR's. A fake JSR answers "attested" first, so the npm lookup is
  // actually reached: without it this case asked the REAL JSR about 9.9.9, stopped at "not on
  // JSR" (exit 2) and passed on "non-zero" without ever touching the fence.
  const away = await withFakeJsr(json({ rekorLogId: "81" }), (jsr) =>
    runAsync([VR, "9.9.9", "--npm"], {
      env: {
        ...process.env,
        ...fast,
        S3D_JSR_API: jsr,
        S3D_NPM_API: "https://npm.example.invalid",
      },
    }),
  );
  assert.notEqual(away.code, 0, away.out);
  has(
    away.out,
    /Rekor log ID: 81/,
    /S3D_NPM_API=https:\/\/npm\.example\.invalid is not a loopback/,
  );
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
  // Read from this file's own source, not from which tests happened to run: under a name filter
  // (`-t`, `--test-name-pattern`) the controls' tests may be filtered out, and the runtime set
  // made this fail for that alone (2026-11-06 review). A control no `control("…")` call names is
  // one no test runs, whatever the filter.
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const named = new Set([...source.matchAll(/\bcontrol\(\s*"([\w-]+)"/g)].map((m) => m[1]));
  const all = readdirSync(CONTROLS)
    .filter((f) => /^control-.*\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ""));
  assert.ok(all.length >= 6, `only ${all.length} control file(s) found`);
  assert.deepEqual(
    all.filter((c) => !named.has(c)),
    [],
    "control file(s) no test runs — add a test or retire the file",
  );
  // And every control this run did use is one that exists (a renamed file breaks loudly).
  for (const c of exercised) assert.ok(all.includes(c), `a test uses a missing control: ${c}`);
});
