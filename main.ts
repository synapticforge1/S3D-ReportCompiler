#!/usr/bin/env -S deno run -A
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
//   deno run -A main.ts [htmlDir] [output.pdf] [options]
//   node          main.ts [htmlDir] [output.pdf] [options]
//   bun run       main.ts [htmlDir] [output.pdf] [options]
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
// can never see a build artifact of its own. Node and Bun need `npm install`
// first; Deno resolves the same dependencies without it.
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
  delimSignatures,
  extractSourceTokens,
  findLeftoverMath,
  MATHJAX_FONTS,
  mathStats,
  mathStyleSheet,
  type PdfObservations,
  skippedDelims,
  sortReportNames,
  svgStyleWarnings,
  VERSION,
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

THE SIMPLE WAY
  Open a terminal in the folder holding your member_*.html reports and run the
  command with no arguments. It finds them, and writes the result to a new
  CompiledPDF folder beside them:

      CompiledPDF/combined_report.pdf     <- the document
      CompiledPDF/combined_report.html    <- exactly what was sent to Chrome

  It also works one level up, from a folder containing HTMLFilesToBeCompiled/.

IF YOU WANT TO CHOOSE THE PATHS
  Quote anything containing spaces.

      s3d-reportcompiler "C:\\Jobs\\Gate Calcs\\Reports"
      s3d-reportcompiler "C:\\Jobs\\Gate Calcs\\Reports" "C:\\Jobs\\GateCalcs.pdf"

  The second argument names the PDF, and the folder above it is created if it
  does not exist.

OPTIONS
  --no-keep-html  delete the intermediate HTML, leaving only the PDF
  --no-optimize   skip the recompression pass (the PDF ends up ~2x larger)
  --no-verify     skip the check that nothing was lost. NOT ADVISABLE for a
                  document that will be issued or sealed -- the check is the
                  only thing proving a value was not silently dropped, and a
                  dropped value still looks right on the page.
  -v, --version   print the version and exit
  -h, --help      print this and exit

REQUIREMENTS
  Google Chrome or Microsoft Edge must be installed -- it does the rendering.
  If it is somewhere unusual, point at it:

      Windows   set CHROME_PATH=C:\\Path\\To\\chrome.exe
      macOS     export CHROME_PATH=/Applications/…/Google Chrome
      Linux     export CHROME_PATH=/usr/bin/chromium

  The first run downloads maths fonts once and caches them in .mathjax-fonts,
  so later runs work offline.

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
const htmlDir = await rt.resolvePath(
  positional[0] ?? (await rt.dirExists(nestedInput) ? nestedInput : workingDir),
);

const outputPdf = await rt.resolvePath(
  positional[1] ?? rt.joinPath(workingDir, OUTPUT_DIR, "combined_report.pdf"),
);

// ---------------------------------------------------------------------------
// Font inlining
//
// Cached beside the reports so repeat builds work offline; the first build is
// the only one that needs the network.
// ---------------------------------------------------------------------------

/**
 * One font file, from the on-disk cache or downloaded once and cached.
 *
 * Writes to a scratch name and renames into place, so a build interrupted
 * mid-write cannot leave a truncated font that every later build silently
 * reuses.
 *
 * @param cacheDir `.mathjax-fonts` in the working directory
 */
async function fontBytes(url: string, cacheDir: string): Promise<Uint8Array> {
  const name = rt.baseName(url).replace(/[^\w.-]/g, "_");
  const cached = rt.joinPath(cacheDir, name);

  try {
    return await rt.readFile(cached);
  } catch {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await rt.mkdirp(cacheDir);

    // Write to a scratch name and rename into place. A build interrupted
    // mid-write would otherwise leave a truncated font cached, and every later
    // build would silently reuse the corrupt copy.
    const partial = `${cached}.partial`;
    await rt.writeFile(partial, bytes);
    await rt.rename(partial, cached);
    return bytes;
  }
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
  const refs = [
    ...new Set([...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1])),
  ];

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
async function readPdf(pdfPath: string): Promise<PdfObservations> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: await rt.readFile(pdfPath) }).promise;

  const obs: PdfObservations = {
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
    for (const fn of (await page.getOperatorList()).fnArray) {
      if (fn === pdfjs.OPS.paintImageXObject) {
        obs.imagePaints++;
        drew = true;
      } else if (fn === pdfjs.OPS.constructPath) {
        drew = true;
      }
    }

    // Items are text runs or marked-content markers; only the former have text.
    const text = (await page.getTextContent()).items
      .map((i) => ("str" in i ? i.str : ""))
      .join("");

    obs.text += text + "\n";
    if (text.trim().length === 0 && !drew) obs.blankPages.push(p);

    // These two patterns are specific to the SkyCiv diagram, which prints its
    // title at the top and its axis caption at the bottom -- landing on
    // different pages means the drawing was cut in half. A template that labels
    // its diagrams differently makes this check find nothing, so the count is
    // reported rather than assumed; zero means it did not run, not that
    // everything is fine.
    if (/Displacements\s*z-axis/i.test(text)) obs.diagramTitlePages.push(p);
    if (/Position\s*along\s*member/i.test(text)) obs.diagramAxisPages.push(p);

    // Report headings are template-specific too, but this one fails loudly:
    // no match means the count will not equal the number of sources.
    if (/MEMBER\s*#?\s*\d+\s*DESIGN\s*REPORT/i.test(text)) obs.headingPages.push(p);
  }

  return obs;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// Files this tool owns are never inputs. The baked document is written beside
// the PDF, and the browser example sits beside the reports; either one ingested
// as a report would inflate the build and, in the baked document's case,
// compound on every run. Everything else in the folder is treated as a report,
// so keep other HTML out of it.
//
// This matters more now that the output directory can sit INSIDE the input one
// (running from the reports folder puts CompiledPDF/ there). Two things keep
// that safe: the scan is one level deep and filters to files, so nothing inside
// CompiledPDF/ is ever visible to it, and this guard catches the baked document
// by name if the two directories are ever pointed at the same place.
const TOOL_OWNED = new Set([
  rt.baseName(outputPdf.replace(/\.pdf$/i, "") + ".html").toLowerCase(),
  "browser_example.html",
]);

// Now that the defaults come from the working directory, "ran it from the wrong
// folder" is the ordinary mistake, and a raw ENOENT stack trace is a poor way to
// report it. Name the folder that is missing and how to point at another one.
// Initialised rather than left definite-assigned: the catch exits, but that
// relies on control-flow analysis seeing through a namespaced never-returning
// call, which is not worth depending on.
let allHtml: string[] = [];
try {
  allHtml = (await rt.listFiles(htmlDir))
    .filter((n) => n.toLowerCase().endsWith(".html"));
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

const entries = sortReportNames(
  allHtml.filter((n) => !TOOL_OWNED.has(n.toLowerCase())),
);

if (entries.length === 0) {
  // Reaching here without positional[0] means the working directory had no
  // nested input folder AND no reports of its own. Someone who runs the command
  // in the wrong place gets the whole usage text, not a one-line rebuke -- this
  // is the most likely first experience of the tool going wrong.
  console.error(`No .html reports found in:\n  ${htmlDir}\n`);
  if (!positional[0]) {
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
if (outputDir && outputDir !== outputPdf) await rt.mkdirp(outputDir);

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
if (skipped > 0) {
  console.log(`  skipped:  ${skipped} tool-owned .html file(s)`);
}

const sources: string[] = [];
const bodies: string[] = [];
const styles: string[] = [];

for (let i = 0; i < entries.length; i++) {
  const src = await rt.readTextFile(rt.joinPath(htmlDir, entries[i]));
  sources.push(src);

  // Every report carries its own stylesheet, scoped to its own wrapper, and its
  // own id namespace, so reports that disagree about CSS or ids cannot
  // interfere with one another.
  styles.push(bakeStyle(src, `.rs${i}`, `r${i}-`));
  bodies.push(bakeBody(src, `r${i}-`));
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
    `  warning: SVG rule "${selector}" could not be hoisted; its <style> block was kept`,
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

const leftovers = findLeftoverMath(bodies.join(""));
if (leftovers.length > 0 || mathStats.failed > 0) {
  console.error("");
  console.error("ERROR: unrendered mathematics reached the baked document.");
  if (mathStats.failed > 0) console.error(`  ${mathStats.failed} expression(s) failed to typeset`);
  for (const l of leftovers) console.error(`  ${l}`);
  console.error("");
  console.error("These are sealed engineering calculations; refusing to emit a PDF");
  console.error("containing raw LaTeX. Check the reports' tex2jax configuration.");
  rt.exit(1);
}

// Cached in the working directory, not inside the input folder: that folder
// should contain reports and nothing else.
const mathCss = await inlineFonts(
  mathStyleSheet(),
  rt.joinPath(workingDir || htmlDir, ".mathjax-fonts"),
);

const combinedHtml = assembleDocument(bodies, styles, mathCss);

const externalRefs = (combinedHtml.match(/(?:href|src)="https?:/gi) ?? []).length;
const scripts = (combinedHtml.match(/<script/gi) ?? []).length;
if (externalRefs > 0 || scripts > 0) {
  console.warn(
    `  warning: baked HTML still has ${scripts} script(s) and ${externalRefs} external ref(s)`,
  );
}

// Only the Chrome profile needs to be temporary now. The baked document is a
// build artifact in its own right and belongs beside the PDF it produced.
const workDir = await rt.makeTempDir("compiled_reports_");

try {
  // Both outputs live in the output directory: the baked HTML is the exact
  // input Chrome was given, so keeping it next to the PDF is what makes a
  // result reproducible and inspectable after the fact.
  const htmlPath = outputPdf.replace(/\.pdf$/i, "") + ".html";

  // Encode once: String.length counts UTF-16 code units, not bytes, so
  // reporting it as a size would understate anything non-ASCII.
  const htmlBytes = new TextEncoder().encode(combinedHtml);
  await rt.writeFile(htmlPath, htmlBytes);
  console.log(`  html:     ${(htmlBytes.length / 1e6).toFixed(2)} MB, self-contained`);

  // Chrome exits 0 even when printing fails, so "no file" is the only reliable
  // failure signal -- but only if there is no file to begin with. A leftover
  // PDF from an earlier run would otherwise be read back and reported as this
  // run's output, turning a failed build into a silently stale one.
  await rt.removeQuietly(outputPdf);

  const result = await rt.run(chrome, [
    "--headless=new",
    "--disable-gpu",
    // Needed to run as root in a container, which is the usual deployment.
    // It disables Chrome's process sandbox, so it is only defensible because
    // the input is a document this script generated itself. Drop it if the
    // HTML ever comes from somewhere untrusted.
    "--no-sandbox",
    "--no-first-run",
    "--disable-extensions",
    // Chrome refuses to start against a profile already in use.
    `--user-data-dir=${rt.joinPath(workDir, "profile")}`,
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
    "--run-all-compositor-stages-before-draw",
    "--no-pdf-header-footer",
    `--print-to-pdf=${outputPdf}`,
    await rt.toFileUrl(htmlPath),
  ]);

  let rendered: Uint8Array;
  try {
    rendered = await rt.readFile(outputPdf);
  } catch {
    throw new Error(`Chrome produced no PDF.\n${result.stderr.trim()}`);
  }

  console.log(`  rendered: ${(rendered.length / 1e6).toFixed(2)} MB`);

  // Parse once. The page count is available from the same document we repack,
  // so re-loading the saved bytes just to count pages would parse it twice.
  const pdf = await PDFDocument.load(rendered, { updateMetadata: false });
  const pageCount = pdf.getPageCount();

  let final = rendered;
  if (optimize) {
    final = await pdf.save({ useObjectStreams: true });
    await rt.writeFile(outputPdf, final);
    console.log(
      `  packed:   ${(final.length / 1e6).toFixed(2)} MB ` +
        `(${((1 - final.length / rendered.length) * 100).toFixed(0)}% smaller)`,
    );
  }

  // Discarded only on request, and only after the render succeeded -- on a
  // failed build the baked document is the first thing worth looking at.
  if (!keepHtml) await rt.removeQuietly(htmlPath);

  console.log(`\nCreated ${outputPdf}`);
  console.log(`${pageCount} pages, ${(final.length / 1e6).toFixed(2)} MB`);
  if (keepHtml) console.log(`Kept ${htmlPath}`);

  // Read back from disk rather than trusting anything held in memory: the
  // artifact that ships is the one that gets checked.
  if (verify) {
    console.log("\nVerifying against the source reports...");

    const expected = extractSourceTokens(sources);
    const observed = await readPdf(outputPdf);
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
      `  latex:    ${check.leftoverLatex.length} surviving, ` +
        `${observed.headingPages.length}/${entries.length} reports, ` +
        `${observed.blankPages.length} blank page(s)`,
    );

    if (check.failures.length > 0) {
      console.error("");
      console.error("VERIFICATION FAILED");
      for (const f of check.failures) console.error(`  - ${f}`);
      console.error("");
      console.error(`${outputPdf} does not faithfully reproduce its sources.`);
      rt.exit(1);
    }

    console.log("  PASS: every source word and number present, nothing split or unrendered.");
  }
} finally {
  await rt.removeQuietly(workDir, true);
}
