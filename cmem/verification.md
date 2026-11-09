# Verification

## Why it exists

Three separate failure modes in this project were **silent** — the build reported success and produced a
plausible-looking document that was wrong:

1. **480 expressions typeset as prose** because a configured delimiter (`$..$`) was not handled. The log
   said `0 failed`, because an unmatched delimiter never *errors* — it simply never matches.
2. **A stale PDF read back as this run's output** after a failed render. Chrome exits 0 even when
   printing fails, so "no file" was the failure signal — which only works if no file was there already.
3. **A CSS rule dropped from every report** by the scoping refactor, via a stray semicolon.

None of these raised an error. For a certified calculation package that is the failure mode that
matters, so the build now proves its own output.

## What it checks

Run automatically as the last step; `--no-verify` skips it (**never on a release path**).

| Check | What it proves |
|---|---|
| **CONSERVATION** | every word and number in the sources appears in the PDF — and, since 2026-10-28, each report's in its OWN pages |
| **MATHEMATICS** | no LaTeX source survived into the PDF |
| **GRAPHICS** | no image or diagram was sliced by a page break |
| **STRUCTURE** | every report contributed content, no page is blank |

```
  checked:  220 words, 685 numbers from 48 source(s)
  missing:  0 word(s), 0 number(s)
  per-report: 48/48 reports hold all their own words and numbers
  graphics: 48 image paint(s), 48 expected; 48 diagram(s) checked, intact
  latex:    0 surviving, 48/48 reports, 0 blank page(s)
  PASS
```

**All 685 distinct numeric values are conserved, each as a whole token** (2026-11-08; 660 before,
when signs and separators split numbers and a value was found inside a longer one). For engineering
calculations that is the check that counts.

## How the tricky parts work

**Read the page as a browser does, on both sides (2026-11-06, review 2, #67).** The bake and the
verification each strip what is not drawn. They are written apart (§9), so each needs the HTML
parser's own rules:
- `<!-->` and `<!--->` are complete, empty comments;
- a comment ends at `--!>`;
- `</script >` ends a script;
- `<noscript>` is not drawn, because scripting is on (the CSP blocks scripts but does not turn
  scripting off).

The lazy regexes they replaced cut the text after such markup from both sides at once, so nothing
noticed. The bake now also pairs maths only within one text run, as MathJax does (never across an
element boundary or inside an attribute). A pair a browser would not see stays as written, and the
guard refuses it. ⚠️ The shared-cut class is the one to fear: when bake and verification lose the
same content, every check agrees.

**TeX settings are not content (2026-11-06, `a41961f`).** Command NAMES were always dropped from
the expected words ("dfrac" never prints), but their ARGUMENTS were all expected. The first real
SkyCiv zip (75 reports) failed a correct PDF on that: `\color{blue}{\text{ NONCOMPACT}}` in two
reports, and "blue" "missing". `dropNonPrintingTex` now removes the arguments that are settings and
keeps the ones that print. The class covers:
- colours;
- spacing, whose numbers never print, `\\[4pt]` included;
- `\phantom`;
- `\label`;
- environment names and column specs;
- MathJax's `\style`, `\class`, `\cssId`, `\unicode`, `\enclose`, `\bbox`, `\require` and `\href`'s
  URL.

The table is `NONPRINTING_TEX` in the core. ⚠️ A NEW non-printing command in a future template
fails the same way: loudly, with the setting named as missing. That is the safe direction. Add it
to the table, with a test, rather than loosening the check.

**Split detection without rendering.** An image straddling a page break is **painted on both pages**
(clipped), so a paint count above the expected count means a split — and, since 2026-11-08, its
drawn box runs past the page's edge, which is checked directly (a count let a lost image cancel a
split one). The diagram carries its title at the top and its axis caption at the bottom; they are
paired in reading order, so a title whose caption lands on a later page means it was cut in half.

**Independence.** It re-reads the sources **and the PDF** from disk and re-derives expected content with
its own extraction, sharing no code with the transforms. When this was quietly violated — the verifier
deriving its image count by re-removing the spinner with its own regex, which could have agreed with the
baker's mistakes — it was treated as a defect and fixed even though it worked.

## ⚠️ Three limits. Know these before relying on it.

(The third, found 2026-11-06, is at the end of this section.)

### 1. ✅ CLOSED 2026-10-28 — conservation was a **set union** across all reports

The set-wide check proves *every distinct value in the package appears somewhere in the PDF* — not that
each value appears in the right report. It would not catch one member silently replaced by a
duplicate of another; a negative control found it by *passing when it should have failed* (a row
hidden in one of two identical reports, the other supplying the same tokens).

**Now also PER REPORT** (`compareEachReport`, roadmap task 7). The PDF is cut into whole pages at
the report headings — report i owns the pages from the one carrying its `MEMBER # n DESIGN REPORT`
up to the one carrying the next (the first report also owns any pages before its heading, since
2026-11-08) — and each report's own words and numbers must appear in its own pages. Whole pages, because each report prints its tab strip and code line BEFORE its heading
(a first version cut at the heading itself and failed the correct samples on the last report: every
earlier report's opening had silently been credited to its predecessor — the set-union gap again,
inside the fix), and every report starts on a new page (`.report-sheet { break-after: page }`).
Were a report ever to start mid-page, the earlier report would FAIL — the loud direction. If the
heading pages do not match the source count the check reports that it did not run, as a failure.

```
  per-report: 48/48 reports hold all their own words and numbers
```

What it still cannot see: a value moved WITHIN one report (task 18 item 2 narrows it).
✅ Since 2026-11-08 (#91) segments are no longer paired by position alone: each segment's printed
heading must equal its source's, member number included, and the build order must be the
verification's own reading order.

### 2. The diagram-split check is template-specific

It keys on `Displacements z-axis` and `Position along member`. A different template makes it find
nothing — and "zero splits" would then read as a pass when the check never ran. So it **reports
coverage**: `0 diagram(s) checked (none recognised -- diagram check did not run)` means exactly that.

The report-heading pattern is template-specific too, but fails *loudly*: no match means the count will
not equal the number of sources.

### 3. It proves PRESENCE, never absence — nothing checks that content was not added

Every word and number of the sources must appear in the PDF; nothing says the PDF holds nothing
else. Content added during the render — by a script a report carried, or by something loaded from
another host — would sit in the sealed PDF and the build would still say PASS. So the protection is
upstream, in the render itself, not here (known-issues #55, #60; design-decisions §8): the bake
strips scripts, event handlers, `javascript:` URLs, `<meta>` and `<base>`; the document's
Content-Security-Policy forbids every script and every outside load (measured: a counting server
saw 5 requests during a render before, 0 after); Chrome keeps its sandbox except as root.

🔁 **The BAKE can add too (2026-11-07, known-issues #72; practices §17)** — not only the render.
What it now prevents: an undefined TeX command typeset as red text (MathJax's `noundefined`, left
out); one report's TeX definitions changing the next (cleared per report); a CSS comment or
string that opened a `/*` and hid later rules' `display:none` (CSS comments read as CSS does); the
reveal gate opened by a commented-out script (only scripts that run); a bad byte read as U+FFFD
on both sides (`decodeReport` refuses it). And one check that is NOT presence: the entity
control's bake must equal the untouched sample's, byte for byte — a swapped `<`/`>` is no word.

## Comparison technique, and why it is that way

PDF text arrives as **positioned fragments**. `REFERENCES CALCULATIONS RESULTS` may extract as one run,
and a single word may arrive in pieces. Comparing token sets reported real content as missing.

🔁 **Until 2026-11-08 both sides were reduced to a stream with every space and non-letter removed and
searched by SUBSTRING** — said here to "only under-report absence, the safe direction". For a
VALUE check that is the lenient direction (class review B): `0.9` was found in `0.95`, `125` in
`1250`, `250` in `1,250`, two table cells "12" and "5" read as "125"; signs, separators and
exponents were not part of a number (`-12.5` → `12.5`, `1,000` → `1.000`); words were three ASCII
letters or more, so `OK` → `NG`, `kN` → `mm`, `λ` → `φ` and `mm²` → `mm³` went unchecked. Measured on
the samples: 30% of the numbers and 15% of the words would still have been "found" with every
occurrence deleted. Now (1% and 0%, the 1% being an unsigned number after a minus, `5-3`):
- **The PDF text is read with its gaps** (`main.ts` `pageText`): pdf.js items that touch on one
  line are joined (kerned pieces, maths glyph by glyph); items apart by more than 0.15 of the text
  height, raised or dropped by more than 0.3 of it, or of another SIZE (a subscript) are separated
  by a space — between two digits, more than 0.35 of it (letter-spacing; separate numbers stand
  4.3 heights apart or more in both PDFs).
- **Tokens are matched WHOLE**: a number with no digit, point or separator joined to it; a word
  with no letter joined to it (one space may stand between its letters — maths draws `λ_{rf}`'s
  subscript as "r f" — but never a line break; a Greek symbol does not count as joined to a Latin
  word, as MathJax prints `\phi P_{c}` as "ϕPc").
- **Every occurrence, per report (since 2026-11-08, #89).** A report's pages must hold each word
  and number at least as many times as its source shows it; a short one is named with its counts,
  `30.483 (2 of 3)`. Presence alone let a changed second occurrence, a deleted line or one
  `PASS` → `FAIL` through. ⚠️ Both sides are counted by ONE matcher, the source on its own text
  read as the PDF is: counted by tokens, the source had fewer than the PDF's matcher found (its
  `t_{w}` prints "t w", which reads as "tw"), and that surplus hid a lost occurrence. The set-wide
  check stays a presence check; the per-report one is the strict one.
- **A number with its neighbours (since 2026-11-08, #92).** Each number is also counted with the
  unit, word, operator or `%` right after it and the operator right before it (`12 m`, `30.483 <`,
  `+ 3`, `85 %`), and `<`, `>`, `=`, `+`, `%` and `-` are counted symbols. Source pairs are taken
  only within one run of text — an element's own text, one maths expression, the cells of one
  table row (a unit in a cell of its own pairs with its number) — because across other elements
  the page's reading order is the layout's; on the PDF side a line break is a space, so a
  wrapped pair still counts. The report's own maths delimiters are blanked from the source text.
- **A token wrapped across lines (since 2026-11-08, #93).** At a wrap within one element (one
  marked-content id) between two letters or digits, the page text carries a soft break; it is
  joined only where one of the report's own tokens stands whole across it (`break-all` printing
  77.531234 as "77.5" / "312" / "34"), and is a line break everywhere else.
- **Number tokens keep** their sign (a "-" with nothing alphanumeric before it, so `M_{p}-0.7` is a
  binary minus), thousands separators, decimal part and exponent; `−` and the dashes read as "-".
  A comma is a thousands separator only inside a whole integer of groups (`1,250`, `12,300.5`);
  anywhere else it separates (`\max(96.982,50.675)` is two numbers — the first version read
  neither). A bare number is not found right after a sign (`12.5` is not `-12.5`); a signed one may
  print its minus spaced, as MathJax sets a binary minus (`M_{u} -0.537` → "- 0.537").
- **Words are two letters or more, in any script; every non-ASCII character is a symbol** (`λ`,
  `≤`, `²`, `°`), matched case and all (`Δ` is not `δ`). A word of three letters or fewer keeps its
  case — that is where the units are (`MN` is not `mN`) — and is found as written, or in capitals
  only where a stylesheet could have set it so: a source word with no capital of its own, on a PDF
  line with no lower-case letter, beyond the occurrences the source's own capital token claims. A command that prints a glyph expects it (`\lambda` → λ, `\phi` →
  U+03D5 as MathJax writes it, `\circ` → ∘); an operator name expects its name (`\max` → "max");
  any other command name is blanked only where it is a command, so prose "Max" is still checked
  beside a `\max`. A phrasing tag joins what is either side of it (`<b>0</b>.95` is 0.95), and
  zero-width characters are dropped.

All three real sets pass under it (2026-11-08). What it adds on the PDF side (`main.ts`): an image
cut by a page break, seen by where it is DRAWN (past the page's edge — a count let a lost image
cancel a split one); each report's own image count; a diagram's title without its caption in
reading order; each image's PIXELS against its source's, decoded by the verification's own PNG,
GIF and JPEG readers (#95; any other format fails as "not verified" — WebP comes in task 18 7b, an
SVG image in group 8); text drawn invisibly (render mode 3, or a tenth of full alpha or less, every
enclosing group's alpha multiplied in — `opacity: 0.02` is a group); text too FAINT to read against
what is behind it (contrast under 3:1; since #94 against the filled rectangles and images painted
before it under its centre, an image sampled from its pixels — white on a dark band passes, grey on
grey fails; the real sets' lowest is 8.6:1); text COVERED by an opaque rectangle or image painted
after it over half its box (#94);
text too SMALL to read (under 2 pt; the real sets' smallest is 3.61). Both measured figures are on
every build's `legible:` line; an image drawn but not seen (under 2 pt on a side, or less than half
inside its clipping box); a report's OWN declared maths delimiters printed around text in its own
pages (read from the source by the verification's own reader, over-inclusively, since 2026-11-08,
#90 — the bake refuses a config it cannot read, and the guard checks what the bake read, so this
is the side that does not depend on the bake); TeX sub/superscript marks in their braced form left in the printed text
(`k_{2}`), whatever delimiter the bake missed — not a bare `x_1`, which prose writes too.
(Since #96 any filled shape, curves included, is a cover and a background, by its outline.)
Since #97 each inline SVG drawing is checked as drawn: every shape's fill and stroke matched to a
PDF path in the shape's own coordinates (outline, colour or gradient, alpha, width, dashes), nothing
else painted among them, every label at its anchor; the report's stylesheets read as a browser
reads them. An SVG `<img>` is checked the same way, with only its own stylesheet (#98). Since #99
also each shape's CLIPS (viewports, markers, nested drawings, `clip-path`), compared as regions
at sample points; its fill rule, cap, join, miter limit and paint order; and nothing painted on the
drawing before its first or after its last shape; since #100 a gradient's stop opacity (Chrome's
luminosity mask read as a second shading); since #101 a drawing's `<image>`, by where it is painted
and pixel for pixel (a `slice` as Chrome's crop); since #102 a `<pattern>` paint, its raster pixel
by pixel against the pattern's own content (within the range its edges can blur to); since #103 a
`mask`, its value where the shape is; since #104 a `filter`, its image against the source run
through the verification's own primitives (`src/report_filter.ts`); since #105 `<switch>` and
conditional attributes (the render pinned to `--lang=en-US`), a `foreignObject`'s text inside its
box, an SVG `<image>` as its own drawing, a mask in a mask, sibling combinators and pseudo-classes.
Since #106 `:has()`, and convolution, lighting, fractal noise and feImage.
⚠️ Not yet verified, and named as such: turbulence of type `turbulence`, stitched noise, `feTile`,
`feDisplacementMap`, specular light from a spot (each run, but not yet matching Chrome); a drawing
of filtered elements alone (unplaceable); an `<image>` outside the document; WebP. ⚠️ Not yet checked at all (group 9, owner 2026-11-09): text STYLING — weight, colour, size,
style — of HTML text and of SVG labels.
⚠️ Formerly NOT seen: a diagram's drawing (only its
labels are text); a one-letter unit is caught only beside its number (#92: in
its run of text, or in the next cell of its row). (A number broken across two lines failed until #93; it is
joined now where the source has it whole.) 🔒 **Each of these is to be FIXED, not kept
(owner, 2026-11-08: "We need fixes not limits")**, (fixed so far: occurrences, size and white-page
contrast, #89; maths with bare marks, by reading each report's own delimiters, #90; report
identity and order, #91; a number's unit and operators, #92): the plan and order are roadmap task
18.

Two extraction rules that were bugs first:

- ⚠️ **`<` is a relational operator inside mathematics** — `30.483<\lambda_{rf}`. A `<[^>]+>` tag
  stripper consumes from there to the next `>` and swallows real numbers, making the check **falsely
  lenient**. The stripper requires a letter after `<`.
- **TeX command names are notation, not content** — a reader never sees `dfrac`. They are blanked
  WHERE THEY ARE COMMANDS (since 2026-11-08; they used to be deleted from the whole report's words,
  so one `\max` stopped a "Max Moment" heading being checked).

## Negative controls

A check that cannot fail proves nothing. See [testing.md](testing.md) — every control is reproducible.

## The lessons that cost the most to learn

*(Moved here from `INDEX.md` on 2026-10-26, verbatim, when the index was cut to one line per file;
the earlier text is `git show 4856337b8:cmem/INDEX.md` — `48ae20d` before the
[2026-10-26 history purge](history-purge-2026-10-26.md).)*

⚠️ **A converter that reports success is not the same as a correct document.** Three separate failure
modes in this project were *silent*: an unrecognised delimiter (480 expressions typeset as prose while
the log said `0 failed`), a stale PDF read back after a failed render, and a CSS rule dropped by the
scoping refactor. None raised an error. All three are why the build now verifies itself and exits
non-zero.

⚠️ **Faithful HTML rendering requires an HTML engine.** This is not a limitation of one tool — the
markup has no appearance until an engine computes one, and every engine computes it differently. The
original script used WeasyPrint, which has no JavaScript engine, and would have produced ~400 blank
pages. See [design-decisions.md](design-decisions.md).

⚠️ **As the pipeline hardened, the bugs moved into the checker.** Reviews 1–2 found bugs in the
builder; reviews 4–5 found bugs in the verification code — an image count that assumed one figure per
report, a blank-page test that would flag a diagram-only page, a diagram check that silently no-ops.
A broken check is more dangerous than a broken build: it fails in the safe-looking direction.

⚠️ **The verification caught a bug introduced by the hardening.** Adding `browser_example.html` to the
folder made it a 49th report. The build refused to ship. Conversely, the **stray-semicolon** bug — the
CSS scoping silently deleting a rule from every report — was found only by a **negative control**,
because the dropped rule was cosmetic and lost no words or numbers. Both kinds of test are load-bearing.
