# Practices

Working rules that this project paid for. Each one is here because ignoring it cost something concrete,
and the evidence is kept alongside so they read as findings rather than platitudes.

These are general — they outlived the specific bugs. [process-log.md](process-log.md) has the narrative;
[known-issues.md](known-issues.md) has the full ledger.

---

## 1. Measure before believing

Three approaches looked obviously reasonable and were wrong by 2–15×:

| Believed | Measured |
|---|---|
| SVG maths is the portable choice | **52.03 MB** vs CHTML's 3.35 MB — every glyph becomes a vector outline |
| MathML is native and compact, so it wins | smallest markup (5.08 MB) but **496 pages vs 380**, and a *larger* PDF |
| Rendering separately then merging is equivalent | 48 duplicate images, 31 duplicate font programs — **9.46 MB vs 3.35 MB** |

⚠️ Two of those were **my own confident recommendations** before I measured. The `fontCache: none` and
`local` SVG variants even produced a **byte-identical** file, which no amount of reasoning would have
predicted.

**Rule:** if a decision has a number attached, get the number. Reasoning about size, speed or layout is
a hypothesis, not a result.

---

## 2. Ask whether a check can actually fail

A check that has never failed has not been tested — it has only been *run*.

- The first hidden-content control **passed when it should have failed**. Chasing that uncovered a stray
  semicolon in the source CSS that was silently deleting a rule from **every report**, introduced by my
  own hardening.
- The graphics check compared paint count against report count. It worked — by coincidence. Every report
  has *two* `<img>` tags, and only the spinner's removal made the numbers line up. A second figure would
  have failed a correct build.

⚠️ Note which one caught which: the **conservation check** caught a 49-report build; the **negative
control** caught the dropped CSS rule, because that loss was cosmetic and cost no words or numbers.
Neither test subsumes the other.

**Rule:** for every guard, write the input that makes it fail, and confirm it does.

---

## 3. "0 failed" does not mean "nothing went wrong"

Three failure modes here were **silent** — the build reported success and produced a plausible document
that was wrong:

1. **480 expressions typeset as prose.** An unrecognised delimiter never *errors*; it simply never
   matches. The log said `0 failed`.
2. **A stale PDF read back as this run's output.** Chrome exits 0 even when printing fails, so "no file"
   was the failure signal — which only works if no file was there already.
3. **A CSS rule dropped from every report** by a scoping refactor.

**Rule:** enumerate what failure would look like if nothing threw. Those are the cases worth a guard.

---

## 4. A broken check is more dangerous than a broken build

Across five review passes the bugs migrated: passes 1–2 found **builder** bugs, passes 4–5 found
**checker** bugs — an image count that assumed one figure per report, a blank-page test that would flag
a diagram-only page, a diagram check that silently no-ops on an unfamiliar template.

A broken build fails loudly. A broken check fails in the **safe-looking direction**.

⚠️ This extends to the tooling used to verify: a PowerShell `-SimpleMatch` search with a `|`-alternation
pattern searches for that pipe-separated string *literally*. It matched nothing, reported "clean", and a
hardcoded machine path survived through it. The redaction script had the same shape of bug — it missed
JSON-escaped paths and a flattened directory slug, and only testing revealed 744 → 538 instead of
744 → 11.

**Rule:** verification code deserves more scrutiny than the code it verifies, not less. Test the test.

---

## 5. Write the reasoning into the file, not the conversation

Two of five review passes found **no defects at all** — only risks that had been reasoned about in
dialogue and never committed to the file: an ordering coupling in `portableSvg`, why a `table` rule is
inert, what the `$` delimiter can do to prose.

Undocumented reasoning is invisible to whoever reads the code next, and the transcript will not be there.

**Rule:** if you thought hard enough about something to explain it, it belongs in the file.

---

## 6. Never remove anything silently from a document of record

Mid-project the framing changed to *certified engineering calculations*, and one planned change was
**reversed**: stripping external `<img>` references generically. For a sealed document, silently
removing anything is the wrong default.

What replaced it: removals stayed narrow, and every one is counted and printed —
`48 loaders removed, 48 visibility gates opened, 144 height:100% relaxed, 48 stray CSS tokens cleaned`.

**Rule:** for anything that will be reviewed, archived or sealed, a dropped value is worse than a broken
layout — because a dropped value still looks right.

---

## 7. Fidelity has a ladder, and the format defines the top rung

> Faithful HTML rendering requires an HTML engine. The markup has no appearance until an engine computes
> one, and every engine computes it differently.

Chrome is exact here *because it is the engine the reports were designed and viewed in*. WeasyPrint and
Prince implement real CSS and land close. Typst and pdfmake are re-implementations — same content,
different document.

**Rule:** name which rung the requirement actually needs before choosing a tool. "One-for-one" and
"single lightweight runtime" were mutually exclusive, and saying so early would have saved a detour.

---

## 8. Deprecation is not a vulnerability, and a renderer swap is not a version bump

`mathjax-full@3.2.2` prints a deprecation warning. `npm audit` reports **0 vulnerabilities**. MathJax 4
replaced the font system, so adopting it changes glyph metrics, line breaking and page count — a
material change to a document whose 380-page output is verified.

Compare: two *real* advisories (one critical) came in through `canvas`, an **optional** dependency whose
native binding was never even built. `omit=optional` removed both and changed nothing.

**Rule:** separate "noisy" from "risky". Fix the advisory that has a CVE; defer the rename that changes
output, and record the deferral with an acceptance baseline (see [roadmap.md](roadmap.md) task 8).

---

## 9. Fix it upstream when you can reach upstream

The most valuable output of this project may not be the converter. SkyCiv already holds this content as
**structured data** — they generate the LaTeX, the section PNG and the diagram SVG, then assemble HTML.
Rendering HTML → PDF is a lossy round-trip through a format that was never the source of truth.

**Rule:** when a workaround is this elaborate, check whether you have access to the layer where the
problem is cheap to fix. See [known-issues.md](known-issues.md).

---

## 10. Confirm you measured the artifact the claim is about

For months the headline said the three runtimes produced **byte-identical output**. Re-measuring
during the JSR restructure showed something the original test could not have distinguished:

```
deno  → 0ba3b588…   node → 9fa16a1c…   bun → 6e7976c8…   deno (again) → 81f37eff…
```

Four different hashes — and the fourth is Deno against *itself*. Chrome stamps `/CreationDate` and
`/ModDate` with the render time, so no two builds of any input ever match. **The runtime was never
the variable being measured.** The claim happened to be true in spirit and unfalsifiable as stated.

The artifact where the runtime *could* differ is the **baked HTML** — Chrome is the same binary in
all three cases, so everything upstream of it is the only thing the adapter affects. Measured there,
all three are identical (`a19e5ad1…`), which is the stronger result the original claim was reaching
for.

⚠️ The near-miss: this looked, at first, like the `deno.json` import map having broken the
cross-runtime invariant. Attributing it to the most recent change would have produced a day of
debugging a non-bug — and, worse, might have "fixed" it by reverting a correct change.

**Rule:** before believing a comparison, ask what it would show if the property under test were
*absent*. A hash that changes for a reason unrelated to your variable cannot prove anything about
your variable — in either direction. When a metric moves right after your change, measure the
baseline again before assuming you caused it.
