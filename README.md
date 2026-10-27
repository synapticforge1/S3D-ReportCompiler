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
- **Hermetic output.** The baked document contains **0 `<script>` tags and 0 external references** —
  MathJax's fonts are inlined as data URIs. No CDN can be slow, blocked, or down at render time.
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

#### As a project dependency

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

⚠️ **npm 12 (bundled with Node 24.21) refuses JSR packages by default** —
`EALLOWREMOTE: Fetching packages of type "remote" have been disabled`, because JSR's npm
registry serves tarballs from a URL npm 12 classes as remote (`allow-remote` defaults to
`none`; npm 10 and 11 allow it). Allow it for the install:

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

#### As a global CLI tool

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

Bun and Node: **there is no global command from JSR.** JSR's npm packages carry no `bin`
entry (measured on 1.0.4: the package manifest has none), so `bun install -g` and `bunx` find
nothing to run. Install the package into a project as above and run its compiled CLI:

```bash
node node_modules/@jrmarcum/s3d-reportcompiler/main.js [reports-dir] [output.pdf]
bun  node_modules/@jrmarcum/s3d-reportcompiler/main.js [reports-dir] [output.pdf]
```

or name it once in that project's `package.json` — `"scripts": { "compile": "node
node_modules/@jrmarcum/s3d-reportcompiler/main.js" }` — and run `npm run compile` /
`bun run compile`. A global command is Deno's (above) or a clone's (below).

#### From a checkout

```bash
deno task install       # global command built from THIS working tree
deno task install:jsr   # global command from the published registry
deno task uninstall
```

`deno task install` is the one to use while developing or if you keep a clone: it
installs whatever is in your working tree, so there is no publish step and no
waiting on the registry. `install:jsr` installs the released package and passes
`--min-dep-age=0`, so it also works within 24 hours of a release.

Both install the command as `s3d-reportcompiler`, and `--force` means re-running
either one simply replaces whatever is installed.

#### Run on demand without installing

Deno:

```bash
deno run -A jsr:@jrmarcum/s3d-reportcompiler/cli
```

Bun and Node: there is no install-free form (no `bin`, see above) — `bunx` and `npx` on this
package find nothing to run.

### Requirements

- **Chrome or Edge** must be installed — it is the rendering engine, not an optional accelerator.
  Set `CHROME_PATH` if it is not in a standard location.
- **A supported runtime** — every current Node LTS line, Bun, and Deno's LTS line, each measured
  with the sample reports producing byte-identical output:

  | runtime | the installed package | a clone of this repository |
  |---|---|---|
  | Node 22 | 22.6 or later | **22.18 or later** (the first 22.x that runs `.ts` with no flag) |
  | Node 24, Node 26 | ✅ | ✅ |
  | Bun | 1.4.4 (the version measured; Bun has no LTS line) | 1.4.4 |
  | Deno | 2.9 LTS (2.9.8 measured) | 2.9 LTS |

  `bun run runtimes` re-checks a clone against Node's own LTS schedule — see
  [Supported runtimes](#supported-runtimes) below.

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
| `--no-keep-html` | discard the baked HTML after rendering, leaving only the PDF |
| `--no-optimize` | skip the object-stream repack (roughly doubles the file size) |
| `--no-verify` | skip the conservation check — **not advisable** for a document that will be issued |
| `--version` | print the version and exit |
| `--help` | print usage and exit |

Unknown flags are rejected rather than ignored, so a mistyped `--no-optimise` cannot silently do the
opposite of what you asked.

> ⚠️ **Every `.html` file in the input folder is treated as a report.** Keep tooling, examples and
> build output somewhere else. Input and output default to separate folders precisely so the scan
> cannot ingest a build artifact of its own.

### Try it without your own data

Thirteen sanitized sample reports ship with the repository — covering both section shapes in the
original set (`HSS6x6x3/16` and all three `HSS12x12x5/8` members):

```bash
git clone https://github.com/synapticforge1/S3D-ReportCompiler
cd S3D-ReportCompiler && npm install
cd tests && deno run -A ../main.ts
```

```
Compiling 13 report(s) on deno
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
✅ node 22.18.0 (floor)         PASS  html 7f283563003f
✅ node 22                      PASS  html 7f283563003f
✅ node 24                      PASS  html 7f283563003f
✅ node 26 (LTS 2026-10-28)     PASS  html 7f283563003f
✅ bun                          PASS  html 7f283563003f
✅ deno                         PASS  html 7f283563003f
✅ 6 runtime(s), one baked document (7f283563003f)
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

Identical, once the package is added with `bunx jsr add --bun` / `npx jsr add` (see
[Installation](#installation) for npm 12):

```typescript
import { assembleDocument, bakeBody, bakeStyle } from "@jrmarcum/s3d-reportcompiler";
```

### Web

The core is bundler-ready — it touches no filesystem, no process and no runtime global. Bundle it
for the browser with any bundler:

```bash
bun build ./src/report_core.ts --target=browser --outfile=report_core.browser.js
```

```html
<script type="module">
  import { assembleDocument, bakeBody, bakeStyle, findLeftoverMath }
    from "./report_core.browser.js";

  const styles = sources.map((src, i) => bakeStyle(src, `.rs${i}`, `r${i}-`));
  const bodies = sources.map((src, i) => bakeBody(src, `r${i}-`));

  const leftovers = findLeftoverMath(bodies.join(""));
  if (leftovers.length) throw new Error("unrendered maths: " + leftovers.join(", "));

  document.querySelector("iframe").srcdoc = assembleDocument(bodies, styles, mathStyleSheet());
  // the browser IS the print engine — window.print() from here
</script>
```

`@jrmarcum/s3d-reportcompiler/runtime` is **not** importable in a browser; every function in it
throws a descriptive error rather than failing obscurely.

### Building a document

| Export | Description |
| --- | --- |
| `bakeBody(src, prefix)` | One report's `<body>` → maths pre-rendered to CHTML, scripts stripped, spinner removed, ids namespaced |
| `bakeStyle(src, scope, prefix)` | One report's stylesheet → every selector scoped to that report's wrapper, every id namespaced |
| `assembleDocument(bodies, styles, mathCss)` | Many baked reports → one hermetic, printable HTML document |
| `mathStyleSheet()` | The MathJax CHTML stylesheet the baked maths needs |
| `scopeCss(css, scope, prefix)` | The scoping primitive behind `bakeStyle` — prefix every selector, namespace every id |
| `portableSvg(html)` | Hoist an inline SVG's internal `<style>` onto presentation attributes, so it survives being merged into a shared document |

### Reading a report's own maths configuration

| Export | Description |
| --- | --- |
| `parseDelimiters(src)` | Read the report's embedded `tex2jax` config → `Delim[]`, sorted longest-opener-first |
| `buildMathRegex(delims)` | Compile those delimiters into a single matcher |
| `FALLBACK_DELIMS` | Used only when a report carries no readable config |
| `skippedDelims` | Degenerate delimiters that were refused — e.g. a bare `[`, which would treat every bracketed phrase as an equation |
| `delimSignatures` | One entry per distinct delimiter set seen; more than one means the inputs disagree |

### Verifying the result

| Export | Description |
| --- | --- |
| `extractSourceTokens(sources)` | Every word, number and expected image count the sources contain → `SourceTokens` |
| `compareAgainstPdf(expected, observed, reportCount)` | Compare against what was found in the PDF → `VerificationResult` with a `failures[]` array |
| `findLeftoverMath(baked)` | **The guard.** Surviving delimiters and TeX commands in a baked document — an empty array is the only acceptable result |
| `textWords(text)` / `textNumbers(text)` | The tokenizers, exposed so a caller can re-derive expectations independently |
| `decodeEntities(s)` | HTML entity decoding used by both sides of the comparison |
| `sortReportNames(names)` | Numeric-aware sort, so `member_2` precedes `member_10` |

### Counters and diagnostics

| Export | Description |
| --- | --- |
| `audit` | What the bake step removed or rewrote: `loadersRemoved`, `visibilityNeutralised`, `heightNeutralised`, `atPageDropped`, `strayTokensDropped`, `bodyTagMissing` |
| `mathStats` | `converted`, `failed`, `firstFailure` |
| `svgStyleWarnings` | SVG rules that could not be hoisted |
| `VERSION`, `MATHJAX_FONTS` | Package version; the CDN base the fonts are inlined from |

### Host adapter — `/runtime`

| Export | Description |
| --- | --- |
| `RUNTIME` / `isBrowser` | `"deno" \| "bun" \| "node" \| "browser"`. Bun is detected before Node, because Bun also sets `process.versions.node` |
| `findChrome()` | Locate Chrome or Edge, honouring `CHROME_PATH` |
| `run(cmd, argv)` | Spawn a process to completion, capturing stderr |
| `cwd()`, `args()`, `env(name)`, `exit(code)` | Process access |
| `readTextFile`, `readFile`, `writeFile`, `listFiles`, `fileExists` | Filesystem reads and writes |
| `mkdirp`, `removeQuietly`, `rename`, `makeTempDir`, `realPath` | Filesystem management |
| `joinPath`, `baseName`, `toFileUrl` | Path handling |

---

## ✅ What "verified" actually proves

The check re-reads the sources and the finished PDF **from disk** and re-derives its expectations
independently — a build and its own self-assessment failing the same way is what it exists to rule
out.

Two limits worth knowing before you rely on it:

- **Conservation is a set union across all reports.** It proves every distinct value in the package
  appears somewhere in the PDF, not that each value appears in the *right* report. With genuinely
  different members that is a strong guarantee; it would not catch one member being silently
  replaced by a duplicate of another.
- **The diagram-split check is template-specific.** It keys on the SkyCiv diagram's title and axis
  caption. A different template makes it find nothing — so the count is printed, and
  `0 diagram(s) checked` means it did not run, **not** that everything is fine.

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
| ✅ | Output | Hermetic baked document: 0 scripts, 0 external refs, fonts inlined |
| ✅ | CSS | Per-report stylesheet scoping and id namespacing, so heterogeneous inputs cannot collide |
| ✅ | Layout | `break-inside: avoid` on figures and equations only — not sections, which cost 123 pages |
| ✅ | Portability | One adapter for Deno, Node and Bun; byte-identical baked HTML on all three |
| ✅ | Portability | Browser path — bake and print, with the same guard as the CLI |
| ✅ | CLI | Defaults resolve from the working directory, so a global install is relocatable |
| ✅ | Packaging | Published to JSR with GitHub Actions OIDC provenance |
| ⏳ | Verification | **Per-report conservation.** Segment the PDF at report headings and compare each segment against its own source, closing the set-union gap above |
| ⏳ | Maths | **MathJax 3 → 4.** Deferred deliberately: v4 replaced the font system, so glyph metrics, line breaking and page count all move. Deprecation is not an advisory — `npm audit` reports 0 vulnerabilities. Requires a measured no-degradation comparison first |
| ⏳ | CSS | **Scope the remaining blanket rewrites.** `visibility: hidden → visible` and `height: 100% → auto` are still textual. They are audited and counted, and they fail *visibly*, which is the safer class — narrowing them means evaluating the cascade |
| ⏳ | Upstream | **Emit MathML from SkyCiv instead.** Their reports are generated from structured data; HTML → PDF is a lossy round-trip through a format that was never the source of truth |

---

## Known behaviour

- **`$` as a delimiter is inherently ambiguous.** A literal dollar sign in prose either pairs with
  the next one and swallows the text between, or is stranded and fails the guard. That ambiguity is
  in the source document — MathJax reads these reports exactly the same way.
- **`--no-sandbox` is passed to Chrome** so it can run as root in a container. It is only defensible
  because the input is a document this tool generated itself. Drop it if the HTML ever comes from
  somewhere untrusted.
- **Fonts cache to `.mathjax-fonts/`** in the working directory on first run, so later builds work
  offline.
- **The PDF is not byte-reproducible.** Chrome stamps its own render time into `/CreationDate` and
  `/ModDate`, so two builds of identical input differ in hash — on the same runtime. The *baked
  HTML* is byte-identical across Deno, Node and Bun; that is the artifact worth comparing.
- **`Cannot polyfill Path2D` / `DOMMatrix`** from pdfjs is expected and harmless. It is those
  optional packages being absent, which is the intended state — chasing it leads back to installing
  a dependency with known advisories that this build cannot use anyway.

## Licence

MIT © 2026 Jon Marcum. See [LICENSE](LICENSE).

Every dependency is permissive — MIT, Apache-2.0, 0BSD, Zlib — with no copyleft and no NOTICE files
to propagate. The published package bundles no third-party code. Full verified tree and the two
places where third-party code *does* travel into an artifact:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
