# Overview

## What this is

A build that compiles a folder of **SkyCiv design reports** (one HTML file per structural member) into
a single combined PDF, and then proves the PDF still contains everything the sources did.

The working set is 48 AISC 360-16 member design reports for one structure — `member_0_report.html`
through `member_47_report.html`, ~60 KB each.

## Why these files cannot be printed naively

The reports are **not static documents**. Three things in them require a JavaScript engine:

1. **The content is hidden until JavaScript reveals it.** The stylesheet contains
   `#report { visibility: hidden }`, and only a jQuery callback — fired after MathJax finishes
   typesetting — makes it visible. A renderer with no JS engine produces blank pages, not degraded ones.
2. **Every equation is LaTeX source, not rendered output.** 8,286 expressions across the set, stored
   between delimiters and typeset at view time by MathJax.
3. **Three CDNs are contacted at view time** — jQuery, MathJax and font-awesome.

What is *already* embedded, and was initially misjudged: the **cross-section drawings are base64 PNGs**
and the **diagrams are static inline SVG** (~18 KB each). `section-svg.min.js` is loaded but has nothing
to hook onto in these files. Only the maths is deferred.

## What one report contains

Measured across all 48 files:

| Thing | Count |
|---|---|
| `[mathin]` delimiters | 8,474 occurrences |
| `[math]` delimiters | 7,138 occurrences |
| `$` delimiters | 960 occurrences |
| `$$`, `\(`, `\[` in bodies | **0** — declared in the config, never used |
| `<img>` tags per report | **2** — the loading spinner and the section PNG |
| `<style>` blocks per report | **3** — two in `<head>`, one *inside* the diagram `<svg>` |
| `visibility: hidden` declarations | 1 (the reveal gate) |
| `height: 100%` declarations | 3 (`html`, `body`, `#report`) |
| `.unbreakable` as a selector | 48 — used by **zero** elements |
| Longest `[math]` body | 219 characters |

Structure is one 3-column table — `REFERENCES | CALCULATIONS | RESULTS` — with each section as a row
bounded by horizontal rules.

## What the build produces

One PDF: **380 pages, 3.35 MB**, with the equations as **real searchable text** rather than vector
outlines. No CDN access is needed at render time; the intermediate document is fully self-contained.

## Why it matters that these are certified

These reports are reviewed, archived and often sealed. That drives three decisions that would otherwise
look like over-engineering:

- **Nothing is removed silently.** Every removal and rewrite is counted and printed as an audit line.
- **The build refuses to emit a PDF containing raw LaTeX**, rather than emitting one with a warning.
- **The build verifies its own output** against the sources and exits non-zero if anything is missing.

A dropped value is worse than a broken layout, because a dropped value still looks right.
