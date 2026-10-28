# Licensing

All runtime dependencies are **permissive**. Verified from the registry and the projects' own LICENSE
files, not from memory — licensing is exactly the kind of fact that changes and that matters
commercially.

## Runtime dependencies

| Package | Version | Licence | Notes |
|---|---|---|---|
| `mathjax-full` | 3.2.2 | **Apache-2.0** | typesets the maths at build time |
| `pdf-lib` | 1.17.1 | **MIT** | object-stream repack |
| `pdfjs-dist` | 6.4.299 | **Apache-2.0** | text/operator extraction for verification (4.6.82 until 2026-10-28) |
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

- **The published package bundles nothing.** It is six first-party files; dependencies are declared
  and resolved by the consumer. No attribution obligation is triggered by publishing it.
- **No NOTICE files to propagate.** None of the Apache-2.0 packages in the tree ships one, so
  Apache-2.0 §4(d) imposes nothing.
- **Two artifacts do carry third-party code**, neither of them committed: the browser bundle, which
  bundles MathJax, and the output PDF, which embeds MathJax's Apache-2.0 fonts as data URIs. See
  [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
