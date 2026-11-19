# native-renderer.md: roadmap task 19, the native renderer and the production plan

Moved 2026-11-19 from `roadmap.md` task 19 (H38 split), verbatim. The trial's progress record: 
[archive/native-renderer-trial-2026-11-11.md](archive/native-renderer-trial-2026-11-11.md). The decision: [design-decisions.md](design-decisions.md) §10.

## 🟡 19. A native renderer: the baked HTML to PDF with no browser — SCOPED TRIAL (from 2026-11-11)

🔒 **Owner, 2026-11-11: "lets test a scoped trial and see if we can move this forward faster"**,
after Chrome could not print the 36ft model report (task 18, re-check 3, item 2b) and on the
owner's own question: "can the transform of html to pdf be accomplished without browser
interaction during the process? This would take a step in our checks off the table for the other
browsers if this could be accomplished."

**The options weighed (2026-11-11):** a layout engine has to stand in Chrome's place --
WeasyPrint (Python: barred, no host Python), Prince (commercial, closed), wkhtmltopdf (QtWebKit,
abandoned, a browser anyway), Paged.js / Vivliostyle (run inside a browser) -- or our own, in
TypeScript on pdf-lib. **Chosen: our own, scoped.** What it buys: the other-browser review leaves
the plan (what is drawn is our code's, known, not Skia's measured); the verification can know
where each glyph came from; a 7,400-page report is bounded by our memory, not Chrome's; no
render-time stamp. What it costs: a layout engine for SkyCiv's subset; line and page breaks will
differ from Chrome's (the 380-page baseline re-set, judged visually by the owner); anything outside
the subset refused by name, never approximated.

**Scope, in order:** (1) the 36ft model report (tables, text, 4 images, a web logo; no maths, no
SVG; 3.1 M cells in 200 tables; 5.3 KB of its own CSS) -- where Chrome prints nothing, so nothing
is lost; Chrome stays for the member reports; (2) grow toward the member reports; maths last.

**Shape:** `src/report_render.ts`, pure (no I/O): the SAME baked document Chrome is given in, a PDF
out; its own HTML parser and cascade, NOT the verifier's (`report_style.ts` / `report_svg.ts`;
design-decisions §9 -- a shared reader would make the style check a tautology); pdf-lib for the
document, content streams written directly (millions of cells). The verification is unchanged and
reads the stored PDF as today.


### 🎯 Production plan (owner, 2026-11-12): target 1, then target 2

Asked "how much longer … to have a viable product for production use?", two targets were laid
out; 🔒 **owner: "I agree. Lets proceed with target 1 that is very resonable"**, then "Please
update all of this and scope the Target 1 versus Target 2 so we can start a new session."
Estimates are in working sessions like 2026-11-11's (a full day each), and are claims with a date.

#### ▶️ Start of the next session, in order

1. ✅ **The merge is committed** (2026-11-12, owner: "lets proceed with Target 1"): `80fb480`.
2. ✅ **T1-1 is done** (2026-11-12, below); the false FAIL it found fixed (#121). 🟡 **T1-2:
   done locally (below); CI's half runs on the next push (owner's word).** ✅ **T1-3 rounds 1
   and 2 done and committed (#123–#127, `5fe3b56`, `1f4876a`).**
   ⏸️ **PAUSED 2026-11-12 (owner: "i need to pause here for the day") with #128 UNCOMMITTED:**
   native in-page links (the owner chose them for target 1), the colour precision, and the style
   check's print scale (`src/report_render.ts`, `src/report_style.ts`, `tests/build.test.ts`,
   README, design-decisions §10, known-issues #128, this file). Done before the pause: types,
   lint and format clean; the link, scale and mixed tests pass, each inverted (the renderer and
   the style check at `1f4876a`, and three mutants). **Not yet seen:** the run started at the
   pause -- the 36ft report natively (it must PASS, and its 261 links must ALL have a
   destination: the first cut gave 21, the inline-box fix is meant to give 261), the samples
   (`487321f2…`), the full suite. **Next session, in order:** (a) re-run those three (the 36ft
   report from the owner's Downloads copy, into a scratch folder; `links36.ts` /
   `deadtargets.ts` were scratch scripts -- re-create: count annotations with and without a
   destination, and the tag of each dead target, printing counts only); (b) if all hold,
   commit #128; (c) T1-3 round 3 on rounds 2's and #128's fixes (the review stops when a round
   finds nothing); (d) the push (CI's half of T1-2); (e) before T1-4's release, the security
   review and the hardening review (review-process.md § 0).
   **Also open:** C46 (the review process, filed with the workspace 2026-11-12) -- closed by this
   repo once the workspace's adoption is readable.
3. The stash (`git stash list`: "trial: table rewrite in progress", `src/report_render.ts` of the
   trial branch) is **target 2's** phase 1 -- leave it until target 1 ships.

#### Target 1 -- a production release using both renderers (~3–4 sessions)

**What it is.** Every report the tool meets prints, verified, in ONE PDF: the native renderer for
what it can draw (the 36ft-style model reports, which Chrome cannot print at all), Chrome for the
rest (the member reports: maths, drawings, their template) -- exactly as Chrome prints them today.

**Acceptance.** (a) A member-report-only set gives the SAME baked HTML and the same PDF as today
(the reference hashes hold: samples `487321f2…`). (b) The 36ft report alone PASSES natively, as on
2026-11-11 (7,161 pages, 24.67 MB). (c) A mixed set -- member reports and a model report --
builds into one PDF that PASSES, each report's checks on its own pages, the output naming which
renderer drew each report and why. (d) CI green on Linux and every Node line; the npm and JSR
packages carry the fonts and their licence (npm:prove). (e) A fresh review finds nothing open.
(f) Released only on the owner's word ("release"), through the release process (H33).

**Steps.**
- **T1-1 Routing and merging (~1 session).** `S3D_RENDERER` = `auto` (the new default) | `chrome`
  (everything through Chrome: today's behaviour) | `native` (everything native; refused if it
  cannot). In `auto`, per report: one holding maths (`<mjx-…>` in its bake) or an inline `<svg>`
  goes to Chrome directly (the native renderer refuses them today; trying costs time); any other is
  laid out natively ON ITS OWN, and a refusal sends it to Chrome, named. Consecutive reports with
  the same renderer form a group; a Chrome group is ONE document as today (its wrappers keep their
  report's index: `report-sheet rs{i}`, the scoped sheets' `.rs{i}` -- `assembleDocument` is public
  API, so its signature does not change); native reports use their own PDFs. The parts are merged
  in report order (pdf-lib `copyPages`), then packed (JPEG re-coding; the structure tree dropped)
  and verified as one PDF -- each report's checks already run on its own pages, so mixed fonts and
  print scales are fine. A single group keeps its bytes as rendered (no merge: a native-only
  build stays byte-reproducible). Tests: (a), (b), (c) above; the setting's values; a refusal routed
  to Chrome and named. `--help`, README, the API surface (a `cli-env` value) and `design-decisions`
  (the render strategy -- read before changing it) updated.
  ✅ **Done 2026-11-12** -- the design and its measurements are design-decisions §10. What was
  built: `S3D_RENDERER` = `auto` (default) | `chrome` | `native`; the routing runs before anything
  on disk is touched (a refusal or a missing Chrome deletes nothing); `assembleReports` (core, new
  export -- a part document keeps each report's `rs{i}`); `joinParts` (main.ts; one part keeps its
  bytes); Chrome found early but required only when a report goes to it (`chrome` mode still stops
  before the bake); the compatibility gate now records the named values `--help` documents
  (`cli-env S3D_RENDERER=auto|chrome|native`). Surface 109 lines, vs v1.5.0: 9 added, 0 removed /
  changed → floor **minor**. README: "Two renderers", Chrome's requirement narrowed, the two
  exports, reproducibility, and the licence paragraph (it still said "bundles no third-party code"
  after the fonts merged). Acceptance: (a) ✅ the 13 samples under `auto` -- all Chrome (13 with
  maths), baked `487321f2…`, 100 pages, PASS; (b) ✅ the 36ft report with NO setting -- native,
  7,161 pages in 37.3 s, 24.68 MB, PASS, 336 s; (c) ✅ the test "auto: member reports by Chrome, a
  model report natively, joined and verified" -- two samples, a model report, a report refused for
  its list: three parts, per-report 4/4, every word styled, the reports in order, `/Lang` carried.
  Tests added: that one, "native: reports joined, the same bytes every build", "assembleReports
  keeps each report's own index", the setting's values; the refusal test now checks the
  per-report message and that no PDF was written. Mutants caught: wrapping by position (three
  tests; the style check names every word), the parts joined in reverse (the verifier: "reports
  exchanged or out of order"), `/Lang` not carried. One line removed for having no test that could
  see it: deleting each copied page's `StructParents` (the packing drops them anyway).
  ⚠️ **Found on the way:** a report whose float paints before its heading (Chrome reads "Gust
  factor 0.85 | Wind Check | …") was not FOUND by its opening words, so the per-report check could
  not run and a correct PDF FAILED. ✅ **Fixed 2026-11-12 before T1-2** (owner: "Lets fix it now
  before we proceed to T1-2"): known-issues #121 -- the opening found in either reading of the
  page, exactly or with its characters rearranged.
  🔔 **For the release notes:** `auto` changes what draws a report with no maths and no drawing
  (Chrome before, native now) -- different fonts (Liberation for Arial, metric-compatible), line
  and page breaks, its own print scale. No member report is affected (all hold maths).
- **T1-2 Hardening for release (~1 session).** CI (`.github/workflows/ci.yml`) runs the native
  tests on Linux and Node 22.18 / 24 / 26; the Linux font path and the `readRenderFonts` hash
  check proven there; `npm:prove` and JSR's upload check with `fonts/`; the native renderer's
  limits written down (what it refuses, by name); the verifier's remaining memory churn (~7.5 GB
  peak in the checks on the full 36ft report) looked at if a target machine needs it; the
  scratch-only measurements (the 36ft report, the zip) re-run as the release's evidence.
  🟡 **T1-2, 2026-11-12 (owner: "proceed") -- everything that can be proven on this machine is;
  CI's half waits on a push (the owner's word):**
  - ✅ **CI already covers it -- no workflow change needed.** `checks` runs the suite under Bun
    and `node-suite` under Node 22.18 / 24 / 26, both on `ubuntu-latest`, so every native test
    runs on Linux at the next push; `npm` runs `npm-prove.ts --deno --install-node`, its new native
    leg included (below), on Deno too. JSR's `deno doc --lint` / `deno check --doc` (the new
    `assembleReports` example) and the upload check with `fonts/` run in `jsr`. ⏳ All of it first
    runs on the next push.
  - ✅ **Linux, locally (WSL Ubuntu, Bun 1.4.4, no Chrome, no Node):** a scratch clone, every
    native-only test PASSES -- the fonts found and hash-checked on Linux, native builds verified,
    joined native builds byte-identical. The mixed test fails there for the right reason: `3
    report(s) need Chrome, and neither Chrome nor Edge was found`, each named with why.
  - ✅ **npm:prove draws natively from the INSTALLED package** (new leg; fixture
    `tests/native/gate_post_model.html`, the suite's `modelReport(120)`, synthetic): on Node 22.13
    (the floor), 22, 24, 26 and Bun the installed CLI PASSES and writes the source's PDF byte for
    byte (`f57bf134629b`). Inverted: a package with one font byte altered fails every runtime --
    which showed the crash fixed as known-issues #122.
  - ✅ **The native renderer's limits written down** for users: README "What the native renderer
    draws, and what it refuses", read from the code's refusals (design-decisions §10 points there).
  - ✅ **The release's evidence, re-run under `auto` (scratch / local; client data):** the 48 set
    -- all Chrome, baked `da92578d…` (the reference), 380 pages, 48/48, 37,556 / 37,556 styled,
    PASS, 48 s; the 75-report zip (a copy) -- all Chrome, 553 pages, 75/75, 54,124 / 54,124,
    PASS, 74 s; the 36ft report -- native, 7,161 pages, PASS (twice today: 336 s, 432 s); the
    samples -- `487321f2…`, PASS.
  - ⏸️ **Not done, by the plan's own condition:** the verifier's memory churn (8.9 GB peak on the
    36ft report on this machine) -- "looked at if a target machine needs it"; none has been named.
  ✅ **T1-3, 2026-11-12 (owner: "proceed to T1-3 first", before pushing T1-2) -- round 1 done.**
  Three independent reviewers, read-only, given the code not the conclusions: (1) the routing and
  join, (2) the native renderer's fidelity, (3) the verification on joined PDFs and #121. Every
  finding re-checked here before acting (each confirmed by a run). Fixed, each with a test that
  fails without it: **#123** (the native renderer drew 27 constructs wrong without refusing --
  the hidden attribute printing a superseded "1.42 FAILS", a forced break in a cell overprinting,
  form controls, conditional `@media`, invisible characters, EXIF orientation, a data-URI crash
  … -- and a 2.15 pt column overlap in collapsed tables), **#124** (in-page links dead after a
  join), **#125** (#121's rule took anagrams for the same report, and the per-report check missed
  a late float), and the help's inexact wording (Chrome's role, the timeout per Chrome run).
  Recorded, not fixed (older, loud or cosmetic): known-issues after #125 -- chief among them class
  E of task 18 (a value moved to another label passes), open since before the native renderer.
  The 36ft report hits none of the new refusals (native, 7,161 pages, PASS, 338 s).
  ✅ **Round 2, 2026-11-12** (owner: "yes run round 2", then "yes" to fixing A, B and C): two
  fresh reviewers on round 1's fixes (the renderer's refusals; the join and the start rule), 16
  findings, every one re-run first. Fixed: **#126** (round 1's refusals bypassed -- case, escapes,
  clipping, `&nbsp;`, row-group alignment, templates, `not all`, a font deny-list -- and its
  over-refusals) and **#127** (#125's false FAIL on a repeated table header, its factorial
  search, dead links named); #125's claim corrected. Recorded: B6; `<pre>`. **B4 decided and
  built (owner: "The table of contents should have links to the content it is showing"): native
  in-page links, #128** — with a false FAIL found while showing them (colours a step off; the
  style check's scale silently assumed), fixed in the same commit.
  ⏳ **Next:** round 3 on round 2's fixes (🔒 owner, 2026-11-12: the review stops when a round's
  reviewers find nothing -- review-process.md § 1.4), the owner's choice on native links, then
  the push (CI's half of T1-2), the release's security and hardening reviews (§ 0), then T1-4.
- **T1-3 A fresh review (~1–2 sessions).** The project's practice before a release: an
  adversarial reviewer on the renderer, the routing and the merge; every finding fixed with a test
  that fails without it. Budgeted because every review so far has found real defects (2026-11-11
  alone: #118–#120).
- **T1-4 Release** -- a MINOR by the gate (additions only so far), on the owner's word.

#### Target 2 -- native for everything, Chrome no longer needed (~5–8 sessions after target 1)

**What it is.** The member reports drawn natively too: no browser anywhere, every platform
(owner, 2026-11-11: "linux, mac, windows, web, ios and android"), and the other-browser review
(Firefox / WebKit) taken off the plan for good.

**Acceptance.** The 13 samples, the 48-report set and the 75-report zip each PASS natively, every
check (words, numbers, images, drawings, styles, maths); the owner's side-by-side visual review of
each kind of page; the refusal list for every real report empty.

**Steps.**
- **Phase 1, the member template (~1–2 sessions; half done, in the stash).** Pop the stash on the
  trial branch: the slot-grid tables (spans, % columns, split rows, the repeated `<thead>`,
  vertical-align, cell heights, `::before` boxes) and the parser's table-scoped end tags. Fix its
  one lint finding; rerun the stripped samples (scratch `strip.ts`: maths and drawings removed);
  compare with Chrome side by side; tests for each feature and the blue-label case (the verifier's
  text pieces, which must fail against the old reader).
- **Phase 2, SVG drawings (~1 session).** All 136 real member reports use only `line`, `path`,
  `text`, `g`, one `<style>` and one transform per drawing (measured 2026-11-11): paths, strokes,
  dashes, text labels in PDF; the verifier's drawing check (proven against Chrome) judges them.
- **Phase 3, maths (~2–4 sessions; the main unknown).** MathJax's own layout, from its SVG
  output, each glyph drawn as TEXT in the embedded MathJax fonts (searchable: "equations must stay
  text, not vector outlines"); the fonts' licence read and recorded as Liberation's was; the
  verifier's maths checks (tuned on Chrome's CHTML) re-measured on the new output.
- **The three real sets natively, the owner's visual sign-off, review rounds (~2 sessions).**

#### Needed either way -- class B re-check 3, groups B–F (~2–3 sessions)

Image placement (B), orientation (C), cover / overprint / decoration (D), values against their
cells (E), per-occurrence styles and the two false FAILs (F) -- listed under task 18. Some are
simpler with the native renderer, which knows where it put everything. Before target 2's release
at the latest; the owner decides whether before target 1's.

#### Where things stand (2026-11-12)

- `main`: everything of 2026-11-11 committed and green, plus `8615dc5` (the verifier's text
  pieces); the trial branch merged (`80fb480`); T1-1, the routing and the join (above).
- The 36ft report: native, VERIFIED (7,161 pages, 24.67 MB, 328 s, peak 8.9 GB); in the session's
  scratch only -- client data.
- The member reports: Chrome, verified as before.
- Nothing pushed; nothing released since 1.5.0.

**Lossless JPEG re-coding, both renderers (on `main`, 2026-11-11).** 🔒 Owner: "scope the
re-optimizing of the JPEG's entropy coding and test the actual gain or loss before we add it";
then "I agree with the recommendation on the JPEG re-optimisation build"; and "this will need to
work on all platforms, linux, mac, windows, web, ios and android" -- so TypeScript, no binary.
- **Scoped first:** of the four real sets only the 36ft report carries JPEGs (4, 0.79 MB, all
  baseline with the standard tables); the member reports carry one PNG each, which Chrome already
  stores once. libjpeg-turbo 2.1.5's `jpegtran` (fetched in WSL, not installed): `-optimize` 21.4 %
  (786 → 618 KB), `-progressive` 25.5 %; pixels identical through libjpeg-turbo AND pdf.js. Chosen:
  baseline -- progressive's 4 % more is not worth some print pipelines' trouble with it.
- **Built:** `src/report_jpeg.ts` (`optimizeJpeg`; internal, no API change): each scan read to its
  symbols, optimal tables by T.81 Annex K.2, the same symbols re-written, read back and compared
  before it is returned; sequential Huffman 8-bit, any sampling, restarts, several scans; anything
  else left as it is. The packing step (`recodeJpegs`, main.ts) re-codes every DCTDecode stream,
  whichever renderer drew it; the build says `jpeg: N image(s) re-coded losslessly, A → B kB`, and
  the image check still compares each with its source, pixel for pixel.
- **Proved:** on the 36ft JPEGs and on eleven synthetic fixtures (`tests/jpeg/`: 4:2:0, 4:2:2,
  4:4:4, grey, two restart intervals, three scans with and without restarts, already optimal;
  progressive and arithmetic left alone), every scan's entropy data is BYTE-IDENTICAL to
  `jpegtran -optimize`'s with the same structure, the pixels identical through pdf.js; damaged
  input never throws. A tie-rule mutant is caught. **Chrome's cut of the 36ft report: 3.12 → 2.95
  MB, PASS, 5 of 5 images identical.**

