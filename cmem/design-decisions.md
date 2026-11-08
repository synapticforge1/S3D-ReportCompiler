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

**What "scoped" means, in full (2026-11-06; known-issues #33–#36, #44, #46, #49).** None of these
cases occurs in the 13 samples or the 48 client reports — the baked HTML was byte-identical before
and after — so they are rules for the next template, each pinned by a test:

- **Every sheet of the page is the report's sheet**: the head's, and a `<style>` in the body outside
  any `<svg>` (moved there by `bakeBody`; left in the body it applied to every report).
- **`html` / `body` / `:root` are the wrapper**, the whole leading chain of them (`html body p` is
  `.rs7 p` in what it matches), and so is a top-level `:scope`, an `:is()`/`:where()` of them, and
  — for `* > .x` — `body`. 🔁 **The removed compounds keep their WEIGHT** (2026-11-07, review 5,
  #82): every scoped selector gains exactly the wrapper's one class, so the report's rules keep
  their order of weight — a removed `body` used to take its type weight with it, and `body
  .x{display:none}` lost to a later `.x{display:block}`. The weight goes back as weight-only
  selectors that match everything — `:is(#s3d-w, *)` an id, `:is(.s3d-w, *)` a class, `:is(s3d-w,
  *)` a type (an `:is()` weighs its heaviest argument; `*` makes it match) — computed by
  `specificity()` (CSS Selectors 4: `:where()` nothing, `:is()`/`:not()`/`:has()` their heaviest
  argument), less whatever qualifier is kept. `:where()` and `*` weighed nothing and still do. The
  first scoping change in a review to alter the real sets' baked HTML: by these selectors alone
  (identical once removed), and every page of the samples' and the 48 set's PDFs has the same text
  at the same positions. A qualifier on one is decided against the SOURCE's own tag, because the wrapper carries
  none of its attributes: classes, ids and attribute selectors that hold are dropped, any that fails
  drops the rule (it never applied); attribute values compare as HTML compares them in selectors
  (`lang`, `dir`, `type` … caselessly; `class`, `id` not; `i` / `s` honoured — Chrome, measured).
  Pseudo-classes stay on the wrapper. A sibling of `html`/`body` (`body + p`) is dropped: kept, it
  reached the NEXT report.
- **Selector lists split at top-level commas only** (`p:not(.a, .b)` is one selector).
- **SVG `<style>` is hoisted onto presentation attributes only where an attribute says the same**:
  top-level rules, bare element selectors, properties on SVG's presentation-attribute list
  (`font`, the shorthand, is not one — Chrome ignores `font="…"`, measured), no `!important`, no
  element the rule names elsewhere in the report, and no rule elsewhere in the report setting that
  property with no more weight (`*`, the bare element, `svg *` — it lost to the sheet in the
  source, and beats any attribute). 🔁 **Otherwise the sheet MOVES to the report's scoped sheet**
  (2026-11-07, known-issues #72), in document order, exactly like a body sheet: an inline-SVG
  `<style>` is document-wide in HTML, so the report's wrapper is its meaning. Until then it was
  confined to its own `<svg>` inside `:where()` (#34, #44), which kept it from other REPORTS but
  also from the report's other diagrams and page — diagram 1's `.lbl{display:none}` no longer hid
  diagram 2's labels. Scoped with `.rsN` like every other rule of the report, it keeps its weight
  relative to them. SVGs are found by depth with a quote-aware tag reader (`</svg >`, nesting,
  `<svg/>`); the 13 samples and both real sets are still hoisted, byte-identical.
- **Attributes are read one after another, each value whole**, by the bake and — separately written,
  §9 — by the reference guard, `findBrokenReferences` (in the core since 2026-11-06, so the browser
  path runs it too; the CLI only until then), which requires every id reference that resolved in a
  source to resolve in its bake: verification counts text and image paints, not gradients or clips.
- **The counters are per process; a batch resets them.** `resetBakeState()` before each batch, for
  any caller that bakes more than once (the browser example does); the CLI bakes once.
- **Each report's TeX starts empty** (2026-11-07, #72): no label, and no definition from an earlier
  report (`\def`, `\newcommand`, `\let`, `\DeclareMathOperator`, `\newenvironment`, `\definecolor`,
  `\newtagform`); MathJax keeps them for the life of the input, so report 0's
  `\renewcommand{\phi}{0.9}` printed report 1's `\phi M_n` as `0.9 M_n` with PASS. And
  `noundefined` / `noerrors` are left out of MathJax's packages, so an undefined command is a
  FAILURE, not red text counted as converted.
- **Nested CSS rules** keep their declarations; the ids in their selectors are renamed.
- **Comments are CSS's**: `/*` inside a string is text, an unclosed one ends its own sheet, and
  they go before the block-less at-rules are removed (a comment that mentions `@import` used to
  delete rules up to the next `;`).
- **A sheet is what the parser makes a sheet** (reviews 4–5, #77, #82): an SVG `<style>` is read as
  SVG parses it — CDATA a wrapper, `<!-- -->` a comment, entities characters, by the bake's own
  decoder (MathJax's table, not the verifier's, §9) — and refused if it holds markup; a `<style>`
  before `<head>` is the head's; one inside `<template>`, `<textarea>`, `<title>` and the other
  raw-text elements is none (`blankInert`). A diagram holding `<foreignObject>` is moved, never
  hoisted (HTML takes no presentation attribute), and another diagram's MOVED sheet is a rival.
- **Page-wide names**: `@layer` names are made the report's own (`r7-a`) and its statement form
  `@layer a, b;` is kept; the names `@font-face`, `@keyframes`, `@counter-style` and `@property`
  define are NOT renamed (that means rewriting every use) — two reports defining one differently
  are named in a warning instead.
- **What prints is what the source shows**: content a report put inside `<head>` (or before
  `<body>` with no `</head>`) is drawn, as a browser draws it — baked and expected (`drawnBeforeBody`
  / `bodyStartBefore`, written apart, §9). The reveal gate opens only what the report's own script
  could: never an `!important` hide.
- **TeX state across reports**, beyond the definitions above: mathtools' paired delimiters and
  `\mathtoolsset` options are reset too; `\unicode`'s font cache cannot be (private to MathJax's
  module), so a `\unicode` after an earlier report changed it — by `\unicode[…]` or an alias — is
  refused. That cache lives as long as the PROCESS: tests that check it bake in a child process.

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

🔁 **Enforced, not just measured, since 2026-11-06** (known-issues #55–#60). The "0 external
references" above came from a check that saw 1 of 7 ways to write one, and nothing stopped a load.
Re-measured with every spelling: the real set's only external host is the SVG namespace
(`www.w3.org`, a name, not a load). Now:

- **The document forbids scripts and outside loads itself** — a Content-Security-Policy `<meta>`
  (`default-src 'none'`; images and fonts from `data:`; MathJax's font origin, for the browser
  path, which does not inline; `base-uri` / `form-action` closed). Measured: a counting server saw
  5 requests during a render under a scripts-only policy, 0 under this one.
- **The bake strips what a policy cannot stop or should not need to**: event-handler attributes,
  `javascript:` URLs, and `<meta>` / `<base>` in a report's body (a refresh navigates).
- **Chrome keeps its sandbox**, except as root (`--no-sandbox` is needed there) or with
  `S3D_CHROME_NO_SANDBOX=1`; checked on CI's Ubuntu runners as a non-root user. ⚠️ JavaScript is
  NOT turned off by Chrome flag: `--blink-settings=scriptEnabled=false` makes `--print-to-pdf`
  write no file (exit 0, empty stderr).
- **The font cache is per MathJax version, and keeps only complete fonts** — one folder per source
  URL directory (an upgrade starts fresh; the old flat cache was adopted once), a WOFF/WOFF2
  signature AND the header's recorded length equal to the file's size (a captive portal's page, or
  a download cut short, is refused with nothing cached).

The reason is §9's and verification.md's limit 3: the check proves presence, not that nothing was
added, so the render must not be able to add anything.

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
