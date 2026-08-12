# Roadmap / Task List

Open work, highest priority first. Status markers: 🔴 not started · 🟡 in progress · ✅ done.

Keep this current — it is the first thing to read after [INDEX.md](INDEX.md) when picking the project
back up.

---

## ✅ 1. Redact machine paths from the session transcript — RESOLVED BY NOT TRACKING IT

**Owner decision, 2026-08-08: `cmem/transcript/` is not tracked.** It is listed in `.gitignore`, so the
744 username occurrences never reach the remote and the redaction is no longer a precondition for
pushing. The transcript stays on this machine.

⚠️ **The trade-off:** the transcript is the one part of the project memory that no longer travels with
a clone. `cmem/*.md` is the portable record; anything durable in the transcript needs to be written
into a topic file to survive. [`scripts/`](../scripts/) and
[`../tests/controls/`](../tests/controls/) already carry the executable part of it.

`tests/controls/redact-paths.ts` is kept: if the transcript is ever published, it is still the tool for
the job, and its two hard-won findings still apply — a transcript embeds tool inputs as JSON so paths
appear both literally and backslash-escaped, and Claude Code flattens a working directory into a
separator-free slug (`C--Users-<user>`) that path rules never see. Missing either took 744 → 538
instead of 744 → 11.

<details>
<summary>Original task, kept for the record</summary>

**Do this before the first push if the repo will be public.**

`cmem/transcript/session-transcript.md` contains **744 occurrences** of the local username — absolute
paths like `C:\Users\<user>\Desktop\<work-folder>\...` captured from the commands run during
development.

(An earlier note said 501. That was PowerShell's `Select-String` counting matching *lines*; the
occurrence count is 744.)

It breaks nothing: the transcript is documentation, not code, and every **code** file is already path
clean (verified). But on a public repository it exposes the local username and directory layout for no
benefit.

**Fix:** [`controls/redact-paths.ts`](controls/redact-paths.ts), written and tested for this.

```bash
deno run -A cmem/controls/redact-paths.ts --check   # report only, writes nothing
deno run -A cmem/controls/redact-paths.ts           # apply
```

Measured on the current transcript:

```
rules hit: 349 → <project>, 172 → <home>/AppData, 43 → <home>, 171 → <home-slug>
username:  744 occurrence(s) before, 11 after
```

The 11 survivors are all the report's own `Designer:` value — SkyCiv report metadata in both rendered and raw LaTeX
form. That is **real document content, not a path**, and is deliberately preserved.

⚠️ Two things the first attempt at this got wrong, both caught by testing rather than review:

- **A transcript embeds tool inputs as JSON**, so paths appear both literally (`c:\Users\...`) and
  escaped (`c:\\Users\\...`). A separator pattern matching one backslash silently misses most
  occurrences — 744 → 538 instead of 744 → 11.
- **Claude Code flattens a working directory into a slug** (`C--Users-<user>`) with no separators at
  all, so path rules never see it. That alone was 171 occurrences.

⚠️ This makes the record non-verbatim. That is why it was not done automatically: the substance is
unaffected, but editing a primary source should be a conscious choice.

</details>

---

## ✅ 2. Resolve default folders from the working directory — DONE (2026-08-08)

`rt.cwd()` replaced `rt.moduleDir(import.meta.url)` for both defaults, and `moduleDir()` was removed
rather than left as dead code. The `.mathjax-fonts` cache follows the working directory too.

This is what makes a global JSR install usable: the script then lives in a registry cache directory
that will never contain anyone's reports.

Two things done alongside it, because the change made them matter:

- **A missing input folder now fails cleanly.** "Ran it from the wrong directory" became the ordinary
  mistake, and `listFiles()` on a nonexistent path threw a raw ENOENT stack trace. It now names the
  folder and says how to point at another one.
- **The output directory is still created before rendering**, and only once there is something to
  compile — Chrome will not create a missing directory for `--print-to-pdf`, and it exits 0 anyway.

⚠️ **Unchanged, deliberately:** `findChrome()`'s candidate list (those are *system install*
locations, not user directories, and `CHROME_PATH` already overrides them) and the controls in
`tests/controls/`, which resolve their sample with `import.meta.url` on purpose so they work from any
invocation directory.

⚠️ **The trade-off accepted:** run from a subdirectory and the defaults point at that subdirectory.
The failure is loud, not silent, which is why it is an acceptable cost.

<details>
<summary>Original task, kept for the record</summary>

**Status of the code at the time, so the task is not misread:** there were **no user-directory strings
anywhere in the source** — zero `C:\Users\…` literals in `compiled_reports.ts`, `report_core.ts`,
`report_runtime.ts` or the controls. This was a **design change, not a leak removal.**

`compiled_reports.ts` currently resolves its defaults from where the *script* lives:

```ts
const projectRoot = await rt.moduleDir(import.meta.url);
const htmlDir     = positional[0] ?? rt.joinPath(projectRoot, "HTMLFilesToBeCompiled");
const outputPdf   = positional[1] ?? rt.joinPath(projectRoot, "CompiledPDF", "combined_report.pdf");
```

**Change to** resolving from the **current working directory**, so the tool can live anywhere — checked
out elsewhere, installed globally, invoked by path — and still operate on the folder you are standing
in.

Work involved:

1. Add a `cwd()` helper to `report_runtime.ts` (`process.cwd()` on Deno, Node and Bun; `""` in a
   browser, where it has no meaning).
2. Use it in place of `moduleDir(import.meta.url)` for the two defaults.
3. `moduleDir()` becomes unused — remove it rather than leave dead code.
4. Re-run the build on all three runtimes; the verification is the regression test.

⚠️ **Do not change these:**

- **`findChrome()`'s candidate list** in `report_runtime.ts` — `C:\Program Files\Google\Chrome\…`,
  `/usr/bin/chromium`, and so on. Those are *system install locations*, not user directories, and they
  are how the browser is discovered at all. Already overridable with `CHROME_PATH`.
- **The controls in `cmem/controls/`** — they resolve their sample report with `import.meta.url` on
  purpose, so a control works no matter where it is invoked from. cwd-relative would break them.

⚠️ **The trade-off being accepted:** run from a subdirectory and the defaults point at that
subdirectory. The failure is loud (`No report .html files found in <path>`), not silent, which is why
it is an acceptable cost for making the tool relocatable.

</details>

---

## ✅ 3. Decide what the repository may contain — DECIDED (2026-08-08)

📌 **Owner decision.** The calculations themselves are academic and may be published; what comes out
is the identifying metadata — **Project Name, Designer, Project Notes**.

| Item | Decision | Why |
|---|---|---|
| `tests/HTMLFilesToBeCompiled/` | **tracked** — 13 sanitized samples | members 0–12: ten `HSS6x6x3/16` plus **all three** `HSS12x12x5/8`, so both section shapes in the original set are covered. Enough reports to exercise the per-report CSS scoping and id namespacing that one or two would not |
| `local/HTMLFilesToBeCompiled/` | **ignored, whole directory** | the real 48-report client set |
| `BlueBeam_Optimized_Report.pdf` | **deleted** | see 3b — it was a 356-page render of the client set |
| `cmem/transcript/` | **ignored** | absolute machine paths + client identifiers (see task 1) |
| `CLAUDE.md` | **ignored** | machine-local, same convention as `wasmtk` |

⚠️ **`local/` is ignored as an entire directory on purpose.** A per-file rule leaks the moment a new
report is dropped in beside the samples. Nothing moves from `local/` to `tests/` by hand — that is
what [`scripts/sanitize-report.ts`](../scripts/sanitize-report.ts) is for.

⚠️ **The sanitizer checks its own work**, because a redaction regex that quietly matches nothing
reports success and ships the data anyway — this project has been bitten by that exact shape twice
(see [practices.md](practices.md) §4). After rewriting the three fields it searches the output for
every word it removed, on **word boundaries**, and treats a survivor as a hard failure. Confirmed
able to fail: injecting the project name into the MEMBER heading, where the field rewrite cannot
reach it, produces `❌ 2 removed term(s) still present: …`, exit 1.

The ignore list for that check holds exactly one word (`design`, which occurs in "DESIGN REPORT").
Keep it that short — every entry is a hole, and widening it to quiet false positives is how a
redaction check ends up unable to fail.

### ✅ 3b. The Bluebeam benchmark PDF — deleted (2026-08-08)

Tracking `BlueBeam_Optimized_Report.pdf` was initially requested in the same decision that said to
scrub the Project Name, Designer and Project Notes. **Those two could not both hold.**

That file was a **356-page render of all 48 client reports**, and text extraction confirmed it
carried every term the sanitizer removes — the project name, the designer, the client name, the job
number and the scope line, on every page. Committing it would have published in full, for all 48
members, precisely what `scripts/sanitize-report.ts` strips from the samples.

📌 **Owner decision on being shown the conflict: delete the file.** `.gitignore` now has no exception
under `tests/CompiledPDF/` — any PDF built from the real set is a client render, so the rule is
simply "no build output is tracked".

**Nothing was lost.** The file was evidence for a measurement, and the measurement is recorded in
[design-decisions.md](design-decisions.md): 356 pages / 3.46 MB, manually shrunk in Bluebeam from a
9.46 MB render-then-merge output — against this build's 380 pages / 3.35 MB, produced automatically
and verified. That comparison is what justified removing the manual step, and it stands on the
numbers rather than on the artifact.

⚠️ **The general shape, worth remembering:** two separately-reasonable decisions about what may be
published contradicted each other, and neither was wrong on its own. The conflict only became
visible when the *content* of the artifact was actually checked rather than its filename. Before
committing any binary derived from client input, extract its text and look.

---

## 🔴 4. Finish removing the session log from the machine

The transcript and file-history entries were migrated into `cmem/` and deleted. But the session log is
**live** — Claude Code recreates and appends to it for the remainder of any session.

After the final session, re-export and delete:

```bash
deno run -A tests/controls/export-transcript.ts `
  "$env:USERPROFILE\.claude\projects\<slug>\<session-id>.jsonl" `
  cmem/transcript/session-transcript.md
Remove-Item "$env:USERPROFILE\.claude\projects\<slug>\<session-id>.jsonl"
```

**Lower priority since task 1 was resolved:** `cmem/transcript/` is git-ignored, so an un-redacted
export can no longer reach the remote. What remains is housekeeping on this machine, not a release
blocker.

⚠️ **The record is in two parts** — see `transcript/README.md`. The log was exported and deleted
mid-session, and Claude Code recreated it for the remainder, so `session-transcript-part2.md` holds
the migration work. Continuing this project in the new location produces a **third** log under a
different directory slug (`d--Programs-…` rather than `C--Users-<user>`). Export each one; do not
assume a single file covers everything.

---

## ✅ 5. First commit, and the first JSR release — DONE (2026-08-08)

**`@jrmarcum/s3d-reportcompiler` is live**: 1.0.0 and 1.0.1, both score **100**, all four runtimes
declared (`browser`, `deno`, `node`, `bun`), and both **attested** — Rekor entries present.

### 🔴 Outstanding: the global install is broken in every published version

`deno install -g jsr:@jrmarcum/s3d-reportcompiler` installs the `.` export — the *library* — so the
command runs, does nothing and exits 0 (bug #24). The `./cli` export that fixes it is on `main` but
**missed 1.0.1**: the tag was cut one commit early (bug #25). **1.0.2 ships it.**

Until then the working install is from a checkout:

```bash
deno install -g -n s3d-reportcompiler -A -f <path-to-repo>/main.ts
```

After 1.0.2, note the `/cli`:

```bash
deno install -g -n s3d-reportcompiler -A -f jsr:@jrmarcum/s3d-reportcompiler/cli
```

### ⚠️ Two predictions in this file were wrong. Both are corrected below.

**1. The release was expected to publish and merely lack an attestation. It got one.** The sibling
`wasmtk` project's missing `rekorLogId` did **not** follow this package. Whatever the JSR-side cause
is there, it is not general, and nothing about this repository's setup needed to differ. The warning
written into `publish.yml` about expecting an unattested release does not describe this project — the
step is still `continue-on-error` on purpose, but for this package it passes.

**2. The failure that actually happened was not predicted at all**, and it was in the one place
nobody looked: the workflow could not install its dependencies. See bug #23 in
[known-issues.md](known-issues.md). `deno publish` failed with `Could not find "mathjax-full" in a
node_modules folder`, because `deno.json` sets `"nodeModulesDir": "manual"` and the workflow had no
install step. Fixed with `npm ci`.

The general shape, worth keeping: **the risk was reasoned about at length in the wrong place.** Pages
of analysis went into an attestation quirk inherited from another project, which turned out not to
apply — while the real defect was a missing three-word step, created by copying a workflow from a
project that has no npm dependencies at all.

### What that cost, and the check that would have caught it

Nothing, as it happens — `deno publish` fails *before* publishing, so no version was burned and the
tag could be reused. But two things had to be fixed before a retry was even possible:

- `npm ci` in the workflow.
- **The retry path itself was broken.** `scripts/publish.ts` force-updated the tag locally but pushed
  it without `--force`, so the remote tag stayed on the failing commit and re-running the workflow
  rebuilt the same failure. Now forced, with a warning that it is only safe while a version is
  unpublished — JSR versions are immutable.

⚠️ **`deno publish --dry-run` in a working tree is not a rehearsal.** It passed throughout, because
the tree already had `node_modules` from development. Reproducing the failure took a clean clone with
nothing installed, which is what CI actually is. That procedure is now in
[testing.md](testing.md) and belongs in the pre-flight below.

### Release path

```bash
deno task bump          # or edit "version" in deno.json
deno task publish       # syncs version, commits, tags, pushes → triggers publish.yml
```

⚠️ **Never run `deno publish` from a workstation.** JSR only records a provenance attestation for a
publish arriving through its native GitHub Actions OIDC integration. A local publish succeeds and
produces an *unattested* release, which cannot be undone for that version number.

⚠️ **`deno task publish` force-pushes the tag.** That is what makes a failed release retryable, and it
is only safe while the version is unpublished. Once a version exists on JSR it is immutable — moving
its tag would leave the GitHub release pointing somewhere the published code does not. **Bump instead
of retrying.** The script now enforces this rather than merely warning: it queries JSR and refuses if
the version already exists.

### What `deno task publish` checks before it tags

All three exist because of a release that went wrong; none is theoretical:

| Refuses when | Because |
|---|---|
| the working tree has uncommitted tracked changes | they are not in the commit being tagged, so they are not in the release |
| HEAD is behind its upstream | commits from elsewhere would be missing from the release |
| the version is already on JSR | versions are immutable; forcing the tag would desync the GitHub release from the published code |

It also **prints the commit and subject it is about to tag.** That single line is what would have
caught bug #25 — v1.0.1 was cut one commit before the fix it was meant to ship, and nothing said so.

### 📌 Provenance — resolved for this package

**This package is attested.** `1.0.0` has a Rekor entry, at score 100. The sibling `wasmtk` project's
missing `rekorLogId` is a JSR-side issue **specific to that package**, and it did not carry over.
There is nothing to configure here and nothing outstanding.

The final workflow step still **warns and exits 0** rather than failing the job, and that stays:

⚠️ **A gate that fails for a known upstream quirk is worse than no gate.** It makes a red job the
normal state, and the next genuine failure gets waved through with it. The step reports the score and
the attestation either way — worth knowing, not worth failing a good release over.

The check is worth running at all because of what the `wasmtk` episode showed: its OIDC *prerequisite*
step passed for ten consecutive releases while the *outcome* was absent, and only asking JSR directly
could tell those two apart.

Pre-flight, all currently green:

```bash
deno task check                          # types
deno fmt --check                         # main.ts, src/, scripts/
deno doc --lint src/report_core.ts src/report_runtime.ts    # docs coverage — a scored criterion
deno check --doc src/report_core.ts src/report_runtime.ts   # the JSDoc EXAMPLES compile
deno publish --dry-run --allow-dirty     # JSR validation incl. slow types
cd tests && deno run -A ../main.ts       # samples: 100 pages, PASS
cd local && deno run -A ../main.ts       # full set: 380 pages, 3.35 MB, PASS
```

⚠️ **And the one that actually matters — rehearse CI in a clean clone**, because every command above
passes in a tree that already has `node_modules`, which CI does not:

```bash
git clone <repo> /tmp/cirepro && cd /tmp/cirepro
npm ci && deno publish --dry-run
```

Two traps the ordinary checks do not cover, both hit for real:

- `deno doc --lint` only verifies that documentation *exists*. `deno check --doc` verifies the
  examples inside it **compile** — the first module-doc example shipped did not.
- `deno publish --dry-run` in the working tree cannot see a missing dependency-install step. See
  bug #23.

`npm install` (or `npm ci`) is required after any clone, for Deno as well as Node and Bun —
`"nodeModulesDir": "manual"` means Deno reads the same `node_modules` rather than its own cache.

⚠️ **Git refuses to operate on this drive until it is trusted.** D: does not record ownership, so every
command fails with *"detected dubious ownership"* until:

```bash
git config --global --add safe.directory <repo-root>
```

That is a machine-local setting — it cannot travel with the repo, so anyone cloning to a similar
filesystem hits it independently.

---

## ✅ 6. Choose a licence — DONE

**MIT**, © 2026 Jon Marcum. `LICENSE` is at the repository root.

Compatible with the whole dependency set — `pdf-lib` is MIT, `mathjax-full` and `pdfjs-dist` are
Apache-2.0, and none of them impose copyleft. See [licensing.md](licensing.md).

---

## 🟡 7. Per-report conservation — the one real capability gap

Conservation is currently a **set union** across all reports: it proves every distinct value appears
somewhere in the PDF, not that each value appears in the *right* report. It would not catch one member
being silently replaced by a duplicate of another.

**Fix:** segment the PDF at report headings and compare each segment against its own source. The
heading pattern already exists in `readPdf()`.

Why it is not urgent: with 48 genuinely different members carrying distinct dimensions and results, a
duplicate would almost certainly surface as a *missing* value from the report it displaced. Worth doing
before this is relied on for a report set where members could legitimately be identical.

See [verification.md](verification.md).

---

## 🔵 8. MathJax 3 → 4 — deliberately deferred, not overlooked

`npm install` prints:

```
npm warn deprecated mathjax-full@3.2.2: Version 4 replaces this package with the scoped package @mathjax/src
```

**This is a deprecation notice, not a security advisory.** `npm audit` reports **0 vulnerabilities**.
`mathjax-full@3.2.2` is Apache-2.0, exact-pinned, and typesets all 8,286 expressions with 0 failures.

### Why staying is the right default here

⚠️ **MathJax 4 replaced the font system.** v3 ships its own woff-v2 fonts, which this build inlines from
`mathjax@3.2.2/es5/output/chtml/fonts/woff-v2` to make the document hermetic. v4 uses a different font
architecture, so `MATHJAX_FONTS` would need repointing — and **different fonts mean different glyph
metrics, different line breaking, and a different page count.**

For a sealed calculation package whose current output is a verified 380 pages, that is a material
change, not a version bump. The build would need re-verifying and the page count would very likely move
— exactly the kind of churn to avoid without a reason.

### What migration would involve, if a reason appears

1. `npm rm mathjax-full && npm i @mathjax/src` — imports map cleanly: the package's `exports` field
   routes `./js/*` → `./mjs/*`, so `@mathjax/src/js/output/chtml.js` resolves.
2. Repoint `MATHJAX_FONTS` in `report_core.ts` at the v4 font path.
3. Re-run the build on all three runtimes; the verification is the regression test.
4. Expect the page count to change, and re-baseline the figures in `INDEX.md`,
   `design-decisions.md` and `overview.md`.
5. Note the size cost: `@mathjax/src` unpacks to ~33.7 MB across 4,287 files.

**Triggers that would justify it:** a security advisory against `mathjax-full`, a TeX construct v3
cannot render, or v3 breaking on a future runtime.

### 📌 Decision (2026-08-08, owner): deferred until a migration is verified to cause no breakage or degradation

Adopt v4 only after it is demonstrated against the baseline below. Deprecation alone is not a reason.

⚠️ **The built-in verification proves the absence of breakage, not the absence of degradation.** It
checks that every word and number survived, that no graphic was sliced and that no LaTeX went
unrendered — so a migration that reflowed the document from 380 pages to 500 would still report
`PASS`. Degradation has to be judged separately, against these figures.

**Baseline to beat or match — `mathjax-full@3.2.2`, 48 reports:**

| Measure | Baseline | Acceptance |
|---|---|---|
| Verification | **PASS**, 0 words / 0 numbers missing | must still PASS — non-negotiable |
| Expressions | 8,286 converted, **0 failed** | must still be 0 failed |
| Pages | **380** | a change is expected; a large increase is degradation |
| Packed size | **3.35 MB** (~3,354,900 bytes; drifts slightly, see below) | material growth needs a reason |
| Intermediate HTML | 15.30 MB, 0 scripts, 0 external refs | must stay hermetic |
| Graphics | 48 image paints / 48 expected, 48 diagrams intact | unchanged |
| Equations searchable | yes — CHTML is real text | must stay text, not vector outlines |
| Runtimes | identical output on Deno, Node, Bun | unchanged |

⚠️ **Do not compare the PDFs by hash, and do not treat a small byte-count change as a regression.**
Chrome stamps the render time into `/CreationDate` and `/ModDate`, so the packed size drifts by a few
hundred bytes between runs of *identical* input on the *same* runtime. Compare the baked HTML by
hash and the PDF by page count and approximate size. See [testing.md](testing.md).

**How to judge degradation**, since no tool does it automatically:

1. Build with v4 into a **separate** output path, keeping the v3 PDF for comparison.
2. Compare the table above.
3. Rasterise the same few pages from each and look at them — `tests/controls/verify-pdf-text.ts` for the
   text side, and the page-render approach in [testing.md](testing.md) for the visual side. Equation
   spacing and line breaking are where a font change shows first.
4. Only then re-baseline the figures in `INDEX.md`, `design-decisions.md` and `overview.md`.

---

## 🔵 9. Optional hardening — scope the remaining blanket CSS rewrites

`visibility: hidden → visible` and `height: 100% → auto` are still textual replacements across each
report's stylesheet. They are audited and counted, and the conservation check backstops the failure they
would cause (hidden content = missing words and numbers).

Narrowing them to specific selectors means evaluating the CSS cascade. Deliberately not done — the
current form fails *visibly*, which is the safer class. See [known-issues.md](known-issues.md).

---

## 🔵 10. The upstream pitch to SkyCiv

The strongest version of this work is not the converter. Three findings, all measured, are worth taking
to them:

1. Their reports cannot be printed by anything without a JavaScript engine.
2. Their reports render differently on different machines — `Lato` is declared but never loaded.
3. Their `tex2jax` config declares `['\[','\]']`, which JavaScript evaluates to a bare `[` and `]`.

Emitting **MathML** would fix (1) and (3). Generating PDF from their data model would remove the
round-trip entirely — the case where **Typst** becomes the right tool.

See [known-issues.md](known-issues.md) and [design-decisions.md](design-decisions.md).
