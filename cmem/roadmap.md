# Roadmap / Task List

Open work, highest priority first. Status markers: 🔴 not started · 🟡 in progress · ✅ done.

Keep this current — it is the first thing to read after [INDEX.md](INDEX.md) when picking the project
back up. **The status line lives here and nowhere else** (workspace memory policy, letter H26; moved
out of `INDEX.md` and `CLAUDE.md` on 2026-10-26).

## Current state

| | |
|---|---|
| Output | **380 pages, 3.35 MB** from 48 reports (measured 2026-08-08; **re-measured 2026-11-06 on Bun, unchanged**: 3,354,047 bytes — the byte count moves with Chrome's render-time stamp, ~3,354,900 then; baked HTML 15.30 MB, rendered 6.54 MB, packed 49% smaller) |
| Maths | 8,286 expressions typeset, **0 failed** (2026-08-08; same 2026-11-06) |
| Verification | 174 words / 660 numbers checked, **0 missing**; per-report 48/48; 48 image paints for 48 expected; 48 diagrams intact; 0 surviving LaTeX; 0 blank pages; 0 id references (2026-08-08; same 2026-11-06 after the fourth review round, and the baked hash unchanged after the fifth) |
| Runtimes | Deno, Node, Bun — **byte-identical baked HTML** (sha256 `a19e5ad1…6277` on all three); browser bakes and prints (2026-08-08). 🔁 **Reference hashes since 2026-11-06:** the document carries one CSP `<meta>` line (#55, widened by #60, its font source narrowed to MathJax's folder by #65) — client set `ae70d5e0…`, samples `37792fe3…` (earlier the same day `a3a6a2af…`/`cc563a15…`, `7d5664f6…`/`cbdd3221…`); without that line both hash to the old values (`a19e5ad1…`, `7f283563…`) |
| Published | **1.2.0 on both registries, both with provenance** (2026-11-06; see Latest release). Before it, 1.1.7; and **1.1.6 on both registries** (2026-11-05, owner: "do the patch release"): the three code-review rounds' fixes. JSR (1.1.0–1.1.6 attested; 1.1.6 Rekor `3696801217`) and npm (1.1.4–**1.1.6 by OIDC with provenance**, 1.1.6 `latest`, 10 files). Took three tags-worth of attempts, none published wrongly: the first `v1.1.6` failed CI on Linux (the redactor missed POSIX paths) and the CI gate published nothing; the retry was refused by the compat gate (it took the stranded tag as its baseline); fixed both, and publish run 42070536432 went green on `f26f030`. Before that: **1.1.5** (2026-10-28, owner: "bump and release"): JSR `@jrmarcum/s3d-reportcompiler` (1.1.0–1.1.5 attested) and npm `@synapticforge1/s3d-reportcompiler` (1.1.0 by hand; 1.1.4 and 1.1.5 by OIDC with provenance). npm now lists **1.1.0, 1.1.4, 1.1.5, 1.1.6, 1.1.7 only** (1.1.7 added 2026-11-05, row below): the stray `0.0.0-stage` was deprecated, then unpublished, by the owner on 2026-11-05 (task 15). 1.1.5 = the first release through `publish.yml`'s CI gate (publish run 40759837547: "CI passed on the tagged commit" ✅, then JSR, then npm) and the first installed from `bun.lock`. 🔒 One tag releases both |
| Latest release | **1.2.0** (2026-11-06, owner: "update the project memory files and release 1.2.0"), tag `v1.2.0` on `138f6e3`, first attempt. Main pushed first (`68ef6e0`) and CI green on all 7 jobs (run 42337350760) BEFORE the bump; `bun run bump minor` → the gate allowed a minor (19 added, v1.1.7's samples PASS); `bun run release`. Publish run 42337922832 — the first of the reworked `publish.yml` — every job green: `ci-green`, `publish` (the SemVer gate on the runner, then JSR: attested, Rekor `3729552596`), `npm` (with provenance), `record` (`release/v1.2.0` = `138f6e3`), `finalize` (GitHub release `v1.2.0`). Ships SkyCiv zip input, both full-project reviews (#61–#71), #66. Before it: **1.1.7** (2026-11-05, owner: "release 1.1.7"), tag `v1.1.7` on `9fd873b`, first attempt: publish run 42079741086 — CI on the tagged commit ✅, JSR ✅ (attested, Rekor `3697712013`), npm ✅ (`latest`, SLSA provenance, 10 files). Ships the 1.1.6-range review's fixes: TeX errors fail the build (MathJax typesets an error box by default, M3), every named entity decodes in maths (M1), attributes read inside tags only, the per-report reference guard; release-script hardening (pathspec bump commit, exact undo, fenced JSR test hook, `compat --unpublished`, shared `scripts/jsr-api.ts`). Gate: patch vs v1.1.6, v1.1.6's samples PASS. The global CLI here: 1.1.7 (`cli:install-published`) |
| Unreleased on `main` | 🔁 **The third full-project review, 2026-11-07** (owner: "Fix all in the order you showed from A - E"; known-issues #72–#76): five groups, each its own commit, two API re-baselines in their own commits (`decodeReport`; the CLI's `cli-env` lines). Baked HTML byte-identical on all three real sets after every group; the suite 52 → **59 tests, all passing on Bun** (2026-11-07); each new test inverted against the commit before it. **Next release: a MINOR (1.3.0)** — `compat` vs v1.2.0: 0 removed, 0 changed, 4 added. ⚠️ `publish.yml`'s reworked job graph (#75) and the pinned actions in `ci.yml` run first on GitHub; the Node legs of the suite ran in CI only. **Unpushed, unreleased** — nothing is, unless the owner says so. Before it, **nothing: everything below shipped in 1.2.0 (2026-11-06).** The record of what went into it: the fourth code review's seven fixes (2026-11-06, owner: "yes"; ledger #31–#37 in [known-issues.md](known-issues.md)): a stale PDF that cannot be deleted refuses the build; a third positional argument is an error; SVG sheets hoisted only where an attribute can say the same, the rest confined to their own `<svg>`; body sheets scoped; `html body` / `body.x` / `:not(a, b)` selectors mapped right; `id=` inside an attribute's value is text (bake AND reference guard); the verification decodes hex and named entities. Baked HTML byte-identical on the samples and the client set; 31/31 tests on Bun and Node 24.21 / 22.18; `compat` → patch. **Then the review of `scripts/` and the workflows** (same day, owner: "fix all"; ledger #38–#43): releases only from `main` (script and workflow), the sanitizer refuses filled fields it does not scrub and short values, `verify-release --npm` (the release passes it), a provenance grace under `--wait`, no CI cancellation on `main`, unknown `verify-release` flags refused; 34/34 tests. **Then a cold review of those fixes** (same day, owner: "yes fix all"; #44–#47): kept SVG sheets confined in `:where()` (no added specificity), the sanitizer's guard refuses a template it cannot read, `html`/`body` attribute qualifiers settled, the redactor redacts email addresses; baked HTML still byte-identical, 34/34. **Then a fourth pass** (#48–#51): the npm-fence test made able to fail, HTML's caseless attributes honoured when settling qualifiers, an empty path argument refused, a control generator guarded; 35/35. **Then a fifth pass** (#52–#54): `resetBakeState()` and `findBrokenReferences()` exported (the browser example uses both), `cmem/local/` ignored; 37/37. **Then a sixth** (#55): the render runs no report code — handlers and `javascript:` URLs stripped, a CSP in the document, the Chrome sandbox kept except as root; baked hashes change by that one line; 38/38. **Then a seventh** (#56–#58): the font cache per MathJax version (the old flat one adopted), only real fonts kept, `S3D_CHROME_NO_SANDBOX=1` for hosts with no usable sandbox; 39/39. ✅ **The sandbox on CI's Linux runners, checked 2026-11-06** (#58): run 42306618122 on the throwaway branch `ci/sandbox-check` (`1b1e498`), all four jobs green, every Chrome render with the sandbox on. `main` was pushed later the same day (owner: "commit and push"; `57b2e23..39f2f16`, 27 commits). **Then an eighth pass** (#59, #60): fonts checked by their header's recorded length too; the document's CSP forbids every outside load (0 requests during the render, measured; 5 before), `<meta>`/`<base>` leave report bodies; 40/40. **Then the full-project review** (four reviewers; groups A–E, #61–#65; commits `4d44dc4`…`bfa5e32`, API re-baselines `c348731`, `319a5bb`): 44/44 on Bun and Node 26.12 / 24.21 / 22.18, the suite now in CI on Node 22.18, 24 and 26 (`0bbdabb`); `api-surface.txt` 81 lines, 12 added vs v1.1.7 → still 1.2.0. **Then zip input** (task 16, owner: "Build it now"; `2734a34`, surface `c6ffaf5`): `s3d-reportcompiler <reports.zip>`, the verified PDF added into the zip; 48/48 on Bun and Node 26.12 / 24.21 / 22.18. **Then the real 75-report export** (on a copy) found #66: the verification expected TeX settings (`\color{blue}`) in the PDF; fixed as the class (`a41961f`), 49/49, and the export PASSES. 🔼 **The next release is therefore a MINOR, 1.2.0** (`bun run bump minor`): `compat` → 19 added vs v1.1.7, `api-surface.txt` 88 lines. **Then the second full-project review** (owner: "All, in order A→E"; #67–#71; `dd0e22e` … `9be2626`, surface re-baselines `c9b90a8`, `d77f4ae`): 52/52 on Bun and Node 26.12 / 24.21 / 22.18; all three real sets byte-identical; unpushed. ✅ The old `release/v*` and merged work branches deleted (owner, 2026-11-06; known-issues #70): only `main` remains, tags kept; `compat.ts release 1.2.0` allows the minor. ✅ **Pushed 2026-11-06** (`39f2f16`; CI run 42327019979 green, all 7 jobs, so `ci.yml`'s changes have now run). ⚠️ `publish.yml`'s changes are first exercised by the next real release. Not released — nothing is, unless the owner says so |
| Attestation | 1.0.0 ✅ · 1.0.1 ✅ · 1.0.2 ❌ · 1.0.3 ❌ (both published locally, #26) · 1.0.4 ✅ Rekor `2439323008` · 1.1.0 ✅ Rekor `3544353215` · 1.1.1 ✅ Rekor `3544876876` · 1.1.2 ✅ Rekor `3545629708` · 1.1.3 ✅ Rekor `3546011937` · 1.1.4 ✅ Rekor `3546339510` · 1.1.5 ✅ Rekor `3547861777` (2026-10-28) · 1.1.6 ✅ Rekor `3696801217` · **1.1.7 ✅ Rekor `3697712013`** (`verify-release`, 2026-11-05); npm 1.1.4–1.1.7 ✅ SLSA provenance. ⚠️ `bun run release`'s wait outlasted by the CI gate on 1.1.5 (exit 2 "not on JSR yet", then attested) — `verify-release --wait` raised from 5 to 15 min — the first release from the org, with no `deno.json`, run from Bun |
| Tags | `v1.0.0` `8192c39d1`, `v1.0.1` `befc61fe8`, `v1.0.4` `9cdf0b06f` on `origin` (their `release/v*` branches, and 1.1.x's, deleted 2026-11-06 — each named its tag's commit; known-issues #70) — moved by the [2026-10-26 history purge](history-purge-2026-10-26.md); JSR's provenance names the pre-purge ids |
| Repository | `github.com/synapticforge1/S3D-ReportCompiler` (moved from `jrmarcum/`, which 301s); JSR's GitHub link names the org (2026-10-26) |
| Runtimes | every Node LTS line (22 from 22.18, 24, 26), Bun 1.4.4, Deno 2.9 LTS — one baked document, `bun run runtimes` (2026-10-26); Deno's leg runs in CI only since 2026-10-28 |
| CI | `.github/workflows/ci.yml` on every push/PR — checks, JSR checks + upload check (Deno), runtime matrix, npm proof, and since 2026-11-06 the test suite on Node 22.18, 24 and 26 (`node-suite`); **green on main: run 42327019979 on `39f2f16`, 2026-11-06, all 7 jobs** — the first run of the reworked `ci.yml` and of the zip and #66 code on Linux |
| Toolchain | Bun: `bun run check` / `format:check` / `lint` / `runtimes` / `compat` / `bump` / `release`; no Deno locally since 2026-10-28 (🔒 owner goal, [bun-migration.md](bun-migration.md)) — **proved 2026-11-05: the whole local gate passes with Deno absent from the PATH** (task 12): compat reads tsc `.d.ts`; `cli:*` install via npm; JSR's checks (`deno check`, `doc --lint`, `check --doc`, `publish --dry-run`, the upload check) and the Deno legs of `runtimes` / `npm:prove` run in `.github/workflows/ci.yml`; Deno publishes from `publish.yml`; the manifest is `jsr.json` (no `deno.json`, task 12 step 7) |
| API surface | `api-surface.txt`, **92 lines** since 2026-11-07 (`64253ae` `decodeReport`; `9c4fad9` three `cli-env` lines, the CLI's environment variables, now part of the surface) → vs v1.2.0: 4 added, floor **minor**. Before: **88 lines** since 2026-11-06 (69 at v1.1.7): 19 additions, none removed or changed — `findBrokenReferences`, `resetBakeState`, `bakeRemovals`, `cssWarnings`, `bakeWarnings`, `readZipReports`, `zipWithFile`, `checkZipUpdate` and three types on `.`; the usage line `s3d-reportcompiler <reports.zip>`; `listNames`, `fileIdentity`, `runWithTimeout`, `MAX_TIMEOUT_MS` and a type on `./runtime`; the CLI flags `--keep-html` and `-?` now documented → floor **minor** vs v1.1.7, so the next release is 1.2.0. v1.1.0 was released at floor minor (`compareEachReport` and two types added; the Node 22.13 floor counted as minor, owner) |
| Verification | set-wide AND per-report conservation (task 7, 2026-10-28); pdfjs-dist 6.4.299, no polyfill warnings (task 14) |
| Dependencies | **Bun installs them** (`bun.lock`; owner, 2026-10-28: "dependency installs should go to bun, because it is faster") — the same 20 package versions as npm's lockfile, ~2× faster warm (15.4 s vs `npm ci` 29.4 s); `bun audit`: **no vulnerabilities** (49 packages; `npm audit` 0 since the `@xmldom/xmldom` 0.9.12 override, task 13) |

🔁 **Corrected 2026-10-26:** this memory said "1.0.4 is staged and unreleased" for two and a half
months after 1.0.4 had shipped attested on 2026-08-12. Nothing re-read JSR in between.

⚠️ **The PDF is not byte-reproducible** (correction of 2026-08-08): Chrome stamps its render time
into `/CreationDate` and `/ModDate`, so two builds of identical input differ in hash. What is
identical across runtimes is the **baked intermediate HTML**; compare that by hash, and the PDF by
page count and approximate size ([testing.md](testing.md)).

For comparison: render-then-merge produced 9.46 MB / 356 pages, and the manual Bluebeam shrink of it
3.46 MB ([design-decisions.md](design-decisions.md)). This build beats the manual step and removes it.

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

## ✅ 4. Finish removing the session log from the machine — DONE 2026-10-28 (owner: "Delete the old session log")

**Done 2026-10-28:** the 2026-10-26 → 28 session's log re-exported over **part 4** (3,122 turns,
21.2 MB log → 1.6 MB, 0 base64 runs, through the `publish.yml` CI gate), then the `.jsonl` and its
session folder (two saved tool outputs) DELETED, and the old-slug project folder (only an empty
`memory/`) removed. What remains under `~/.claude/projects/` for this project: an empty `memory/`.
⚠️ Claude Code recreates the live log for the rest of the session that deleted it: that tail, and
every later session's log, is exported as the next part and deleted when its session ends — the
same routine, not an open task. 🔁 **Refined 2026-11-05:** a session cannot finish its own export
(each export's turns land in a fresh log), so the routine is: at the START of a session, export the
ENDED session's leftover log as the next part and delete it. Parts 5–8 (8 = that remainder, 4
turns, done 2026-11-05, owner: "finish part 8"); the parts table is `cmem/transcript/README.md`.

*The record before, kept:*

Owner: "perform" (2026-10-28). Exported with `bun tests/controls/export-transcript.ts` into the
git-ignored `cmem/transcript/`: **part 3** (the 2026-10-22 session, logged under the project's OLD
folder slug, 32 turns — verified 16 user / 16 assistant, no base64 left — then its `.jsonl` DELETED)
and **part 4** (the 2026-10-26 → 28 session, 1,787 turns, a SNAPSHOT: that session was the one
running the export, so its log could not be deleted from inside it). Both slugs' `memory/`
subfolders checked: EMPTY (the no-machine-local-memory rule held). **Left:** when that session ends,
re-export its `<session-id>.jsonl` (under `~/.claude/projects/<slug>/`) over part 4 and delete it —
and the same for any later session. (Slugs and session ids are machine-specific: they encode this
machine's folder layout, so they stay out of committed files — `cmem/transcript/README.md`, which is
git-ignored, may name them.)

The transcript and file-history entries were migrated into `cmem/` and deleted. But the session log is
**live** — Claude Code recreates and appends to it for the remainder of any session.

After the final session, re-export and delete:

```bash
bun tests/controls/export-transcript.ts `
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
different directory slug (one per project folder the work ran in). Export each one; do not assume a
single file covers everything. (Now four parts — `transcript/README.md`.)

---

## ✅ 5. First commit, and the first JSR release — DONE (2026-08-08)

**`@jrmarcum/s3d-reportcompiler` is live**: 1.0.0 and 1.0.1, both score **100**, all four runtimes
declared (`browser`, `deno`, `node`, `bun`), and both **attested** — Rekor entries present.

### ✅ The global install works as of 1.0.2

Verified by installing from JSR and running it — `--version` → `1.0.2`, `-h` → the full usage text.
Bugs #24 and #25 are closed. Note the `/cli`:

```bash
deno install -g -n s3d-reportcompiler -A -f jsr:@jrmarcum/s3d-reportcompiler/cli
```

⚠️ Within 24 hours of a release, add `--min-dep-age=0` or Deno silently installs the previous
version — see the note at the end of [known-issues.md](known-issues.md).

### ✅ 1.0.4 restored provenance — released 2026-08-12

Released through `deno task release`: tag `v1.0.4` and branch `release/v1.0.4` on GitHub, JSR
latest, attested (Rekor `2439323008`; re-verified 2026-10-26 with `deno task verify-release 1.0.4`).
The text below is the record of how it got there.

**1.0.3 was lost the same way as 1.0.2** — `deno publish` instead of the release task. The task is
now named **`deno task release`** so it cannot be confused with `deno publish`; that rename is the
actual fix, and everything below it is secondary.

✅ **Settled 2026-10-28 (owner):** JSR requires publishing from a GitHub Actions workflow by default
once the GitHub repository is linked, and it is linked (`synapticforge1/S3D-ReportCompiler`). So a
workstation `deno publish` fails at the registry instead of producing an unattested version — the
prevention this section once listed as still to do (known-issues #26).

<details>
<summary>The 1.0.3 attempt, kept for the record</summary>

**1.0.2 was published from a workstation rather than through GitHub Actions** (bug #26). No `v1.0.2`
tag, no `release/v1.0.2` branch, no Rekor entry, while 1.0.0 and 1.0.1 are both attested. JSR reports
it at score 100 regardless, because provenance is not scored — which is precisely why it was easy to
miss. Immutable, so it cannot be corrected.

**1.0.3 is bumped and committed. Release it with `deno task release`** — not `deno publish`.

What to watch for, in order:

1. `tagging <sha> <subject>` — confirm it names the commit you expect **before** it tags.
2. The workflow runs at `github.com/synapticforge1/S3D-ReportCompiler/actions` (then `jrmarcum/`).
3. A `v1.0.3` tag and a `release/v1.0.3` branch appear on GitHub. Their *absence* is what identified
   #26 after the fact.
4. The script waits and then reports `✅ 1.0.3 is published AND attested` with a Rekor log ID. If it
   prints `❌ … NO provenance attestation` instead, it exits non-zero and the release needs another
   bump — but you will know within minutes rather than days.

What 1.0.3 carries beyond the version: the `./cli` fix is already in 1.0.2, so this release is about
the release *process* — the pre-flight guards, the provenance verification, the install tasks, and
full function documentation.

</details>

**Release 1.0.4 with `deno task release`.** The four things to watch are unchanged from the list
above; substitute 1.0.4. The one that settles it is step 3 — a `v1.0.4` tag and a `release/v1.0.4`
branch appearing on GitHub. If they do not appear, the release did not go through Actions, whatever
jsr.io shows.

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

Since 2026-10-26 the release tooling runs on Bun from `package.json` (bun-migration step 4); the
accounts above of 1.0.3 and 1.0.4 keep the `deno task` names they were run with.

```bash
bun run bump            # or edit "version" in jsr.json
bun run release         # syncs version, commits, tags, pushes → triggers publish.yml
```

⚠️ **Never run `deno publish` from a workstation.** JSR only records a provenance attestation for a
publish arriving through its native GitHub Actions OIDC integration. A local publish succeeds and
produces an *unattested* release, which cannot be undone for that version number.

⚠️ **`bun run release` force-pushes the tag.** That is what makes a failed release retryable, and it
is only safe while the version is unpublished. Once a version exists on JSR it is immutable — moving
its tag would leave the GitHub release pointing somewhere the published code does not. **Bump instead
of retrying.** The script now enforces this rather than merely warning: it queries JSR and refuses if
the version already exists.

### What `bun run release` checks before it tags

All three exist because of a release that went wrong; none is theoretical:

| Refuses when | Because |
|---|---|
| the compatibility gate refuses (since 2026-10-28): a stale `api-surface.txt`, a bump below the surface floor since the last tag, or the last tag's samples failing on the new code | SemVer is a gate result, not a judgment (workspace letter H6; testing.md § Compatibility gate) |
| `jsr.json` (`deno.json` until 2026-10-28), `package.json` or `src/report_core.ts` differ from `HEAD` beyond their version line (since 2026-10-26) | the release `git add`s those three, so anything else in them would ship under "bump version" — known-issues #30 |
| the working tree has uncommitted tracked changes | they are not in the commit being tagged, so they are not in the release |
| HEAD is not on `main`, or `main` does not track `origin/main` (since 2026-11-06; checked before anything is committed) | `ci.yml` runs on every branch, so the CI gate did not stop a tag on an unmerged branch from publishing it to both registries — known-issues #38. `publish.yml` checks the same from its side: the tagged commit must be on `main` |
| HEAD is behind `origin/main` | commits from elsewhere would be missing from the release (an unreadable count refuses too; with no upstream this used to be skipped in silence) |
| the version is already on JSR | versions are immutable; forcing the tag would desync the GitHub release from the published code |

It also **prints the commit and subject it is about to tag.** That single line is what would have
caught bug #25 — v1.0.1 was cut one commit before the fix it was meant to ship, and nothing said so.

### After the tag: the release is not done until provenance is confirmed

`bun run release` now waits for the workflow to publish and then checks the attestation, via
[`scripts/verify-release.ts`](../scripts/verify-release.ts). It exits non-zero if the version landed
without one, so an unattested release cannot pass quietly. 🔁 Corrected 2026-10-26: until then the
check's progress and verdict were CAPTURED and never printed (Deno's `Command.output()`), so the
wait was silent and only the exit code told — measured by the step-4 equivalence run, fixed in
step 4 part 3 (`stdio: "inherit"`).

```bash
bun run verify-release              # the version in jsr.json
bun run verify-release 1.0.1        # audit any version
```

Exit codes: **0** attested · **1** published but not attested · **2** not published yet, or JSR
could not be asked · **3** attested but yanked · **4** (`--npm`) attested on JSR, but npm lacks the
version, its provenance, or an answer · **5** (`--github`, since 2026-11-07) both registries fine,
but no GitHub release for the tag, or no answer · **64** a usage error (an unknown flag, since
2026-11-06). Verified against all three real cases (again on Deno, Bun and Node, 2026-10-26).
**Since 2026-11-07 the release passes `--github` too** (known-issues #75); `publish.ts` refuses an
unknown argument (exit 64).

🔁 **`publish.yml`'s job graph since 2026-11-07** (#75; first exercised by the next real release):
`ci-green` → `checks` (the upload check and the SemVer gate; no token) → `publish` (JSR; installs
with scripts off; holds `id-token`) → `record` (the release branch) and `jsr-score`
(informational) · `npm-build` (no token) → `npm` (publishes the built artifact; holds `id-token`) →
`finalize` (the GitHub release; on "Run workflow" too). A second run for the same tag WAITS; none
is cancelled. Every action is pinned to a commit.
`bun run release --no-wait` skips the wait if you do not want to hold the terminal.

**Since 2026-11-06 the release passes `--npm`** (known-issues #40): one tag publishes both, and a
failed npm job used to end the release with ✅. Measured on the real registries that day: 1.1.7 →
exit 0 (Rekor `3697712013`, npm provenance); 1.1.0 → "on npm with NO provenance" (published by
hand, as recorded). Under `--wait`, a JSR record with no `rekorLogId` is looked at 8 more times
before it is called unattested (#41): `deno publish` attaches the provenance after the version is
visible.

⚠️ **This detects; JSR prevents.** Nothing in this repo can stop a `deno publish` typed directly —
Deno has no pre-publish hook. What refuses it is JSR, which requires publishing from GitHub Actions
for a package with a linked repository (owner, 2026-10-28). `verify-release` stays as the check that
an Actions release really was attested. There is still deliberately no `publish` script: `bun run publish` answers `Script not found "publish"`
(measured 2026-10-26).

⚠️ **`deno task release` is NOT dead — it runs the real release** (on any machine that still has
Deno; with no `deno.json` at all since 2026-10-28 this is UNMEASURED — assume it still does). With no `tasks` in `deno.json`,
`deno task <name>` falls back to `package.json` scripts, so `deno task release` runs
`bun scripts/publish.ts`. Found the hard way on 2026-10-26: typed as a "does the old name still
resolve?" probe, it synced the version and committed `bump version to v1.0.4` on the step-4 branch,
sweeping the uncommitted edits in `deno.json` / `package.json` / `src/report_core.ts` into it (the
defect below), and stopped only at the dirty-tree pre-flight — no tag, no push; undone with
`git reset --soft`. **Never probe a release command by running it.** Read the script table instead
(`bun run` with no arguments lists the scripts). What
changed is that the loss is now loud and immediate instead of found days later.

⚠️ **None of it helps if `deno publish` is run directly**, which is how 1.0.2 lost its attestation
(#26). The script is the whole release procedure, not a convenience wrapper around part of it:

| | `bun run release` | `deno publish` |
|---|---|---|
| Provenance / Rekor entry | ✅ | ❌ **none** |
| Git tag + `release/vX.Y.Z` branch | ✅ | ❌ |
| GitHub release | ✅ | ❌ |
| Version sync across the three files | ✅ | ❌ |
| Refuses to release the wrong commit | ✅ | ❌ |

Both produce a package JSR scores at 100. Only one produces a release you can prove came from this
repository.

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
bun run check                            # types (see testing.md for the full list)
bun run format:check                     # bun fmt over main.ts, src/, scripts/ (was deno fmt)
bun run lint                             # Biome
bun run compat                           # the compatibility gate's report (bump / release enforce it)
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

`bun install` (CI: `bun install --frozen-lockfile`; npm until 2026-10-28) is required after any
clone, for Deno as well as Node and Bun —
`"nodeModulesDir": "manual"` means Deno reads the same `node_modules` rather than its own cache.

⚠️ **Git refuses to operate on this drive until it is trusted.** D: does not record ownership, so every
command fails with *"detected dubious ownership"* until:

```bash
git config --global --add safe.directory <repo-root>
```

That is a machine-local setting — it cannot travel with the repo, so anyone cloning to a similar
filesystem hits it independently. (Until 2026-10-26 this line named the real path; it was replaced
by the placeholder under the workspace privacy rule — see [INDEX.md](INDEX.md) § Privacy.)

⚠️ **On an exFAT drive, also set `git config --local maintenance.strategy gc`** (workspace letters
H16, H26 §5; set in this clone 2026-10-26, 1 pack at the time). The failure it answers, as the
workspace recorded it from other repos on exFAT (binaryang, 2026-09-16): git's detached geometric
maintenance cannot replace files on exFAT (`renaming pack … failed: File exists`, `could not write
multi-pack-index`), so rolled-up packs pile up and `.git` grows without bound. It lives in
`.git/config`, so every fresh clone needs it again. This repo had not hit it — the setting is
preventive. The workspace is choosing one recipe for everyone (divergence P7).

---

## ✅ 6. Choose a licence — DONE

**MIT**, © 2026 Jon Marcum. `LICENSE` is at the repository root.

Compatible with the whole dependency set — `pdf-lib` is MIT, `mathjax-full` and `pdfjs-dist` are
Apache-2.0, and none of them impose copyleft. See [licensing.md](licensing.md).

---

## ✅ 7. Per-report conservation — DONE 2026-10-28

Owner: "perform" (2026-10-28). `compareEachReport` in `src/report_core.ts` (a new export — the
compatibility floor is now MINOR) cuts the PDF into whole pages at the report headings and checks each
report's own words and numbers against its own pages; `main.ts` prints `per-report: N/N …` and fails
the build otherwise. Acceptance: `control-hidden-row-two-reports` — PASS before — now FAILS for the
right reason (`b_report.html: 5 word(s) … internal, forces, absolute, force, bending`; the set-wide
check alone still says 0 missing); every correct build still passes — samples 13/13 on Deno, Bun,
Node 24 and all six runtimes (`7F283563003F`), the 48-report set 48/48 (`A19E5AD15E3F`), the
positive controls. ⚠️ A first version cut AT the heading and failed the correct samples on the last
report: each report prints its tab strip before its heading, so every earlier report had been
credited its successor's opening — the set-union gap reappearing inside the fix; whole pages fixed
it (verification.md § limit 1). Remaining blind spot: a value moved within one report.

The task as written:

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

**This is a deprecation notice, not a security advisory.** `npm audit` reported **0 vulnerabilities**
on 2026-08-08. 🔁 On 2026-10-26 it reported 1 high + 1 moderate, both `@xmldom/xmldom` 0.9.10 pinned
exactly by `speech-rule-engine` 4.1.4 under `mathjax-full` — fixed by an override to 0.9.12 on
2026-10-28 (task 13; `npm audit` 0 again), not a reason for v4.
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

### 🔁 MathJax limitations the bake works around — RE-CHECK ON EVERY MATHJAX UPDATE

🔒 Owner, 2026-11-05: "We need to note these as what they are, MathJax limitations. These will need
to be checked whenever MathJax is updated to the next version." Each is a MathJax behaviour (3.2.2,
measured 2026-11-05), not this repo's logic; the workaround lives in `src/report_core.ts`, and
**`bun run test`'s "MathJax limitations" test pins M1–M4, and "review 3, group A" M5–M6** — run them first after any MathJax
change (any version, 3.x patch included, and the v4 migration above). A failure there names the
limitation; re-measure it, then update the workaround, the test and this list together.

| # | Limitation | Workaround | Pinned by |
|---|---|---|---|
| M1 | **Entity tables load asynchronously.** The core table has 406 names and lacks common ones (`&ge;` `&ne;` `&plusmn;` `&minus;` `&middot;` `&sum;` … — 45 of 76 probed); the other 2125 load on demand, which a synchronous `convert()` cannot wait for. | `import "mathjax-full/js/util/entities/all.js"` fills the table synchronously; `texFromMarkup` reads it case-sensitively (`&Delta;` ≠ `&delta;`). | each entity typesets exactly like its character; an unknown one fails |
| M2 | **`\text{}` keeps U+00A0 but collapses ASCII spaces** (maths mode treats them alike). | `&nbsp;` decodes to U+00A0, as the DOM does, never to a space. | `&nbsp;` ≡ `&#160;` ≠ two spaces |
| M3 | **A TeX error does not throw.** By default MathJax typesets an inline red error box ("Misplaced &", "Undefined control sequence") and returns normally — the bake would count it as converted and seal the box into the PDF. | `formatError` rethrows, so the error is counted as failed and the build refuses. 0 error boxes in the 13 samples and the 48-report client set when added. | an unknown entity (a bare `&`) counts as failed |
| M4 | **CHTML must emit no `<svg>` or `<style>`.** `portableSvg` rewrites every `<text>` and hoists every SVG `<style>`, safe only while MathJax's own output has neither (see the ordering note on `portableSvg`). | none needed while it holds; switching the output to SVG would break it. | the typeset output holds no `<svg` / `<style` |
| M5 | **Two packages in `AllPackages` turn errors into text** (added 2026-11-07, known-issues #72): `noundefined` typesets an unknown command as its red name and returns normally, so M3's `formatError` never ran for the commonest TeX error; `noerrors` typesets a failed expression's source. | `TEX_PACKAGES` filters both out. | "review 3, group A" § 1: `\phiM_n` counts as failed |
| M6 | **Definitions outlive the expression** (2026-11-07, #72): `\def` / `\newcommand` / `\let` / `\DeclareMathOperator` / `\newenvironment` go into the `newcommand` package's `new-Command` / `new-Environment` / `new-Delimiter` maps, `\definecolor` into `packageData.color.model.userColors`, `\newtagform` into the tags' `mtFormats` — for the life of the TeX input, so one report's changed the next. | `resetTexDefinitions()` clears all five per report (and in `resetBakeState`), and THROWS if one is not where 3.2.2 keeps it. | "review 3, group A" § 2 |

Also MathJax-dependent, and covered by the full build rather than this test: the woff-v2 font path
(`MATHJAX_FONTS`, above) and the page count (the degradation baseline below).

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

---

## 🟡 11. Workspace floor (letter H26) — one owner action left: the GitHub Support request (item 2)

Since 2026-10-26 this repo sits under the workspace's common rules (`../cmem/working-rules.md`,
`memory-conventions.md`). Done in-repo on 2026-10-26: `origin` reset to the org, the stale links
fixed, the drive path at HEAD replaced, `maintenance.strategy gc` set, the ★ block copied
([best-practices.md](best-practices.md)), the privacy rule recorded ([INDEX.md](INDEX.md) § Privacy),
`.gitattributes` made wildcard-first, the status line moved here. Then, the same day:

1. ✅ **Pushed** (owner: "yes").
2. ✅ **The drive path purged from history (H19)** (owner: "Purge now"), force-pushed with the three
   tags and `release/v*` branches; every commit id from `387cbd9` changed. Method, verification,
   the old → new map, and what the moved tags re-triggered: [history-purge-2026-10-26.md](history-purge-2026-10-26.md).
   ⚠️ **Learned there: `deno publish` SKIPS an already-published version with exit 0**, so a
   re-run of `publish.yml` does NOT stop at the publish step — it runs on into the release-branch
   and GitHub Release steps. Harmless this time; read the workflow before ever moving a `v*` tag.
   🗓️ Still the owner's: a GitHub Support request to drop the old commits GitHub serves by hash.
3. ✅ **The five `scripts/*.ts` ran under Deno** (drift X17). Owner 2026-10-26: port them — done in
   task 12 step 4 (`129fd0a`): `scripts/` and `tests/controls/` run on Bun.
4. ✅ **JSR: require publishing from GitHub Actions** — settled 2026-10-28 (owner): it is JSR's
   default once the GitHub repository is linked, and the link is in place (#26 above).
5. ✅ **The pull line** ("At session start, read `../cmem/workspace-correspondence.md`, then the
   letters in `../cmem/handoffs.md` addressed to this repo") is in the gitignored `CLAUDE.md` on
   this machine, and INDEX § Workspace carries the same instruction for clones.

**Correspondence this repo opened** (`../cmem/workspace-correspondence.md`):
- **C20 ✅ closed 2026-10-28** — `--config jsr.json` corrupts a package with dependencies: binaryang's
  `jsr-deno-exit-guide.md` F1 / § 4 carry the caveat (`39c127def`, was `a846dc68f`, on its `origin/main`); wasmtk's
  `deno-exit-plan.md` P1 must prove its upload (`67686067a60`). Verified read-only by this repo.
- **C21 ✅ closed 2026-10-28** — six findings from task 12 steps 2–4: binaryang's guide § 5a carries
  all six (`97c2c0375`, was `a3d338e8e`, five re-measured), wasmtk's plan maps each to a phase (`67686067a60`).
  binaryang NARROWED (5) — only `jsr add`'s alias install is refused by npm 12 — re-measured here and
  carried into known-issues #27 and the README.
- **C27 ✅ closed 2026-10-28** (filed as C26, renumbered after a collision) — five findings from
  steps 5–7 and 1.1.0 for binaryang's guide; answered `60025f640` (local `main` at closing),
  verified read-only (bun-migration.md § "binaryang's guide update … reviewed").

**Correspondence addressed TO this repo:**
- **binaryang's C26 (2026-10-28) — ANSWERED 2026-10-28** (owner: "proceed with items 4 and 5"):
  binaryang rewrote its history a second time, so quoted binaryang ids went stale; translated
  through the table in `../cmem/handoffs.md` (the C26 bullet). Measured with a one-time read-only
  scan of every TRACKED file here for binaryang commit ids: **three were stale and are translated**
  — `a846dc68f` → `39c127def` (bun-migration.md, C20 above), `a3d338e8e` → `97c2c0375` (C21
  above), and `899b3fa5d` → `54cc098ea` (quoted only in this paragraph's earlier text); the old ids
  stay beside the new as "was". Still current, checked on a binaryang branch: `701d1043d`,
  `60025f640`, `8d9ba0cb9`; `b8fafaa3f` (best-practices 6.1) is quoted ON PURPOSE as the id
  before binaryang's FIRST purge and stays. The answer is in binaryang's row; binaryang closes it.
  (The workspace ledger's C20/C21 rows quote the old ids too — those are the workspace's to
  translate, as C26 lists.) **✅ CLOSED by binaryang 2026-11-05**: its 398-pair re-scan verified
  this repo ("S3D-ReportCompiler ✅ verified … nothing stale"); all four recipients done.

**Status of every ledger row naming this repo — re-read 2026-11-05.** Nothing in the ledger waits on
this repo. One item is the owner's (H19). The rows still open stay open only for OTHER repos; the
workspace closes them.

| Row | Ledger | This repo's part |
|---|---|---|
| H26 | ✅ closed 2026-10-28 | answered (task 11 above) |
| H20 | ✅ closed by the workspace 2026-11-05 | answered 2026-10-28 (one JSR path by GitHub OIDC, linked by repository id — architecture.md § JSR packaging); 1.1.0 → 1.1.7 released from the org measured as the proof |
| C26 | ✅ closed by binaryang 2026-11-05 | verified, above |
| C20, C21, C27 | ✅ closed 2026-10-28 (this repo's own) | above |
| H6 | open — wasmtk H6.5b (🗓️ owner) and loader-go | ✅ **verified done by the workspace 2026-11-05**: `ci.yml` runs `bun run compat`, `publish.yml` publishes nothing unless CI passed on the tagged commit (testing.md § Compatibility gate) |
| H15 | open — loader-go | ✅ verified by the workspace 2026-10-28 (scripts and controls on Bun, `129fd0a`) |
| H22 | open — loader-go | ✅ verified by the workspace 2026-10-28 (the path test, INDEX § Privacy) |
| H28 | open — rsxtk, loader-go | ✅ verified by the workspace 2026-10-30 (below) |
| H19 | open — the owner's GitHub Support requests | purged and force-pushed 2026-10-26; 🗓️ **OWNER: the GitHub Support request** to drop old commits served by hash (item 2 above) — this repo's only open item in the ledger |

- **H28 ✅ this repo's part VERIFIED by the workspace 2026-10-30** (ledger: "S3D ✅ (`cmem/INDEX.md:35-37`,
  'This repo has no such note')"). Re-measured 2026-11-05: the maintainer address is on commits
  only — `git grep` finds no address in any tracked file (the one email-like string is
  `test@example.invalid` in `tests/build.test.ts`), `package.json` / `jsr.json` carry no author or
  email field, no `cmem/` contact note; wabt-ts / binaryen-ts appear only as origin tags inside
  the verbatim ★ block (`best-practices.md`), no link, pin or `../` path. The row stays open in the
  ledger for rsxtk and loader-go only; the workspace closes it.

---

## ✅ 12. Move the toolchain off Deno, keep JSR — DONE 2026-11-05: the no-Deno local gate run passed

**Closed 2026-11-05 (owner: "I do not think Task 12 is dependent on deno not being installed. we
can run it with bun specifically to check that everything is ok").** Uninstalling Deno was never
the test; nothing resolving to Deno is. One run with Deno ABSENT from the PATH (the scoop shims
folder dropped for that shell; Bun and fnm from their real install folders, `bunx` as a hardlink
to `bun.exe` — the lint canary spawns `bunx` by name): `bun install --frozen-lockfile`, `check`,
`lint` (+ canary), `format:check`, `compat`, `test`, `runtimes`, `npm:build`, `npm:prove` all exit
0, and `node --test` (Node 24.21) 20/20. `runtimes` and `npm:prove` print "deno: runs in CI", as
designed. Deno stays installed here; whether to uninstall it is now only a preference.
⚠️ Learned: removing the shims folder from PATH also removes `bun` and `bunx` (scoop shims them
too) — a first attempt failed lint on a missing `bunx`, not on Deno.

**`publish.yml` gated on CI (2026-10-28; owner: "make the publish.yml"):** a first job `ci-green`
waits for `ci.yml`'s run on the tagged SHA (`gh api …/workflows/ci.yml/runs?head_sha=`, every
30 s, up to 40 min) and requires `success`; the JSR job `needs` it and npm needs JSR — so a red,
cancelled or missing CI run publishes NOTHING to either registry. Manual npm-only runs skip it
(they publish an already-tagged version). The query was checked against v1.1.4's commit
(`completed success`, run 40749944867); the gate itself first runs on the next tag.


Done and merged 2026-10-26: step 2 `bun check` (`a222adf`), step 3 `bun fmt` + Biome (`78f9ac8`),
step 4 every script and control on Bun, with three release defects fixed (`129fd0a`). 2026-10-28
(🔒 owner goal: no Deno on this machine): the compat gate reads tsc's `.d.ts`; **step 6, CI part** —
`.github/workflows/ci.yml`, first run green (run 40725430831); **step 7** — `jsr.json` is the one
manifest, `deno.json` deleted, `deno publish` with no `--config`, proved by
`scripts/jsr-upload-check.ts` (a fake-JSR capture of the real upload, in CI and in `publish.yml`
before the real publish); **step 5** — `tests/build.test.ts`, the samples and every control on
`bun test` and `node --test`, inverted 8/8, in CI; **step 6's proof** — 1.1.0 released
2026-10-28 by `bun run release`, the upload check green in `publish.yml`, attested (Rekor
`3544353215`). Remaining: `publish.yml` gated on CI passing for the tagged commit, the npm job
(task 15), and the owner uninstalling Deno here. Details and every measurement: [bun-migration.md](bun-migration.md).

The scope as first written:

Owner, 2026-10-26: "scope this repo's transition to bun per the guidelines in the binaryang
project". **The scope, the measurements and the seven steps: [bun-migration.md](bun-migration.md).**
In one line: the published code already runs on Node and Bun (no `Deno.*` call), so only the
toolchain moves — manifest to `jsr.json`, `bun check`, dprint, the release scripts and controls on
`node:` builtins, a CI gate that does not exist yet — while `deno publish` stays for JSR. The owner's
five decisions (2026-10-26) are at the end of that file: Biome for lint, `bun fmt` for format, the
pdfmake spike retired, a new `node:test` suite, no npm; push and settle the purge first.

---

## ✅ 13. Override `@xmldom/xmldom` to 0.9.12 — DONE 2026-10-28

Owner: "Override to 0.9.12" (2026-10-26), "yes, override" (2026-10-28). Measured first: **the build
never loads `speech-rule-engine`** — with it hidden the sample build PASSES with the identical baked
document — so the advisories were never reachable from the build. `package.json` `"overrides":
{ "@xmldom/xmldom": "0.9.12" }`; the lockfile moved by that one package (3 lines); `npm audit` →
0 vulnerabilities. Full gate identical: samples `7F283563003F` on Deno, Bun, Node 24 and all six
runtimes; the 48-report set 380 pages, 8,286 / 0 failed, `A19E5AD15E3F`. ⚠️ An override binds this
repo's installs only: a user of the JSR package resolves `mathjax-full`'s dependencies with their own
package manager (where the vulnerable code is, again, never loaded by this package).

The plan as written:

`npm audit` (2026-10-26): `@xmldom/xmldom` 0.9.10 **high** (a run of injection / ReDoS / quadratic
advisories, affected range 0.9.0-beta.1 – 0.9.11) and `speech-rule-engine` **moderate** (through it).
`speech-rule-engine` 4.1.4 — pulled in by `mathjax-full` 3.2.2 (`^4.0.6`) — pins `@xmldom/xmldom` at
exactly `0.9.10`, so nothing upstream moves it; 0.9.12 is the fixed patch. Plan: first measure
whether the build LOADS `speech-rule-engine` at all (nothing in `src/` imports it; `AllPackages` is
TeX input only — UNMEASURED); then one `"overrides": { "@xmldom/xmldom": "0.9.12" }` in
`package.json`, its own branch and commit, `npm audit` re-read, and the full gate including the
48-report set (baked HTML must stay `A19E5AD15E3F…`).

---

## ✅ 14. Upgrade `pdfjs-dist` 4.6.82 → 6.4.299 — DONE 2026-10-28

Owner: "upgrade pdfjs" (2026-10-26), "yes, upgrade" (2026-10-28). `pdfjs-dist` 6.4.299 (2026-10-03),
`@napi-rs/canvas` pinned 1.0.11 by `overrides` (the newest past two weeks; `^1.0.10` would take the
7-day-old 1.0.13), `.npmrc`'s `omit=optional` removed; the lockfile's optional entries are exactly
`@napi-rs/canvas` + its 11 platform binaries; the old `canvas → node-pre-gyp → tar` chain gone;
`npm audit` 0. Both type checks pass unchanged. **Acceptance = identical verification:** a one-time
capture of every verification line and exit code — samples on Deno / Bun / Node 24, the 48-report
set, all six controls — before and after: 68 lines identical; the ONLY difference is that the
"Cannot polyfill `DOMMatrix` / `Path2D`" warnings are gone, on Deno too. Full gate green; samples
`7F283563003F`, all six runtimes; API surface unchanged (floor patch); `verify-pdf-text` 146,878
chars, no warnings. Consequence for users: pdfjs 6 requires Node ≥ 22.13 (or ≥ 24), so the next
release's installed-package floor rises from 22.6 (README).

The plan as written:

Why: pdfjs 4.6.82 fills in `DOMMatrix` / `Path2D` from the optional `canvas` ^2.11.2, which this repo
does not install (`.npmrc` `omit=optional` — it drags in `tar` critical + `node-pre-gyp` high), so
Node and Bun print "Cannot polyfill `DOMMatrix`" and all three print "…`Path2D`" (known-issues
§ "pdfjs polyfill warnings"). Installing `canvas` was measured and does not work: no prebuilt binary
for Node 24 (`node-v137` 404), the source build needs Cairo, Deno cannot load it, npm 12 blocks its
install script. pdfjs 6.x (6.4.299 on 2026-10-26; Node ≥ 22.13 or ≥ 24) uses `@napi-rs/canvas`
instead — prebuilt N-API binaries, no `tar` chain. Plan, as its own task after 13:
- it is the VERIFICATION engine: re-baseline every count the build reports (words, numbers, image
  paints, diagrams) on the samples AND the 48-report set, and require the same verdicts; run the
  negative controls (each must still fail for its own reason);
- `@napi-rs/canvas` ships as OPTIONAL per-platform packages — `omit=optional` would drop them (the
  Biome lesson), so the `.npmrc` line changes, and `canvas` must not come back through another path;
- measure Bun (N-API) and Deno (npm N-API addons) loading it, and that the warnings are gone;
- the two majors' breaking changes read first (`main.ts` `readPdf()`, `tests/controls/verify-pdf-text.ts`).

---

## ✅ 15. Publish to npm as well as JSR — DONE 2026-10-28: 1.1.4 on both, by OIDC, with provenance; the stray `0.0.0-stage` removed 2026-11-05

**Outcome (read 2026-10-28):** npm `@synapticforge1/s3d-reportcompiler` has `1.1.0` (by hand, no
provenance), **`1.1.4` = latest, published by the trusted publisher with provenance**
(`https://slsa.dev/provenance/v1`; the re-run of publish run 40749944976 after the owner deleted
the token secret), bin `s3d-reportcompiler` → `main.js`, 10 files, Node ≥ 22.13.0 — and a
**`0.0.0-stage`** version nobody here published on purpose (open: owner's call — likely left by
npm's staged-publishing / trust setup; deprecate or unpublish within npm's window). A clean
install of 1.1.4 (npm 12.2, Node 24): 0 vulnerabilities, the CLI compiles the 13 samples PASS
(13/13 per report), the library imports with `compareEachReport`. JSR has 1.1.0–1.1.4, all attested.
From now on one tag publishes both (🔒 owner: "jsr and npm are updated at the same time always").
**"Require 2FA and disallow tokens" is SET** (owner, 2026-10-28). **`0.0.0-stage`** (read
2026-10-28): description "Temporary package placeholder for staged publishing", published by the
owner's npm user at 18:49:30Z — npm's staged-publishing flow left it during the first manual
attempt; not `latest`. The owner found no way to deprecate it on the website; the CLI can, with an
interactive 2FA login: `npm deprecate @synapticforge1/s3d-reportcompiler@0.0.0-stage "<msg>"`, or
`npm unpublish …@0.0.0-stage` while npm's unpublish window allows (owner's call).
✅ **DEPRECATED 2026-11-05** (owner: "deprecate the stray 0.0.0-stage", run by the owner — the
CLI's 2FA web confirmation cannot run from a session): the registry reads `deprecated:
"Placeholder left by npm staged publishing; not a release. Install 1.1.6 or later."`, `latest`
1.1.6. Deprecation keeps the version listed (npm skips it in ranges and warns on an exact
install); removing it is a separate `npm unpublish`, past the 72-hour window and so subject to
npm's no-dependents / low-downloads / single-owner policy — the owner's call.
✅ **UNPUBLISHED 2026-11-05** (owner ran `npm unpublish "@synapticforge1/s3d-reportcompiler@0.0.0-stage"`;
npm allowed it past the 72-hour window). Read back: versions 1.1.0, 1.1.4, 1.1.5, 1.1.6; `latest`
1.1.6; the 0.0.0-stage tarball 404, 1.1.6's 200. The registry keeps a `time` entry for it, and the
version string can never be published again. **Owner,
2026-10-28: the npm tokens are revoked** (and the `NPM_TOKEN` secret deleted before 1.1.4's
re-run) — no npm token exists for this package. The global CLI on this machine: the Deno one
uninstalled by the owner, now a Bun global of npm 1.1.4 (architecture.md § Installing it).

*The record of how it got here, kept:*

**2026-10-28, later:** the owner created the trusted publisher (`publish.yml`, no environment);
`publish.yml` has an `npm` job (architecture.md § JSR packaging). The first `npm publish --dry-run`
found npm 12 DROPPING the `"./main.js"` bin at publish time — fixed in `npm-build` (`"main.js"`) and
guarded in `npm:prove` and the job (testing.md § npm package). ⚠️ **The `v1.1.0` tag carries the
old `npm-build`**, so the npm job refuses 1.1.0; owner: npm starts at **1.1.1** ("I agree on
1.1.1"). **1.1.1 released 2026-10-28:** JSR ✅ attested (Rekor `3544876876`); **npm ❌ NOT
published** — publish run 40739241100: every check in the npm job passed (version = tag, the dry
run corrected nothing), then `npm publish` exited 1; the public annotations carry no reason (job
logs need a GitHub sign-in). **The log (owner pasted it):** provenance was signed and logged
(Sigstore index 3544894402) — the OIDC token reached Sigstore — but the PUT got `E404 Not Found`
with `NODE_AUTH_TOKEN: XXXXX-XXXXX-XXXXX-XXXXX` in the step's environment: npm's OIDC exchange for
publishing failed or was skipped, and npm fell back to setup-node's PLACEHOLDER token (written
because the job passed `registry-url`). The registry answers an unauthorised scoped write with 404.
npm's docs: the CLI tries OIDC "before falling back to traditional tokens"; npm does not check a
trusted-publisher entry when it is saved; troubleshooting = workflow filename incl. `.yml`,
`id-token: write`, GitHub-hosted runner, `repository.url` matching exactly (it does — read
2026-10-28: `synapticforge1/S3D-ReportCompiler`). Changed: no `registry-url` (no placeholder; a
failed exchange now fails as itself) and `--loglevel verbose` with the OIDC lines in the annotation.
**Cause (owner, 2026-10-28): "the first version must be published first before the trusted
publisher is set for that specific module"** — the name did not exist, so no trusted publisher
could match. **Bootstrap, once:** the npm job publishes with the repository secret `NPM_PUBLISH` (owner's name for it) when
it exists (npm tries OIDC, falls back to the token, and still signs provenance with the run's OIDC
token — never a local publish, which could not carry provenance). Owner steps: a granular npm token,
shortest expiry, read-write on the `synapticforge1` scope (2FA bypass only if the account enforces
2FA for publishing) → GitHub secret `NPM_PUBLISH` → **owner, 2026-10-28: "lets try release 1.1.2
with all of the updates first"** — after a second dispatch also ran from `release/v1.1.1`
(run 40743268151), npm starts at **1.1.2**, released by tag (a tag push runs the TAG's own
`publish.yml`, so the dropdown trap cannot occur); 1.1.1 stays JSR-only. ⚠️ **A manual "Run
workflow" must use "Use workflow from" = `main`** and put the version in `tag`: runs 40742854280 and
40743268151 were started from `release/v1.1.1`, so GitHub ran THAT branch's old `publish.yml` (no
token step, placeholder token, the same 404). **1.1.2 released 2026-10-28:** JSR ✅ attested (Rekor
`3545629708`); npm ❌ — publish run 40744332897, and the new annotation said why: the OIDC exchange
`404 … package not found` (expected for a new name), the `NPM_PUBLISH` token was used, and the PUT
got **`403 Forbidden — You may not perform that action with these credentials`**: the token lacks
write permission on the `@synapticforge1` scope. Fix = a token with "Read and write" for the
`@synapticforge1` scope (a token limited to selected PACKAGES cannot name one that does not exist
yet), then "Re-run failed jobs" on run 40744332897 — a re-run uses the tag's own workflow and reads
the secret afresh. **The first token was STAGE-ONLY** (owner pasted npm's text: stage-only tokens
"cannot publish new package versions directly", only `npm stage publish` + a 2FA maintainer's
promotion). Per GitHub's changelog (2026-09-18) staged publishing "works with existing npm
packages" — not a first publish — and direct publishing with bypass-2FA tokens continues until a
January 2027 target. So the bootstrap token must be a granular token, Read and write on
`@synapticforge1`, **bypass 2FA**, not stage-only. The owner renamed the secret to `NPM_TOKEN`;
main's job reads `NPM_TOKEN || NPM_PUBLISH` (the v1.1.2 tag's copy reads only `NPM_PUBLISH`). For
LATER versions on npm, the npm-recommended pairing is trusted publishing + staged publishing
(owner's call). Run 40745632990 (dispatch, 18:29) was AGAIN started from `release/v1.1.2` → that
copy reads only `NPM_PUBLISH` (gone) → no token → `ENEEDAUTH`. Three of three manual runs picked a
`release/v*` branch in "Use workflow from": the trap is the UI, not a slip. **Owner: "release
1.1.3 and try again"** — npm starts at 1.1.3, by tag (its `publish.yml` reads `NPM_TOKEN`); 1.1.1
and 1.1.2 stay JSR-only. 🔒 **Owner, 2026-10-28: "jsr and npm are updated at the same time
always"** — one tag, one run, both registries; an npm-only run exists only to complete a release
whose npm half failed. **1.1.3 released 2026-10-28:** JSR ✅ attested (Rekor `3546011937`); npm ❌ —
publish run 40746815045: the `NPM_TOKEN` token was READ and accepted as a credential, then
**`EOTP — This operation requires a one-time password`**: the account requires 2FA for writes and
the token lacks **"Bypass 2FA"**. Fix = the same granular token (Read and write on
`@synapticforge1`, not stage-only) WITH "Bypass 2FA", saved as `NPM_TOKEN`, then **"Re-run failed
jobs" on run 40746815045** (the v1.1.3 tag's own workflow reads `NPM_TOKEN`; no dropdown).
A manual run 40747526243 (from `release/v1.1.3`, whose copy does read `NPM_TOKEN`) got the same
`EOTP`. **Owner: "it is not asking for the 2FA like it did for the other repos"** — and binaryang's
own record (`../binaryang/cmem/publishing.md` § 1.13.1, read 2026-10-28) shows why: ITS first npm
version was a **manual publish by the owner** (`npm login`, then `npm publish --provenance=false`
from a `dist/` built and proved at the tag — the 2FA prompt was that interactive login), and only
then the trusted publisher (`npm trust github … --file publish.yml --repo … --allow-publish`, or the
package's Settings page). **Same route here:** `dist/` built from a checkout of `v1.1.3`
(`fcb6706`), `npm:prove` 20/20, `npm publish --dry-run --access public --provenance=false` clean
(10 files, 1.1.3); the owner publishes it. So npm's FIRST version, 1.1.3, carries NO provenance
(only CI can make it); every later one does, by OIDC. The token route is abandoned: revoke the
token, delete the `NPM_TOKEN` secret. **What actually happened:** the first attempt ran from the
REPO ROOT and tried to publish the whole repository as `@jrmarcum/s3d-reportcompiler` (68 files,
`cmem/` and the samples included) — refused only by the root `package.json`'s `"private": true`
(`EPRIVATE`). ⚠️ **Keep `"private": true` on the root manifest: it is the only thing between a
mistyped `npm publish` and a public copy of the whole repository.** The second ran in the repo's
own `dist/`, last built at 1.1.0, so **npm's first version is 1.1.0** (owner: "now the version on
npm says 1.1.0"), by hand, no provenance; npm versions are immutable, so it stays. The owner then
made the package public and set its trusted publisher (2026-10-28) and asked for **1.1.4** to JSR
and npm together. (An anonymous registry read still answered 404 just before — propagation or the
visibility change; re-read after 1.1.4.) **1.1.4 released 2026-10-28:** JSR ✅ attested (Rekor
`3546339510`); npm ❌ — the package now EXISTS (registry GET 200 in the job), yet the OIDC exchange
still said `package not found` → npm holds no trusted publisher matching this package + workflow
(the entry was first made before the package existed); the `NPM_TOKEN` fallback then hit `EOTP`.
Fix: the trusted publisher ON the package — `npm trust github @synapticforge1/s3d-reportcompiler
--file publish.yml --repo synapticforge1/S3D-ReportCompiler --allow-publish` (npm ≥ 11.15, logged
in with 2FA), or its Settings → Trusted publishing; then "Re-run failed jobs" on 1.1.4's publish
run (OIDC is tried before the token). **Done by the owner 2026-10-28** (`npm trust`: type github,
`publish.yml`, `synapticforge1/S3D-ReportCompiler`, permissions publish + stage publish). Owner:
"rerun it without the token" — the `NPM_TOKEN` secret is deleted before the re-run (the v1.1.4
tag's copy uses a token only if the secret exists), and main's `publish.yml` has NO token path
any more: OIDC only. After the first npm version: on npm, the
package's trusted publisher (`synapticforge1` / `S3D-ReportCompiler` / `publish.yml` / no
environment) and "require 2FA and disallow tokens" → revoke the token, delete the secret. Then
every later version publishes by OIDC with no token.

🔒 Owner: "we will post this to npm as well as jsr" — **supersedes** the 2026-10-26 "we will not
publish this to npm" (bun-migration.md, owner decision 4). 🔒 **Names** (owner, 2026-10-28: "jsr
remains the same, npm is on synapticforge1"): JSR `@jrmarcum/s3d-reportcompiler`, npm
**`@synapticforge1/s3d-reportcompiler`** (the npm org binaryang publishes under; all candidate names
were free, read-only check 2026-10-28).

**Built** (binaryang's design, adapted): `bun run npm:build` → `dist/` (git-ignored): `tsc` 7.0.2
(pinned devDependency) emits JS + `.d.ts` for the three entry points (`tsconfig.npm.json`,
`.ts` imports rewritten), the bin's shebang becomes `#!/usr/bin/env node`, a GENERATED
`package.json` (version from the one version source; the exports as `{ types, default }`; `bin`
`s3d-reportcompiler`; the runtime dependencies exact; `engines.node` `>=22.13.0` taken from
`pdfjs-dist`'s own engines; repository links; `publishConfig` public + provenance), README, LICENSE
and notices copied. **Proven:** `bun run npm:prove` (testing.md § npm package) — 20 / 20 on
2026-10-28: the 44 KiB tarball installed into a scratch project; on Node 22.13.0 (the floor), 22, 24,
26, Bun and Deno it imports and its INSTALLED CLI bakes the source's exact document; `npm exec`;
the `.d.ts` type-check; the export list equals JSR's npm build. README installation covers both
registries (owner request).

**Left, in order:** (1) 🗓️ OWNER on npmjs.com: a trusted publisher for
`@synapticforge1/s3d-reportcompiler` — GitHub Actions, repository `synapticforge1/S3D-ReportCompiler`,
workflow `publish.yml` (check npm's docs on whether the package must exist first: binaryang's first
version was published by hand); (2) a `publish.yml` job that runs `npm:build` + `npm:prove`, then
`npm publish` from `dist/` by OIDC, then reads the provenance back — task 12 step 6; (3) the first
release publishes to both. ⚠️ npm's trusted-publisher configuration must complete a publish within 2
days (binaryang's record), so (1) is best done just before the release.

The plan as written — what binaryang's `jsr-deno-exit-guide.md` § 5b says carries over, checked
against this package:
- **Dependencies on npmjs.org:** `mathjax-full`, `pdf-lib`, `pdfjs-dist` (+ `@napi-rs/canvas`) are
  all npm packages — no JSR-only `@std/*` at runtime ✓.
- **Ship compiled JavaScript + `.d.ts`:** Node will not strip types inside `node_modules`, so a
  `.ts`-only npm package does not load on Node. A build step is needed (tsc with
  `rewriteRelativeImportExtensions`, since the sources import `./src/*.ts`).
- **One version source:** generate the npm manifest at build time from the manifest that holds the
  version (step 7 makes that `jsr.json`). Put `bin` there — npm runs a CLI through `npx`, which JSR
  cannot (known-issues #29), so this also gives Bun / Node users a global command.
- **The name** is claimed permanently by the first publish: `@jrmarcum/s3d-reportcompiler` matches JSR
  — or the `synapticforge1` npm org binaryang uses. 🗓️ OWNER.
- **Trusted publishing (OIDC, provenance)** set up on npmjs.org by the owner BEFORE the first publish
  (workspace letter H20 — npm's policy may pin owner / repository ids; create it under the org), and
  provenance checked on that first publish, not assumed.
- **Prove the TARBALL, not the tree:** pack, install into a scratch project, import every export and
  run the CLI on each Node LTS line, Bun and Deno (`testing.md` § Runtime matrix, the installed-
  package column); JSR's own npm build of the same version is an independent reference.
- `package.json` is `"private": true` today and its `bin` points at `main.ts` — both change.
- Order: after task 12 step 7 (the version source settles) and with step 6 (the CI release path
  publishes both).

---

## ✅ 16. Take SkyCiv's zip directly — DONE 2026-11-06, released in 1.2.0 (`2734a34`, surface `c6ffaf5`)

**How S3D delivers reports** (owner): it creates each HTML file, bundles them into one zip, and the
browser downloads it to the Downloads folder. There is no stream to hook into, so a programmatic
"stream the HTML in" API does not fit S3D's process (it was considered and set aside; it would only
matter for a generator written in TS/JS). **Measured from the owner's example export
(`…_pack.zip`, entry list only, nothing extracted): 75 entries, all `member_N_report.html`, flat,
no folders, no other files; ~1.3 MB zipped, 48–67 KB per report; 12 share one size (47,928 B).**

**Scope (owner, 2026-11-06): "parsing the html files in from the zip file, then creating the
bundled html file and pdf file and running the check on the bundled html file and pdf file, then
adding the resulting pdf to the zip file."** So `s3d-reportcompiler <reports.zip>`:

1. **Read.** Parse the zip's central directory in memory and inflate each `.html` entry
   (`DecompressionStream("deflate-raw")`: Bun, Node, Deno and browsers have it, so no new
   dependency and the code stays in the I/O-free core). Check each entry's CRC-32 as it is read.
   Nothing is unpacked to disk. Exactly the `.html` entries are the reports, in the order the
   folder build uses.
2. **Refuse** (and name the entry): a folder or nested path; an encrypted entry; zip64; a
   compression method other than stored or deflate; a bad CRC; two names that differ only in
   case; and any entry other than `.html`, except this tool's own PDF from an earlier run (see 5).
3. **Bundle, render and check** with the existing pipeline unchanged: bake, guard, the bundled
   HTML, the Chrome print, the repack, then step-4 verification of the PDF against the bundled
   HTML and against each report. A FAIL leaves the zip **untouched**.
4. **Add the PDF to the zip.** Only after a PASS:
   - Write a new zip beside the old one. Copy every original entry's compressed bytes verbatim,
     so the reports are not re-encoded, and add `<zip name>.pdf` stored (a PDF is already
     compressed).
   - Re-read that new zip: every original entry's name, CRC and size must be unchanged, and the
     PDF entry must match the verified PDF byte for byte.
   - Then rename it over the original, which is atomic.
5. **A second run** finds its own PDF in the zip. That entry is not a report, and it is replaced.
6. **The bundled HTML is NOT added to the zip.** It is a `.html`, so the next run would read it as
   a report. It is kept beside the zip as now (`--no-keep-html` removes it).

**Decided (owner, 2026-11-06): "Into the original zip"** — no copy and no loose PDF; "Build it now".

**As built.** Everything above, plus what building it showed was needed:
- **Every byte before the central directory belongs to exactly one entry**, its data descriptor
  included. A descriptor must agree with the central directory. Bytes no entry claims are a file
  another reader could see.
- **A name without the UTF-8 flag is read only if it is ASCII.** A guessed code page could
  misname a report.
- **An entry stops unpacking at its recorded size.**
- **The zip is replaced only if it still holds the bytes the reports were read from.** After the
  rename it is read back again.
- **A file of the baked HTML's name beside the zip that is not a bake is the user's.** The build
  stops rather than overwrite it.
- **A zip takes no output argument and no `--no-verify`.**
- **If the PDF passed but the zip could not be updated** (locked, changed, check failed), the
  verified PDF is kept as `<name>.pdf` beside the zip, if that name is free, and the build
  exits 1.

The core exports `readZipReports`, `zipWithFile`, `checkZipUpdate` and `ZipReports`. The CLI
wiring is in `main.ts` (`addPdfToZip`).

**Measured on the owner's export** (in memory, nothing written, counts only): 75 reports read in
23 ms. All 75 entries are deflate, flags 2, made-by Unix, no extras, no descriptors, no comment.
An update round-trips through `checkZipUpdate`.

**The full build of that export** (owner: "proceed with the test build"; 2026-11-06). It ran on
a COPY in the git-ignored `local/skyciv-zip-test/`; the download itself is unchanged (hash
checked).
- **The first run FAILED verification** on a correct PDF: "blue" missing, from
  `\color{blue}{…}` in 2 reports (#66). The zip was left untouched, as designed.
- **After `a41961f` it PASSED:** 75 reports, 11,865 expressions, 0 failed; 553 pages, 4.68 MB
  (9.66 MB before the repack); 195 words, 1,176 numbers checked, 0 missing; 75/75 per report;
  75 diagrams intact.
- `pack.pdf` was added to the copy: 76 entries, read by .NET and `tar`.
- The copy is a second real check set: `cd local/skyciv-zip-test && bun ../../main.ts pack.zip`.

---

## ⚪ 17. A browser version — NOT A GOAL (owner, 2026-11-06: "Task 17 is not a goal")

Kept as a record of what was weighed. Task 16 is the integration.

The core already runs in a browser (`tests/browser_example.html`: bakes, guards, prints; measured
in headless Chrome the same day). What a usable web version needs: a folder / zip picker or drop
(task 16's input, unpacked with the browser's `DecompressionStream("deflate-raw")`); fetching and
inlining MathJax's fonts so the print matches the CLI's; then **"drop the saved PDF back in"** —
pdf.js and pdf-lib run in browsers and `compareAgainstPdf` / `compareEachReport` are pure core, so
the page can verify the print and offer the repacked PDF; hosting on GitHub Pages. Nothing leaves
the user's machine — which matters for client calculations. The one difference that stays: the
print dialog lets a user add headers or scaling; the page must say which settings to choose
(verification catches a lost value, not an added margin date). Roughly one fix-group of work.
