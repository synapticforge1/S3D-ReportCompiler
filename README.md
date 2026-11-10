# s3d-reportcompiler

Compile a folder of **SkyCiv structural design reports** (HTML) into one combined PDF — then prove
nothing was lost on the way. Runs on **Deno, Node, Bun and in the browser**.

## 🌟 Why s3d-reportcompiler?

SkyCiv member design reports cannot be printed by anything without a JavaScript engine, and printing
them one at a time produces a file several times larger than it needs to be. This tool fixes both,
and then checks its own work.

- **Renders what you actually see.** The reports hide themselves behind `visibility: hidden` until
  MathJax finishes typesetting and jQuery reveals them, and every equation is stored as LaTeX source.
  A renderer with no JS engine gives you ~400 blank pages. This bakes the maths first, then prints
  with the same engine the reports were designed in.
- **One pass, not one-per-report.** All reports are concatenated into a single document and rendered
  once, so the shared section image and each font subset are embedded once instead of 48 times.
  Measured on a 48-report set: **3.35 MB / 380 pages**, against **9.46 MB** for render-then-merge.
- **Equations stay real text.** Maths is encoded as CHTML, so the output is searchable and
  selectable. The SVG alternative turns every glyph into a vector outline — 52 MB for the same
  content.
- **Verifies itself and exits non-zero.** Every word, every number, every graphic and every
  equation in the sources is checked against text extracted from the finished PDF on disk. The
  verification shares no code with the transforms, so a bug cannot hide by agreeing with itself.
- **Hermetic output, enforced.** The baked document runs no code and loads nothing from another
  host — and does not just happen to: the bake strips scripts and event handlers, and the
  document's own Content-Security-Policy forbids every script and every outside load but one,
  MathJax's font folder (`cdn.jsdelivr.net/npm/mathjax@3.2.2/…/woff-v2/`), which the in-browser
  path loads its fonts from. The CLI inlines those fonts as data URIs, so its render loads
  nothing at all. No CDN can be slow, blocked, or down at render time, and nothing inside a report
  file can change the PDF while it renders.
- **Delimiters are read, not assumed.** Each report's own `tex2jax` config decides what marks an
  equation, so a template that switches from `[math]..[math]` to `$$..$$` keeps working.
- **Nothing is removed silently.** These are calculations that get sealed. Every removal and rewrite
  is counted and printed as an audit line.

> ⚠️ **"0 failed" is not "nothing went wrong."** An unrecognised delimiter never *errors* — it simply
> never matches, and the LaTeX is typeset as prose. That cost 480 silently-unrendered expressions
> once. The guard and the verification exist for exactly that failure mode.

---

## 🚀 Quick Start

### Installation

The same package is published to two registries, under two names:

| Registry | Name | Best for |
|---|---|---|
| **npm** | `@synapticforge1/s3d-reportcompiler` | Node and Bun — a plain `npm install`, a global command, `npx` |
| **JSR** | `@jrmarcum/s3d-reportcompiler` | Deno — and Node / Bun through `jsr add` |

#### From npm — `@synapticforge1/s3d-reportcompiler`

**On npm from 1.1.0** (1.1.1–1.1.3 and everything before 1.1.0 are on JSR only). Compiled JavaScript with its type
declarations, so it runs on Node with no flags, no `.npmrc` and no JSR registry setting.

As a project dependency:

```bash
npm install @synapticforge1/s3d-reportcompiler
bun add @synapticforge1/s3d-reportcompiler
```

```ts
import { assembleDocument, bakeBody, bakeStyle } from "@synapticforge1/s3d-reportcompiler";
```

As a command — the npm package has a `bin`, which JSR's npm layer cannot provide:

```bash
npm install -g @synapticforge1/s3d-reportcompiler    # then: s3d-reportcompiler [reports-dir] [output.pdf]
npx @synapticforge1/s3d-reportcompiler                # run without installing
```

Measured before any publish, on the packed tarball installed into a fresh project: the library
imports and the installed CLI bakes the identical document on Node 22.13 (the floor), 22, 24 and
26, Bun and Deno, and `npm exec s3d-reportcompiler -- --version` runs (`bun run npm:prove`).

#### From JSR — `@jrmarcum/s3d-reportcompiler`

##### As a project dependency

Deno:

```bash
deno add jsr:@jrmarcum/s3d-reportcompiler
```

Bun — note the **`--bun`**, or `jsr add` hands the install to npm:

```bash
bunx jsr add --bun @jrmarcum/s3d-reportcompiler
```

Node:

```bash
npx jsr add @jrmarcum/s3d-reportcompiler
```

⚠️ **npm 12 (bundled with Node 24.21) refuses the install `npx jsr add` performs** —
`EALLOWREMOTE: Fetching packages of type "remote" have been disabled`. `jsr add` installs the
package under an alias pointing at a tarball URL on JSR's npm registry, which npm 12 classes as
remote (`allow-remote` defaults to `none`; npm 10 and 11 allow it). A direct
`npm install @jsr/jrmarcum__s3d-reportcompiler` (with `@jsr:registry=https://npm.jsr.io` in
`.npmrc`) is not affected (measured on npm 12.2.0) — the package is then named
`@jsr/jrmarcum__s3d-reportcompiler` in imports and under `node_modules/`. To keep `jsr add`, allow
it for the install:

```bash
npm_config_allow_remote=all npx jsr add @jrmarcum/s3d-reportcompiler
```

```powershell
$env:npm_config_allow_remote = "all"; npx jsr add @jrmarcum/s3d-reportcompiler
```

Either way, `jsr add` writes `@jsr:registry=https://npm.jsr.io` to the project's `.npmrc` and
the dependency to `package.json` — commit both. Then one import line works on every runtime:

```ts
import { assembleDocument, bakeBody, bakeStyle } from "@jrmarcum/s3d-reportcompiler";
```

##### As a global CLI tool

Deno — note the **`/cli`** on the end:

```bash
deno install -g -n s3d-reportcompiler -A jsr:@jrmarcum/s3d-reportcompiler/cli
```

⚠️ Without `/cli` you install the *library* entrypoint, and the command runs, does
nothing and exits 0 — the package's default export is the pure API, not the CLI.
Requires **1.0.2 or later**; earlier versions have no `./cli` export.

⚠️ **Just after a release, Deno may quietly install the previous version.** Deno
applies a minimum dependency age (24 hours by default) as a supply-chain measure,
and silently resolves to the newest version older than that. The symptom is
confusing, because it reports the *old* version's exports:

```
error: Unknown export './cli' for '@jrmarcum/s3d-reportcompiler@1.0.1'.
```

Either wait a day, or opt out for this install:

```bash
deno install -g -n s3d-reportcompiler -A --min-dep-age=0 jsr:@jrmarcum/s3d-reportcompiler/cli
```

Bun and Node: **there is no global command from JSR** — use the npm package above for that. JSR's
npm packages carry no `bin` entry (measured on 1.0.4: the package manifest has none), so
`bun install -g` and `bunx` on the JSR package find nothing to run. Installed from JSR, run its
compiled CLI directly:

```bash
node node_modules/@jrmarcum/s3d-reportcompiler/main.js [reports-dir] [output.pdf]
bun  node_modules/@jrmarcum/s3d-reportcompiler/main.js [reports-dir] [output.pdf]
```

or name it once in that project's `package.json` — `"scripts": { "compile": "node
node_modules/@jrmarcum/s3d-reportcompiler/main.js" }` — and run `npm run compile` /
`bun run compile`. A global command is Deno's (above) or a clone's (below).

##### Run on demand without installing

Deno:

```bash
deno run -A jsr:@jrmarcum/s3d-reportcompiler/cli
```

Bun and Node: not from JSR (no `bin`) — `npx @synapticforge1/s3d-reportcompiler` from npm, above.

#### From a checkout

```bash
bun run cli:install             # global command built from THIS working tree
bun run cli:install-published   # global command from npm
bun run cli:uninstall
```

These need only **Bun** — they install a Bun global (`bun add -g`), and with no `node` on your
`PATH` Bun runs the command itself. `bun run cli:install` is the one to use while developing or if
you keep a clone: it builds the npm package from your working tree and installs a copy of it
(`bun add -g ./dist`), so there is no publish step and no waiting on the registry.
`cli:install-published` installs the released npm package. Both install the command as
`s3d-reportcompiler`; re-running either replaces it.

### Requirements

- **Chrome or Edge** must be installed — it is the rendering engine, not an optional accelerator.
  Set `CHROME_PATH` if it is not in a standard location. It runs with its **sandbox on**, except
  as root (a container), where it cannot start with one. On a host where Chrome finds no usable
  sandbox for an ordinary user, the build says so; set `S3D_CHROME_NO_SANDBOX=1` for that build
  (the build then prints `sandbox: OFF`). The reports' own code stays blocked either way.
  `CHROME_PATH` must name the browser program itself, not a script that starts it and exits.
  Chrome is stopped if it has not finished in 10 minutes; a very large set may need more — set
  `S3D_CHROME_TIMEOUT_MS` (milliseconds, e.g. `1800000`).
- **The network, once.** The first build in a folder downloads MathJax's fonts (329 kB) into
  `.mathjax-fonts/`; later builds there work offline. Only complete font files are kept — a
  network login page, or a download cut short, stops the build with a plain message and nothing
  cached.
- **A report's linked images, every build.** An image a report links to rather than embeds (an
  `<img src="fig.png">`, an SVG `<image href="…">`) is fetched as a browser opening the report
  would find it — beside the report, or from the web — typed by its bytes, embedded, and checked
  pixel for pixel like any other (the build prints `links:`). One that cannot be had (missing,
  not an image, an HTTP error) stops the build by name: it would otherwise print blank. A zip
  holds reports only, so its reports' relative links stop the build. SkyCiv's loading spinner
  is removed, never fetched; SkyCiv's own exports embed every figure, so they fetch nothing.
- **A supported runtime** — every current Node LTS line, Bun, and Deno's LTS line, each measured
  with the sample reports producing byte-identical output:

  | runtime | the installed package | a clone of this repository |
  |---|---|---|
  | Node 22 | **22.13 or later since 1.1.0** — its `pdfjs-dist` 6 requires it (the npm package declares `node >=22.13.0`); 1.0.4 ran on 22.6 or later (measured) | **22.18 or later** (the first 22.x that runs `.ts` with no flag) |
  | Node 24, Node 26 | ✅ | ✅ |
  | Bun | 1.4.4 (the version measured; Bun has no LTS line) | 1.4.4 |
  | Deno | 2.9 LTS (2.9.8 measured) | 2.9 LTS |

  `bun run runtimes` re-checks a clone against Node's own LTS schedule — see
  [Supported runtimes](#supported-runtimes) below.
- **Two dependency pins hold in this repository only.** `package.json` `overrides` pins
  `@xmldom/xmldom` to 0.9.12 (MathJax's `speech-rule-engine` asks for 0.9.10, which has an
  advisory) and `@napi-rs/canvas` to 1.0.11. A package manager applies `overrides` from the ROOT
  project only, so an install of the published package resolves them afresh: add the same
  `overrides` (npm, Bun) or `pnpm.overrides` to your own `package.json` to get them. MathJax uses
  `@xmldom/xmldom` for its speech output, which this tool never turns on.

### First run

Put your reports in a folder and run the command from its parent:

```
your-project/
  HTMLFilesToBeCompiled/     ← the reports, and nothing else
  CompiledPDF/               ← created for you, holds both outputs
    combined_report.html     ← the baked document Chrome was given
    combined_report.pdf      ← the result
```

```bash
s3d-reportcompiler
```

```
Compiling 48 report(s) on deno
  delims:   [mathin]..[mathin] [math]..[math] $$..$$ \(..\) $..$
  math:     8286 expressions, 0 failed
  audit:    48 loader(s) removed, 48 visibility gate(s) opened, 144 height:100% relaxed, …
  html:     15.30 MB, self-contained
  packed:   3.35 MB (49% smaller)

380 pages, 3.35 MB

Verifying against the source reports...
  checked:  174 words, 660 numbers from 48 source(s)
  missing:  0 word(s), 0 number(s)
  graphics: 48 image paint(s), 48 expected; 48 diagram(s) checked, intact
  latex:    0 surviving, 48/48 reports, 0 blank page(s)
  PASS: every source word and number present, nothing split or unrendered.
```

---

## 🖨️ CLI

```bash
s3d-reportcompiler [htmlDir] [output.pdf] [options]
s3d-reportcompiler <reports.zip> [options]     # the verified PDF is added to the zip
```

Both paths default to the **current working directory**, so the tool operates on the folder you are
standing in no matter where it was installed:

| Default | Meaning |
| --- | --- |
| `HTMLFilesToBeCompiled/` | the reports to compile — reports and nothing else |
| `CompiledPDF/` | created if missing; holds **both** outputs |
| `CompiledPDF/combined_report.html` | the baked, self-contained document handed to Chrome |
| `CompiledPDF/combined_report.pdf` | the rendered, repacked result |

The baked HTML is kept because it is the exact input that produced the PDF — it is what makes a
result reproducible and inspectable afterwards, and on a failed build it is the first thing worth
looking at.

| Flag | Effect |
| --- | --- |
| `--keep-html` | keep the baked HTML beside the PDF — the default, accepted so it can be said |
| `--no-keep-html` | discard the baked HTML after a good build, leaving only the PDF (a failed build keeps it). Given with `--keep-html`, refused |
| `--no-optimize` | skip the object-stream repack (roughly doubles the file size) |
| `--no-verify` | skip the conservation check — **not advisable** for a document that will be issued |
| `-v`, `--version` | print the version and exit |
| `-h`, `-?`, `--help` | print usage and exit |

The output must be a `.pdf` (1.2.0): the file at that path is replaced, so `reports pack.zip`
would have replaced the zip. The baked HTML beside it never replaces a file of its name that this
tool did not bake.

Unknown flags are rejected rather than ignored, so a mistyped `--no-optimise` cannot silently do the
opposite of what you asked. So are a third path and an empty one: an unquoted path with a space
arrives as two arguments, and an unset variable (`"$DIR"`) as an empty one — both used to be
taken, silently, as something else. **Quote any path containing spaces.**

The build also refuses rather than proceeds when an earlier PDF cannot be replaced (it is probably
open in a viewer — close it), and when an output would overwrite one of the reports.

> ⚠️ **Every `.html` file in the input folder is treated as a report.** Keep tooling, examples and
> build output somewhere else. Input and output default to separate folders precisely so the scan
> cannot ingest a build artifact of its own.

### Straight from SkyCiv's zip (1.2.0)

```bash
s3d-reportcompiler "C:\Users\me\Downloads\pack.zip"
```

SkyCiv downloads a report set as one zip. Give the tool the zip itself; nothing is unpacked:

1. Its `.html` entries are the reports. Each is read in memory and checked against its CRC.
2. They are compiled and verified exactly as a folder would be.
3. Only after a **PASS** is the PDF added **into the zip**, named after it (`pack.zip` gets
   `pack.pdf`).

Every other entry keeps its compressed data, name, CRC, sizes and directory record exactly, never
re-encoded; only its local header is rewritten (sizes written in place of a trailing data
descriptor). The archive comment is kept. The updated zip is written beside the original, read back
and checked: every report entry must be unchanged and the PDF entry identical to the verified file.
Only then does it replace the original, in one rename. A failed build, or a zip that changed
during the build, leaves the zip exactly as it was.

- **Run it again** and the PDF in the zip is replaced, not duplicated. The tool finds its own PDF
  by a mark it writes in the entry's comment, not by name, so a zip renamed since still rebuilds,
  and a file of yours that merely has the PDF's name is refused, never replaced.
- **If the PDF passes but cannot be added** (the zip is open elsewhere, or changed meanwhile), the
  build says so, leaves the zip as it was, keeps the verified PDF as `pack.verified.pdf` and exits 1.
  The next run removes that file before it renders, and refuses to start if it cannot (open in a
  viewer), so an earlier "verified" PDF never sits beside a newer zip.
- **The baked HTML** is kept beside the zip (`pack.html`). `--no-keep-html` removes it. It is never
  put into the zip: it is a `.html`, so the next run would read it as a report. An existing
  `pack.html` that is not a previous bake is the user's file, and the build stops rather than
  overwrite it.
- **A zip takes no output argument and no `--no-verify`.** Only a verified PDF goes into it.
- **Anything but a flat set of reports is refused, naming the entry:**
  - folders, a nested path, or a file that is neither `.html` nor this tool's own PDF;
  - two names that differ only in case;
  - encryption, zip64, split archives, or a compression method other than stored or deflate;
  - headers or data descriptors that disagree, or bytes no entry claims;
  - a bad CRC.

  A report read wrongly would be a report missing from the package.

### Try it without your own data

Thirteen sanitized sample reports ship with the repository — covering both section shapes in the
original set (`HSS6x6x3/16` and all three `HSS12x12x5/8` members):

```bash
git clone https://github.com/synapticforge1/S3D-ReportCompiler
cd S3D-ReportCompiler && bun install
cd tests && bun ../main.ts
```

```
Compiling 13 report(s) on bun
  math:     2203 expressions, 0 failed
100 pages, 0.99 MB
  checked:  173 words, 342 numbers from 13 source(s)
  missing:  0 word(s), 0 number(s)
  graphics: 13 image paint(s), 13 expected; 13 diagram(s) checked, intact
  PASS: every source word and number present, nothing split or unrendered.
```

Their Project Name, Designer and Project Notes fields are replaced with synthetic values by
[`scripts/sanitize-report.ts`](scripts/sanitize-report.ts); the calculations are untouched, so the
samples exercise the real pipeline rather than a toy one.

### Supported runtimes

The same clone runs on any of them — only the launcher differs:

```bash
cd tests
node ../main.ts            # Node 22.18+, 24, 26
bun ../main.ts             # Bun
deno run -A ../main.ts     # Deno
```

**`bun run runtimes`** checks that promise instead of trusting it. It reads Node's own release
schedule, builds the samples on the `engines.node` floor, on every current Node LTS line and on a
line that becomes LTS within 30 days (each through [fnm](https://github.com/Schniz/fnm), so nothing
switches globally), then on Bun and Deno — and fails unless every build passes its verification
**and** all of them bake a byte-identical document. A Node version fnm does not have fails with
the `fnm install` that fixes it; it is never skipped.

```
✅ node 22.18.0 (floor)         PASS  html 487321f24fb9
✅ node 22                      PASS  html 487321f24fb9
✅ node 24                      PASS  html 487321f24fb9
✅ node 26                      PASS  html 487321f24fb9
✅ bun                          PASS  html 487321f24fb9
✅ deno                         PASS  html 487321f24fb9
✅ 6 runtime(s), one baked document (487321f24fb9)
```

---

## 📦 Programmatic API

The package's default export is the **pure core** — every transform, with no I/O of any kind. That
is what lets the same module run in a browser unchanged.

### Deno

```typescript
import { assembleDocument, bakeBody, bakeStyle } from "@jrmarcum/s3d-reportcompiler";
import * as rt from "@jrmarcum/s3d-reportcompiler/runtime";
```

### Bun and Node

Identical, under the name of the registry you installed from ([Installation](#installation)):

```typescript
// from npm (`npm install` / `bun add`)
import { assembleDocument, bakeBody, bakeStyle } from "@synapticforge1/s3d-reportcompiler";

// from JSR (`npx jsr add` / `bunx jsr add --bun`; see Installation for npm 12)
import { assembleDocument, bakeBody, bakeStyle } from "@jrmarcum/s3d-reportcompiler";
```

The `/runtime` export has the same path under either name.

### Web

The core is bundler-ready — it touches no filesystem, no process and no runtime global. Bundle it
for the browser with any bundler:

```bash
bun build ./src/report_core.ts --target=browser --outfile=report_core.browser.js
```

```html
<script type="module">
  import {
    assembleDocument, bakeBody, bakeStyle, findBrokenReferences, findLeftoverMath,
    mathStats, mathStyleSheet, resetBakeState,
  } from "./report_core.browser.js";

  // `sources`: the reports' HTML, fetched however the page likes.
  resetBakeState(); // the counters are per page: start every bake clean

  const styles = sources.map((src, i) => bakeStyle(src, `.rs${i}`, `r${i}-`));
  const bodies = sources.map((src, i) => bakeBody(src, `r${i}-`)); // use the two together

  // The two guards the CLI runs: no unrendered maths, and no graphic reference broken.
  const leftovers = findLeftoverMath(bodies.join(""));
  if (leftovers.length || mathStats.failed) {
    throw new Error(`unrendered maths: ${[...leftovers, `${mathStats.failed} failed`].join(", ")}`);
  }
  const refs = findBrokenReferences(
    sources.map((source, i) => ({ source, style: styles[i], body: bodies[i], prefix: `r${i}-` })),
  );
  if (refs.broken.length) throw new Error(`broken references: ${refs.broken.length}`);

  document.querySelector("iframe").srcdoc = assembleDocument(bodies, styles, mathStyleSheet());
  // the browser IS the print engine — window.print() from here
</script>
```

A complete, working page — fetching the reports, logging the warnings, printing — is
[`tests/browser_example.html`](tests/browser_example.html) (`bun run bundle:browser`, then serve
`tests/` over HTTP).

`@jrmarcum/s3d-reportcompiler/runtime` **imports** in a browser (its `node:` modules load lazily),
but it is of no use there: every function in it throws a descriptive error rather than failing
obscurely.

### Building a document

| Export | Description |
| --- | --- |
| `bakeBody(src, prefix)` | One report's `<body>` → maths pre-rendered to CHTML, scripts stripped, spinner removed, ids namespaced |
| `bakeStyle(src, scope, prefix)` | One report's stylesheet → every selector scoped to that report's wrapper, every id namespaced |
| `assembleDocument(bodies, styles, mathCss)` | Many baked reports → one hermetic, printable HTML document |
| `mathStyleSheet()` | The MathJax CHTML stylesheet the baked maths needs |
| `scopeCss(css, scope, prefix)` | The scoping primitive behind `bakeStyle` — prefix every selector, namespace every id |
| `portableSvg(html)` | Hoist an inline SVG's internal `<style>` onto presentation attributes, so it survives being merged into a shared document. A sheet it cannot hoist exactly is left as written; `bakeBody` / `bakeStyle` move such a sheet to the report's scoped stylesheet, because in HTML it applies to the whole page |
| `decodeReport(bytes, name)` | A report's bytes as text (UTF-8), refused, naming `name`, where that is not the text a browser shows: invalid UTF-8, UTF-16, or another declared charset over non-ASCII bytes. Read every report through it: a lenient decode turns a bad byte into U+FFFD on both sides of the check |

### Reading a report's own maths configuration

| Export | Description |
| --- | --- |
| `parseDelimiters(src)` | Read the report's embedded `tex2jax` config → `Delim[]`, sorted longest-opener-first. Only from scripts a browser runs (not one in a comment or `<noscript>`); each key from the last script that sets it |
| `buildMathRegex(delims)` | Compile those delimiters into a single matcher |
| `FALLBACK_DELIMS` | Used only when a report carries no readable config |
| `skippedDelims` | Degenerate delimiters that were refused — e.g. a bare `[`, which would treat every bracketed phrase as an equation |
| `delimSignatures` | One entry per distinct delimiter set seen; more than one means the inputs disagree |

### Verifying the result

| Export | Description |
| --- | --- |
| `extractSourceTokens(sources)` | Every word, number and expected image count the sources contain → `SourceTokens` |
| `compareAgainstPdf(expected, observed, reportCount)` | Compare against what was found in the PDF → `VerificationResult` with a `failures[]` array |
| `compareEachReport(sources, pageTexts)` | **Per-report conservation**: the PDF split at the report headings, each report checked against its own pages → `PerReportResult` (`checked: false`, with the reason, when it cannot segment) |
| `findLeftoverMath(baked)` | **The guard.** Surviving delimiters and TeX commands in a baked document — an empty array is the only acceptable result |
| `findBrokenReferences(reports)` | **The reference guard.** Each report's `{ source, style, body, prefix }` → `ReferenceCheck`; `broken` lists every `url(#…)` / `href="#…"` the bake broke (one that resolved in its source no longer does). Empty is the only acceptable result: verification counts text and images, so a lost gradient, clip path or marker is otherwise invisible. Run by the CLI and the browser example |
| `textWords(text)` / `textNumbers(text)` | The tokenizers, exposed so a caller can re-derive expectations independently |
| `decodeEntities(s)` | The verification's HTML entity decoding (named symbols, decimal and hex references, one pass) for the source side of the comparison. The bake decodes with its own, separately written code, so the check cannot share a decoding mistake with the build |
| `sortReportNames(names)` | Numeric-aware sort, so `member_2` precedes `member_10` |

### SkyCiv's zip (1.2.0)

Pure byte functions. Inflating uses the platform's `DecompressionStream`, so they run in Deno, Bun,
Node and browsers.

| Export | Description |
| --- | --- |
| `readZipReports(zip, ownName)` | The `.html` entries of a zip, unpacked and CRC-checked → `ZipReports` (`reports[]` of `{ name, html }`, and `own`: the name of the PDF an earlier run added, found by its mark, or `null`). Throws, naming every problem, on anything else in the zip, on an unmarked entry named `ownName`, and on every shape it does not read (see the CLI section) |
| `zipWithFile(zip, name, file, date)` | The zip with `file` added under `name` (stored, marked as this tool's), replacing the PDF an earlier run added. Every other entry's compressed data, name, CRC and sizes are kept, never re-encoded; its local header is rewritten. Throws if an unmarked entry already has `name` |
| `checkZipUpdate(original, updated, name, file)` | The failures, an empty array on a pass. It proves `updated` is `original` plus `file`: every entry and the comment unchanged, the reports reading back the same, and the added entry byte-identical. Written apart from the writer, so a writer bug cannot vouch for itself |

### Counters and diagnostics

| Export | Description |
| --- | --- |
| `audit` | What the bake step removed or rewrote: `loadersRemoved`, `visibilityNeutralised`, `heightNeutralised`, `atPageDropped`, `strayTokensDropped`, `bodyTagMissing` |
| `mathStats` | `converted`, `failed`, `firstFailure` |
| `bakeRemovals` | The rest of what the bake removes or moves: `activeAttributes` (event handlers, `javascript:` URLs), `metaBaseTags`, `blocklessAtRules`, `atRules`, `bodySheetsMoved`, `noscript` |
| `svgStyleWarnings` | SVG rules that could not be hoisted (their sheet moved to the report's stylesheet), with the reason |
| `cssWarnings` | CSS rules that could not be scoped to their report, and were left out |
| `bakeWarnings` | What the bake declined to guess: a spinner id on an element that holds text (kept), a hidden rule no script reveals (left hidden) |
| `seenOpeners` | Every opening delimiter met so far — what the guard looks for |
| `resetBakeState()` | Zero every counter above and empty every diagnostic set (`seenOpeners` and the delimiter sets too), and clear MathJax's labels and every TeX definition (`\def`, `\newcommand`, `\definecolor`, …; each report also starts without them). They are cumulative per process: **call it before each batch** when one page or server bakes more than once, or a later batch inherits an earlier one's failures and delimiters |
| `VERSION`, `MATHJAX_FONTS` | Package version; the CDN base the fonts are inlined from |

### Host adapter — `/runtime`

| Export | Description |
| --- | --- |
| `RUNTIME` / `isBrowser` | `"deno" \| "bun" \| "node" \| "browser"`. Bun is detected before Node, because Bun also sets `process.versions.node` |
| `findChrome()` | Locate Chrome or Edge, honouring `CHROME_PATH` |
| `run(cmd, argv)` | Spawn a process to completion, capturing stderr |
| `runWithTimeout(cmd, argv, timeoutMs, signal?)` | `run`, bounded: past `timeoutMs` (1 to `MAX_TIMEOUT_MS`) or on `signal`, the process tree is killed → `TimedRunResult` with `timedOut` |
| `cwd()`, `args()`, `env(name)`, `exit(code)` | Process access |
| `readTextFile`, `readFile`, `writeFile`, `listFiles`, `listNames`, `fileExists`, `dirExists` | Filesystem reads and writes; `listNames` returns every entry, so a caller can account for what `listFiles` left out |
| `fileIdentity(file)` | Device and file number, or `null`: two paths with one identity are one file, a hard link included |
| `mkdirp`, `removeQuietly`, `rename`, `makeTempDir`, `realPath` | Filesystem management |
| `joinPath`, `baseName`, `resolvePath`, `toFileUrl` | Path handling |

---

## ✅ What "verified" actually proves

The check re-reads the sources and the finished PDF **from disk** and re-derives its expectations
independently — a build and its own self-assessment failing the same way is what it exists to rule
out.

Conservation is checked twice: across the whole package, and **per report** — each report's words
and numbers must appear in its own pages, so one member silently replaced by a duplicate of another
is caught (`per-report: 48/48 reports hold all their own words and numbers`). It cannot see a value
moved *within* a report.

Two limits worth knowing before you rely on it:

- **The diagram-split check is template-specific.** It keys on the SkyCiv diagram's title and axis
  caption. A different template makes it find nothing — so the count is printed, and
  `0 diagram(s) checked` means it did not run, **not** that everything is fine.
- **It proves presence, not absence.** Every source word and number must be in the PDF; nothing
  checks that the PDF holds nothing else. That is why the render itself cannot add anything: the
  CLI's document runs no code and loads nothing from outside (see *Hermetic output* above). The build
  also checks that every graphic reference the bake renamed — a gradient, a clip path, an arrowhead
  — still resolves, since the PDF check counts text and images, not those.

---

### ⚠️ Breaking Changes

Versions follow [Semantic Versioning 2.0.0](https://semver.org/): a breaking change bumps the major.
`bun run bump` will not let a release claim less — it diffs the package's API surface (the exports,
every exported symbol's signature, and the CLI's options) against the last release and refuses a
bump below what that diff requires. Removals are deprecated for at least one minor release first,
and each lands here with its migration.

| Version | What changed | How to migrate |
|---|---|---|
| next (unreleased) | No API removed or changed. **Added:** `drawnSvgAncestors(source)` — the HTML each drawing stands in; `readerBody(source)` — the body as the verification reads it. **The verification is stricter:** the report's text is printed in the weight, style, colour and size its source gives each word (at the print's scale); each diagram label is drawn in its source's weight, style, colour and size — the `font` shorthand, sizes in any unit, and what the label inherits from the HTML around its drawing (a `<th>`, `<b>`, heading, a coloured `<div>`) included; a drawing that draws but reads as nothing visible fails | — |
| 1.4.0 (2026-11-10) | No API removed or changed. **Added:** `linkedImages`, `inlineLinkedImages` (an image a report links to — `<img src>`, an SVG `<image href>` — is fetched at build time and inlined, so it prints instead of drawing blank), `drawnImages`, `drawnSvgs`, `sniffImageType`; on `/runtime`, `fromFileUrl`. **The verification is stricter** (known-issues #87–#113): every number and word is checked as a whole token, with its unit and operator, as often as its report has it, against its own report; text must be legible against what is actually drawn under it; images are compared pixel for pixel (PNG, GIF, JPEG and WebP, decoded by the package itself); diagrams are checked shape by shape, clips, gradients, patterns, masks and every filter primitive included. A PDF that used to pass with a lost or changed value now fails. **Changed output:** a CSS rule written against `html`, `body`, `:root` or a top-level `:scope` keeps its specificity once scoped (weight-only `:is(…, *)` selectors are added: compare baked hashes from this release on, not across it; the 13 samples and both real sets render the same text at the same positions); an SVG `<style>` is read as SVG parses it (CDATA, comments, entities); `@layer` names are each report's own; content inside `<head>` is drawn; a `<style>` before `<head>` applies, one in a `<template>` or `<textarea>` does not. **Now refused where they used to pass silently:** report files named `.htm`, `.xhtml`, `.shtml`, `.mhtml` or `.mht` in a report folder (they were left out); an unclosed `<svg>` holding a `<style>`, or markup inside an SVG `<style>`; a `\unicode` after an earlier report changed its font cache; a TeX macro defined and never used (its body is now expected in the PDF). **CLI:** an interrupt during the final step lets it finish, then names what was finished; SIGHUP and SIGQUIT are handled on POSIX; a cache that cannot be written no longer fails the build | Rename such a report to `.html`. A report that defines a macro it never uses: remove the definition |
| 1.3.0 (2026-11-07) | No API removed or changed. **Added:** `decodeReport(bytes, name)`. **Now refused where they used to pass silently:** a report that is not UTF-8, or declares another charset over non-ASCII bytes; an undefined TeX command (it was typeset as red text and counted converted); `--keep-html` together with `--no-keep-html`. **Changed output:** each report's TeX starts without the previous report's `\def` / `\newcommand` / `\definecolor`; an SVG `<style>` that cannot be hoisted exactly moves to its report's stylesheet instead of staying confined to its own `<svg>`. The 13 samples and both real sets bake byte-identically | Re-save a non-UTF-8 report as UTF-8; fix the misspelled command the error names; give one of the two flags. A report that relied on an earlier report's macro must define it itself |
| 1.2.0 (2026-11-06) | No API removed or changed (19 additions). **Added:** SkyCiv zip input (`s3d-reportcompiler pack.zip`; `readZipReports`, `zipWithFile`, `checkZipUpdate`); `findBrokenReferences()` with `BakedReport` / `ReferenceCheck`; `resetBakeState()`; `bakeRemovals`, `cssWarnings`, `bakeWarnings`; on `/runtime`, `runWithTimeout`, `MAX_TIMEOUT_MS`, `listNames`, `fileIdentity`. **Behaviour:** <br>• the core's counters are per process — call `resetBakeState()` before each batch; <br>• the baked document carries a Content-Security-Policy (compare baked hashes from 1.2.0 on, not across it); <br>• `bakeBody` leaves a body's own `<style>` blocks to `bakeStyle` — use the two together; <br>• maths pairs only within one text run, as MathJax does, and `visibility: hidden` is lifted only where the report's own script reveals it (unchanged on every real report measured); <br>• the CLI **refuses** an output that is not a `.pdf`, a user's file at the baked HTML's name, an empty or a third path argument, a mistyped setting (`S3D_CHROME_NO_SANDBOX`, `S3D_CHROME_TIMEOUT_MS`, `CHROME_PATH`), and an unreadable `*.html` entry (a broken link, a folder) — a symlinked report is now compiled, not skipped; <br>• a PDF is `<name>.unverified.pdf` until it passes; <br>• Chrome keeps its sandbox and is stopped after 10 minutes | Baking more than once in one process: call `resetBakeState()` per batch. A script that names an output without `.pdf`: add it. A Linux host without a usable sandbox: `S3D_CHROME_NO_SANDBOX=1`. A very large set: `S3D_CHROME_TIMEOUT_MS` |
| 1.1.5 – 1.1.7 | nothing breaking — fixes only (1.1.7: a TeX error fails the build instead of typesetting a red error box; every named entity decodes inside maths) | — |
| 1.1.4 | nothing breaking — the same library as 1.1.0; released to JSR and npm together, both with provenance | — |
| 1.1.1 – 1.1.3 | nothing breaking — the same library as 1.1.0 (JSR only: their npm publishes did not go through) | — |
| 1.1.0 | No API removed or changed (`compareEachReport` and its two types were added). **The installed package's Node floor rises from 22.6 to 22.13** (`pdfjs-dist` 6 requires it); the compatibility gate does not read engine requirements, and the owner released this as a minor (2026-10-28). Also the first version on npm (`@synapticforge1/s3d-reportcompiler`), published by hand, so without npm provenance. | Node 22.6–22.12: move to 22.13 or later, or stay on 1.0.4 |
| 1.0.0 – 1.0.4 | nothing breaking (1.0.2 added the `./cli` export) | — |

---

## 🗺️ Roadmap

**Legend:** ✅ shipped · ⏳ planned or deliberately deferred. Incomplete items are listed last.

| Status | Area | Feature |
| :---: | --- | --- |
| ✅ | Rendering | Single-pass Chrome render — 3.35 MB / 380 pages vs 9.46 MB render-then-merge |
| ✅ | Maths | CHTML encoding; equations stay searchable text. 8,286 expressions, 0 failed |
| ✅ | Maths | Delimiters read from each report's own `tex2jax` config, longest opener first |
| ✅ | Maths | Degenerate delimiters (bare `[`, `(`) refused loudly instead of matching prose |
| ✅ | Guard | Build refuses to emit a PDF containing unrendered LaTeX |
| ✅ | Verification | Word, number, graphic, blank-page and report-count conservation; exits non-zero |
| ✅ | Verification | Shares no code with the transforms; re-reads both sides from disk |
| ✅ | Output | Object-stream repack — 49% smaller, no quality loss |
| ✅ | Output | Hermetic baked document: 0 scripts, 0 external refs, fonts inlined — **enforced** by its own Content-Security-Policy, with scripts and event handlers stripped (1.2.0) |
| ✅ | Guard | Every graphic reference the bake renamed must still resolve; exported as `findBrokenReferences` for the browser path too (1.2.0) |
| ✅ | CSS | Per-report stylesheet scoping and id namespacing, so heterogeneous inputs cannot collide |
| ✅ | Layout | `break-inside: avoid` on figures and equations only — not sections, which cost 123 pages |
| ✅ | Portability | One adapter for Deno, Node and Bun; byte-identical baked HTML on all three |
| ✅ | Portability | Browser path — bake and print, with the same guard as the CLI |
| ✅ | CLI | Defaults resolve from the working directory, so a global install is relocatable |
| ✅ | CLI | **SkyCiv's zip as input**. The reports are read in memory, and the verified PDF is added back into the zip, checked, in one rename (1.2.0) |
| ✅ | Packaging | Published to JSR and npm from one tag, both with GitHub Actions OIDC provenance; a release is cut only from `main` and confirms both registries before it reports success |
| ✅ | Verification | **Per-report conservation.** The PDF is segmented at the report headings and each report is compared against its own source, closing the set-union gap |
| ⏳ | Maths | **MathJax 3 → 4.** Deferred deliberately: v4 replaced the font system, so glyph metrics, line breaking and page count all move. Deprecation is not an advisory. (`npm audit` reports 0 vulnerabilities since 2026-10-28, when `@xmldom/xmldom` — pinned by MathJax's `speech-rule-engine` — was overridden to the fixed 0.9.12; v4 was not the remedy.) Requires a measured no-degradation comparison first |
| ⏳ | CSS | **Scope the remaining blanket rewrites.** `visibility: hidden → visible` and `height: 100% → auto` are still textual. They are audited and counted, and they fail *visibly*, which is the safer class — narrowing them means evaluating the cascade |
| ⏳ | Upstream | **Emit MathML from SkyCiv instead.** Their reports are generated from structured data; HTML → PDF is a lossy round-trip through a format that was never the source of truth |

---

## Known behaviour

- **`$` as a delimiter is inherently ambiguous.** A literal dollar sign in prose either pairs with
  the next one and swallows the text between, or is stranded and fails the guard. That ambiguity is
  in the source document — MathJax reads these reports exactly the same way.
- **Chrome's sandbox is on**, except as root or with `S3D_CHROME_NO_SANDBOX=1`. Until 1.2.0
  `--no-sandbox` was passed everywhere, on the reasoning that the input was a document this tool
  generated — but it is built from whatever report files are in the folder.
- **Fonts cache to `.mathjax-fonts/`** in the working directory on first run, so later builds work
  offline — one folder per MathJax version, so an upgrade starts fresh. A cache from before 1.2.0
  is adopted once, without the network.
- **The PDF is not byte-reproducible.** Chrome stamps its own render time into `/CreationDate` and
  `/ModDate`, so two builds of identical input differ in hash — on the same runtime. The *baked
  HTML* is byte-identical across Deno, Node and Bun; that is the artifact worth comparing.
- **`Cannot polyfill Path2D` / `DOMMatrix`** from pdfjs should no longer appear (since pdfjs-dist 6,
  which takes both from `@napi-rs/canvas`). If it does, the optional `@napi-rs/canvas` binary for
  your platform was not installed — check that your install does not skip optional dependencies.
  The verification does not need either, so the build's verdict is unaffected.

## Licence

MIT © 2026 Jon Marcum. See [LICENSE](LICENSE).

Every dependency is permissive — MIT, Apache-2.0, 0BSD, Zlib — with no copyleft and no NOTICE files
to propagate. The published package bundles no third-party code. Full verified tree and the two
places where third-party code *does* travel into an artifact:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
