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
  has(r.out, /refs:\s+\d+ id reference\(s\), 1 unresolved, 0 broken by the bake/);
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

// ── the transcript redactor ──────────────────────────────────────────────────

test("the redactor removes checkout, drive and slug paths, and fails on a residue", () => {
  const redact = join(ROOT, "tests", "controls", "redact-paths.ts");
  // Built from this checkout's real location at run time, so the file names no path. On a
  // runner whose checkout is not on a drive letter the project rule simply does not apply.
  const root = ROOT.replace(/[\\/]+$/, "");
  const slug = root.replace(/[:\\/]/g, "-");
  const file = join(work, "transcript.md");
  const lines = [
    `read ${root}\\main.ts`,
    `json ${root.replace(/\\/g, "\\\\")}\\\\src\\\\report_core.ts`,
    `slash ${root.replace(/\\/g, "/")}/cmem/INDEX.md`,
    "home C:\\Users\\zorblax\\AppData\\Local\\Temp\\x.txt",
    "other J:\\Archive\\clients\\job-41\\report.html",
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
  assert.ok(text.includes("https://github.com/synapticforge1/S3D-ReportCompiler stays"), text);
  // POSIX drive spellings, a folder name with spaces, network paths.
  for (const leak of ["/mnt/", "/j/Archive", "Vendor Tool", "Files\\", "fileserver7", "job-41"]) {
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
  git("remote", "set-url", "--push", "origin", "NO-PUSH-FROM-TESTS");
  // The release under test is the working tree's, not the last commit's.
  writeFileSync(
    join(dir, "scripts", "publish.ts"),
    readFileSync(join(ROOT, "scripts", "publish.ts")),
  );
  const version = JSON.parse(readFileSync(join(dir, "jsr.json"), "utf8")).version as string;
  const pkg = readFileSync(join(dir, "package.json"), "utf8");
  const behind = pkg.replace(`"version": "${version}"`, '"version": "0.0.1"');
  assert.notEqual(behind, pkg, "could not set package.json behind");
  writeFileSync(join(dir, "package.json"), behind);
  git("commit", "-qam", "release test setup");
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
  // The reset fails (the index is locked while JSR is being asked): told, not claimed.
  const locked = releaseClone("release-locked");
  const before = headOf(locked);
  const r = await withFakeJsr(
    (req, res) => {
      writeFileSync(join(locked, ".git", "index.lock"), "");
      json({}, 503)(req, res);
    },
    (base) =>
      runAsync([join(locked, "scripts", "publish.ts"), "--no-wait"], {
        cwd: locked,
        env: { ...process.env, S3D_JSR_API: base, S3D_JSR_TIMEOUT_MS: "2000" },
      }),
  );
  rmSync(join(locked, ".git", "index.lock"), { force: true });
  assert.equal(r.code, 1, r.out);
  has(r.out, /could NOT undo the local "bump version to v/, /do not push it/);
  hasNot(r.out, /undid the local/);
  assert.notEqual(headOf(locked), before, "expected the bump commit to remain");

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
