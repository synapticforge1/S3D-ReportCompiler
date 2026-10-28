# Architecture

## On disk

```
main.ts                        CLI entry point
src/                           the two library modules
scripts/                       release tooling, sample sanitizer (Deno); new shell-style scripts are Bun .ts — practices.md §15
tests/HTMLFilesToBeCompiled/   13 SANITIZED sample reports (committed)
tests/controls/                negative controls
tests/browser_example.html     the browser path
local/                         the real 48-report client set — GIT-IGNORED as a whole directory
cmem/                          portable project memory
<cwd>/CompiledPDF/             created on demand; holds combined_report.html AND .pdf
<cwd>/.mathjax-fonts/          font cache, in the working directory (never inside the input folder)
```

⚠️ **`CompiledPDF/` is never committed and has no placeholder.** It is created next to whatever is
being compiled, so a `.gitkeep` would only pin one arbitrary copy of a directory that appears
wherever you run. It is ignored at every depth, with no exceptions — every PDF built from the real
set is a render of client calculations.

⚠️ **Both outputs live there.** The baked HTML used to go to a temp directory unless `--keep-html`
was passed; it is now written beside the PDF by default, because it is the exact document Chrome was
given and therefore the only way to reproduce or diagnose a result after the fact. `--no-keep-html`
discards it, and only *after* a successful render — on a failed build it is the first thing worth
reading. The temp directory now holds nothing but the Chrome profile.

⚠️ **Input and output are separate directories by design**: under an earlier flat layout the input
scan ingested the tool's own output as an extra report. Both paths are overridable positionally, and
the tool-owned-file guard remains for anyone who points them at the same folder.

⚠️ **`local/` is ignored as a whole directory, not per file.** A per-file rule leaks the moment a new
report is dropped in beside the samples. Only `scripts/sanitize-report.ts` moves anything from
`local/` into `tests/`, and it verifies its own output before writing.

## Three modules

| File | Runs on | Contains |
|---|---|---|
| `src/report_core.ts` | **everything, browsers included** | every transform; **zero I/O** |
| `src/report_runtime.ts` | Deno, Node, Bun | filesystem, process, browser discovery |
| `main.ts` | Deno, Node, Bun | orchestration, reporting, the CLI |

**The core performs no I/O — strings in, strings out.** That single constraint is what lets it run in a
browser unchanged, and it is worth defending: the moment the core reads a file, the browser path dies.

## The pipeline

```
sources ──► BAKE ──► GUARD ──► RENDER ──► OPTIMIZE ──► VERIFY ──► PDF
            core     core      runtime    pdf-lib      core+pdfjs
```

1. **BAKE** (core) — parse each report's own delimiter config, pre-render the maths to CHTML, strip
   scripts, remove the spinner, namespace ids, scope the CSS, hoist SVG styles onto presentation
   attributes, inline the fonts. Output is one hermetic document.
2. **GUARD** (core) — refuse to continue if anything that looks like unrendered maths survives. An
   unrecognised delimiter never errors on its own; this is the only thing that catches it.
3. **RENDER** (runtime) — one headless Chrome pass over the whole document.
4. **OPTIMIZE** (pdf-lib) — repack Chrome's uncompressed objects into object streams.
5. **VERIFY** (core + pdfjs) — re-read sources and PDF from disk, prove nothing was lost, exit non-zero
   if it was.

## Cross-runtime strategy

**One adapter, not three.** Deno, Node and Bun all implement the `node:` builtins this needs —
`fs/promises`, `child_process`, `os`, `path`, `url` — including `spawn`, the part most likely to differ.
This was **probed before being designed around**, not assumed.

The builtins are imported **lazily**, because a browser has no filesystem and would fail on a static
`import "node:fs"`.

```ts
export const RUNTIME =
  typeof Bun  !== "undefined" ? "bun"      // checked first: Bun also sets process.versions.node
: typeof Deno !== "undefined" ? "deno"
: typeof process !== "undefined" && process.versions?.node ? "node"
: "browser";
```

⚠️ **Bun must be detected before Node** — Bun also populates `process.versions.node`.

`process.argv.slice(2)` gives the same arguments on all three, so argument handling is shared too.

## What the browser can and cannot do

| | Browser |
|---|---|
| Bake reports into one printable document | ✅ |
| Run the unrendered-maths guard | ✅ |
| Print the result | ✅ — `window.print()`; the browser **is** the engine |
| Read a folder, launch a browser, repack a PDF on disk | ❌ |

So the browser flow is *bake → hand HTML to the page → print*, which `browser_example.html`
demonstrates. Verified in real headless Chrome: 169 expressions converted, 0 failed, and the baked HTML
actually rendered in an iframe — matching the server-side numbers exactly.

One deliberate difference: the CLI inlines MathJax's fonts as data URIs to make the output hermetic;
the browser build leaves them as CDN references, because in a browser the network is already how
everything else loaded.

## Dependency resolution

The source uses **bare specifiers only** — no `npm:` or `jsr:` prefixes anywhere in `main.ts`,
`src/` or the controls. That is what lets one file tree serve four runtimes.

Node and Bun resolve those specifiers from `node_modules` via `package.json`. Deno now resolves them
through the `imports` map in `deno.json`, which is required for JSR: a published package must declare
where its dependencies come from, and `deno publish` will not accept a bare specifier it cannot
resolve.

⚠️ **`"nodeModulesDir": "manual"` is load-bearing, not boilerplate.** It keeps Deno reading the same
`node_modules` that `npm install` produced — the same packages, `overrides` included (the
`@xmldom/xmldom` and `@napi-rs/canvas` pins below). Without it Deno resolves from its own global
cache, independently of this lockfile — whether it would then apply `package.json` `overrides` is
UNMEASURED, so do not rely on it. (Until 2026-10-28 the reason given here was
`.npmrc`'s `omit=optional`, since removed.)
Verified after the change: the full 48-report build still produces 380 pages / 3.35 MB with 8,286
expressions and 0 failures, and the baked HTML is still byte-identical across Deno, Node and Bun.

## JSR packaging

Published as `@jrmarcum/s3d-reportcompiler` from GitHub Actions, never from a workstation — JSR only
records a provenance attestation for a publish that arrives through its native GitHub OIDC
integration, so a local `deno publish` would succeed and produce an *unattested* release.

**The publishing path, and what pins it** (workspace letter H20, checked 2026-10-28). One registry,
JSR; one path: `.github/workflows/publish.yml` on a `v*` tag, `id-token: write`, `deno publish` with
GitHub OIDC — no token anywhere. No npm, PyPI or other trusted-publisher policy exists yet — but npm
is now planned (owner, 2026-10-28: "npm as well as jsr", roadmap task 15), and its trusted publisher
must be created under the org before the first npm publish (H20's lesson). JSR links the package to the GitHub repository **by repository id**: its API reads
`githubRepository` = `synapticforge1/S3D-ReportCompiler`, id `1328030455` — GitHub's id for that
repository (owner `synapticforge1`, id `342141589`, Organization). ⚠️ **JSR does not follow a
transfer or a rename on its own** (binaryang measured it, its `cmem/publishing.md`): the link here
was re-linked on 2026-10-20 at 23:37:36 UTC, 93 s after binaryang's, so it already names the org.
binaryang's 1.13.1 proved the same path publishes with provenance from the org. **Not yet
measured for THIS package:** its first release from the org — `bun run release` ends with
`verify-release`, which is the check. **Before any release after a future move:** read
`api.jsr.io/scopes/jrmarcum/packages/s3d-reportcompiler` → `githubRepository` first; a stale link
shows only as a provenance failure, on a version that can never be republished.

| Export | Points at | Why |
|---|---|---|
| `.` | `src/report_core.ts` | the programmatic API is the pure core — importing it has no side effects |
| `./cli` | `main.ts` | the command-line entrypoint |
| `./runtime` | `src/report_runtime.ts` | host adapter; throws in a browser |

⚠️ **`./cli` exists because `deno install -g` installs the `.` export, not the `bin` field.** Without
it, `deno install -g jsr:@jrmarcum/s3d-reportcompiler` installs `report_core.ts` — a pure library — so
the command runs, does nothing and **exits 0**. It looks installed and behaves like a no-op. This
shipped in 1.0.0 and was only found by someone actually installing it; the README documented the
broken command, because the install path was never exercised. The correct form is:

```bash
deno install -g -n s3d-reportcompiler -A jsr:@jrmarcum/s3d-reportcompiler/cli
```

Splitting the library from the CLI is still right — `import "@jrmarcum/s3d-reportcompiler"` must not
execute a build — so the fix is the extra export rather than pointing `.` at `main.ts`.

### Installing it

| Task | Installs from | Use when |
|---|---|---|
| `bun run cli:install` | this working tree | developing, or you keep a clone — no publish, no registry lag |
| `bun run cli:install-jsr` | the published package | you want exactly what users get |

⚠️ **`bun run cli:install` deliberately omits `--config deno.json`.** Passing it breaks the install:

```
error: Failed to resolve the specifier "mathjax-full/js/input/tex/AllPackages.js" as its
after-prefix portion could not be URL-parsed relative to "npm:mathjax-full@3.2.2/"
```

The trailing-slash prefix mapping in `imports` — required for JSR to resolve subpath imports — is not
handled the same way when the config is attached to a globally installed command. Without `--config`,
Deno resolves the bare specifiers through `package.json` instead and it works. Verified end to end:
the installed command compiles the 13 samples to 100 pages and reports PASS.

⚠️ `install:jsr` passes `--min-dep-age=0`, because Deno's 24-hour minimum dependency age otherwise
installs the *previous* release and reports the error against *its* exports.

⚠️ **JSR rejects "slow types".** Every exported symbol needs a type its analyser can read without
running `tsc`. Four exported `new Set<string>()` declarations had to become
`const x: Set<string> = new Set()`. `deno publish --dry-run` is the check; it is a hard error, not a
warning.

⚠️ `@types/node` is a **devDependency for Deno's benefit**: `deno check` needs it to resolve the
`node:` builtin type references. Runtime works without it.

⚠️ **`package.json` must not have a UTF-8 BOM.** Deno's JSON parser rejects it with a misleading
"Malformed package.json … expected value at line 1 column 1". PowerShell's `Set-Content -Encoding utf8`
writes one.

### Optional dependencies — installed since pdfjs 6 (2026-10-28)

`pdfjs-dist` 6.4.299 declares one optional dependency, **`@napi-rs/canvas`** (pinned 1.0.11 by
`overrides`), which supplies `DOMMatrix` / `Path2D` from prebuilt N-API binaries — no node-gyp, no
`tar`; it loads on Deno, Bun and Node. It is itself split into OPTIONAL per-platform packages, so the
old `.npmrc` `omit=optional` was REMOVED (it would drop the binary — the Biome trap). The 12 optional
entries in the lockfile are exactly `@napi-rs/canvas` and its 11 platform binaries.

*History:* pdfjs 4.6.82 declared the old `canvas` and `path2d`; `canvas` pulled in
`@mapbox/node-pre-gyp → tar` (one critical, one high advisory) and never built, so `omit=optional`
took the install from 18 packages to 16 and `npm audit` from 2 to 0. Both gone with pdfjs 6.

⚠️ **A `Cannot polyfill Path2D` / `DOMMatrix` notice now means the optional binary is MISSING** (an
install that skips optional dependencies, or no prebuilt binary for the platform) — not the intended
state any more. Measured 2026-10-28: with `@napi-rs/canvas` installed, none appears on Deno, Bun or
Node, and every verification count is identical either way (the verification never draws). *Until
2026-10-28 the instruction here was the opposite — "do not fix it" — while pdfjs 4's only source was
the vulnerable old `canvas`.*

## Browser bundle

`bun run bundle:browser` → `bun build --target=browser` → `tests/report_core.browser.js` (1.57 MB,
285 modules, mostly MathJax). Generated, and git-ignored. It is emitted into `tests/` because
`tests/browser_example.html` imports it as a sibling.
