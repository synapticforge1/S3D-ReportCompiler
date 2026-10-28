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
  checked:  174 words, 660 numbers from 48 source(s)
  missing:  0 word(s), 0 number(s)
  per-report: 48/48 reports hold all their own words and numbers
  graphics: 48 image paint(s), 48 expected; 48 diagram(s) checked, intact
  latex:    0 surviving, 48/48 reports, 0 blank page(s)
  PASS
```

**All 660 distinct numeric values are conserved.** For engineering calculations that is the check that
counts.

## How the tricky parts work

**Split detection without rendering.** An image straddling a page break is **painted on both pages**
(clipped), so a paint count above the expected count means a split. The diagram carries its title at the
top and its axis caption at the bottom — landing on different pages means it was cut in half.

**Independence.** It re-reads the sources **and the PDF** from disk and re-derives expected content with
its own extraction, sharing no code with the transforms. When this was quietly violated — the verifier
deriving its image count by re-removing the spinner with its own regex, which could have agreed with the
baker's mistakes — it was treated as a defect and fixed even though it worked.

## ⚠️ Two limits. Know these before relying on it.

### 1. ✅ CLOSED 2026-10-28 — conservation was a **set union** across all reports

The set-wide check proves *every distinct value in the package appears somewhere in the PDF* — not that
each value appears in the right report. It would not catch one member silently replaced by a
duplicate of another; a negative control found it by *passing when it should have failed* (a row
hidden in one of two identical reports, the other supplying the same tokens).

**Now also PER REPORT** (`compareEachReport`, roadmap task 7). The PDF is cut into whole pages at
the report headings — report i owns the pages from the one carrying its `MEMBER # n DESIGN REPORT`
up to the one carrying the next — and each report's own words and numbers must appear in its own
pages. Whole pages, because each report prints its tab strip and code line BEFORE its heading
(a first version cut at the heading itself and failed the correct samples on the last report: every
earlier report's opening had silently been credited to its predecessor — the set-union gap again,
inside the fix), and every report starts on a new page (`.report-sheet { break-after: page }`).
Were a report ever to start mid-page, the earlier report would FAIL — the loud direction. If the
heading pages do not match the source count the check reports that it did not run, as a failure.

```
  per-report: 48/48 reports hold all their own words and numbers
```

What it still cannot see: a value moved WITHIN one report, and the order of reports matching the
headings only by position (segments are paired with sources in build order).

### 2. The diagram-split check is template-specific

It keys on `Displacements z-axis` and `Position along member`. A different template makes it find
nothing — and "zero splits" would then read as a pass when the check never ran. So it **reports
coverage**: `0 diagram(s) checked (none recognised -- diagram check did not run)` means exactly that.

The report-heading pattern is template-specific too, but fails *loudly*: no match means the count will
not equal the number of sources.

## Comparison technique, and why it is that way

PDF text arrives as **positioned fragments**. `REFERENCES CALCULATIONS RESULTS` may extract as one run,
and a single word may arrive in pieces. Comparing token sets reported real content as missing.

Both sides are therefore reduced to a normalised stream and searched by **substring**, which survives
concatenation and fragmentation alike. This can only **under-report** absence — the safe direction for a
check whose job is to prove nothing was lost.

Two extraction rules that were bugs first:

- ⚠️ **`<` is a relational operator inside mathematics** — `30.483<\lambda_{rf}`. A `<[^>]+>` tag
  stripper consumes from there to the next `>` and swallows real numbers, making the check **falsely
  lenient**. The stripper requires a letter after `<`.
- **TeX command names are notation, not content** — a reader never sees `dfrac`. They are excluded,
  which costs a little coverage since `text`, `left`, `right` and `delta` are also ordinary words. The
  alternative is failing a correct build.

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
