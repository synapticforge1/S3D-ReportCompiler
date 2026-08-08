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
| **CONSERVATION** | every word and number in the sources appears in the PDF |
| **MATHEMATICS** | no LaTeX source survived into the PDF |
| **GRAPHICS** | no image or diagram was sliced by a page break |
| **STRUCTURE** | every report contributed content, no page is blank |

```
  checked:  174 words, 660 numbers from 48 source(s)
  missing:  0 word(s), 0 number(s)
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

### 1. Conservation is a **set union** across all reports

It proves *every distinct value in the package appears somewhere in the PDF* — **not** that each value
appears in the right report. With 48 genuinely different members, each carrying distinct dimensions and
results, that is a strong guarantee. It would **not** catch one member being silently replaced by a
duplicate of another.

This was discovered by a negative control that *passed when it should have failed*: hiding a row in one
of two identical reports, where the other supplied the same tokens.

Tightening it means segmenting the PDF at report headings and comparing each against its own source.
Not done; the one real capability gap left.

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
