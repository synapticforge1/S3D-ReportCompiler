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

---

## 11. Rehearse in the environment that will run it, not the one you built it in

The first release failed at `deno publish` with `Could not find "mathjax-full" in a node_modules
folder`. Every local check had passed — including `deno publish --dry-run`, repeatedly.

It passed **because the working tree already had `node_modules` from development.** CI starts from a
bare checkout. Reproducing the failure took thirty seconds once the right environment was used:

```bash
git clone <repo> /tmp/repro && cd /tmp/repro   # no npm install — this IS ci
deno publish --dry-run                          # fails, exactly as the runner did
```

⚠️ **The defect lived in the seam between two correct decisions.** `"nodeModulesDir": "manual"` was
right — it keeps Deno reading the same `node_modules` as Node and Bun, which is what preserves the
identical-output property. Copying the release workflow from a sibling project was right too. But
that project has **no npm dependencies at all**, so it had no install step to copy, and neither
decision was individually wrong enough to notice.

⚠️ **Two smaller versions of the same lesson, from the same afternoon:**

- `deno doc --lint` passes on an example that does not compile. It checks that documentation
  *exists*; `deno check --doc` checks that the code in it *works*. The first module-doc example
  shipped was broken.
- Moving `cmem/controls/` to `tests/controls/` silently broke all eight scripts — their `../../`
  paths were correct one directory deeper. Nothing failed at move time because nothing ran them.

**Rule:** a check run in a privileged environment proves less than it appears to. Ask what your local
setup *provides* that the target does not — installed dependencies, a warm cache, a file that happens
to be there — then reproduce without it. And for anything moved, run it, do not read it.

---

## 12. Spend the analysis where the risk is, not where the story is

Extensive effort went into an inherited provenance quirk: comments, roadmap sections, a polling
verification step, a decision about warn-versus-fail. The release then failed for an entirely
different reason — a missing three-word install step — and the provenance concern **turned out not to
apply to this package at all**, which published attested at score 100 on the first successful run.

The quirk was interesting, documented in a sibling project, and had a satisfying narrative. The real
defect was boring, undocumented, and in a file copied without reading closely.

**Rule:** an inherited concern is a hypothesis about *your* system, not a finding. Check whether it
reproduces before building around it — and give at least equal attention to the parts that were
copied rather than reasoned about, because those are the parts nobody has examined.

---

## 13. Automate what you assume the release contains

Three releases, three ways of shipping the wrong thing — none of them a coding error:

| | What shipped | Why |
|---|---|---|
| 1.0.0 | a global install that did nothing | `deno install -g` installs the `.` export, not `bin` |
| 1.0.1 | the fix for that, **missing** | the tag was cut one commit before it |
| — | a tag force-pushed onto a published version | the guard against exactly this could not run |

The second is the instructive one. Everything was correct — the fix was written, reviewed, committed,
pushed — and the release still did not contain it, because `git tag` tags whatever HEAD happens to be
and prints nothing. There was no bug to find. There was only an assumption nobody had rendered
visible.

The fix is not vigilance, it is output. `deno task publish` now prints:

```
  tagging 8ff6093  Fix global install, and make the CLI explain itself
  as       v1.0.2
```

One line, and the class of mistake becomes hard to make.

⚠️ **The third row is the sharpest lesson, because it happened *inside the guard written to prevent
the second*.** The JSR "already published" check called `fetch` while the task lacked `--allow-net`.
The `NotCapable` error landed in a `catch` written for "offline, keep going", so the check reported
nothing and the script proceeded to force-push a tag onto a published version — precisely the act it
existed to stop. A missing permission is a **broken check**, not an absent hazard, and the two must
be distinguished in code.

**Rule:** make the release state itself out loud, and make every guard fail loudly when it cannot
run. Then confirm the guard fires — see §2. A check you have never seen refuse is a check you have
not yet written.
