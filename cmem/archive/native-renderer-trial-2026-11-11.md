# Task 19: the native-renderer trial's progress record

Archived 2026-11-19 from `cmem/roadmap.md` (workspace letter H38), verbatim: task 19's "Progress" block (branch `trial/native-render`).
Read only when asked about past work. IDs are unchanged, so a search for one still finds it.

**Progress (branch `trial/native-render`, 2026-11-11; `S3D_RENDERER=native` selects it):**
- The whole 36ft report (62 MB baked) laid out in **~28 s** (Chrome: 33 min, no PDF) -- refused
  then for MathJax's never-matching selectors (fixed: a pseudo-element refused only where its rule
  matches) and an 849 px table.
- **Chrome's shrink-to-fit, measured** on a 3 MB cut of the report: every size printed at 0.635
  pt/px (50 px → 31.75 pt, 13 → 8.26, 12 → 7.62) = 0.75 × 720 / 850, the widest table's width.
  Blink lays the document out at the page width, then again at the width it reaches (at most twice
  the page), the page height in the same ratio, and scales every page down. The renderer does the
  same (two passes); a box past the content box prints into the margin as Chrome's does (a
  `max-width: 100%` image's own 1 px border); past the paper it is refused.
- **The 3 MB cut, native: 332 pages (Chrome 433); 280 words / 2,744 numbers, 0 missing; per-report
  1/1; styling 110,504 of 110,504; images 2 of 2 identical; lowest contrast and smallest text as
  Chrome's** -- and the same image-count failure as Chrome's, which was the verifier's (#118).
- **Fonts embedded, 2026-11-11** (🔒 owner: "we should embed the fonts into the file that are
  required for fidelity. and into the project for full compatibility on the usage and
  incorporation needs"; "We need to add the dependency and make any license references for
  compiance sake"): Liberation 2.1.5 (SIL OFL 1.1, metric-compatible with Arial / Courier New /
  Times New Roman) shipped in `fonts/liberation/` with its licence and each file's SHA-256
  (checked by `readRenderFonts`, `./runtime`: surface +1, floor minor); `@pdf-lib/fontkit` 1.1.1
  (MIT) embeds them SUBSET; a character with no glyph is refused (fontkit would draw .notdef
  silently). Both packages ship the fonts (`jsr.json`, `npm-build.ts`; `npm:prove` checks every
  font file and the licence are packed -- PASS on Node 22.13 / 22 / 24 / 26 and Bun). Licence
  records: THIRD-PARTY-NOTICES.md (what is redistributed, the OFL's conditions quoted from the
  licence, the compliance summary), [licensing.md](../licensing.md). `bun audit`: 0 (50 packages).
- **The 3 MB cut, native with embedded fonts: PASS** -- 332 pages laid out in 2.3 s; 5 of 5 images
  identical; styling 110,504 / 110,504; three faces embedded (Liberation Sans, Sans Bold, Mono:
  33 KB of subsets; Chrome's ArialMT, Arial-BoldMT, CourierNewPSMT: 82 KB); the nine unused faces
  swept out by the packer.
- 🔒 **Owner, 2026-11-11: "The package growing by 6mb is not an issue, as long as the resulting
  pdf is minimized."** Images: carried as the source's own bytes (the pixel check requires it; a
  lossy re-encode is ruled out); the one lossless gain left there is a JPEG's entropy coding
  re-optimised (estimated ~5–15 %; measured 21.4 % on the 36ft report and built on `main`, below).
  The page content was the lever: written
  compactly (one text object, state set only when it changes, a line's pieces in one string,
  0.01 pt) and collapsed table borders drawn as a grid, each line once. **The 3 MB cut: 3.19 →
  1.74 MB (Chrome 3.12), page content 2.28 → 0.84 MB; a table page's 848 fills → 88; still PASS.**
- Found on the way: the H33 release test's "behind origin" case cloned origin's default branch,
  which is whatever branch ROOT had checked out -- from a branch other than main its push was
  refused quietly and the guard never reached (fixed on main too, `9b48dce`).
- ✅ **The full 36ft report, native, VERIFIED -- 2026-11-11** (after #119's verifier indexes and
  #120's bake containment, both on `main`): 6,969 pages laid out in 37.8 s; 24.66 MB; 308 words
  and 16,160 numbers, 0 missing, per-report 1/1; images 5 of 5 identical; styling 2,836,333 of
  2,836,333; PASS. 6 min in all (verification 5 min). Chrome on the same report: 33 min, no PDF.
  ⚠️ **Peak memory 22.4 GB** (the verification holds every page's text, operators and styles at
  once) -- the next thing to bring down; a smaller machine would fail before any time limit.
- ✅ **The verifier's memory, 2026-11-11** (owner: "yes"; on `main`: `573ccf6`, `43d9470`): pdf.js's
  page caches released per page (`page.cleanup()`); painted paths kept only when a report has a
  drawing (their one reader); run styles shared; a full collection at the phase boundaries where
  the runtime offers one (`Bun.gc`). **Measured with a full collection at each phase: the
  verification never holds more than 1.5 GB live** (0.38 / 0.54 / 1.52 / 1.49 / 1.42 GB) -- the
  rest was garbage the engine let pile up on a machine with memory to spare. **The full 36ft report:
  peak 22.4 → 16.3 → 8.2 GB, 360 → 314 s, PASS each time.** Left: ~7.5 GB of churn inside the word,
  number and style checks, ~4.5 GB in the render -- refinement, not a blocker.
- ✅ **Tests for the native renderer, 2026-11-11** (owner: "yes"): (1) a report in the model
  template's shape, made in the test (`modelReport`: collapsed tables with zebra rows and min/max
  cells over pages, a 13-column table forcing shrink-to-fit, a bordered screenshot with an unquoted
  src, an inline-block subheading, links, superscripts, a stray `</div>`), built natively: PASS,
  every word styled, no pdf.js warning; in the PDF every font embedded and a Liberation face,
  every alpha state a page uses defined; two builds byte-identical. (2) A member report refused
  with `<svg>` named and no final PDF; a float, absolute positioning, a list, a CJK character, a
  text-transform, a background image each refused by name through `renderDocument`. (3)
  `S3D_RENDERER` refuses another value. Inverted: the resource-order bug (caught by the warning
  check) and a render-time stamp ("two builds differ").
- ✅ **Visual review and page breaks, 2026-11-11.** Matching pages of the 3 MB cut rendered side
  by side (a local page in the session's scratch -- client data, never published). Seen: title,
  tables, zebra rows, superscripts, and the shrink-to-fit (column widths and wrapping) the same;
  the number columns heavier (Liberation Mono's stroke against Courier New's thin one). Different:
  breaks around boxes with `break-inside: avoid` -- Chrome moves such a box on when it does not
  fit the room left (Blink's rule), stranding headings (60 pages of the cut hold only a heading);
  the renderer moved one only if it fit a page, and split a table's two header rows. 🔒 **Owner,
  given A (Chrome's rule exactly) or B (that rule, and no heading left alone): "I agree with B".**
  Built: Blink's rule; `h1`–`h6` with their `<hr>`, and the opening text of a box that avoids
  breaks (SkyCiv's `<span class="subheading">`), kept with what follows (`Flow.keeping` /
  `hasContent`: a box is not moved off a page holding only its own heading); a table's header rows
  (all `th`) kept with its first row. **The cut: 371 pages (Chrome 433; 332 before), no page holding
  only a heading, PASS.** The full report: 7,161 pages (6,969 before), 24.68 MB, PASS in 328 s,
  peak 8.9 GB. Tests: the model report (no lone heading; the subheading with its header
  rows and first row; no page ending in a header row) and the header rows at the lengths that
  force them; each rule's mutant caught.
- Next: the visual
  comparison (pages rasterised side by side, for the owner); the page-count difference (332 vs
  Chrome's 433 on the cut) measured; then the member reports (maths, SVG).

