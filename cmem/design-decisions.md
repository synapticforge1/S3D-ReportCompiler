# Design Decisions & Invariants

Load-bearing decisions, each with the measurement that justifies it. **Do not silently revert these.**
Three of them look obviously improvable until you see the numbers.

---

## 1. Render with a browser engine (Chrome/Edge). Not WeasyPrint, not pdfmake, not Typst.

The original script used **WeasyPrint**, which has no JavaScript engine. Since the reports hide
themselves behind `visibility: hidden` until MathJax finishes, it would have produced ~400 blank pages
with a broken spinner. Neither WeasyPrint nor Python was even installed.

The general principle, which cost several rounds to establish:

> **Faithful HTML rendering requires an HTML engine.** The markup has no appearance until an engine
> computes one, and every engine computes it differently. Chrome is faithful here *because it is the
> same engine the reports were designed and viewed in*.

The fidelity ladder, in order:

| Approach | Fidelity to the source |
|---|---|
| Chrome / Chromium | exact by definition — same engine |
| WeasyPrint / Prince | real CSS engines; close, not identical |
| Typst | different typesetting model; excellent output, different document |
| pdfmake | **no CSS at all** — a hand-written re-implementation |

**pdfmake was spiked and rejected.** It works under Deno and handles tables, base64 PNGs and inline SVG
as true vectors (verified: 110 paths, 107 strokes, 146 text ops). But it consumes its own JSON document
model, so a converter would be transcribing the reports by hand — and it **cannot place an SVG inline
within a line of text**, which is fatal for the 87 inline expressions per report that sit mid-sentence.

**Typst was considered and rejected for this job.** It would likely produce a smaller file (~1–1.5 MB
estimated, never measured) and has first-class inline maths, but it does not read HTML/CSS either, so it
is the same transcription problem with better typography. It is the *right* tool if SkyCiv ever
generates from their data model instead — see [known-issues.md](known-issues.md).

---

## 2. Encode maths as CHTML. **Not SVG. Not MathML.** This is the single biggest size lever.

All three were built and measured on the full 48-report set:

| Encoding | Intermediate HTML | PDF (raw) | PDF (packed) | Pages |
|---|---|---|---|---|
| SVG (`fontCache: none` **and** `local`) | 65.8–83.1 MB | **52.03 MB** | — | 352 |
| **CHTML (chosen)** | 14.81 MB | 6.57 MB | **3.35 MB** | 380 |
| MathML (native, Chrome 109+) | **5.08 MB** | 25.70 MB | 6.29 MB | **496** |

⚠️ **SVG output turns every glyph into a vector outline — an 8× size penalty.** `fontCache: none` and
`local` produced a **byte-identical** 52,033,177-byte PDF, because Chrome flattens `<use>` back into
path draws when printing. No SVG variant will ever embed a reusable font.

⚠️ **MathML loses on both axes despite the smallest markup.** It is genuinely native in 94% of browsers
([caniuse](https://caniuse.com/mathml), Chrome 109+), and MathJax's `SerializedMmlVisitor` exports it
cleanly — the instinct is sound. But native MathML layout emits far more positioned boxes (only 2.29 MB
of the 25.7 MB was content stream; the rest was object overhead), it produced **496 pages vs 380**, and
it needs an OpenType MATH-table font on the host, reintroducing the host dependency the bake step
removes. Windows has Cambria Math; a stock Linux container does not.

CHTML also leaves the equations as **real searchable text**, which SVG does not.

---

## 3. Render all reports in ONE browser pass. Never render-then-merge.

Rendering 48 files separately and merging with pdf-lib duplicates every shared resource. Measured on the
same content:

| | Images | Font programs | Total |
|---|---|---|---|
| Render-then-merge (and the Bluebeam file derived from it) | 48 copies, 0.34 MB | 31, 0.67 MB | 9.46 MB |
| **Single pass** | **1**, 0.01 MB | **5**, 0.08 MB | 6.54 MB → 3.35 MB packed |

All 48 reports share one section image; a single pass lets the engine embed it once. Actual page
content is near-identical between the two (2.57 vs 2.53 MB) — the difference is entirely duplication.

**This is only possible because the bake step makes the documents concatenable** (see §5).

---

## 4. Repack the PDF into object streams. 49% for free.

Chrome writes its non-stream objects **uncompressed**. `PDFDocument.load(...).save({ useObjectStreams: true })`
takes 6.54 MB → 3.35 MB with no quality loss. This is what beats the manual Bluebeam step (3.46 MB).

---

## 5. Read the maths delimiters from each document. Do not hard-code them.

Every report embeds its own MathJax `tex2jax` configuration. The build parses it, so a template that
switches from `[math]..[math]` to `$$..$$` — **both declared in the same config** — keeps working.

Verified: a report rewritten to use `@@..@@` and `%%..%%`, declared in its config, produced output
**identical to the baseline** (169 expressions, 8 pages, 9,486 characters extracted).

Two rules that fall out of doing this properly:

- **Longest opener first.** Otherwise `$` matches inside `$$` and swallows the prose between
  expressions. This was a real bug: it produced a page of HTML markup typeset as mathematics.
- ⚠️ **Degenerate delimiters are refused, loudly.** SkyCiv's config declares `['\[','\]']`, which
  JavaScript evaluates to a bare `[` and `]` — because `\[` is not a valid escape. Honouring that would
  treat every bracketed phrase in the prose as an equation. The build refuses it and says so.

---

## 6. Each report keeps its own stylesheet, scoped to its own wrapper.

Rather than "use the first report's CSS and warn if they differ". Each report gets a scope class
(`.rs7`) and an id namespace (`r7-`); every selector is prefixed, `html`/`body` selectors map onto the
wrapper, and **every** id is namespaced rather than the two this template happens to use.

Cost is ~450 KB of duplicated CSS in a 15 MB intermediate — 3%, and it buys correctness for
heterogeneous inputs.

⚠️ **This refactor introduced a bug that shipped silently until a negative control caught it.** The
source CSS contains a stray `;` between rules. CSS error recovery normally discards a lone semicolon,
but the scoping walker glued it onto the following selector, making it invalid — and **browsers drop a
rule whose selector will not parse**. One rule per report, deleted with no error. Preludes are now
truncated at the last semicolon and the count is audited (`48 stray CSS tokens cleaned`).

---

## 7. Protect graphics and equations from page breaks. Not sections.

An earlier version applied `break-inside: avoid` to `tr`, keeping whole report sections together. It
worked but cost **123 pages** (475 vs 380) of trailing whitespace. The bounding rules around sections
are cosmetic; what must never be sliced is a figure or an equation:

```css
img, svg, mjx-container { page-break-inside: avoid; break-inside: avoid; }
```

Verified exhaustively: 48 image paints for 48 expected (a straddling image is painted on *both* pages,
so a higher count means a split), and all 48 diagrams have their title and axis caption on the same page.

---

## 8. Bake to a hermetic document — no scripts, no network.

The baked HTML contains **0 `<script>` tags and 0 external references**. MathJax's fonts are inlined as
data URIs (22 files, 329 kB) and cached in `.mathjax-fonts/` so later builds work offline.

This is not only about portability. The original approach fetched jQuery, MathJax and font-awesome from
CDNs **at render time**, so a slow or failed fetch could produce a half-typeset page — the main
fragility of rendering the source files directly. Hermetic means deterministic.

---

## 9. The verification shares no code with the transforms.

It re-reads the sources and the finished PDF **from disk** and re-derives the expected content
independently. A transform and its own self-assessment failing the same way is exactly what it exists to
rule out. See [verification.md](verification.md).

When this principle was quietly violated — the verifier deriving its image count by re-removing the
spinner with its own regex — it was treated as a defect and fixed, even though it worked.
