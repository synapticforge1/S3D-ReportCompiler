# Licensing

All runtime dependencies are **permissive**. Verified from the registry and the projects' own LICENSE
files, not from memory — licensing is exactly the kind of fact that changes and that matters
commercially.

## Runtime dependencies

Columns: Package · Version · Licence · Notes.

- `mathjax-full` — 3.2.2 — **Apache-2.0** — typesets the maths at build time
- `pdf-lib` — 1.17.1 — **MIT** — object-stream repack
- `pdfjs-dist` — 6.4.299 — **Apache-2.0** — text/operator extraction for verification (4.6.82 until 2026-10-28)
- `@pdf-lib/fontkit` — 1.1.1 — **MIT** — the native renderer's font embedding (task 19; added 2026-11-11, owner: "We
  need to add the dependency and make any license references for compiance sake"). Declared in `package.json` and its
  README; **ships no licence file** -- recorded in THIRD-PARTY-NOTICES

## Shipped with the package: the Liberation Fonts 2.1.5 (SIL OFL 1.1)

🔒 Owner, 2026-11-11: "we should embed the fonts into the file that are required for fidelity. and
into the project for full compatibility on the usage and incorporation needs." `fonts/liberation/`
holds the twelve TTFs, unmodified, with `LICENSE` (the OFL) and `AUTHORS`; its README records the
upstream release, the tarball's and each file's SHA-256, and `readRenderFonts`
(`src/report_runtime.ts`) refuses a file whose hash differs. Both packages ship the folder
(`jsr.json` `publish.include`; `scripts/npm-build.ts`), and `npm:prove` fails a tarball missing any
of it. What the OFL asks, read from the licence itself (2026-11-11): not sold by itself (cond. 1);
the copyright notice and licence with every copy (cond. 2 -- the LICENSE file beside them); no
Reserved Font Name on a modified version (cond. 3 -- not modified); the fonts stay OFL (cond. 5),
which "does not apply to any document created using the Font Software" -- so the PDFs carry no
font-licence obligation. **This ended "the published package bundles nothing"** (below): it now
redistributes third-party files, under their own licence, alongside the MIT code.
| `@napi-rs/canvas` (+ one platform binary) | 1.0.11 | **MIT** | optional dependency of `pdfjs-dist` 6; licence files read 2026-10-28 |
| `@xmldom/xmldom` (transitive) | 0.9.12 | MIT | overridden from 0.9.10 (roadmap task 13) |
| `@types/node` | 22.20.1 (dev) | MIT | type checking only |

⚠️ **Corrected 2026-08-08:** an earlier version of this file said "`pdf-lib` pulls `pdfkit`, `xmldoc`
and `linebreak` — all MIT." **None of those three is in the tree.** They are dependencies of
`pdf-lib`'s *source* repository, not of the published package. What is actually installed is
`@pdf-lib/standard-fonts`, `@pdf-lib/upng`, `pako` and `tslib`. The conclusion was right by luck —
they are all permissive — but the list was wrong, and it was wrong because it was written from the
project's README rather than from `npm ls`.

The full verified tree, with the parent each package arrives through, now lives in
[../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) and is generated from what is actually on disk.
That file is the authority; this one is the reasoning.

## Runtimes

| | Licence |
|---|---|
| Deno | MIT |
| Node.js | MIT |
| Bun | MIT |
| Chromium | BSD-3-Clause (+ others) |

⚠️ **Google Chrome the binary ships under Google's proprietary Terms of Service, not an open-source
licence.** Chromium is BSD-3-Clause. If this is ever packaged for redistribution, that distinction
matters — and it is a quiet argument in favour of the "fix it upstream" pitch in
[known-issues.md](known-issues.md), since a vendor may be uncomfortable depending on it.

## Written from a standard, tested against a reference: `src/report_jpeg.ts`

The lossless JPEG re-coder (2026-11-11) implements ITU-T T.81 Annexes C, F and K.2 from the
standard's description -- not ported from libjpeg / libjpeg-turbo, so no IJG acknowledgement is
owed; THIRD-PARTY-NOTICES says so, so a reviewer does not take the byte-identical output for
copied code. libjpeg-turbo 2.1.5 (`jpegtran`, `cjpeg`) was the measuring reference only, fetched with
`apt-get download` into a WSL temp folder and never installed; its outputs (the test images'
references in `tests/jpeg/jpegtran/`) carry no licence of the tool's.

## Evaluated and not adopted

| Option | Licence | Why not — see [design-decisions.md](design-decisions.md) |
|---|---|---|
| **WeasyPrint** | BSD-3-Clause | No JavaScript engine → blank pages. Also requires Python |
| **pdfmake** | MIT | No CSS engine; cannot place SVG inline within text |
| **Typst** | **Apache-2.0** | Does not read HTML/CSS; right tool for generating from a data model, not for converting |

### Typst licence detail, if it is ever reconsidered

Verified from the repository's own `LICENSE`: **Apache License 2.0**. The `typst.ts` WASM bindings are
Apache-2.0 as well. Permissive and commercially usable, with three things a legal reviewer would want
flagged:

- The **express patent grant**, which terminates on patent litigation. Usually seen as a feature;
  it is the clause that gets flagged in review.
- The `NOTICE` file lists third-party code under MIT, a BSD-licensed Skia port, Apache-2.0-with-LLVM
  -exceptions, and — the unusual one — **translation files derived from the LaTeX packages Babel and
  Cleveref under the LPPL (1.2–1.3)**, a niche licence with file-renaming obligations on modification.
- **Bundled fonts are not mentioned in `NOTICE`.** Typst ships default fonts with their own licences
  (typically SIL OFL). Not investigated — it would need checking before embedding Typst in a product.

MIT (pdfmake's licence) is the lowest-friction option for procurement review; Apache-2.0 is broadly
accepted but carries the NOTICE-propagation and patent clauses.

## This project

**MIT**, © 2026 Jon Marcum. `LICENSE` is at the repository root, and `deno.json` declares
`"license": "MIT"` so JSR records it.

Compatible with the whole dependency set: MIT, Apache-2.0, 0BSD and Zlib impose no copyleft.

### Obligations, checked before the first publish

- ~~**The published package bundles nothing.**~~ True at the first publish (six first-party files);
  🔁 **no longer:** `src/report_webp.ts` is ported from libwebp (BSD-3-Clause, 2026-11-10, its notice
  kept), and since 2026-11-11 `fonts/liberation/` ships the Liberation Fonts (SIL OFL 1.1, above).
  Both carry attribution obligations, met in the files themselves and in THIRD-PARTY-NOTICES, which
  both packages ship. Dependencies are still declared and resolved by the consumer.
- **No NOTICE files to propagate.** None of the Apache-2.0 packages in the tree ships one, so
  Apache-2.0 §4(d) imposes nothing.
- **Two artifacts do carry third-party code**, neither of them committed: the browser bundle, which
  bundles MathJax, and the output PDF, which embeds MathJax's Apache-2.0 fonts as data URIs (and,
  rendered natively, subsets of the Liberation Fonts, which the OFL does not reach). See
  [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
