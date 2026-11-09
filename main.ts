#!/usr/bin/env bun
/**
 * @module
 *
 * CLI entry point for `@jrmarcum/s3d-reportcompiler`. Compiles every .html file
 * in a folder into a single combined PDF, then proves nothing was lost.
 *
 * The programmatic API is the pure core, which has no I/O and runs in a browser
 * too -- import `@jrmarcum/s3d-reportcompiler` for that. This file is the
 * orchestration around it.
 */
// main.ts
//
// Compiles every .html file in a folder into a single combined PDF.
//
//   bun         main.ts [htmlDir] [output.pdf] [options]
//   node        main.ts [htmlDir] [output.pdf] [options]
//   deno run -A main.ts [htmlDir] [output.pdf] [options]
//   bun         main.ts <reports.zip> [options]     (the PDF is added to the zip)
//
//     --no-keep-html  discard the baked HTML after rendering
//     --no-optimize   skip the recompression pass
//     --no-verify     skip the final conservation check (not advisable for a
//                     document that will be issued)
//
// Default layout, relative to the CURRENT WORKING DIRECTORY. Either standing
// place works, because that is how someone will actually reach for it:
//
//     in the project folder            in the reports folder
//       HTMLFilesToBeCompiled/*.html     *.html
//       CompiledPDF/                     CompiledPDF/
//
// CompiledPDF/ is created if missing and holds BOTH outputs --
// combined_report.html (what Chrome was given) and combined_report.pdf.
//
// Resolving from the working directory rather than from this file's location is
// what makes the tool relocatable: installed globally from JSR, the script lives
// in a cache directory that will never contain anyone's reports. Both paths are
// overridable positionally. Keeping input and output apart means the input scan
// can never see a build artifact of its own. From a clone, run `bun install`
// first: Bun, Node and Deno all read that node_modules (jsr.json sets Deno's
// "nodeModulesDir": "manual"). Installed from npm or JSR, the dependencies come
// with the package.
//
// ---------------------------------------------------------------------------
// Layout
//
//   src/report_core.ts     pure transforms, no I/O -- runs in a browser too
//   src/report_runtime.ts  filesystem and process access, one runtime adapter
//   main.ts                (this file) orchestration and reporting
//
// ---------------------------------------------------------------------------
// Why it works this way
//
// These SkyCiv reports cannot be rendered by a JavaScript-free engine: the CSS
// hides the report behind `visibility: hidden` until MathJax finishes
// typesetting and jQuery reveals it, and every equation is stored as LaTeX
// between delimiters. So the pipeline is:
//
//   1. BAKE   Pre-render the maths with MathJax's Node API, strip the scripts,
//             and inline the fonts. The result is static and makes no network
//             requests -- no CDN outage or slow fetch can produce a half
//             typeset page, which was the main fragility of rendering the
//             original files directly.
//
//             Which strings delimit an equation is read from each report's own
//             tex2jax configuration rather than hard-coded, so a template that
//             changes delimiters keeps working.
//
//   1b. GUARD Refuse to emit a PDF that still contains LaTeX. An unrecognised
//             delimiter raises no error on its own -- it simply never matches --
//             so the baked document is scanned for surviving delimiters and TeX
//             commands, and the build fails if any are found.
//
//   2. RENDER All reports concatenated into ONE document and rendered in a
//             single browser pass. This is what makes the output small: the
//             engine embeds the shared section image and each font subset once
//             instead of once per report.
//
//   3. OPTIMIZE Chrome writes its non-stream objects uncompressed. Repacking
//             them into compressed object streams roughly halves the file with
//             no loss.
//
//   4. VERIFY Re-read the sources and the finished PDF and prove that every
//             word and number survived, that no graphic was sliced by a page
//             break, and that no LaTeX went unrendered. The build exits
//             non-zero if anything is missing, so it can gate a release.
//
// Measured on a 48-report set: 3.35 MB / 380 pages, versus 9.46 MB
// from a render-then-merge approach.
//
// Maths is encoded as CHTML (real text in an embedded font) rather than SVG.
// SVG output turns every glyph into a vector outline and produces a 52 MB file;
// CHTML also leaves the equations selectable and searchable.
// ---------------------------------------------------------------------------

import { PDFDocument } from "pdf-lib";

import {
  assembleDocument,
  audit,
  bakeBody,
  bakeStyle,
  compareAgainstPdf,
  compareEachReport,
  decodeReport,
  delimSignatures,
  extractSourceTokens,
  findBrokenReferences,
  findLeftoverMath,
  MATHJAX_FONTS,
  mathStats,
  mathStyleSheet,
  type PdfObservations,
  skippedDelims,
  sortReportNames,
  svgStyleWarnings,
  bakeRemovals,
  bakeWarnings,
  cssWarnings,
  checkZipUpdate,
  readZipReports,
  VERSION,
  zipWithFile,
} from "./src/report_core.ts";

import * as rt from "./src/report_runtime.ts";

// Generous ceiling, not a fixed wait -- the browser exits as soon as the page
// settles. The baked HTML fetches nothing, so this only has to cover layout.
const VIRTUAL_TIME_BUDGET_MS = 180_000;

// Split on a SINGLE leading dash, not a double one. Splitting on "--" would file
// `-v` under positionals, and the tool would go looking for a folder named "-v"
// instead of printing its version -- an unknown short option has to be rejected,
// not silently reinterpreted as a path.
const argv = rt.args();
const positional = argv.filter((a) => !a.startsWith("-"));
const flags = argv.filter((a) => a.startsWith("-"));

// The baked HTML is kept by default: it is the exact document Chrome was handed,
// so it is what makes a result inspectable afterwards. `--keep-html` is still
// accepted and means what it says -- it just asks for the default.
const keepHtml = !flags.includes("--no-keep-html");
const optimize = !flags.includes("--no-optimize");
const verify = !flags.includes("--no-verify");

// Reject unknown options rather than ignoring them: a mistyped --no-optimise
// would otherwise silently do the opposite of what was asked.
const KNOWN_FLAGS = [
  "--keep-html",
  "--no-keep-html",
  "--no-optimize",
  "--no-verify",
  "-v",
  "--version",
  "-h",
  "--help",
  "-?",
];
const unknownFlags = flags.filter((f) => !KNOWN_FLAGS.includes(f));
if (unknownFlags.length > 0) {
  console.error(`Unknown option(s): ${unknownFlags.join(", ")}\n`);
  console.error(`Supported: ${KNOWN_FLAGS.join(", ")}`);
  console.error(`Run with --help for what they do.`);
  rt.exit(1);
}
// Two that contradict each other are a mistake, not a choice: --no-keep-html used to win silently.
if (flags.includes("--keep-html") && flags.includes("--no-keep-html")) {
  console.error("--keep-html and --no-keep-html contradict each other: give one.");
  rt.exit(1);
}

if (flags.includes("-v") || flags.includes("--version")) {
  console.log(VERSION);
  rt.exit(0);
}

/** Usage text. Shared by --help and by the "nothing to do" paths below. */
function helpText(): string {
  return `s3d-reportcompiler ${VERSION}

Compiles a folder of SkyCiv design reports into ONE combined PDF, then checks
that every word, number and figure in the reports survived into it.

USAGE
  s3d-reportcompiler                        compile the reports here
  s3d-reportcompiler <reportsFolder>
  s3d-reportcompiler <reportsFolder> <output.pdf>
  s3d-reportcompiler <reports.zip>

THE SIMPLE WAY
  Open a terminal in the folder holding your member_*.html reports and run the
  command with no arguments. It finds them, and writes the result to a new
  CompiledPDF folder beside them:

      CompiledPDF/combined_report.pdf     <- the document
      CompiledPDF/combined_report.html    <- exactly what was sent to Chrome

  It also works one level up, from a folder containing HTMLFilesToBeCompiled/.

STRAIGHT FROM SKYCIV'S ZIP
  Give it the zip SkyCiv downloaded. Nothing is unpacked: its .html entries are
  the reports, and once the PDF has PASSED its check it is added INTO the zip,
  named after it (pack.zip gets pack.pdf). The reports in the zip are not
  touched, and a failed build leaves the zip exactly as it was.

      s3d-reportcompiler "C:\\Users\\me\\Downloads\\pack.zip"

  The intermediate HTML is kept beside the zip (pack.html). Run it again and
  the PDF in the zip is replaced. A zip holding anything but a flat set of
  .html reports is refused, naming what else is in it. If the PDF passes but
  cannot be added (the zip is open in another program), it is kept beside the
  zip as pack.verified.pdf, and the build ends with an error.

IF YOU WANT TO CHOOSE THE PATHS
  Quote anything containing spaces.

      s3d-reportcompiler "C:\\Jobs\\Gate Calcs\\Reports"
      s3d-reportcompiler "C:\\Jobs\\Gate Calcs\\Reports" "C:\\Jobs\\GateCalcs.pdf"

  The second argument names the PDF, and the folder above it is created if it
  does not exist. It must end in .pdf: a file already there is replaced.

OPTIONS
  --keep-html     keep the intermediate HTML beside the PDF (the default)
  --no-keep-html  delete the intermediate HTML after a good build, leaving only
                  the PDF (a failed build keeps it: it is the first thing to read)
  --no-optimize   skip the recompression pass (the PDF ends up ~2x larger)
  --no-verify     skip the check that nothing was lost. NOT ADVISABLE for a
                  document that will be issued or sealed -- the check is the
                  only thing proving a value was not silently dropped, and a
                  dropped value still looks right on the page.
  -v, --version   print the version and exit
  -h, -?, --help  print this and exit

REQUIREMENTS
  Google Chrome or Microsoft Edge must be installed -- it does the rendering.
  If it is somewhere unusual, point at it:

      Windows   set CHROME_PATH=C:\\Path\\To\\chrome.exe
      macOS     export CHROME_PATH=/Applications/…/Google Chrome
      Linux     export CHROME_PATH=/usr/bin/chromium

  Chrome runs with its sandbox on (off only as root, where it cannot start
  with one). If the build reports that Chrome found no usable sandbox -- some
  Linux hosts give an ordinary user none -- turn it off for that build:

      Linux     S3D_CHROME_NO_SANDBOX=1 s3d-reportcompiler

  The build then prints "sandbox: OFF". The reports' own code stays blocked
  either way. S3D_CHROME_NO_SANDBOX takes 1, true or yes (or 0, false, no);
  anything else stops the build, as does a CHROME_PATH that names no file.

  Chrome is stopped if it has not finished in 10 minutes. For a very large set
  allow it longer, in milliseconds: S3D_CHROME_TIMEOUT_MS=1800000

  The first run in a folder downloads maths fonts once and caches them in
  .mathjax-fonts in the folder you run it FROM, so later runs from there work
  offline. Run from another folder, it downloads them again.

  Until a build passes its check, its PDF is named <name>.unverified.pdf; only
  a pass (or --no-verify) gives it the name you asked for.

WHAT "PASS" AT THE END MEANS
  Every distinct word and number in your reports was found in the PDF, no
  figure was cut across a page break, no equation was left unrendered, and
  every report contributed a page. If anything is missing the command says so
  and exits with an error rather than handing you a plausible-looking file.

  Read the "diagram(s) checked" count: it reports how many diagrams the split
  check actually recognised. A low number means it did not run on the rest,
  not that they are fine.`;
}

if (flags.includes("-h") || flags.includes("--help") || flags.includes("-?")) {
  console.log(helpText());
  rt.exit(0);
}

// Two positionals at most, and a third is an error, not ignored: an unquoted path
// with a space arrives as two arguments, so `reports C:\My Docs\out.pdf` would
// write a PDF named "C:\My" and drop the rest without a word.
// An EMPTY argument is refused too: `s3d-reportcompiler "$DIR" out.pdf` with DIR unset passes "",
// which resolved to the working directory -- compiling whatever is here, silently.
if (positional.some((p) => p.trim() === "")) {
  console.error(
    `An empty path argument was given (position ${positional.findIndex((p) => p.trim() === "") + 1}).`,
  );
  console.error(`If it came from a variable, the variable is probably unset. Name the folder,`);
  console.error(`or leave the argument out to use the default layout.`);
  rt.exit(1);
}
if (positional.length > 2) {
  console.error(`Too many arguments (${positional.length}); expected a reports folder and an`);
  console.error(`output PDF at most. Received:`);
  for (const p of positional) console.error(`  ${p}`);
  console.error(`\nA path containing spaces must be quoted as ONE argument:`);
  console.error(`  s3d-reportcompiler "C:\\Jobs\\Gate Calcs\\Reports" "C:\\Jobs\\Gate Calcs.pdf"`);
  rt.exit(1);
}

// Settings that are SET but cannot be honoured stop the build, named -- never a silent fallback.
// A mistyped CHROME_PATH used to render with whatever other browser was found; any value of
// S3D_CHROME_NO_SANDBOX but "1" was silently ignored (2026-11-06).
const settingError = (msg: string): never => {
  console.error(`${msg}\n`);
  console.error("Run with --help for what each setting accepts.");
  return rt.exit(1);
};
const sandboxSetting = (rt.env("S3D_CHROME_NO_SANDBOX") ?? "").trim().toLowerCase();
if (!["", "0", "1", "false", "true", "no", "yes"].includes(sandboxSetting)) {
  settingError(
    `S3D_CHROME_NO_SANDBOX=${JSON.stringify(sandboxSetting)} is not 1/true/yes or 0/false/no.`,
  );
}
const sandboxOptOut = ["1", "true", "yes"].includes(sandboxSetting);
const timeoutSetting = rt.env("S3D_CHROME_TIMEOUT_MS");
const chromeTimeoutMs =
  timeoutSetting === undefined || timeoutSetting.trim() === ""
    ? 10 * 60_000
    : Number(timeoutSetting);
// At most what a timer can hold: past 2^31 - 1 ms a timer fires after 1 ms, so "a very long
// time" killed Chrome at once (2026-11-06 review).
if (
  !Number.isFinite(chromeTimeoutMs) ||
  chromeTimeoutMs < 1 ||
  chromeTimeoutMs > rt.MAX_TIMEOUT_MS
) {
  settingError(
    `S3D_CHROME_TIMEOUT_MS=${JSON.stringify(timeoutSetting)} is not a number of milliseconds from 1 ` +
      `to ${rt.MAX_TIMEOUT_MS} (about 24 days).`,
  );
}
const chromeSetting = rt.env("CHROME_PATH");
if (chromeSetting && !(await rt.fileExists(chromeSetting))) {
  settingError(
    `CHROME_PATH names no file:\n  ${chromeSetting}\n\nFix it, or unset it to use an installed Chrome or Edge.`,
  );
}

// Default layout: reports in one folder, output in another, so the input scan
// can never see a build artifact and the two concerns stay separate on disk.
const INPUT_DIR = "HTMLFilesToBeCompiled";
const OUTPUT_DIR = "CompiledPDF";

// Resolved from where the tool was INVOKED, not from where it is installed.
// A globally installed copy lives in a registry cache; defaulting to that
// directory would be defaulting to a folder that can never hold reports.
const workingDir = rt.cwd();
if (!workingDir && !positional[0]) {
  console.error(
    "Could not determine the working directory; pass the HTML folder as the first argument.",
  );
  rt.exit(1);
}

// Two ways of standing in the right place, both of which should just work:
//
//   in the project folder   ./HTMLFilesToBeCompiled/*.html  ->  ./CompiledPDF/
//   in the reports folder   ./*.html                        ->  ./CompiledPDF/
//
// So the input folder is the nested one if it exists, and the working directory
// itself otherwise. The output always lands under the working directory, which
// is what puts CompiledPDF/ inside the reports folder in the second case.
const nestedInput = rt.joinPath(workingDir, INPUT_DIR);

// Both are resolved to absolute paths, because a relative one supplied on the
// command line reaches Chrome as-is and Chrome will not resolve it -- it fails
// with "cannot find the path specified" on stderr and still exits 0. The
// defaults were never exposed to this (they are built from an absolute cwd),
// which is exactly why it would have gone unnoticed.
// A SkyCiv zip (roadmap task 16): the reports are its .html entries, read in memory, and after a
// PASS the verified PDF is added back into the zip, under the zip's own name. The working files --
// the baked HTML, the PDF until it is in the zip -- sit beside the zip. Resolved to the REAL path,
// so a link to a zip updates the zip, not the link.
let zipPath: string | null = null;
if (positional[0] !== undefined && /\.zip$/i.test(positional[0].trim())) {
  const given = await rt.resolvePath(positional[0]);
  if (!(await rt.fileExists(given))) {
    console.error(`No such zip file:\n  ${given}\n`);
    console.error("Check the path; if it contains spaces, wrap the whole path in quotes.");
    rt.exit(1);
  }
  if (positional[1] !== undefined) {
    console.error("A zip takes no output argument: the verified PDF is added to the zip itself.");
    console.error(`Run:  s3d-reportcompiler "${given}"`);
    rt.exit(1);
  }
  // The PDF goes into a package that will be issued; an unchecked one must not.
  if (!verify) {
    console.error("--no-verify cannot be used with a zip: only a verified PDF is added to it.");
    rt.exit(1);
  }
  zipPath = await rt.realPath(given);
}
const zipDir = zipPath === null ? "" : zipPath.replace(/[\\/][^\\/]*$/, "");
const zipStem = zipPath === null ? "" : rt.baseName(zipPath).replace(/\.zip$/i, "");
/** The PDF's name inside the zip. */
const zipPdfName = `${zipStem}.pdf`;

const htmlDir =
  zipPath !== null
    ? zipDir
    : await rt.resolvePath(
        positional[0] ?? ((await rt.dirExists(nestedInput)) ? nestedInput : workingDir),
      );

const outputPdf =
  zipPath !== null
    ? rt.joinPath(zipDir, zipPdfName)
    : await rt.resolvePath(
        positional[1] ?? rt.joinPath(workingDir, OUTPUT_DIR, "combined_report.pdf"),
      );

/**
 * Where a zip build keeps its PDF when it PASSED but could not be added to the zip -- one fixed
 * name, replaced by the next such run and removed by the next successful one, so a stale verified
 * PDF never sits beside the zip under the zip's own name (2026-11-06 review).
 */
const zipKeptPdf = zipPath === null ? "" : rt.joinPath(zipDir, `${zipStem}.verified.pdf`);

// The second argument names the PDF FILE, and only a .pdf: the file at that path is replaced, so
// `reports pack.zip` ("compile into the zip") deleted the zip, and `reports notes.docx` the
// document, before the build ran (2026-11-06 review).
if (zipPath === null && !/\.pdf$/i.test(outputPdf)) {
  console.error(`The output must be a .pdf file:\n  ${outputPdf}\n`);
  console.error("The second argument names the PDF to write, and a file of that name is replaced.");
  if (/\.zip$/i.test(outputPdf)) {
    console.error(`To add the PDF to a SkyCiv zip, give the zip as the ONLY argument:`);
    console.error(`  s3d-reportcompiler "${outputPdf}"`);
  }
  rt.exit(1);
}

// A folder where the build must write a file could not be replaced: Chrome's write failed
// ("Access is denied"), the run ended in a stack trace blaming Chrome, and a stray "<folder>.html"
// was left beside it.
// The unverified name in a folder build too (review 5): a folder there was blamed on Chrome, with
// the CHROME_PATH launcher hint.
const unverifiedPath = `${outputPdf.replace(/\.pdf$/i, "")}.unverified.pdf`;
for (const path of zipPath === null ? [outputPdf, unverifiedPath] : [unverifiedPath, zipKeptPdf]) {
  if (await rt.dirExists(path)) {
    console.error(`A folder is where the build must write a file:\n  ${path}\n`);
    console.error(
      zipPath === null && path === outputPdf
        ? `The second argument names the PDF itself, e.g. "${rt.joinPath(path, "combined_report.pdf")}".`
        : "Move or rename that folder, then re-run.",
    );
    rt.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Font inlining
//
// Cached in the working directory (not beside the reports) so repeat builds from there work
// offline; the first build is
// the only one that needs the network.
// ---------------------------------------------------------------------------

/**
 * A complete WOFF or WOFF2 file: its signature, and the total length its header records (bytes
 * 8–11, big-endian) equal to its size -- what a font download must be before it is kept. The
 * signature alone passed a file cut off mid-download (it still starts `wOFF`); all 22 MathJax
 * fonts record their exact size (measured 2026-11-06).
 */
const isFont = (b: Uint8Array) =>
  b.length >= 12 &&
  ["wOFF", "wOF2"].includes(String.fromCharCode(b[0], b[1], b[2], b[3])) &&
  ((b[8] << 24) | (b[9] << 16) | (b[10] << 8) | b[11]) >>> 0 === b.length;

/**
 * Where a font is fetched from: its URL, or -- under the TEST hook `S3D_FONT_ORIGIN`, honoured
 * for a loopback address only -- the same path on that origin. The cache key is always the real
 * URL, so the hook changes where bytes come from, never where they are kept.
 */
function fontSource(url: string): string {
  const hook = rt.env("S3D_FONT_ORIGIN");
  if (!hook) return url;
  const host = new URL(hook).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error(
      `S3D_FONT_ORIGIN=${hook} is not a loopback address. It is a TEST hook; unset it.`,
    );
  }
  return url.replace(/^https?:\/\/[^/]+/, hook.replace(/\/+$/, ""));
}

/** How long one font may take to download (each is under 100 kB). */
const FONT_FETCH_TIMEOUT_MS = 60_000;

/** The font cache's write failure is said once a build, not once a font. */
let fontCacheWarned = false;

/**
 * One font file, from the on-disk cache or downloaded once and cached.
 *
 * Cached under a folder named for the URL's directory -- which carries the MathJax version
 * (`…mathjax@3.2.2…`) -- so a MathJax update starts a fresh cache. Keyed by the file name alone,
 * as it was until 2026-11-06, an update would have embedded the old version's fonts beside the new
 * stylesheet, silently. The flat cache of earlier releases is adopted once: every release before
 * this used MathJax 3.2.2, so a flat file is that version's.
 *
 * Only a real font is kept: a 200 that is not one (a captive portal's login page, a proxy's error
 * page) is refused with nothing cached, and a cached file that is not one is fetched again.
 *
 * Writes to a scratch name and renames into place, so a build interrupted mid-write cannot leave a
 * truncated font that every later build silently reuses.
 *
 * @param cacheRoot `.mathjax-fonts` in the working directory
 */
async function fontBytes(url: string, cacheRoot: string): Promise<Uint8Array> {
  const name = rt.baseName(url).replace(/[^\w.-]/g, "_");
  // Bytes from the test hook are kept apart from the real cache: stored under the real key, a
  // test run in a working folder left the fake server's fonts for every later real build there.
  const dirKey =
    (rt.env("S3D_FONT_ORIGIN") ? "test-hook_" : "") +
    url
      .slice(0, url.length - rt.baseName(url).length)
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .replace(/[^\w.@-]/g, "_");
  const cacheDir = rt.joinPath(cacheRoot, dirKey);
  const cached = rt.joinPath(cacheDir, name);

  // A cache that cannot be written is said as such (it used to surface as "check the network") --
  // and costs only the cache: the font was downloaded and checked, so the build uses it. It used to
  // fail the build whose fonts had all arrived (review 4). True once the font is in the cache.
  const keep = async (bytes: Uint8Array, from: "downloaded" | "old cache"): Promise<boolean> => {
    const partial = `${cached}.partial`;
    try {
      await rt.mkdirp(cacheDir);
      await rt.writeFile(partial, bytes);
      await rt.rename(partial, cached);
      return true;
    } catch (e) {
      await rt.removeQuietly(partial);
      if (!fontCacheWarned) {
        fontCacheWarned = true;
        console.warn(
          `  warning: the font cache could not be written (${cacheDir}: ${(e as Error).message}); ` +
            (from === "downloaded"
              ? "the fonts were downloaded and are used, and the next build downloads them again"
              : "the fonts are used from the earlier release's cache, which is kept"),
        );
      }
      return false;
    }
  };

  try {
    const bytes = await rt.readFile(cached);
    if (isFont(bytes)) return bytes;
    await rt.removeQuietly(cached); // not a font: fetched again below
  } catch {
    // not cached yet
  }

  if (url.startsWith(`${MATHJAX_FONTS}/`)) {
    const legacy = rt.joinPath(cacheRoot, name);
    try {
      const bytes = await rt.readFile(legacy);
      if (isFont(bytes)) {
        // Removed only once it is in the new cache: removed regardless, a cache that could not be
        // written lost the earlier release's fonts, and the next offline build failed (review 5).
        if (await keep(bytes, "old cache")) await rt.removeQuietly(legacy);
        return bytes;
      }
    } catch {
      // no flat cache from an earlier release
    }
  }

  // Bounded, like the render: a stalled download held the build forever, before Chrome's own
  // timeout could apply (2026-11-07 review).
  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await fetch(fontSource(url), { signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if ((e as Error).name === "TimeoutError") {
      throw new Error(`${url} did not download within ${FONT_FETCH_TIMEOUT_MS / 1000} s`);
    }
    throw e;
  }
  if (!isFont(bytes)) {
    throw new Error(
      `${url} did not return a font (${res.headers.get("content-type") ?? "no content type"}, ` +
        `${bytes.length} bytes) -- a captive portal or a proxy page, or a download cut short? ` +
        `Nothing was cached.`,
    );
  }
  await keep(bytes, "downloaded");
  return bytes;
}

/**
 * Replace every `url(...)` in a stylesheet with a base64 data URI, making the
 * document hermetic — no CDN can be slow, blocked or down at render time.
 *
 * ⚠️ Every reference is resolved first, then rewritten in a single pass.
 * Substituting one at a time by substring is unsafe: a font name that is a
 * suffix of another would be rewritten inside its neighbour's URL too.
 */
async function inlineFonts(css: string, cacheDir: string): Promise<string> {
  const refs = [...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]))];

  // Resolve every reference first, then rewrite in a single pass. Substituting
  // one reference at a time by substring is unsafe: any font name that is a
  // suffix of another would be rewritten inside its neighbour's URL too.
  const inlined = new Map<string, string>();
  let total = 0;

  for (const ref of refs) {
    const url = ref.startsWith("http") ? ref : `${MATHJAX_FONTS}/${rt.baseName(ref)}`;

    const bytes = await fontBytes(url, cacheDir);
    total += bytes.length;

    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    inlined.set(ref, `data:font/woff;base64,${btoa(binary)}`);
  }

  const out = css.replace(/url\(["']?([^"')]+)["']?\)/g, (whole, ref) => {
    const data = inlined.get(ref);
    return data ? `url("${data}")` : whole;
  });

  console.log(`  fonts:    ${refs.length} inlined (${(total / 1e3).toFixed(0)} kB)`);
  return out;
}

// ---------------------------------------------------------------------------
// Verification: the PDF half
// ---------------------------------------------------------------------------

/**
 * Read the finished PDF back **from disk** and record what is actually in it.
 *
 * Deliberately re-reads the artifact rather than trusting anything held in
 * memory: the file that ships is the file that gets checked.
 *
 * Counts image *paints*, not images — a figure straddling a page break is
 * painted on both pages, so a count above the expected number means a split.
 * Tracks drawing as well as text, because a page holding only a diagram has no
 * extractable text and calling it blank would fail a correct build.
 */
/**
 * A page's text as a reader sees it: items that touch on one line are joined (a word or number
 * cut into kerned pieces, a maths expression drawn glyph by glyph), and items that stand APART --
 * a gap of more than 0.15 of the text's height, or a raise or drop of more than 0.3 of it (a
 * superscript, a subscript) -- are separated by a space; a new line by a line break. Joined with
 * nothing at all, two table cells "12" and "5", or the axis ticks "0 2 4 6", read as "125" and
 * "0246", and a value check could not tell them from the numbers they are not (2026-11-08, class
 * B). Measured on the samples: kerned pieces touch (gap 0), word gaps and cells are 0.2–5 heights.
 */
function pageText(items: unknown[]): string {
  type Item = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };
  let out = "";
  let prev: { x: number; y: number; w: number; h: number } | null = null;
  for (const raw of items) {
    const it = raw as Partial<Item>;
    if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 1;
    if (prev !== null && it.str !== "") {
      const size = Math.max(h, prev.h);
      const dy = Math.abs(y - prev.y);
      // Between two digits (or a digit and its point) a gap may be letter-spacing, up to 0.35 of
      // the height: `letter-spacing: 0.25em` printed 77.531 as "7 7 . 5 3 1" (iteration 2). A
      // number apart from another stands 4.3 heights from it or more (measured 2026-11-08 on the
      // samples and the 48-report set).
      const digits = /[\d.,]$/.test(out) && /^[\d.,]/.test(it.str);
      if (dy > size) out += "\n";
      else if (
        dy > 0.3 * size ||
        x - (prev.x + prev.w) > (digits ? 0.35 : 0.15) * size ||
        // A change of size: a subscript set smaller, touching its base (`λ` then `rf`).
        Math.abs(h - prev.h) > 0.2 * size
      ) {
        out += " ";
      }
    }
    out += it.str;
    if (it.str !== "") prev = { x, y, w: it.width ?? 0, h };
    if (it.hasEOL) {
      out += "\n";
      prev = null;
    }
  }
  return out;
}

/** What {@link readPdf} observes beyond the exported {@link PdfObservations} (kept apart, so that type does not change). */
type PdfDetail = {
  pageTexts: string[];
  /** Images drawn on each page, in page order. */
  imagesPerPage: number[];
  /** Pages with an image cut by the page break (drawn past the page's edge). */
  cutImagePages: Set<number>;
  /** Pages with an image drawn but not seen: under 2 pt on a side, or mostly outside its clip. */
  hiddenImagePages: Set<number>;
  /** Pages with text drawn invisibly (rendering mode 3, or a tenth of full alpha or less). */
  invisibleTextPages: Set<number>;
  /** Pages with text too light to read on the white page (contrast under {@link MIN_CONTRAST}). */
  lowContrastPages: Set<number>;
  /** The lowest contrast of any visible text, for the log (21 = black, 1 = white). */
  lowestContrast: number;
  /** Pages with text too small to read (under {@link MIN_TEXT_PT}). */
  tinyTextPages: Set<number>;
  /** The smallest visible text, in points, for the log. */
  smallestText: number;
  /** Pages where a diagram's title had no caption before the page ended. */
  cutDiagramPages: number[];
};

/**
 * How the VERIFICATION orders two report names (its own, not `sortReportNames`, §9): runs of
 * digits compared as numbers, so member_2 comes before member_10; the rest compared as text,
 * case and accents aside. 0 when a reader could not tell them apart -- either order is right.
 */
function readingOrder(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let k = 0; k < Math.min(pa.length, pb.length); k++) {
    if (k % 2 === 1) {
      // digits: the longer number (leading zeros aside) is the larger
      const x = pa[k].replace(/^0+(?=\d)/, "");
      const y = pb[k].replace(/^0+(?=\d)/, "");
      if (x.length !== y.length) return x.length - y.length;
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const c = pa[k].localeCompare(pb[k], undefined, { sensitivity: "base" });
      if (c !== 0) return c;
    }
  }
  return pa.length - pb.length;
}

/**
 * The maths delimiter pairs a source declares, read by the VERIFICATION's own code -- not the
 * bake's `parseDelimiters` (design-decisions §9: a reader they shared could lose the same
 * delimiter on both sides, and every check would agree). Over-inclusive on purpose: every
 * `<script>` of any type, live or not, so a pair is looked for whenever any config names it; a
 * variable holding the array is followed. Single-character brackets are left out, as MathJax
 * reads SkyCiv's `['\[','\]']` as "[" and "]" (roadmap task 18 item 1).
 */
function declaredDelimiters(raw: string): [string, string][] {
  const scripts = [
    ...raw.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi),
  ]
    .map((m) => m[1])
    .join("\n;\n");
  /** The `[...]` at `at`, quotes respected. */
  const bracket = (at: number) => {
    let depth = 0;
    let quote = "";
    for (let i = at; i < scripts.length; i++) {
      const c = scripts[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) return scripts.slice(at, i + 1);
    }
    return "";
  };
  const jsString = (s: string) =>
    s.replace(
      /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g,
      (_m, u?: string, x?: string, c?: string) =>
        u || x ? String.fromCharCode(parseInt((u ?? x) as string, 16)) : (c ?? ""),
    );
  const pairs: [string, string][] = [];
  for (const key of scripts.matchAll(/(?<![\w$])["']?(?:inline|display)Math["']?\s*:\s*/g)) {
    const at = (key.index ?? 0) + key[0].length;
    let array = scripts[at] === "[" ? bracket(at) : "";
    const name = /^[A-Za-z_$][\w$]*/.exec(scripts.slice(at))?.[0];
    if (!array && name) {
      const assigned = [
        ...scripts.matchAll(
          new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*=(?!=)\\s*\\[`, "g"),
        ),
      ];
      for (const a of assigned) array += bracket((a.index ?? 0) + a[0].length - 1);
    }
    for (const p of array.matchAll(
      /\[\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(['"])((?:\\.|(?!\3).)*)\3\s*\]/g,
    )) {
      const open = jsString(p[2]);
      const close = jsString(p[4]);
      if (open && close && !(open.length === 1 && "[](){}<>".includes(open)))
        pairs.push([open, close]);
    }
  }
  return pairs;
}

/**
 * The lowest contrast against the white page that text may have: WCAG's floor for large text, a
 * floor for "can be read", not its 4.5 for comfort. Well below the lowest the real sets print,
 * 8.6:1 in all three (measured 2026-11-08; logged on every build's `legible:` line); `#eeeeee` is
 * 1.16, `#aaaaaa` 2.3.
 */
const MIN_CONTRAST = 3;
/** The smallest text that may be printed, in points: the samples' smallest is 3.61 (subscripts). */
const MIN_TEXT_PT = 2;

async function readPdf(pdfPath: string): Promise<PdfObservations & PdfDetail> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: await rt.readFile(pdfPath) }).promise;
  let openDiagrams = 0;

  // Each page's text, in order, for the per-report check (compareEachReport): kept beside the
  // public observations rather than added to them, so the exported type does not change.
  const obs: PdfObservations & PdfDetail = {
    imagesPerPage: [],
    cutImagePages: new Set(),
    hiddenImagePages: new Set(),
    invisibleTextPages: new Set(),
    lowContrastPages: new Set(),
    lowestContrast: 21,
    tinyTextPages: new Set(),
    smallestText: Number.POSITIVE_INFINITY,
    cutDiagramPages: [],
    pageTexts: [],
    text: "",
    pages: doc.numPages,
    imagePaints: 0,
    diagramTitlePages: [],
    diagramAxisPages: [],
    headingPages: [],
    blankPages: [],
  };

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);

    // Track drawing as well as text: a page holding only a diagram has no
    // extractable text, and calling that "blank" would fail the build for a
    // page that is perfectly correct.
    let drew = false;
    // The graphics state, as far as these checks need it (class B, 2026-11-08): the transform, to
    // place each image on the page; the text rendering mode and fill alpha, to know text drawn
    // invisibly -- it is still in the text layer, so a value printed in mode 3 or at alpha 0
    // passed the word check unseen.
    // Since iteration 2: the alpha of every enclosing transparency group, multiplied in (an
    // element's `opacity` is a group, its text's own alpha set inside it); and the clipping box,
    // to know an image `overflow: hidden` left mostly unseen.
    type Box = [number, number, number, number];
    type Gs = { m: number[]; mode: number; alpha: number; fill: number[]; clip: Box | null };
    const stack: Gs[] = [];
    const groupAlpha: number[] = [1];
    let gs: Gs = { m: [1, 0, 0, 1, 0, 0], mode: 0, alpha: 1, fill: [0, 0, 0], clip: null };
    let clipPending = false;
    /** A fill colour as RGB 0-1: pdf.js gives "#rrggbb", or numbers 0-255 or 0-1, or one grey. */
    const rgb = (args: unknown[]): number[] => {
      if (typeof args[0] === "string") {
        const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(args[0]);
        return hex ? hex.slice(1).map((c) => parseInt(c, 16) / 255) : [0, 0, 0];
      }
      const v = args.map(Number);
      const scaled = v.some((c) => c > 1) ? v.map((c) => c / 255) : v;
      return scaled.length === 1 ? [scaled[0], scaled[0], scaled[0]] : scaled.slice(0, 3);
    };
    /**
     * Text's contrast against the white page, as WCAG defines it (1:1 to 21:1), its alpha
     * composited over white first. Since re-check 2 this replaces a test for white: every channel
     * at `0xF0` or more passed `#eeeeee`, as unreadable on a white page (1.16:1).
     */
    const contrast = (fill: number[], alpha: number) => {
      const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const [r, g, b] = fill.map((c) => lin(alpha * c + (1 - alpha)));
      return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
    };
    /** Whether a text-show's glyphs draw anything but spaces. */
    const inks = (glyphs: unknown) =>
      Array.isArray(glyphs) &&
      glyphs.some(
        (g) =>
          typeof g === "object" &&
          g !== null &&
          /\S/.test(String((g as { unicode?: string }).unicode ?? "")),
      );
    /** A box under the transform, in page space. */
    const place = (b: Box, m: number[]): Box => {
      const xs = [b[0], b[2]].flatMap((x) => [b[1], b[3]].map((y) => m[0] * x + m[2] * y + m[4]));
      const ys = [b[0], b[2]].flatMap((x) => [b[1], b[3]].map((y) => m[1] * x + m[3] * y + m[5]));
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const meet = (a: Box, b: Box): Box => [
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.min(a[2], b[2]),
      Math.min(a[3], b[3]),
    ];
    const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const mul = (a: number[], b: number[]) => [
      a[0] * b[0] + a[1] * b[2],
      a[0] * b[1] + a[1] * b[3],
      a[2] * b[0] + a[3] * b[2],
      a[2] * b[1] + a[3] * b[3],
      a[4] * b[0] + a[5] * b[2] + b[4],
      a[4] * b[1] + a[5] * b[3] + b[5],
    ];
    const [, , pageW, pageH] = page.view as number[];
    const ops = await page.getOperatorList();
    let imagesHere = 0;
    const SHOW_TEXT = new Set([
      pdfjs.OPS.showText,
      pdfjs.OPS.showSpacedText,
      pdfjs.OPS.nextLineShowText,
      pdfjs.OPS.nextLineSetSpacingShowText,
    ]);
    ops.fnArray.forEach((fn: number, i: number) => {
      const args = ops.argsArray[i] as unknown[];
      if (fn === pdfjs.OPS.save) stack.push({ ...gs });
      else if (fn === pdfjs.OPS.restore) gs = stack.pop() ?? gs;
      else if (fn === pdfjs.OPS.transform) gs = { ...gs, m: mul(args as number[], gs.m) };
      else if (fn === pdfjs.OPS.setTextRenderingMode) gs = { ...gs, mode: Number(args[0]) };
      else if (fn === pdfjs.OPS.setFillRGBColor || fn === pdfjs.OPS.setFillGray) {
        gs = { ...gs, fill: rgb(args) };
      } else if (fn === pdfjs.OPS.setGState) {
        for (const [key, value] of (args[0] as [string, unknown][]) ?? []) {
          if (key === "ca") gs = { ...gs, alpha: Number(value) };
        }
      } else if (fn === pdfjs.OPS.beginGroup) {
        groupAlpha.push(groupAlpha[groupAlpha.length - 1] * gs.alpha);
      } else if (fn === pdfjs.OPS.endGroup) {
        if (groupAlpha.length > 1) groupAlpha.pop();
      } else if (fn === pdfjs.OPS.clip || fn === pdfjs.OPS.eoClip) {
        clipPending = true; // pdf.js gives the clip before the path it clips to
      } else if (SHOW_TEXT.has(fn) && inks(args[0])) {
        // Faint is invisible: at a tenth of full alpha or less (text is drawn at 0.87).
        const alpha = gs.alpha * groupAlpha[groupAlpha.length - 1];
        const hidden = gs.mode % 4 === 3 || alpha <= 0.1;
        if (hidden) obs.invisibleTextPages.add(p);
        else {
          const c = contrast(gs.fill, alpha);
          obs.lowestContrast = Math.min(obs.lowestContrast, c);
          if (c < MIN_CONTRAST) obs.lowContrastPages.add(p);
        }
      } else if (fn === pdfjs.OPS.paintImageXObject) {
        obs.imagePaints++;
        imagesHere++;
        drew = true;
        // The image is the unit square under the transform. One that runs past the page's edge
        // is cut by the page break: the whole image is drawn on each page and each shows part.
        // A count could not see it when a lost image elsewhere made the totals agree (class B).
        const box = place([0, 0, 1, 1], gs.m);
        if (box[1] < -1 || box[3] > pageH + 1 || box[0] < -1 || box[2] > pageW + 1) {
          obs.cutImagePages.add(p);
        }
        // Drawn, but not seen: under 2 pt on a side, or less than half inside its clip.
        const seen = gs.clip === null ? box : meet(box, gs.clip);
        if (box[2] - box[0] < 2 || box[3] - box[1] < 2 || area(seen) < 0.5 * area(box)) {
          obs.hiddenImagePages.add(p);
        }
      } else if (fn === pdfjs.OPS.constructPath) {
        drew = true;
        const minMax = args[2] as ArrayLike<number> | null | undefined;
        if (clipPending && minMax && minMax.length === 4) {
          const box = place([minMax[0], minMax[1], minMax[2], minMax[3]], gs.m);
          gs = { ...gs, clip: gs.clip === null ? box : meet(gs.clip, box) };
        }
        clipPending = false;
      }
    });
    obs.imagesPerPage.push(imagesHere);

    // Items are text runs or marked-content markers; only the former have text.
    const items = (await page.getTextContent()).items;
    const text = pageText(items);
    // Text too small to read is still in the text layer: 0.17 pt and a `scale(0.01)` passed
    // every word check (class B, re-check 2). The size is the item's smaller axis on the page.
    for (const raw of items) {
      const it = raw as { str?: string; transform?: number[] };
      if (typeof it.str !== "string" || !/\S/.test(it.str) || !Array.isArray(it.transform))
        continue;
      const [a, b, c, d] = it.transform;
      const size = Math.min(Math.hypot(a, b), Math.hypot(c, d));
      obs.smallestText = Math.min(obs.smallestText, size);
      if (size < MIN_TEXT_PT) obs.tinyTextPages.add(p);
    }

    obs.text += `${text}\n`;
    obs.pageTexts.push(text);
    if (text.trim().length === 0 && !drew) obs.blankPages.push(p);

    // These two patterns are specific to the SkyCiv diagram, which prints its
    // title at the top and its axis caption at the bottom -- landing on
    // different pages means the drawing was cut in half. A template that labels
    // its diagrams differently makes this check find nothing, so the count is
    // reported rather than assumed; zero means it did not run, not that
    // everything is fine.
    if (/Displacements\s*z-axis/i.test(text)) obs.diagramTitlePages.push(p);
    if (/Position\s*along\s*member/i.test(text)) obs.diagramAxisPages.push(p);
    // Paired in reading order, not by page: each title opens a diagram, its caption closes it,
    // and one still open at the page's end was cut. By page, two titles and one caption on a page
    // hid the second diagram's split (class B).
    for (const m of text.matchAll(/Displacements\s*z-axis|Position\s*along\s*member/gi)) {
      if (/^Displacements/i.test(m[0])) openDiagrams++;
      else if (openDiagrams > 0) openDiagrams--;
    }
    if (openDiagrams > 0) {
      obs.cutDiagramPages.push(p);
      openDiagrams = 0;
    }

    // Report headings are template-specific too, but this one fails loudly:
    // no match means the count will not equal the number of sources.
    if (/MEMBER\s*#?\s*\d+\s*DESIGN\s*REPORT/i.test(text)) obs.headingPages.push(p);
  }

  return obs;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// The baked document is written beside the PDF, under the PDF's name.
const outputHtml = `${outputPdf.replace(/\.pdf$/i, "")}.html`;

// Files this tool owns are never inputs. The browser example sits beside the
// reports; ingesting it as a report would inflate the build. Everything else in
// the folder is treated as a report, so keep other HTML out of it.
//
// The baked document is NOT excluded by name. It used to be, wherever the output
// was, so `reports out/member_3_report.pdf` silently dropped
// reports/member_3_report.html from the package -- and from both sides of the
// verification, so the build still passed. The scan is one level deep and
// filters to files, so an output folder inside the input one (CompiledPDF/) is
// never visible to it; only an output written INTO the input folder can collide,
// and that is handled below by content, not by name.
const TOOL_OWNED = new Set(["browser_example.html"]);

// A real path as a comparison key: one separator, no trailing one, one case.
// Case-folding everywhere is the conservative direction: on a case-sensitive
// filesystem it can only refuse a build, never let one overwrite a report.
const pathKey = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** A document this tool baked: its fixed title and its first report wrapper. */
const isBakedDocument = (html: string) =>
  html.includes("<title>Combined Design Report</title>") &&
  html.includes('<div class="report-sheet rs0">');

// Now that the defaults come from the working directory, "ran it from the wrong
// folder" is the ordinary mistake, and a raw ENOENT stack trace is a poor way to
// report it. Name the folder that is missing and how to point at another one.
// Initialised rather than left definite-assigned: the catch exits, but that
// relies on control-flow analysis seeing through a namespaced never-returning
// call, which is not worth depending on.
let allHtml: string[] = [];
const contents = new Map<string, string>();
/** The zip's bytes as read: the PDF is added to THESE, and only if the file still holds them. */
let zipBytes: Uint8Array = new Uint8Array(0);
/** The PDF an earlier run added to the zip (found by its mark), or null. */
let zipOwnPdf: string | null = null;
if (zipPath !== null) {
  try {
    zipBytes = await rt.readFile(zipPath);
    const read = await readZipReports(zipBytes, zipPdfName);
    zipOwnPdf = read.own;
    for (const r of read.reports) {
      allHtml.push(r.name);
      contents.set(r.name, r.html);
    }
  } catch (e) {
    const why = (e as Error).message;
    console.error(`Cannot compile this zip:\n  ${zipPath}\n`);
    console.error(why);
    // The layout hint only where the layout is the problem: a zip locked by another program (EBUSY)
    // or a report in another charset was told "a SkyCiv export is a flat set of reports".
    if (/more than a flat set of reports/.test(why)) {
      console.error(`\nA SkyCiv export is a flat set of member_*.html reports.`);
    }
    console.error("Nothing was changed.");
    rt.exit(1);
  }
} else {
  try {
    allHtml = (await rt.listFiles(htmlDir)).filter((n) => n.toLowerCase().endsWith(".html"));
  } catch {
    console.error(`No such folder:\n  ${htmlDir}\n`);
    if (positional[0]) {
      console.error("Check the path given as the first argument.");
      console.error("If it contains spaces, wrap the whole path in quotes.");
    } else {
      console.error(`Nothing to compile here. Either:`);
      console.error(`  - run this from the folder holding your member_*.html reports, or`);
      console.error(`  - run it from a folder containing ${INPUT_DIR}/, or`);
      console.error(`  - give the folder as an argument: s3d-reportcompiler "<path to reports>"`);
    }
    console.error(`\nRun with --help for examples.`);
    rt.exit(1);
  }

  // Every ".html" entry is accounted for: compiled, or reported as skipped below. One that is not a
  // readable file -- a folder named *.html, a broken link -- is refused here: it is a report the
  // package would otherwise lack without a word (a linked report was missing that way, with PASS).
  const unreadable = (await rt.listNames(htmlDir)).filter(
    (n) => n.toLowerCase().endsWith(".html") && !allHtml.includes(n),
  );
  if (unreadable.length > 0) {
    console.error(`Not a readable report file (a folder, or a broken link?):`);
    for (const n of unreadable) console.error(`  ${rt.joinPath(htmlDir, n)}`);
    console.error(`\nEvery .html in the input folder is a report. Fix or move these, then re-run.`);
    rt.exit(1);
  }
  // A report saved as `.htm` is still a report: left out, the package lacked it with PASS (12 of 13
  // compiled), where the zip path refuses it (2026-11-07 review 4).
  // `.shtml`, `.mhtml` / `.mht` (a browser's "save as single file") too: each was left out the same
  // way, with PASS (review 5).
  const htm = (await rt.listNames(htmlDir)).filter((n) =>
    /\.(?:htm|xhtml|shtml|mhtml|mht)$/i.test(n),
  );
  if (htm.length > 0) {
    console.error(`Not compiled, and not a report name this tool reads (.html):`);
    for (const n of htm) console.error(`  ${rt.joinPath(htmlDir, n)}`);
    console.error(
      `\nRename each report to .html, or move the file out of the folder, then re-run.`,
    );
    rt.exit(1);
  }

  // Read once, here: every input is needed below to tell reports from previous
  // bakes, and again to compile. As bytes, decoded by decodeReport -- as the zip's entries are: a
  // lenient UTF-8 read turned a Windows-1252 report's "²" into U+FFFD on BOTH sides of the
  // verification, and it passed (2026-11-07 review). Every unreadable one is named.
  const undecodable: string[] = [];
  for (const name of allHtml) {
    const file = rt.joinPath(htmlDir, name);
    if (TOOL_OWNED.has(name.toLowerCase())) {
      contents.set(name, await rt.readTextFile(file)); // skipped below, never compiled
      continue;
    }
    try {
      contents.set(name, decodeReport(await rt.readFile(file), name));
    } catch (e) {
      undecodable.push((e as Error).message);
    }
  }
  if (undecodable.length > 0) {
    console.error("Cannot read these reports as the text a browser shows:");
    for (const m of undecodable) console.error(`  ${m}`);
    console.error("\nNothing was changed. Re-save them as UTF-8 (SkyCiv's own exports are).");
    rt.exit(1);
  }
}

// A previous run's baked document is never an input, WHATEVER its name: a bake
// left in the folder by a run named a.pdf would otherwise be compiled into a run
// named b.pdf as one more "report" -- every report twice, and verification
// passes, because the copy is on both sides of it. Recognised by content.
const bakedLeftovers = new Set(allHtml.filter((n) => isBakedDocument(contents.get(n) ?? "")));

// An output must never land on a source report: the baked HTML would overwrite
// it (and --no-keep-html then delete it), and an output named *.html would be
// deleted as a "stale PDF" before Chrome writes over it. Compared by REAL path,
// not by spelling: a junction, symlink, subst drive or 8.3 name reaching the
// input folder another way still names the same file. An output path that does
// not exist yet cannot overwrite anything. Only a previous bake may be replaced,
// and only by the baked HTML.
// By file identity too (device + file number): a hard link names the same file under another
// path, which no real-path comparison can see (2026-11-06).
// A zip's reports are not files, so nothing on disk can be one of them (the zip itself is never
// written until the end, and then only by the rename of a checked copy).
const inputByRealPath = new Map<string, string>();
const inputByIdentity = new Map<string, string>();
for (const name of zipPath === null ? allHtml : []) {
  const path = rt.joinPath(htmlDir, name);
  inputByRealPath.set(pathKey(await rt.realPath(path)), name);
  const id = await rt.fileIdentity(path);
  if (id !== null) inputByIdentity.set(id, name);
}
for (const out of zipPath === null ? new Set([outputPdf, outputHtml]) : []) {
  let real: string;
  try {
    real = pathKey(await rt.realPath(out));
  } catch {
    continue; // nothing there yet
  }
  const id = await rt.fileIdentity(out);
  const name = inputByRealPath.get(real) ?? (id === null ? undefined : inputByIdentity.get(id));
  if (name === undefined) continue;
  if (out === outputHtml && out !== outputPdf && bakedLeftovers.has(name)) continue;
  console.error(`The output would overwrite a source report:\n  ${rt.joinPath(htmlDir, name)}\n`);
  console.error("Every .html in the input folder is a report. Choose an output name that is");
  console.error("not one of them, or write the output to another folder (the default is");
  console.error(`${OUTPUT_DIR}/ under the working directory).`);
  rt.exit(1);
}

// The baked HTML is written beside the PDF, under its name, and replaced -- or deleted, with
// --no-keep-html. A file of that name that is not a previous bake is the user's: `reports
// site/index.pdf` replaced site/index.html, and with --no-keep-html deleted it (2026-11-06 review;
// only the zip build checked). Both builds refuse now.
if ((await rt.fileExists(outputHtml)) && !isBakedDocument(await rt.readTextFile(outputHtml))) {
  console.error(`A file the build would overwrite is already there:\n  ${outputHtml}\n`);
  console.error(
    "It is not a document this tool baked. Move or rename it (or choose another output",
  );
  console.error("name), then re-run.");
  rt.exit(1);
}

const entries = sortReportNames(
  allHtml.filter((n) => !TOOL_OWNED.has(n.toLowerCase()) && !bakedLeftovers.has(n)),
);

if (entries.length === 0) {
  // Reaching here without positional[0] means the working directory had no
  // nested input folder AND no reports of its own. Someone who runs the command
  // in the wrong place gets the whole usage text, not a one-line rebuke -- this
  // is the most likely first experience of the tool going wrong.
  console.error(`No .html reports found in:\n  ${zipPath ?? htmlDir}\n`);
  if (zipPath !== null) {
    console.error(`The zip holds no .html reports. Nothing was changed.`);
  } else if (!positional[0]) {
    console.error(`Looked for a ${INPUT_DIR}/ folder here, then for *.html here.\n`);
    console.error(helpText());
  } else {
    console.error(`That folder exists but holds no .html files.`);
    console.error(`Run with --help for examples.`);
  }
  rt.exit(1);
}

// The output folder is part of the layout, not something the user has to
// pre-create -- and Chrome will not create a missing directory for
// --print-to-pdf, it just fails and still exits 0. Created under the working
// directory by default, and only once there is actually something to compile.
const outputDir = outputPdf.replace(/[\\/][^\\/]*$/, "");

const skipped = allHtml.length - entries.length;

const chrome = await rt.findChrome();
if (!chrome) {
  console.error("Could not find Google Chrome or Microsoft Edge.\n");
  console.error("One of them does the rendering, so it has to be installed. If you");
  console.error("already have one somewhere non-standard, point at the executable:\n");
  console.error(`  Windows   set CHROME_PATH=C:\\Path\\To\\chrome.exe`);
  console.error(
    `  macOS     export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`,
  );
  console.error(`  Linux     export CHROME_PATH=/usr/bin/chromium`);
  rt.exit(1);
}

console.log(`Compiling ${entries.length} report(s) on ${rt.RUNTIME}`);
if (zipPath !== null) {
  console.log(
    `  zip:      ${rt.baseName(zipPath)}, ${allHtml.length} report entr${allHtml.length === 1 ? "y" : "ies"}` +
      (zipOwnPdf === null ? "" : `, and ${zipOwnPdf} from an earlier run (it will be replaced)`),
  );
}
if (skipped > 0) {
  console.log(`  skipped:  ${skipped} tool-owned .html file(s)`);
  for (const name of bakedLeftovers) console.log(`            ${name} (a previous bake)`);
  // Named too: a real report of that name would otherwise drop out under a count alone.
  for (const name of allHtml.filter((n) => TOOL_OWNED.has(n.toLowerCase()))) {
    console.log(`            ${name} (the browser example, skipped by name)`);
  }
}

const sources: string[] = [];
const bodies: string[] = [];
const styles: string[] = [];

const unbakeable: string[] = [];
for (let i = 0; i < entries.length; i++) {
  const src = contents.get(entries[i]) ?? "";
  sources.push(src);

  // Every report carries its own stylesheet, scoped to its own wrapper, and its
  // own id namespace, so reports that disagree about CSS or ids cannot
  // interfere with one another.
  styles.push(bakeStyle(src, `.rs${i}`, `r${i}-`));
  // A report whose maths delimiters cannot be read is refused by name, every one of them, as an
  // unreadable file is (a config only running it could tell; roadmap task 18 item 1).
  try {
    bodies.push(bakeBody(src, `r${i}-`));
  } catch (e) {
    if (!/^cannot read its maths delimiters/.test((e as Error).message)) throw e;
    unbakeable.push(`${entries[i]}: ${(e as Error).message}`);
  }
}
if (unbakeable.length > 0) {
  console.error("Cannot tell which maths delimiters these reports use:");
  for (const m of unbakeable) console.error(`  ${m}`);
  console.error(
    "\nNothing was written. Give the report a literal tex2jax config (SkyCiv's own exports have one).",
  );
  rt.exit(1);
}

console.log(`  delims:   ${[...delimSignatures][0] ?? "none"}`);
if (delimSignatures.size > 1) {
  console.warn(`  warning: reports declare ${delimSignatures.size} different delimiter sets`);
}
for (const skipped of skippedDelims) {
  console.warn(
    `  warning: refused degenerate delimiter "${skipped}" -- it would match ordinary prose`,
  );
}
for (const selector of svgStyleWarnings) {
  console.warn(
    `  warning: SVG rule "${selector}" could not be hoisted; its <style> block was moved to ` +
      `its report's stylesheet (in HTML it applies to the whole page)`,
  );
}

console.log(`  math:     ${mathStats.converted} expressions, ${mathStats.failed} failed`);
if (mathStats.failed > 0) console.warn(`  first failure: ${mathStats.firstFailure}`);

// Every removal and rewrite is reported. For a certified calculation package,
// "nothing was lost" has to be auditable rather than assumed.
console.log(
  `  audit:    ${audit.loadersRemoved} loader(s) removed, ` +
    `${audit.visibilityNeutralised} visibility gate(s) opened, ` +
    `${audit.heightNeutralised} height:100% relaxed, ` +
    `${audit.atPageDropped} @page rule(s) superseded, ` +
    `${audit.strayTokensDropped} stray CSS token(s) cleaned`,
);
if (audit.bodyTagMissing > 0) {
  console.warn(`  warning: ${audit.bodyTagMissing} report(s) had no <body>; whole file used`);
}
// The rest of what the bake removes or moves -- printed only when it removed something, so an
// ordinary build's output is unchanged.
const removed = [
  [bakeRemovals.activeAttributes, "event handler(s) / javascript: URL(s)"],
  [bakeRemovals.metaBaseTags, "<meta>/<base> tag(s) in a body"],
  [bakeRemovals.blocklessAtRules, "@import/@charset/@namespace rule(s)"],
  [bakeRemovals.atRules, "CSS at-rule(s) that cannot be scoped"],
  [bakeRemovals.bodySheetsMoved, "body <style> block(s) moved into the scoped sheet"],
  [bakeRemovals.noscript, "<noscript> element(s), which a browser does not draw"],
] as const;
if (removed.some(([n]) => n > 0)) {
  console.log(
    `  removed:  ${removed
      .filter(([n]) => n > 0)
      .map(([n, what]) => `${n} ${what}`)
      .join(", ")}`,
  );
}
for (const rule of cssWarnings) {
  console.warn(`  warning: CSS "${rule}" cannot be scoped to its report; it was left out`);
}
for (const warning of bakeWarnings) console.warn(`  warning: ${warning}`);

/**
 * Said with a refusal before the render: a PDF already at the output name is an EARLIER build's.
 * It is left (a refusal deletes nothing), but it does not reflect these reports, and a reader
 * finding it beside a failed run could take it for this one (2026-11-06 review).
 */
async function noteEarlierPdf(): Promise<void> {
  const earlier = zipPath === null ? outputPdf : zipKeptPdf;
  if (await rt.fileExists(earlier)) {
    console.error(
      `\nThe PDF already at\n  ${earlier}\nis from an earlier build. It was not replaced,`,
    );
    console.error("and it does NOT reflect the reports as they are now.");
  }
}

const leftovers = findLeftoverMath(bodies.join(""));
if (leftovers.length > 0 || mathStats.failed > 0) {
  console.error("");
  console.error("ERROR: unrendered mathematics reached the baked document.");
  if (mathStats.failed > 0) console.error(`  ${mathStats.failed} expression(s) failed to typeset`);
  for (const l of leftovers) console.error(`  ${l}`);
  console.error("");
  console.error("These are sealed engineering calculations; refusing to emit a PDF");
  console.error("containing raw LaTeX. Check the reports' tex2jax configuration.");
  await noteEarlierPdf();
  rt.exit(1);
}

// Cached in the working directory, not inside the input folder: that folder
// should contain reports and nothing else.
let mathCss = "";
try {
  mathCss = await inlineFonts(
    mathStyleSheet(),
    rt.joinPath(workingDir || htmlDir, ".mathjax-fonts"),
  );
} catch (e) {
  console.error(`\nERROR: the maths fonts could not be loaded.\n  ${(e as Error).message}\n`);
  console.error("The first build downloads them once into .mathjax-fonts/ in this folder; later");
  console.error("builds work offline. Check the network (or a login page on it) and that this");
  console.error("folder is writable, then re-run.");
  await noteEarlierPdf();
  rt.exit(1);
}

const combinedHtml = assembleDocument(bodies, styles, mathCss);

// The reference guard (findBrokenReferences, in the core since 2026-11-06 so the browser path runs
// it too): a reference that resolved in its own source must still resolve in its bake, or a
// gradient, clip or arrowhead silently vanishes -- and the PDF checks below cannot see that.
{
  const check = findBrokenReferences(
    sources.map((source, i) => ({ source, style: styles[i], body: bodies[i], prefix: `r${i}-` })),
  );
  const broken = check.broken.map((b) => `${entries[b.report]}: #${b.target}`);
  console.log(
    `  refs:     ${check.references} id reference(s), ${check.unresolved} unresolved, ` +
      `${broken.length} broken by the bake`,
  );
  if (broken.length > 0) {
    console.error("");
    console.error("ERROR: the bake broke id references that resolved in the sources.");
    console.error(`  broken: ${broken.slice(0, 10).join(", ")}`);
    console.error("");
    console.error("A graphic's gradient, clip path or marker would silently vanish; refusing");
    console.error("to emit a PDF. Every renamed id must carry its references with it.");
    await noteEarlierPdf();
    rt.exit(1);
  }
}

// Every way of writing a reference to another host: an attribute quoted either way or bare,
// `srcset`, `url(…)` in a sheet or a style, `//host/…` as much as `https://…`. It used to count
// double-quoted `href="http…"` / `src="http…"` only (1 of 7 spellings). The document's CSP blocks
// the loads themselves; this says how many the bake left.
const externalRefs =
  (
    combinedHtml.match(
      /(?<![\w:-])(?:src|href|srcset|poster|data|action|formaction|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\//gi,
    ) ?? []
  ).length + (combinedHtml.match(/url\(\s*["']?\s*(?:https?:)?\/\//gi) ?? []).length;
// Event-handler attributes are scripts too; the bake removes them, so any left is a bake bug.
const scripts =
  (combinedHtml.match(/<script/gi) ?? []).length +
  (combinedHtml.match(/<[a-zA-Z](?:"[^"]*"|'[^']*'|[^"'<>])*>/g) ?? []).filter((tag) =>
    // Quoted values removed first, so "on…=" inside one is text; read whole, so a ">" inside an
    // earlier value does not hide a handler after it.
    /\son[a-z]+\s*=/i.test(tag.replace(/"[^"]*"|'[^']*'/g, '""')),
  ).length;
if (externalRefs > 0 || scripts > 0) {
  console.warn(
    `  warning: baked HTML still has ${scripts} script(s) and ${externalRefs} external ref(s)`,
  );
}

/** Root (uid 0) on a POSIX host: the one case Chrome needs `--no-sandbox` to start. */
const runningAsRoot =
  typeof process !== "undefined" && typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Whether Chrome's sandbox is turned off: as root (it cannot start with one there), or when
 * `S3D_CHROME_NO_SANDBOX=1` asks -- for a host where Chrome finds no usable sandbox as an ordinary
 * user (Ubuntu 24.04 restricts the user namespaces it needs). Off by default, and said when on.
 */
const noSandbox = runningAsRoot || sandboxOptOut;
if (noSandbox) {
  console.log(`  sandbox:  OFF (${runningAsRoot ? "running as root" : "S3D_CHROME_NO_SANDBOX"})`);
}

// Chrome prints to an UNVERIFIED name; only a passed verification (or an explicit --no-verify)
// gives the file its final one. A failed or crashed run used to leave a finished-looking PDF
// under the final name, "Created …" already printed (2026-11-06).
const candidatePdf = `${outputPdf.replace(/\.pdf$/i, "")}.unverified.pdf`;

// Chrome exits 0 even when printing fails, so "no file" is the only reliable
// failure signal -- but only if there is no file to begin with. A leftover PDF
// from an earlier run would otherwise be read back and reported as this run's
// output, turning a failed build into a silently stale one. So the old PDF must
// be GONE, not merely asked to go: removeQuietly swallows a failed delete, and a
// PDF open in a viewer on Windows cannot be deleted or written -- but can be read.
// From a zip the PDF never takes its final name on disk -- it goes into the zip -- so a file of
// that name beside the zip is the user's, and is left alone. But `<zip>.verified.pdf` is this
// tool's, from an earlier run whose zip update failed, and goes now, as the folder build's old PDF
// does: removed afterwards with removeQuietly, one held open in a viewer survived a later
// SUCCESSFUL build beside the new zip, still called "verified", without a word -- and a failed
// build left it unmentioned (2026-11-07 review).
for (const old of zipPath === null ? [outputPdf, candidatePdf] : [candidatePdf, zipKeptPdf]) {
  const existed = await rt.fileExists(old);
  await rt.removeQuietly(old);
  if (await rt.fileExists(old)) {
    console.error(`Could not remove the previous PDF:\n  ${old}\n`);
    console.error("It is probably open in a PDF viewer. Close it and run again.");
    // Said of what this file IS (review 4): Chrome never writes the zip's kept PDF, so "Chrome
    // could not write the new one" was wrong for it.
    console.error(
      old === zipKeptPdf
        ? "(An earlier build kept it beside the zip when its zip update failed; left in place, it\n" +
            "would still be called verified beside a zip that this build changes.)"
        : "(Left in place, Chrome could not write the new one, and the old one would be\n" +
            "read back as this run's output.)",
    );
    rt.exit(1);
  }
  // Removed with a word: it was an earlier build's verified PDF, and it is gone now.
  if (existed && old === zipKeptPdf) {
    console.log(
      `  removed:  ${zipKeptPdf}\n            (an earlier build's PDF, kept when its zip update failed)`,
    );
  }
}

// Created only now that there is something to write: a build refused earlier used to leave an
// empty output folder behind.
if (outputDir && outputDir !== outputPdf) {
  try {
    await rt.mkdirp(outputDir);
  } catch (e) {
    // A message, not a stack trace (review 4): a read-only drive, a file where a folder must go.
    console.error(`Cannot create the output folder:\n  ${outputDir}\n  ${(e as Error).message}\n`);
    console.error("Give an output path in a folder that can be written, then re-run.");
    rt.exit(1);
  }
}

// Only the Chrome profile needs to be temporary now. The baked document is a
// build artifact in its own right and belongs beside the PDF it produced.
const workDir = await rt.makeTempDir("compiled_reports_");
/** The updated zip while it is being written and checked, beside the original. */
let zipPartial: string | null = null;

// Ctrl-C (or a kill) during the build: Chrome is stopped too -- a SIGTERM sent to this process
// alone left it running, still able to write its PDF afterwards -- and the temp profile, the
// partial zip and the unverified PDF are removed (66 old profiles had collected in the temp
// folder). Always exit 130: the build used to carry on while cleanup ran, and end with 1 or 130
// depending on which finished first (2026-11-06 review).
const interrupt = new AbortController();
/**
 * From the first final rename on ({@link finalRename}), an interrupt is HELD: the build finishes
 * and then exits 130, naming what was given its final name ({@link finalNames}). The hold covered
 * the rename call alone, so an interrupt during the cleanup after it said "nothing was finished"
 * of a PDF already named, and one during a rename that then FAILED said "this is complete" and
 * deleted the verified PDF (2026-11-07 review 5).
 */
let finalStage = false;
/** The signal held during the final stage, acted on when the build ends. */
let heldSignal: string | null = null;
/** Each path a final rename gave its name to, in order. */
const finalNames: string[] = [];
/** Chrome's run while it lasts: an interrupt waits for it to stop before cleaning up. */
let rendering: Promise<unknown> | null = null;
// Removed SYNCHRONOUSLY on an interrupt, then exit: an asynchronous cleanup let the build go on
// beside it -- reading back, repacking and rewriting the unverified PDF it had just removed, or
// writing a partial zip it had not been told of (review 5).
const { rmSync } = await import("node:fs");
const removeNow = (path: string, recursive = false) => {
  try {
    rmSync(path, { recursive, force: true, maxRetries: 3 });
  } catch {
    // best effort, as removeQuietly
  }
};
if (typeof process !== "undefined" && typeof process.once === "function") {
  // SIGHUP (the terminal closed, a dropped SSH session) and SIGQUIT too, on POSIX: Chrome runs in
  // a process group of its own there, so a hang-up of the build's group no longer reaches it, and
  // it wrote its PDF after the build had died (review 5). Windows has neither signal.
  const signals =
    process.platform === "win32"
      ? (["SIGINT", "SIGTERM"] as const)
      : (["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const);
  for (const signal of signals) {
    process.once(signal, () => {
      interrupt.abort(); // stops Chrome, if it runs
      if (finalStage) {
        if (heldSignal === null) {
          heldSignal = signal;
          console.error(`\nInterrupted (${signal}): finishing the last step first...`);
        }
        return;
      }
      const cleanUp = () => {
        console.error(
          `\nInterrupted (${signal}): nothing was given its final name. Cleaning up...`,
        );
        removeNow(workDir, true);
        if (zipPartial !== null) removeNow(zipPartial);
        removeNow(candidatePdf);
        rt.exit(130);
      };
      // While Chrome runs, wait for it to stop (it was just told to), so it cannot write the PDF
      // after the cleanup; bounded, in case it will not die.
      if (rendering === null) cleanUp();
      else
        void Promise.race([rendering, new Promise((d) => setTimeout(d, 10_000))]).finally(cleanUp);
    });
  }
}

/**
 * Stop here, for good, once interrupted: the signal handler cleans up and exits 130. Called before
 * each step that gives something its final name -- an interrupt after Chrome finished (during the
 * verification or the zip write) used to let the build rename the PDF or replace the zip while the
 * cleanup ran, and then say "nothing was finished" (2026-11-07 review).
 */
async function haltIfInterrupted(): Promise<void> {
  if (interrupt.signal.aborted) await new Promise(() => {});
}

/**
 * `rt.rename(from, to)`, a step that gives something its final name: from here on an interrupt is
 * held to the end of the build ({@link finalStage}), and `to` is recorded once the rename is DONE.
 */
async function finalRename(from: string, to: string): Promise<void> {
  await haltIfInterrupted();
  finalStage = true;
  await rt.rename(from, to);
  finalNames.push(to);
}

// Set inside the try and acted on after the finally: rt.exit() is process.exit(),
// which skips finally blocks, so exiting in place left the temp Chrome profile
// behind on every failed verification.
let verificationFailed = false;
let zipFailed = false;
let buildFailed = false;

/**
 * Add the verified PDF to the zip, or say why not and leave the zip exactly as it was. The zip is
 * updated only if it still holds the bytes the reports were read from; the new one is written
 * beside it, read back and checked against the original by the core's independent check
 * ({@link checkZipUpdate}), and only then renamed over it -- one step, so there is never a
 * half-written zip under the real name. Returns false if the zip was not updated; the verified PDF
 * is then kept beside the zip.
 */
async function addPdfToZip(zip: string, pdfPath: string, htmlPath: string): Promise<boolean> {
  const pdfBytes = await rt.readFile(pdfPath);
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  let problem = "";
  /** Past the rename the zip IS the new one: a later failure must not say "unchanged". */
  let replaced = false;
  try {
    if (!same(await rt.readFile(zip), zipBytes)) {
      problem = "the zip changed while the build ran (re-run on the zip as it is now)";
    } else {
      zipPartial = `${zip}.partial`;
      await rt.writeFile(zipPartial, zipWithFile(zipBytes, zipPdfName, pdfBytes, new Date()));
      const written = await rt.readFile(zipPartial);
      const failures = await checkZipUpdate(zipBytes, written, zipPdfName, pdfBytes);
      if (failures.length > 0) {
        problem = `the updated zip failed its check:\n${failures.map((f) => `    - ${f}`).join("\n")}`;
      } else {
        try {
          await finalRename(zipPartial, zip);
          zipPartial = null;
          replaced = true;
        } catch (e) {
          problem = `the zip could not be replaced -- is it open in another program? (${(e as Error).message})`;
        }
        if (replaced && !same(await rt.readFile(zip), written)) {
          problem = "the zip on disk is not the one that was checked";
        }
      }
    }
  } catch (e) {
    problem = (e as Error).message;
  }
  if (problem) {
    if (zipPartial !== null) await rt.removeQuietly(zipPartial);
    zipPartial = null;
    // The PDF passed: kept under ONE fixed name (an earlier one was removed before the render),
    // never under the zip's own name, where a stale copy outlived later builds.
    await finalRename(pdfPath, zipKeptPdf);
    console.error("");
    if (replaced) {
      console.error(
        `The PDF PASSED and the zip WAS replaced, but reading it back failed: ${problem}`,
      );
      console.error("Check the zip before issuing it, or re-run the build on it.");
    } else {
      console.error(`The PDF PASSED, but it was NOT added to the zip: ${problem}`);
      console.error("The zip is unchanged.");
    }
    console.error(`The verified PDF is kept at:\n  ${zipKeptPdf}`);
    return false;
  }
  await rt.removeQuietly(pdfPath);
  if (!keepHtml) await rt.removeQuietly(htmlPath);
  console.log(
    `\nAdded ${zipPdfName} to ${zip}` +
      (zipOwnPdf === null ? "" : ` (replacing ${zipOwnPdf}, from an earlier run)`),
  );
  console.log(`  checked:  every report entry unchanged, the PDF entry byte-identical`);
  if (keepHtml) console.log(`Kept ${htmlPath}`);
  return true;
}

try {
  // Both outputs live in the output directory: the baked HTML is the exact
  // input Chrome was given, so keeping it next to the PDF is what makes a
  // result reproducible and inspectable after the fact.
  const htmlPath = outputHtml;

  // Encode once: String.length counts UTF-16 code units, not bytes, so
  // reporting it as a size would understate anything non-ASCII.
  const htmlBytes = new TextEncoder().encode(combinedHtml);
  await rt.writeFile(htmlPath, htmlBytes);
  console.log(`  html:     ${(htmlBytes.length / 1e6).toFixed(2)} MB, self-contained`);

  // The old PDF was removed, and proved gone, before the bake was written.
  const htmlUrl = await rt.toFileUrl(htmlPath);
  rendering = rt.runWithTimeout(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      // No script runs in the render: the bake strips scripts and handlers, and the document itself
      // forbids scripting (its Content-Security-Policy, assembleDocument). Not by a Chrome flag:
      // `--blink-settings=scriptEnabled=false` makes --print-to-pdf write NO file (measured
      // 2026-11-06, Chrome; exit 0, empty stderr).
      // Chrome's sandbox stays on, except as root (a container), where Chrome cannot start with it.
      // It used to be off everywhere, justified as "the input is a document this script generated
      // itself" -- but the bake is made from whatever reports are in the folder (2026-11-06).
      ...(noSandbox ? ["--no-sandbox"] : []),
      "--no-first-run",
      "--disable-extensions",
      // Chrome refuses to start against a profile already in use.
      `--user-data-dir=${rt.joinPath(workDir, "profile")}`,
      `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
      "--run-all-compositor-stages-before-draw",
      "--no-pdf-header-footer",
      `--print-to-pdf=${candidatePdf}`,
      htmlUrl,
    ],
    chromeTimeoutMs,
    interrupt.signal,
  );
  const result = (await rendering) as Awaited<ReturnType<typeof rt.runWithTimeout>>;
  rendering = null;
  // An interrupt is handled by its signal handler (cleanup, then exit 130); this flow stops here.
  await haltIfInterrupted();
  if (result.timedOut) {
    const limit =
      chromeTimeoutMs < 1000 ? `${chromeTimeoutMs} ms` : `${Math.round(chromeTimeoutMs / 1000)} s`;
    throw new Error(
      `Chrome did not finish within ${limit} and was stopped. ` +
        `A larger document may need more: set S3D_CHROME_TIMEOUT_MS (milliseconds).`,
    );
  }
  let rendered: Uint8Array;
  try {
    rendered = await rt.readFile(candidatePdf);
  } catch {
    // Said in plain words when the cause is the sandbox: its own message is easy to miss.
    const sandboxHint = /no usable sandbox|sandbox/i.test(result.stderr)
      ? "\nChrome could not start its sandbox here. If this host cannot provide one to an " +
        "ordinary user, set S3D_CHROME_NO_SANDBOX=1 for this build (the reports' own code is " +
        "still blocked: the bake strips it and the document forbids scripts)."
      : "";
    // Exit 0 and no file: the usual sign of a CHROME_PATH that names a launcher, which starts the
    // browser and exits before it has printed (review 4).
    const launcherHint =
      result.code === 0 && rt.env("CHROME_PATH")
        ? "\nCHROME_PATH must name the browser program itself, not a script that starts it and exits."
        : "";
    throw new Error(
      `Chrome produced no PDF (exit status ${result.code}).\n${result.stderr.trim()}${sandboxHint}${launcherHint}`,
    );
  }
  // Chrome's exit status counts too, even with a PDF written: it was never read, so a Chrome that
  // crashed after writing one still ended in "Created" under --no-verify (2026-11-06 review).
  if (result.code !== 0) {
    throw new Error(
      `Chrome wrote a PDF but exited with status ${result.code}, so the PDF cannot be trusted.\n` +
        result.stderr.trim(),
    );
  }

  console.log(`  rendered: ${(rendered.length / 1e6).toFixed(2)} MB`);

  // Parse once. The page count is available from the same document we repack,
  // so re-loading the saved bytes just to count pages would parse it twice.
  const pdf = await PDFDocument.load(rendered, { updateMetadata: false });
  const pageCount = pdf.getPageCount();

  let final = rendered;
  if (optimize) {
    final = await pdf.save({ useObjectStreams: true });
    await rt.writeFile(candidatePdf, final);
    console.log(
      `  packed:   ${(final.length / 1e6).toFixed(2)} MB ` +
        `(${((1 - final.length / rendered.length) * 100).toFixed(0)}% smaller)`,
    );
  }

  console.log(`\n${pageCount} pages, ${(final.length / 1e6).toFixed(2)} MB`);

  // Read back from disk rather than trusting anything held in memory: the
  // artifact that ships is the one that gets checked.
  if (verify) {
    console.log("\nVerifying against the source reports...");

    const expected = extractSourceTokens(sources);
    const observed = await readPdf(candidatePdf);
    const check = compareAgainstPdf(expected, observed, entries.length);

    console.log(
      `  checked:  ${expected.words.size} words, ${expected.numbers.size} numbers ` +
        `from ${entries.length} source(s)`,
    );
    console.log(
      `  missing:  ${check.missingWords.length} word(s), ${check.missingNumbers.length} number(s)`,
    );
    if (check.missingWords.length) console.log(`    ${check.missingWords.slice(0, 12).join(", ")}`);
    if (check.missingNumbers.length) {
      console.log(`    ${check.missingNumbers.slice(0, 12).join(", ")}`);
    }

    // The set-wide check above cannot see a value lost from one report but present in another;
    // this one checks every report against its own part of the PDF (verification.md, limit 1).
    const perReport = compareEachReport(sources, observed.pageTexts);
    const short = perReport.reports.filter((r) => r.missingWords.length || r.missingNumbers.length);
    if (!perReport.checked) {
      console.log(`  per-report: NOT checked -- ${perReport.reason}`);
      check.failures.push(`per-report check could not run: ${perReport.reason}`);
    } else if (short.length === 0) {
      console.log(
        `  per-report: ${entries.length}/${entries.length} reports hold all their own words and numbers`,
      );
    } else {
      console.log(
        `  per-report: ${short.length} of ${entries.length} report(s) missing their own content`,
      );
      for (const r of short.slice(0, 10)) {
        const lost = [...r.missingWords, ...r.missingNumbers].slice(0, 8).join(", ");
        console.log(
          `    ${entries[r.report]}: ${r.missingWords.length} word(s), ${r.missingNumbers.length} number(s) -- ${lost}`,
        );
      }
      check.failures.push(
        `content missing from its own report: ${short.map((r) => entries[r.report]).join(", ")}`,
      );
    }
    // Review class B (2026-11-08). Each of these used to pass behind a check that read totals or
    // pages: an image cut by a page break (seen by where it is drawn, so a lost image elsewhere
    // cannot cancel it); each report's own images; a diagram's title without its caption before
    // the page ends, in reading order; text drawn invisibly.
    if (observed.cutImagePages.size > 0) {
      check.failures.push(
        `an image was cut by a page break on page(s) ${[...observed.cutImagePages].join(", ")}`,
      );
    }
    if (observed.hiddenImagePages.size > 0) {
      check.failures.push(
        `an image drawn but not seen (under 2 pt, or mostly clipped) on page(s) ${[...observed.hiddenImagePages].join(", ")}`,
      );
    }
    if (observed.headingPages.length === entries.length) {
      const starts = observed.headingPages;
      sources.forEach((source, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] - 1 : observed.pages;
        // The first report owns the pages before its heading too (as compareEachReport reads it).
        const from = i === 0 ? 0 : starts[i] - 1;
        const drawn = observed.imagesPerPage.slice(from, end).reduce((a, b) => a + b, 0);
        const want = extractSourceTokens([source]).expectedImages;
        if (drawn !== want) {
          check.failures.push(`${entries[i]}: ${drawn} image paint(s), ${want} image(s) expected`);
        }
      });
    }
    // The package's order is the reader's: every report after the one before it, by the
    // verification's own reading order (task 18 item 7). The build sorts by its own rule; a change
    // to it, or an assembly that reorders, would otherwise ship a package out of order.
    const misordered = entries.flatMap((name, i) =>
      i > 0 && readingOrder(entries[i - 1], name) > 0 ? [`${entries[i - 1]} before ${name}`] : [],
    );
    if (misordered.length > 0) {
      check.failures.push(`reports out of reading order: ${misordered.slice(0, 5).join("; ")}`);
    }
    // Maths left as prose prints its delimiters: a declared pair around text in a report's own
    // pages means the bake never read it. The LaTeX check looks for the standard delimiters only;
    // a report's own -- `@@`, a bare `$` -- were looked for only as the BAKE read them, so a config
    // it could not read hid both sides at once (task 18 item 1).
    {
      const starts = observed.headingPages;
      const segmented = starts.length === entries.length;
      const printed: string[] = [];
      sources.forEach((source, i) => {
        const text = segmented
          ? observed.pageTexts
              .slice(
                i === 0 ? 0 : starts[i] - 1,
                i + 1 < starts.length ? starts[i + 1] - 1 : undefined,
              )
              .join("\n")
          : observed.text;
        for (const [open, close] of declaredDelimiters(source)) {
          const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (new RegExp(`${esc(open)}[^\\n]{0,200}?\\S[^\\n]{0,200}?${esc(close)}`).test(text)) {
            printed.push(`${entries[i]}: ${open}..${close}`);
          }
        }
      });
      if (printed.length > 0) {
        check.failures.push(
          `maths printed as prose, its delimiters shown -- ${[...new Set(printed)].join(", ")}`,
        );
      }
    }
    if (observed.cutDiagramPages.length > 0) {
      check.failures.push(`diagram cut on page(s) ${observed.cutDiagramPages.join(", ")}`);
    }
    // White or near-white text on a white page reads as nothing, yet passes every text check: it
    // FAILS, the loud direction -- a template with white text on a coloured band would fail here
    // until the background is read (roadmap task 18, item 4), never pass unseen.
    if (observed.lowContrastPages.size > 0) {
      check.failures.push(
        `text drawn in white or too light to read on page(s) ${[...observed.lowContrastPages].join(", ")} ` +
          `-- contrast ${observed.lowestContrast.toFixed(2)}:1 on a white page, under ${MIN_CONTRAST}:1`,
      );
    }
    if (observed.tinyTextPages.size > 0) {
      check.failures.push(
        `text too small to read on page(s) ${[...observed.tinyTextPages].join(", ")} ` +
          `-- ${observed.smallestText.toFixed(2)} pt, under ${MIN_TEXT_PT} pt`,
      );
    }
    if (observed.invisibleTextPages.size > 0) {
      check.failures.push(
        `text drawn invisibly on page(s) ${[...observed.invisibleTextPages].join(", ")}`,
      );
    }
    console.log(
      `  graphics: ${observed.imagePaints} image paint(s), ${expected.expectedImages} expected; ` +
        `${observed.diagramTitlePages.length} diagram(s) checked` +
        (observed.diagramTitlePages.length === 0
          ? " (none recognised -- diagram check did not run)"
          : check.splitDiagrams.length === 0
            ? ", intact"
            : ", SPLIT"),
    );
    console.log(
      `  legible:  lowest contrast ${observed.lowestContrast.toFixed(1)}:1 (floor ${MIN_CONTRAST}), ` +
        `smallest text ${Number.isFinite(observed.smallestText) ? observed.smallestText.toFixed(2) : "-"} pt (floor ${MIN_TEXT_PT})`,
    );
    console.log(
      `  latex:    ${check.leftoverLatex.length} surviving, ` +
        `${observed.headingPages.length}/${entries.length} reports, ` +
        `${observed.blankPages.length} blank page(s)`,
    );

    if (check.failures.length > 0) {
      console.error("");
      console.error("VERIFICATION FAILED");
      for (const f of check.failures) console.error(`  - ${f}`);
      console.error("");
      console.error("The PDF does not faithfully reproduce its sources. It was NOT given its");
      console.error("final name; it is kept for inspection, with the baked HTML Chrome was given:");
      console.error(`  ${candidatePdf}`);
      console.error(`  ${htmlPath}`);
      if (zipPath !== null) console.error(`The zip is unchanged.`);
      verificationFailed = true;
    } else {
      console.log("  PASS: every source word and number present, nothing split or unrendered.");
    }
  }

  // The final name only now: verified, or verification turned off by request. Same folder, so a
  // rename, never a copy across drives.
  await haltIfInterrupted();
  if (!verificationFailed && zipPath !== null) {
    zipFailed = !(await addPdfToZip(zipPath, candidatePdf, htmlPath));
  } else if (!verificationFailed) {
    await finalRename(candidatePdf, outputPdf);
    // Discarded only on request, and only after a good build -- on a failed one the baked
    // document is the first thing worth looking at (it used to be deleted before verifying).
    if (!keepHtml) await rt.removeQuietly(htmlPath);
    console.log(`\nCreated ${outputPdf}${verify ? "" : "  (NOT verified: --no-verify)"}`);
    if (keepHtml) console.log(`Kept ${htmlPath}`);
  }
} catch (e) {
  // Said as a message, not a stack trace: the cause (a timeout, a Chrome failure, a full disk) is
  // what the reader needs. Nothing was given its final name.
  console.error(`\nERROR: ${(e as Error).message ?? e}`);
  console.error("Nothing was given its final name.");
  buildFailed = true;
} finally {
  await rt.removeQuietly(workDir, true);
  if (zipPartial !== null) await rt.removeQuietly(zipPartial);
}

// An interrupt held through the final stage: the build has finished; say what it named, and exit
// 130 as any interrupted build does.
if (heldSignal !== null) {
  console.error(
    finalNames.length > 0
      ? `\nInterrupted (${heldSignal}) during the last step, which was finished first. ` +
          `Given its final name:\n${finalNames.map((n) => `  ${n}`).join("\n")}`
      : `\nInterrupted (${heldSignal}) during the last step; nothing was given its final name.`,
  );
  rt.exit(130);
}

if (verificationFailed || zipFailed || buildFailed) rt.exit(1);
