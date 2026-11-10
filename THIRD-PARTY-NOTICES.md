# Third-Party Notices

`@jrmarcum/s3d-reportcompiler` is licensed under the MIT License — see [LICENSE](LICENSE).

This file lists the third-party software it depends on. Every entry was verified from the installed
package's own `package.json` and `LICENSE` file, not from memory or from the registry summary.

**Last verified: 2026-11-07, against the tree pinned by `bun.lock`. `bun audit`: no
vulnerabilities (49 packages checked).** (First verified 2026-08-08 against `package-lock.json`;
`bun.lock` replaced it on 2026-10-28; TypeScript joined the development tree since.)

## Does this package redistribute any of it?

**One file is derived from third-party code.** The JSR package contains `LICENSE`,
`THIRD-PARTY-NOTICES.md`, `README.md`, `jsr.json`, `main.ts` and `src/*.ts` (`jsr.json`
`publish.include`), and the npm package that source compiled to JavaScript with its declarations.
Of those, **`src/report_webp.ts` is a port of parts of libwebp** (BSD-3-Clause; see
[libwebp](#libwebp-src-report_webpts) below): its notice is kept in that file's header and reproduced
here. Nothing else is vendored or bundled; dependencies are declared and resolved by the consumer's
own runtime.

Two more places where third-party code **is** carried into an artifact are called out under
[Redistribution](#redistribution-when-it-does-apply) below.

### libwebp (`src/report_webp.ts`)

The verification's WebP decoder (roadmap task 18 group 7b) is ported from libwebp's decoder
(`src/dec/`, `src/dsp/`, `src/utils/`, read 2026-11-10), its constant tables extracted from
`src/dec/tree_dec.c`. libwebp is distributed under this licence:

```
Copyright (c) 2010, Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

libwebp also ships a separate `PATENTS` file: Google's additional grant of patent rights for its
implementation of VP8, an extra permission rather than a restriction. The conformance test vectors
used to prove the port (webm/libwebp-test-data) are not part of this repository or its packages.

## Licences in the dependency tree

All permissive. **No copyleft, and no NOTICE files to propagate** — none of the Apache-2.0 RUNTIME
packages ships one, so Apache-2.0 §4(d) imposes nothing here. (`typescript`, a development tool,
ships a `NOTICE.txt`; it is never redistributed — the npm package is compiled BY it, and carries
none of its code.)

### Direct runtime dependencies

| Package | Version | Licence | Used for |
|---|---|---|---|
| `mathjax-full` | 3.2.2 | Apache-2.0 | typesets the LaTeX to CHTML at build time |
| `pdf-lib` | 1.17.1 | MIT | repacks the PDF into object streams |
| `pdfjs-dist` | 6.4.299 | Apache-2.0 | text and operator extraction for the verification pass |

### Transitive

| Package | Version | Licence | Comes in via |
|---|---|---|---|
| `esm` | 3.2.25 | MIT | `mathjax-full` |
| `mhchemparser` | 4.2.1 | Apache-2.0 | `mathjax-full` |
| `mj-context-menu` | 0.6.1 | Apache-2.0 | `mathjax-full` |
| `speech-rule-engine` | 4.1.4 | Apache-2.0 | `mathjax-full` |
| `@xmldom/xmldom` | 0.9.12 | MIT | `speech-rule-engine` (overridden from 0.9.10 — `package.json` `overrides`) |
| `commander` | 13.1.0 | MIT | `speech-rule-engine` |
| `wicked-good-xpath` | 1.3.0 | MIT | `speech-rule-engine` |
| `@pdf-lib/standard-fonts` | 1.0.0 | MIT | `pdf-lib` |
| `@pdf-lib/upng` | 1.0.1 | MIT | `pdf-lib` |
| `pako` | 1.0.11 | MIT AND Zlib | `pdf-lib` |
| `tslib` | 1.14.1 | 0BSD | `pdf-lib` |

### Development only

| Package | Version | Licence | Note |
|---|---|---|---|
| `@types/node` | 22.20.1 | MIT | needed by `bun run check` (and CI's `deno check`); not required at runtime |
| `undici-types` | 6.21.0 | MIT | via `@types/node` |
| `typescript` | 7.0.2 | Apache-2.0 | compiles the npm package and its `.d.ts` (`npm:build`), and the compatibility gate's surface; ships a `NOTICE.txt` (above) |
| `@typescript/typescript-<platform>` | 7.0.2 | Apache-2.0 | `typescript` — its native compiler, one per platform |

⚠️ `mj-context-menu` declares `Apache-2.0` in its `package.json` but **ships no licence file**. The
declaration governs; noted only so a reviewer running an automated file-based scan is not surprised
when it reports one package without a licence text.

### Optional dependency (installed)

| Package | Version | Licence | Comes in via |
|---|---|---|---|
| `@napi-rs/canvas` | 1.0.11 | MIT | `pdfjs-dist` (optional; pinned by `overrides`) |
| `@napi-rs/canvas-<platform>` | 1.0.11 | MIT | `@napi-rs/canvas` — one prebuilt N-API binary per platform; npm installs only the one matching the machine |

`pdfjs-dist` 6 fills in `DOMMatrix` and `Path2D` from `@napi-rs/canvas`. The verification pass does
not draw, but with it installed pdfjs no longer warns "Cannot polyfill …" on any runtime.

*Until 2026-10-28* `pdfjs-dist` 4.6.82 declared the old `canvas` and `path2d` instead, and `.npmrc`
skipped all optional dependencies: `canvas` pulled in `@mapbox/node-pre-gyp → tar` (one critical, one
high advisory) and never built. That chain is gone with pdfjs 6 (`npm audit`: 0).

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

`bun run bundle:browser` produces `tests/report_core.browser.js`, which **bundles MathJax**
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
| Any NOTICE files requiring propagation? | **No** — none of the Apache-2.0 runtime packages ships one; the development tool that does (`typescript`) is not redistributed |
| Any licence incompatible with releasing this as MIT? | **No** — MIT, Apache-2.0, BSD-3-Clause, 0BSD and Zlib are all compatible with an MIT release |
| Third-party code inside the published package? | **One file, derived:** `src/report_webp.ts`, ported from libwebp (BSD-3-Clause), its notice in the file and [above](#libwebp-src-report_webpts); the rest first-party, the same source compiled on npm |
| Known vulnerabilities? | **None** in this repository's tree — `bun audit`, 2026-11-07. A consumer's install resolves `@xmldom/xmldom` afresh (README § Requirements: the `overrides` pins hold here only) |
| Attribution required to publish? | **Yes, for libwebp only** — its copyright notice, conditions and disclaimer must travel with the source (kept in `src/report_webp.ts`) and with any compiled copy (reproduced in this file, which both packages ship); otherwise no |

Apache-2.0 carries an express patent grant that terminates on patent litigation. That is normally
regarded as a feature, but it is the clause a legal reviewer will flag, so it is stated here.
