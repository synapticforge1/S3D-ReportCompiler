# Process Log

How this project actually got here — the order things were tried, what the measurements said, and what
turned out to be wrong. Distilled from [transcript/session-transcript.md](transcript/session-transcript.md),
which is the primary source.

Read this for *why the code looks like it does*. [design-decisions.md](design-decisions.md) has the
conclusions without the route taken to reach them.

---

## Phase 1 — "review this script and correct any issues"

The starting point was a ~65-line Deno script that used **WeasyPrint** to concatenate 48 HTML reports
into a PDF. It had ordinary bugs — a folder that did not exist (`./html_files`), lexicographic sorting
(`member_0, member_10, … member_1`), no error handling.

Fixing only those would have produced **~400 blank pages**, and finding out why reframed the whole
project:

- The reports hide themselves behind `#report { visibility: hidden }` until a jQuery callback — fired
  after MathJax finishes — reveals them. **WeasyPrint has no JavaScript engine.**
- Neither WeasyPrint nor Python was installed on the machine anyway.
- ⚠️ **An early claim of mine was wrong**: I said the cross-section drawings were generated at runtime
  by `section-svg.min.js`. They are not — they are embedded base64 PNGs, and the diagrams are static
  inline SVG. Only the *maths* is deferred. Corrected after inspecting the source.

Switched to headless Chrome. Verified by screenshotting a single report before committing to it.
**Result: 9.46 MB, 356 pages**, rendering each report separately and merging with pdf-lib.

A methodological note that recurred all session: `--disable-javascript` is **silently ignored** by
headless Chrome. A test using it produced a byte-identical screenshot and nearly led to a false
conclusion. Proving JS-independence had to be done by *stripping the scripts from the file*.

---

## Phase 2 — "can we do this without Chrome at the server level?"

Established the fidelity ladder that governs everything after it:

> **Faithful HTML rendering requires an HTML engine.** The markup has no appearance until an engine
> computes one, and every engine computes it differently.

- **WeasyPrint** — a real CSS engine, so close but not identical. Ruled out when the runtime narrowed.
- **pdfmake** — spiked and it works under Deno (tables, base64 PNGs, inline SVG as true vectors). But it
  has no CSS engine at all, so a converter would be transcribing by hand, and it **cannot place an SVG
  inline within a line of text** — fatal for 87 inline expressions per report.
- **Typst** — Apache-2.0, excellent output, native inline maths. Also does not read HTML/CSS, so it is
  the same transcription problem. The right tool for *generating* from a data model, not for converting.

What *is* portable was proven separately: **MathJax's Node API pre-renders the maths with no browser**,
which removes the JavaScript dependency from the HTML entirely. 159 expressions converted, 0 failed,
0 `<script>` tags remaining — and the result rendered identically.

---

## Phase 3 — "widest engine compatibility, and a slim PDF"

This is where the numbers came from. All measured on the full 48-report set.

| Maths encoding | Intermediate HTML | PDF raw | PDF packed | Pages |
|---|---|---|---|---|
| SVG (`fontCache` none **and** local) | 65.8–83.1 MB | **52.03 MB** | — | 352 |
| **CHTML** | 14.81 MB | 6.57 MB | **3.35 MB** | 380 |
| MathML (native) | **5.08 MB** | 25.70 MB | 6.29 MB | **496** |

Three findings, none of which were predictable from reasoning alone:

1. **SVG maths is catastrophic for size** — every glyph becomes a vector outline. `none` and `local`
   produced a **byte-identical** 52,033,177-byte PDF, because Chrome flattens `<use>` back into path
   draws when printing.
2. **Single-pass rendering deduplicates.** The merge approach carried 48 copies of the section image
   and 31 font programs; one pass carries **1 image and 5 fonts**. Actual page content was near
   identical (2.57 vs 2.53 MB) — the rest was pure duplication.
3. **Chrome writes its non-stream objects uncompressed.** Repacking into object streams: 6.57 → 3.35 MB,
   49% off, no loss. This is what beat the manual Bluebeam shrink (3.46 MB) and removed that step.

MathML deserves its own note because the instinct was right and the measurement still said no: it is
genuinely native in 94% of browsers, MathJax exports it cleanly, and it produces the smallest markup by
far. It still lost on size (object overhead), on pagination (496 vs 380 pages), and on portability
(needs a MATH-table font on the host).

---

## Phase 4 — page layout

First attempt kept whole report sections together (`tr { break-inside: avoid }`). It worked — sections
stopped splitting mid-box — but cost **123 pages** of trailing whitespace (475 vs 380).

Owner's call settled it: *"as long as we do not cut in half any graphics or equations, the lines are the
least of the page issues."* Narrowed to `img, svg, mjx-container`. Back to 380 pages, nothing sliced.

Along the way: **480 `$..$` expressions were rendering as raw LaTeX**. Only two of the six configured
delimiters were handled. The log said `0 failed`, because an unmatched delimiter never errors. This one
finding drove Phase 6.

---

## Phase 5 — five review passes

Twenty-one bugs. The full ledger is in [known-issues.md](known-issues.md); the pattern matters more:

| Pass | Found |
|---|---|
| 1 | builder bugs — SVG `<style>` leaking into global scope, unescaped LaTeX on the error path |
| 2 | **silent stale output** — a failed render read back the previous run's PDF and reported success |
| 3 | no bugs; three risks reasoned about in conversation but never written into the file |
| 4 | **checker** bugs — image count assuming one figure per report, blank-page false positive |
| 5 | no bugs; more undocumented reasoning |

⚠️ **As the pipeline hardened, the bugs moved into the verification code.** A broken check is more
dangerous than a broken build: it fails in the safe-looking direction. Passes 3 and 5 found no defects
at all — only reasoning that existed in dialogue and not in the file, which is its own failure mode once
the transcript is gone.

---

## Phase 6 — "these are certified calculation documents"

The reframe that changed priorities. For sealed engineering calculations, **a dropped value is worse
than a broken layout, because a dropped value still looks right.**

Two things followed immediately:

- A planned change was **reversed**: stripping external `<img>` references generically. Silently
  removing anything from a certified document is the wrong default. Removals stayed narrow and became
  auditable (`48 loaders removed, 48 visibility gates opened, …`).
- The conservation check was built *before* trusting the CSS-scoping refactor, and then used to validate
  it — rather than the other way round.

**Delimiters became document-driven**: parsed from each report's own `tex2jax` config. Proven with a
report rewritten to use `@@..@@` and `%%..%%`, which produced output identical to the baseline.

⚠️ That work exposed a config bug in the source: SkyCiv declares `['\[','\]']`, which JavaScript
evaluates to a bare `[` and `]` — `\[` is not a valid escape. Honouring it would treat every bracketed
phrase in the prose as an equation. The build refuses it loudly.

### The negative control that earned its keep

Asking "can this check actually fail?" found a bug the conservation check could not:

The first hidden-content control **passed when it should have failed**. Chasing that revealed the source
CSS contains a **stray semicolon between rules**. CSS error recovery discards a lone `;`, but the
scoping walker glued it onto the following selector — and **browsers drop a rule whose selector will not
parse**. One rule silently deleted from every report, introduced by my own hardening, invisible to
conservation because the rule was cosmetic and lost no words or numbers.

---

## Phase 7 — cross-runtime

Probed before designing: Deno, Node and Bun all implement the needed `node:` builtins identically,
including `spawn`. So **one adapter, not three**, with lazy imports so a browser does not fail on
`node:fs`.

Split into a pure `report_core.ts` (zero I/O — which is what makes the browser case possible), a
`report_runtime.ts` adapter, and the CLI. Verified on all four: **identical output on Deno 2.9.4,
Node 24.18.0 and Bun 1.3.14**, and the core bakes and renders inside real headless Chrome.

⚠️ **Corrected 2026-08-08: "byte-identical" was the wrong word for the PDF.** Re-measuring during the
JSR restructure showed *two consecutive Deno builds of the same input* hash differently, because
Chrome stamps `/CreationDate` and `/ModDate` with the render time. The runtime was never the
variable. What is byte-identical — verified by sha256 on all three — is the **baked intermediate
HTML**, which is also the only artifact where the runtime could have made a difference, since Chrome
is the same binary in every case. See [testing.md](testing.md).

Two gotchas worth keeping: **`package.json` must not carry a UTF-8 BOM** (Deno rejects it with a
misleading parse error), and **Bun must be detected before Node** because Bun also sets
`process.versions.node`.

Then the restructure promptly broke the build — adding `browser_example.html` to the folder made it a
**49th report**. The verification caught it (`48/49 reports`, exit 1) and refused to ship. Fixed by
excluding tool-owned files.

---

## Phase 8 — packaging, and four releases to get one right

The build was finished and verified. What remained was shipping it: restructure into `main.ts` +
`src/`, sanitize samples, publish to JSR with provenance. That sounded like an afternoon. It produced
**four bugs and four new practices**, none of them in the converter.

**The pattern across all four: the code was correct and the *packaging around it* was not.** Every
gate — types, formatting, docs, dry run, builds on three runtimes — passed throughout, because every
gate exercised the code. Nothing exercised the artifact, the install, or the release.

| # | What shipped wrong | Why nothing caught it |
|---|---|---|
| 23 | the release workflow could not install its dependencies | `deno publish --dry-run` passed locally, in a tree that already had `node_modules` |
| 24 | a global install that ran, did nothing, exited 0 | `deno install -g` installs the `.` export, not `bin`; the README documented the broken command |
| 25 | the fix for #24 missed the release it was written for | `git tag` tags whatever HEAD is and prints nothing |
| 26 | two releases published with no provenance | `deno publish` and `deno task publish` differ by one word |

### The two that taught the most

**#25 — nothing was broken.** The fix was written, reviewed, committed and pushed, and the release
still did not contain it, because the tag was cut one commit early. There was no defect to find, only
an assumption nobody had made visible. The remedy was one line of output: `tagging 8ff6093 <subject>`.

**#26 — documentation lost to naming, twice.** After the first unattested release the response was a
warning in the script header, a contrast table, and a verification step reporting the damage
afterwards. All of it was in place when the next release went the same way. The owner's own account —
*"I thought that was what was happening, that is why I was asking when it popped up in the jsr instead
of the github actions"* — made the cause obvious: `deno publish` reasonably reads as *the way you
publish this package*. Renaming the task to `release` and **deleting** the `publish` task (an alias
would have preserved the habit) ended it. Four characters achieved what four paragraphs had not.

⚠️ **The self-inflicted one worth remembering:** while testing the guard written to prevent #25, the
guard's own JSR check could not run — the task lacked `--allow-net`, and the `catch` written for
"offline, keep going" swallowed it. The script then force-pushed a tag onto a published version, the
exact act the guard existed to prevent. Practice §2 — *a check that cannot fail proves nothing* —
violated inside the check written to enforce it.

Practices [§11](practices.md) through [§14](practices.md) all come from this phase.

## What I would tell the next person

1. **"0 failed" is not "nothing went wrong."** Three separate failure modes here were silent. That is
   why the build guards *and* verifies, and why neither is optional on a release path.
2. **Measure before believing.** SVG maths, MathML and render-then-merge all looked reasonable and were
   all wrong by 2–15×.
3. **Write the reasoning into the file, not the conversation.** Two of five review passes found nothing
   but undocumented risk. This document exists because of that.
4. **The strongest version of this work is upstream.** SkyCiv holds this content as structured data;
   HTML → PDF is a lossy round-trip through a format that was never the source of truth. See
   [known-issues.md](known-issues.md).
