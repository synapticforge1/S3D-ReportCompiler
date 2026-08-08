# Licensing

All runtime dependencies are **permissive**. Verified from the registry and the projects' own LICENSE
files, not from memory — licensing is exactly the kind of fact that changes and that matters
commercially.

## Runtime dependencies

| Package | Version | Licence | Notes |
|---|---|---|---|
| `mathjax-full` | 3.2.2 | **Apache-2.0** | typesets the maths at build time |
| `pdf-lib` | 1.17.1 | **MIT** | object-stream repack |
| `pdfjs-dist` | 4.6.82 | **Apache-2.0** | text/operator extraction for verification |
| `@types/node` | ^22.10.2 (dev) | MIT | needed only by `deno check` |

`pdf-lib` pulls `pdfkit`, `xmldoc` and `linebreak` — all MIT.

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

No licence file has been chosen. If this is offered to SkyCiv or published, pick one — the dependency
set imposes no copyleft, so anything from MIT upward is available.
