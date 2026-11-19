# class-review.md: roadmap task 18, the class-by-class review

Moved 2026-11-19 from `roadmap.md` task 18 (H38 split), verbatim. Status 🟡: class B paused 2026-11-08; 
its re-check is in [native-renderer.md](native-renderer.md) "Needed either way". Ledger rows: [archive/known-issues-ledger.md](archive/known-issues-ledger.md).

## 🟡 18. Class-by-class review — IN PROGRESS, class B (paused 2026-11-08)

Owner, 2026-11-08: one CLASS of issue at a time, fixed completely, then re-checked by a fresh
reviewer of that class, repeated until clean, before the next. Order **B, A, C, E, D, F** (A output
fidelity, B verification gaps, C privacy, D release integrity, E lifecycle and errors, F tests and
docs). The first triage's findings for A, C, E, D and F are in the session that ran it, not here: run
those classes' reviewers fresh when B closes.

**Class B so far:** round 1 `3555326` (known-issues #87), re-check 1's fixes `8b5a113` (#88), both
pushed 2026-11-08 (CI run 42515756466 green). Re-check 2 (2026-11-08) found no false FAIL a SkyCiv report can trigger, and six lenient
gaps (items 8–11 below, and two folded into items 2 and 4).

🔒 **Owner, 2026-11-08: "We need fixes not limits"** — every limit that #88 and verification.md
left open is to be FIXED. Agreed decisions: item 1 resolve statically and fail otherwise; item 4
threshold measured from the real sets, well below their lowest contrast; item 5 an own PNG decoder
on zlib, no new dependency. **Agreed order** (owner: "I agree with the order"), each group
committed after inversion against the commit before it and all three real sets, then one fresh
class-B re-check at the end:

1. ✅ **DONE 2026-11-08 (known-issues #89)** — **Small and most serious first.**
   - **8:** count every word and number per report; its own pages must hold at least as many whole
     matches. Only presence was required: 64% of member_0's numbers occur two or more times, so a
     changed second `30.483`, a deleted line or `STATUS PASS` → `FAIL` all passed.
   - **11:** only a space, not a line break, between a word's letters (`k` / `N` passed).
   - **10:** the capitals fallback only for a source word with no capital of its own, inside
     all-capital PDF text (`12 mN` → `12 MN` passed).
   - **9:** text under 2 pt fails, sized from the item's transform (0.17 pt and 0.07 pt passed; the
     smallest real text is 3.61 pt).
   - **4, its first part:** contrast against the white page, under about 1.5:1 fails (`#eeeeee`
     passed).
2. ✅ **DONE 2026-11-08 (known-issues #90)** — **1, maths config.** `parseDelimiters` treats a config key it cannot read (`inlineMath: D`, a
   variable) as no config and uses the fallback; nothing reads the real delimiters. Fix: resolve a
   `var`/`let`/`const` holding a literal, otherwise FAIL "cannot read the maths delimiters"; the
   verifier reads the delimiters with its own code (§9), and any pair of them printed in the PDF
   fails.
3. ✅ **DONE 2026-11-08 (known-issues #91)** — **7, report identity and order.** Segment k's printed heading must equal source k's, member
   number included; the build order must equal the verifier's own natural sort of the file names.
4. ✅ **DONE 2026-11-08 (known-issues #92)** — **2, a number with its neighbours:** checked with the token after it (a unit, single letters
   included; an operator; `%`) and the operator before it. `30.483 <` → `>`, `12.5+3` → `12.5-3`
   and `85%` → `85` passed. Option: pair a value with its row label too.
5. ✅ **DONE 2026-11-08 (known-issues #93; marked content was enough, the structure tree was not
   needed)** — **3, a number wrapped across lines:** joined only inside one structure element (Chrome tags its
   PDFs: Table/TR/TD/TH/H3, measured), at a break directly between digits, with no space glyph at
   the line's end. Measure first whether Chrome emits that glyph at an ordinary word wrap.
6. ✅ **DONE 2026-11-08 (known-issues #94)** — **4, the rest:** each filled shape (box, colour, alpha, paint order) and each text show's box in
   the operator walk; the background is the last fill beneath the text (an image is sampled from
   its pixels); a fill or image painted over at least half of a text box at alpha 0.9 or more is
   covered text; WCAG contrast below the threshold fails. White on a dark band then passes.
7. ✅ **7a DONE 2026-11-08 (known-issues #95): PNG, GIF, JPEG.** 🔒 Owner, 2026-11-08: "Can we
   build a method for verifying the SVG, GIF and WebP file types also?" — GIF in 7a; **7b: WebP by
   OWN decoders** (owner's choice over Chrome-as-decoder, a dependency, or refusal): lossless VP8L,
   lossy VP8, the VP8X container with its ALPH chunk; Chrome re-encodes WebP as plain pixels
   (measured), so the comparison is 7a's. SVG `<img>` goes to group 8 (below). — **5, image pixels:** each report's data-URI images paired, in order, with its paints; JPEG
   compared by bytes through pdf-lib if Chrome passes them through; PNG decoded on both sides and
   compared exactly (alpha is a separate mask); an SVG `<img>` gets its own check or a loud "not
   verified". Lives in main.ts. Measure first whether Chrome re-encodes, downsamples or
   colour-converts.
8. ✅ **8a, 8b DONE 2026-11-09 (#96, #97)** — **6, diagram geometry:** each drawn SVG element (paths with arcs, lines, rects, polylines),
   transformed and flattened, against the PDF paths inside the diagram's placed box (Chrome's SVG
   viewport clip, to confirm), both normalised to the box: every stroke matched within a measured
   tolerance, nothing extra, colours equal; each `<text>` at its own position. Its CSS read for
   `display: none`. member_0's SVG: 24 paths, 54 lines, 23 texts in 8 groups.

✅ **Group 8a, 8b and 8c DONE 2026-11-09 (known-issues #96, #97, #98).**
✅ **Group 8d DONE 2026-11-09 (known-issues #99)** — what the drawing check read without, found by
a lenience harness (one property changed in the bake, the source unchanged): clips (viewports,
markers, nested drawings, `clip-path`), fill rule, paint order, cap / join / miter limit, a shape
drawn before the first or after the last match; colour names, `hsl()`, colour alpha.

9. 🔒 **Text styling (owner, 2026-11-09): "Text styling (weight, colour, size of HTML text and SVG
   labels) should match the html as close as possible when converting to pdf."** Nothing checks it
   today: a bold label printed normal PASSES (#99's harness, the `font-weight` case), and so would
   a red value printed black. Scope: HTML text and SVG labels, each text run's weight, style,
   colour and size against what the source's cascade gives it. Measure first what Chrome writes
   (the font each show uses, its fill colour, its size) and how pdf.js exposes it. After 8e–8h,
   before the fresh re-check.
   🔁 **Started 2026-11-10 (owner: "push then release, then start group 9 items"). Measured on
   the samples' PDF (scratch probe, pages 1–8):** every text show carries what is needed. The
   font, through pdf.js's `commonObjs` with `fontExtraProperties: true`, has its PostScript `name`:
   `ArialMT`, `Arial-BoldMT`, `Arial-ItalicMT`, `Arial-BoldItalicMT` for the report text (CSS
   family Lato, Helvetica Neue, Arial → Arial on this host), `MathJax_Main-Regular`,
   `MathJax_Math-Italic`, `MathJax_Size3/4-Regular` for maths; one fallback seen
   (`TimesNewRomanPS-ItalicMT` for a Cyrillic `М`). Without `fontExtraProperties` the name is
   absent (only `bold` / `italic` getters, unset here). The size is `Tf` × the text matrix's
   scale (13.00, 15.21, 17.33, 13.33, 11.65, 9.19, 6.49 pt seen). The fill is `setFillRGBColor`
   with ONE hex argument in pdf.js 6 (`#0000ff` for the samples' 454 `color:blue` spans, e.g.
   "Section Name:", and blue maths). The sources' vocabulary: `<b>` 336, `<h3>` 412, `<th>` 195,
   `<h2>` 39, `<h4>` 13, `font-weight: bold` 175, `font-style: italic` 13, sizes in pt / px / em,
   one colour (`blue`). **The plan:** 9a SVG labels first — `report_svg.ts` already runs the
   cascade for them (size known; fill, weight, style to add) and pairs each label with the PDF's
   text at its position; 9b HTML text, which needs the source's cascade for HTML (UA defaults for
   `b` / `strong` / `th` / `h1–h6` / `i` / `em`, inherited `color`, relative sizes) — the
   selector matcher of `report_svg.ts` is the starting point.
   ✅ **9a DONE 2026-11-10 (known-issues #115):** every SVG label's run held to its source's
   weight, style, colour and size; a face Chrome slants (no italic of its own) read by its skew.
   ✅ **9a part 2 DONE 2026-11-10 (known-issues #116; owner: "scope the part that is not covered
   yet and provide the fix"):** the `font` shorthand, sizes with units, the HTML a drawing stands
   in (inheritance with the browser's defaults; the report's selectors through it; the `#report`
   reveal gate as the script leaves it); a drawing that draws but reads as nothing visible now
   fails. API: `drawnSvgAncestors` added (surface re-baselined; the next release is a minor).
   ✅ **9b DONE 2026-11-10 (known-issues #117; owner: "list the remaining open items then proceed
   with 9b"):** the report's own text, every word per report in the weight, slant, colour (with
   its alpha) and size its source gives it, at the print's measured scale (`src/report_style.ts`;
   API: `readerBody` added). **Group 9 is DONE. Next: the fresh class-B re-check**, then the
   browser review.

🔁 **Fresh class-B re-check 3, 2026-11-10 (owner: "proceed with the recheck"; a fresh reviewer,
measured with a harness that bakes a modified copy and verifies against the ORIGINAL sample;
member_0 only, `local/` untouched).** Controls: unmodified PASSES, `0.045` → `0.046` FAILS. **Nine
lenient gaps, each PASSED:** (1) maths structure — single Latin letters and `/ | ( ) *` are no
tokens (`report_core.ts` wordTokens; checked), sub/superscript read alike: `F_y` → `F_u`,
`P_r`/`P_c` swapped, `in^2` → `in_2`, a fraction bar dropped, `/` → `*`, `|…|` dropped; (2) an
`<img>` judged by pixels only (`main.ts` ~1949; checked): mirrored, squashed 148 → 22 pt, 45 %
clipped, opacity 0.04, wholly under a white box — "1 of 1 identical"; (3) a drawing placed by
any matrix: `scaleX(-1)`, `rotate(180deg)`; (4) text partly covered (`-1.067` shown "-1.06"), or
printed over other text; (5) maths styling unchecked (`\color{red}`, `\mathbf`, `\Large`, both
ways); (6) `text-decoration` (a struck "STATUS PASS"); (7) text mirrored / upside down; (8) a value
moved between cells of a row (ΔZ ↔ δz; #92's neighbour check pairs units only) — known; (9) styles
swapped between two occurrences of one word (multiset; low). **Two false FAILs (loud, no sample
hits them):** the capitals rule across a `<br>` (U+2028) with `text-transform`; `font-size:
calc(…)` misread (should be named unread). Checked fine: a fraction's terms swapped, λ across
`<`, text off-page or clipped, `scaleY(0.12)`, an SVG faded or moved over text, MathJax's CSS
dropped, `font-family: Symbol`; no false FAIL from soft hyphens, `<wbr>`, rem / % / larger, hsl /
named / `rgb(/ 80%)`, group opacity, small-caps, bolder, `<sup>`, the shorthand, `\color` in
`\text`. CSS `url()` backgrounds not re-probed (still listed). **Owner: "yes"** — fix all, in the
order A (maths structure + styling), B (image placement), C (orientation), D (cover, overprint,
decoration), E (values against their cells), F (per-occurrence styles; the two false FAILs).
Group A part 1 done (committed 2026-11-11 with the member-first order and the dropped structure
tree; `bun run test` 95 pass, 2 skip (POSIX), 0 fail, 497 s): single Latin letters and `/ | ( ) *` counted;
a script at TeX's floor size read joined to its base (`0.658^{\frac{F_y}{F_e}}` prints "Fy");
a stretched delimiter's pieces (`⎛`…`⎝`) read as the delimiter (a real zip report).

🔁 **A second real zip, 2026-11-10 (owner's Downloads; client data, built only in scratch
copies):** the 75 member reports + `36ftGatePostCheckCaseA SkyCiv Report.html`, a DIFFERENT
kind of SkyCiv report: no "MEMBER #n DESIGN REPORT" heading, no maths, ~200 tables with 360,000
rows (3.1 M cells, 60 MB), one image taller than a page, ~7,400 pages. Chrome ran past 30 min.
**Owner's decisions:** "the 'member_x_report' files are the primary target" — member reports
first, any other report merged LAST (done: `sortReportNames` and the verifier's own
`readingOrder`); test the 36ft report and the member reports SEPARATELY, combine once all works;
"36ft report first" before groups A–F continue; an image taller than a page SCALED to fit one
page; "compressing the pdf file is important for the stored size" — the tagged-PDF structure
tree DROPPED when packing ("Drop it": 22.3 → 7.4 MB on 891 table pages; samples 0.99 → 0.83 MB;
verification passes on the untagged PDF). Measured render: 3 % of the report 15 s, 6 % 43 s, 12 %
89 s (891 pages; 117 MB rendered, 22 MB stored). **To do for it:** report starts found without
the member heading (each report's own first words as its signature); the tall image; a render
limit that grows with the document. 🔒 **Owner, 2026-11-10: "just remember the fidelity of the
document is paramount"** — each change here is held to it: what prints must be the source's,
proved by the verification on the stored PDF; a size saving may drop only what does not print
(the structure tree), and the one printed change accepted (an over-tall image scaled to a page)
keeps its pixels the source's and must be verified whole on its page.
🔒 **Owner, 2026-11-10 (later): the 36ft report moved back out of the zip, to the documents folder
where it normally resides — "keeping them separate tests is a better idea for now. at least until
all of the bugs in the code are worked out."** So two test sets, never mixed until then: the
member reports (the 75-report zip) and the 36ft report on its own (a scratch copy; client data,
never in the repo).

⏸️ **Paused 2026-11-10 (owner: "pause here for today"); resumed 2026-11-11 (owner: "lets proceed
from where we left off yesterday").** (1) ✅ committed 2026-11-11 (above). (2a) ✅ **report starts
without the member heading, 2026-11-11:** `findReportStarts` (exported; surface +2, floor minor):
a report printing no `MEMBER # n DESIGN REPORT` is known by the page that OPENS with its own first
40 printed characters (spaces aside, from its body as a reader sees it -- not the head's
`<title>`); each start must be its own source's; main.ts cuts every per-report check there (the
image segmentation too). `sourceTally` memoised (the 36ft report: 96 s per read, read 3 times).
Suite 96 pass, 2 skip, 0 fail. (2b) ❌ **the 36ft report alone, full size, 2026-11-11 (scratch
copy, `S3D_CHROME_TIMEOUT_MS` 3 h):** bake 14 s (62 MB HTML, the web logo embedded), then Chrome
rendered **33.3 min and exited 0 with NO PDF** (no reason printed; 10 processes, 15.4 GB at minute
19). The guard held: nothing given its final name. So a longer limit alone cannot print it.
🔒 **Owner, 2026-11-11, on the choice (split the render at the report's forced page breaks, or
"can the transform of html to pdf be accomplished without browser interaction during the
process? This would take a step in our checks off the table for the other browsers"): "lets test
a scoped trial and see if we can move this forward faster."** → task 19, a native renderer
(below). The split render is not being built. (2c) ✅ **the "tall image" was the verifier's**
(known-issues #118, 2026-11-11): an unquoted `src` was not read, so the report's screenshots were
not expected; Chrome and the native renderer both draw all five images of a 3 MB cut of the
report. (2) the 36ft report on
its own: report starts without the member heading (each report's first words as its signature),
an over-tall image scaled to one page (measure how Chrome resolves a page height under its
shrink-to-fit first), a render limit that grows with the document (its full-size timing was
running at the pause); (3) then group A parts 2–3 (maths roles; maths styling), and B–F.

**Next step, in order (owner: fixes not limits):** the items still named "not verified", each
measured 2026-11-09 (scratch probe; Chrome's output named here so it is not re-measured):
- ✅ **8e — a gradient with stop-opacity, DONE 2026-11-09 (known-issues #100):** a tiling pattern
  holding a luminosity soft-mask group filled with one shading (the alpha ramp), then the colour
  shading — read as those two shadings, compared colour and alpha.
- ✅ **8f — `<image>` in an SVG, DONE 2026-11-09 (known-issues #101):** placed (three corners),
  sized, faded and clipped as its source says; a `slice` as Chrome's whole-pixel crop; its pixels
  by 7a's comparison. Drawings now come before the `<img>` pairing.
- ✅ **8g — `<pattern>`, DONE 2026-11-09 (known-issues #102):** Chrome rasterises it over the
  drawing's whole VIEWPORT at a pixel a point into one image inside a tiling pattern; each pixel
  on the painted area is held to the range of colours the source paints within a pixel of it.
- ✅ **8h — `mask`, DONE 2026-11-09 (known-issues #103):** soft masks tracked on the PDF side
  (a group with one is the mask's definition; Chrome's first pass, under nothing, not recorded);
  a matched path's mask value against the source's luminance times alpha, at points.
- ✅ **8i — `filter`, DONE 2026-11-09 (known-issues #104):** each filtered element is one image;
  compared with the source run through `src/report_filter.ts`'s primitives (ten of them). Open:
  lighting, turbulence, displacement, convolution, `feTile`, `feImage`; a drawing of filtered
  elements alone cannot be placed (fails, named).
- ✅ **8j, DONE 2026-11-09 (known-issues #105):** `foreignObject` (its text inside its box),
  `<switch>` and conditional attributes (the render pinned to `--lang=en-US`), an SVG `<image>`,
  a mask in a mask, a selector engine with sibling combinators and pseudo-classes.
- 🟡 **8k, part 1 DONE 2026-11-09 (known-issues #106; owner: "we need to implement the still
  refused items"):** `:has()`; convolution, diffuse light (distant, point, spot), specular
  (distant), fractal noise, feImage, filter properties from stylesheets. **Open, each measured:**
  turbulence type `turbulence` (178 px), stitching, feTile's period (228 px), displacement (2
  px), specular from a spot (77 px) -- the run code exists, refused by name until it matches;
  Skia's per-point noise code is the missing source. ✅ **Part 2 DONE 2026-11-09 (known-issues
  #107):** an feImage past its region (bilinear, as Chrome), a drawing of filtered elements alone
  (placed by its viewport clip), a filter its viewport cuts away (no image). ✅ **Linked images
  DONE 2026-11-09 (known-issues #108; owner: "a linked image must fetch the image for inclusion
  into the pdf for fidelity of the documents"):** fetched (beside the report or from the web),
  embedded in body and source, checked pixel for pixel; one that cannot be had stops the build.
  ✅ **Part 3 DONE 2026-11-09 (known-issues #109):** turbulence of type `turbulence` and
  `feDisplacementMap` judged (the noise 1.6 device pixels on, measured -- since part 5 derived:
  half a USER UNIT from the device pixel's corner; edges sampled 16 by 16;
  a near-clear map's pixels doubtful).
  ✅ **Part 3b DONE 2026-11-10 (known-issues #110):** specular light from a spot judged (an
  edge's 2 % strip, sampled 64 by 64 where a pixel's outer 32nd disagrees).
  ✅ **Part 4 DONE 2026-11-10 (known-issues #111):** feTile judged, by Skia's own rule (read from
  `SkCropImageFilter.cpp`: the source rect rounded IN on 300-dpi device pixels, the 72-dpi cell
  point-sampled), pixel for pixel at every place on the page.
  ✅ **Part 5 DONE 2026-11-10 (known-issues #112):** stitched noise judged, by Skia's raster
  stage (`perlin_noise`); the noise's point derived (half a user unit from the device pixel's
  corner), replacing part 3's measured offset. **Every filter primitive the check runs now
  matches Chrome -- none is refused.** ✅ **Group 7b DONE 2026-11-10 (known-issues #113):** WebP
  by the check's own decoder, bit for bit libwebp's on its 129 conformance vectors. ✅ The
  spot-specular test's caveat reviewed and closed 2026-11-10 (owner: "yes"; known-issues #110):
  a layout-independent unit check now pins the thin-strip sampling. Next: group 9 (text
  styling), the fresh class-B re-check; then the browser review (below).
  Not covered: a CSS `url()` background image (none in any real report; the CSP blocks it, the
  external-ref warning names an http one) -- class B's re-check takes it.
- 🔴 **Other browsers, after the Chromium work (owner, 2026-11-09: "firefox and firefox-esr is
  installed on this machine. once the chromium settings are completed, review the same settings
  for those browsers also"; "you may also be able to check safari through playright on this
  machine"; "once we have the basic settings via playright. we can check it on full mac
  later").** Two kinds of setting to review per browser: how it is DRIVEN (Chrome takes
  `--headless --print-to-pdf --lang=en-US`, its sandbox, the document's CSP; Firefox prints
  through WebDriver BiDi / Marionette, not a flag; WebKit has no headless print of its own --
  Playwright's WebKit build does) and what the verifier EXPECTS it to draw (everything measured
  in task 18 is Skia's: filters at 300 dpi, pattern cells at 72 dpi, feImage bilinear, the
  spot cone's fade, noise half a user unit on, feTile rounded in on 300-dpi device pixels and
  point-sampled to 72 dpi). Other Chromium browsers share Skia and the
  flags (unmeasured). Firefox (WebRender / Skia in parts) and Playwright's Windows WebKit are a
  baseline only: Safari on a Mac draws through CoreGraphics -- the owner checks a real Mac later.
  Order: Firefox, Firefox ESR, then WebKit by Playwright.
Then group 7b (WebP decoders); then the fresh class-B re-check. Earlier:
group 8's geometry FIRST (owner, 2026-11-08: "can we work on group 8 then come
back to the SVG and WebP issues?"): the diagrams, and any filled shape as cover and background.
Then the SVG `<img>` (below) and group 7b (WebP decoders). Group 8 also takes the SVG `<img>`:
Chrome draws it as paths (measured), so it is checked as geometry like a diagram, and left out of
the image count (today it fails on the count, the loud direction). Group 6 left one thing unseen: a non-rectangular
shape over text. 🔒 **Added to group 8's scope (owner, 2026-11-08: "if group eight will address the
still not seen items, proceed to group 7"):** group 8 flattens PDF paths into polygons for the
diagram comparison; with them, any filled shape — not only a rectangle — is tested as a cover
over text and as a background behind it.
Group 4's last gap (a unit in a cell of its own) was fixed before group 5 (owner, 2026-11-08): a
table row's cells are one run.

🔒 **Owner, 2026-11-08: "skips need fixes also, unless it will be fixed in a different class."**
Nothing is set aside without a fix. Recorded for the class it belongs to:
- **Class F:** the 2 POSIX-only tests skip on Windows (`bun test` here: 70 pass, 2 skip). They run
  in WSL and on Linux CI; class F makes them run, or their check runs, on Windows too.
  🔒 **Scoped 2026-11-09 (owner: "I agree with the 'fake Chrome' suggestion. I agree with the
  recommended when")** — after class B, in class F: on Windows the stand-in Chrome is built at test
  time with `bun build --compile` into a temporary `.exe` (no test-only switch in the shipped
  code); signals are raised inside the build by a preload (`process.emit`), so the real handlers
  run (Linux and CI keep real signals); the helper-reaping section inverts on Windows until the fix
  below. Two REAL Windows gaps the scoping found, for class E: (1) an exited Chrome's helpers are
  never reaped on Windows (`runWithTimeout`'s `reapGroup` returns at once there) — find them by
  their recorded parent (`Get-CimInstance Win32_Process`, a PID-reuse guard on creation time) and
  stop each; (2) `main.ts` registers no SIGHUP/SIGBREAK on Windows, though Node raises SIGHUP when
  the console closes — register both (measure Bun first). Then 80 tests run on Windows, none skipped.
- Group 1's own skip, a probe case where a deletion removed the report heading, needed no fix: that
  build already fails ("report count does not match"); now pinned as a test section.

---

