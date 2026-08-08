# Third-Party Notices

`@jrmarcum/s3d-reportcompiler` is licensed under the MIT License — see [LICENSE](LICENSE).

This file lists the third-party software it depends on. Every entry was verified from the installed
package's own `package.json` and `LICENSE` file, not from memory or from the registry summary.

**Last verified: 2026-08-08, against the tree pinned by `package-lock.json`. `npm audit`: 0
vulnerabilities.**

## Does this package redistribute any of it?

**No.** The published package contains six files of first-party source — `LICENSE`, `README.md`,
`deno.json`, `main.ts`, `src/report_core.ts`, `src/report_runtime.ts` — and no vendored or bundled
third-party code. Dependencies are declared and resolved by the consumer's own runtime.

That means no attribution obligation is triggered by installing or publishing this package. This file
exists so a reviewer does not have to reconstruct the tree to establish that.

Two places where third-party code **is** carried into an artifact are called out under
[Redistribution](#redistribution-when-it-does-apply) below.

## Licences in the dependency tree

All permissive. **No copyleft, and no NOTICE files to propagate** — none of the Apache-2.0 packages
above ships one, so Apache-2.0 §4(d) imposes nothing here.

### Direct runtime dependencies

| Package | Version | Licence | Used for |
|---|---|---|---|
| `mathjax-full` | 3.2.2 | Apache-2.0 | typesets the LaTeX to CHTML at build time |
| `pdf-lib` | 1.17.1 | MIT | repacks the PDF into object streams |
| `pdfjs-dist` | 4.6.82 | Apache-2.0 | text and operator extraction for the verification pass |

### Transitive

| Package | Version | Licence | Comes in via |
|---|---|---|---|
| `esm` | 3.2.25 | MIT | `mathjax-full` |
| `mhchemparser` | 4.2.1 | Apache-2.0 | `mathjax-full` |
| `mj-context-menu` | 0.6.1 | Apache-2.0 | `mathjax-full` |
| `speech-rule-engine` | 4.1.4 | Apache-2.0 | `mathjax-full` |
| `@xmldom/xmldom` | 0.9.10 | MIT | `speech-rule-engine` |
| `commander` | 13.1.0 | MIT | `speech-rule-engine` |
| `wicked-good-xpath` | 1.3.0 | MIT | `speech-rule-engine` |
| `@pdf-lib/standard-fonts` | 1.0.0 | MIT | `pdf-lib` |
| `@pdf-lib/upng` | 1.0.1 | MIT | `pdf-lib` |
| `pako` | 1.0.11 | MIT AND Zlib | `pdf-lib` |
| `tslib` | 1.14.1 | 0BSD | `pdf-lib` |

### Development only

| Package | Version | Licence | Note |
|---|---|---|---|
| `@types/node` | 22.20.1 | MIT | needed by `deno check`; not required at runtime |
| `undici-types` | 6.21.0 | MIT | via `@types/node` |

⚠️ `mj-context-menu` declares `Apache-2.0` in its `package.json` but **ships no licence file**. The
declaration governs; noted only so a reviewer running an automated file-based scan is not surprised
when it reports one package without a licence text.

### Optional dependencies, deliberately not installed

`pdfjs-dist` declares `canvas` and `path2d` as optional. Both exist only to rasterise a PDF page to a
canvas; this build never rasterises. `.npmrc` sets `omit=optional`, which takes the install from 18
packages to 16 and `npm audit` from 2 vulnerabilities to 0 — `canvas` pulled in
`@mapbox/node-pre-gyp → tar`, which carried one critical and one high advisory. Its native binding was
never even built, so the package could not load.

⚠️ Do not "fix" the `Cannot polyfill Path2D` / `DOMMatrix` notice from pdfjs. That message *is* those
packages being absent, which is the intended state.

## Runtimes and the browser

| | Licence |
|---|---|
| Deno, Node.js, Bun | MIT |
| Chromium | BSD-3-Clause (plus others) |

⚠️ **Google Chrome the binary ships under Google's proprietary Terms of Service, not an open-source
licence.** Chromium is BSD-3-Clause. Neither is redistributed by this project — the browser is
discovered on the host and invoked — but the distinction matters if this is ever packaged into a
container or an installer.

## Redistribution: when it *does* apply

Two artifacts carry third-party code. Neither is produced by installing this package, and neither is
committed to this repository, but both are worth knowing about before shipping one onward.

### 1. The browser bundle

`deno task bundle:browser` produces `tests/report_core.browser.js`, which **bundles MathJax**
(Apache-2.0) — roughly 285 modules. It is generated and git-ignored.

If that file is ever distributed, Apache-2.0 §4 applies: include a copy of the licence and retain the
attribution notices. It is not distributed today.

### 2. Fonts embedded in the output PDF

The build inlines MathJax's CHTML web fonts (Apache-2.0) as data URIs so the document is hermetic, and
they end up embedded in the finished PDF. Embedding a permissively-licensed font in a generated
document is ordinary and permitted — but it does mean **a PDF produced by this tool contains
Apache-2.0 licensed font data**, which is worth knowing if the output is issued under a client's or an
employer's own terms.

## Compliance summary

| Question | Answer |
|---|---|
| Any copyleft (GPL/LGPL/AGPL/MPL)? | **No** |
| Any NOTICE files requiring propagation? | **No** — none of the Apache-2.0 packages ships one |
| Any licence incompatible with releasing this as MIT? | **No** — MIT, Apache-2.0, 0BSD and Zlib are all compatible with an MIT release |
| Third-party code inside the published package? | **No** — six first-party files |
| Known vulnerabilities? | **None** — `npm audit`: 0 |
| Attribution required to publish? | **No**, given the above. This file is provided for transparency |

Apache-2.0 carries an express patent grant that terminates on patent litigation. That is normally
regarded as a feature, but it is the clause a legal reviewer will flag, so it is stated here.
