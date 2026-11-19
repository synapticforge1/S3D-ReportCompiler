# testing.md: what each review round added to the suite

Archived 2026-11-19 from `cmem/testing.md` (workspace letter H38), verbatim: the dated per-review blocks of § Test suite.
Read only when asked about past work. IDs are unchanged, so a search for one still finds it.

**2026-11-06, the review of `scripts/` and the workflows (owner: "fix all"; ledger #38–#43):**
34/34 on `bun test` (52 s) and `node --test` on Node 24.21 and the 22.18 floor; `compat` → patch;
both workflow files parse (`Bun.YAML`). `releaseClone` now puts its throwaway clone on `main`,
fetching from ITSELF as `origin` (so `origin/main` is its own `main`, whatever branch or detached
PR head the checkout is on) — the release tests would otherwise stop at the new branch check.
| test | asserts |
|---|---|
| release: only main (#38) | a `feature` branch tracking `origin/main` → exit 1 "Only main is released; HEAD is on "feature"", no commit, no tag; detached → "HEAD is detached"; main with no upstream → "it tracks nothing", no commit |
| sanitizer: unscrubbed fields, short values (#39) | invented values as before, plus: `Company:` / `Project ID:` / `Client:` filled → exit 1 "field(s) … hold a value this script does not scrub"; designer `QV` also after the heading → "still present: QV"; a Greek name likewise; a one-letter value → "too short to verify absent" |
| verify-release: arguments, grace, npm (#40, #41, #43) | `--wiat`, two versions, `v9.9.9` → 64; `--wait` with `rekorLogId: null` twice then `79` → exit 0 after "no provenance record yet (1/8)"; never → exit 1 after "(8/8)"; `--npm` against a fake npm: provenance → 0; none / 404 / 503 / another version's record → 4; npm never asked about an unattested version; a non-loopback `S3D_NPM_API` refused |
**Inverted:** HEAD's five scripts under the new tests → the three new tests fail (the old release
went on to ask JSR from a feature branch; the old verify-release took `--wiat` and exited 2; the
old sanitizer passed a filled Company, exit 0), the 8 existing release / sanitizer / compat tests
still pass. The sanitizer's other three cases, inverted one by one on a planted copy of the sample:
initials, Greek, one letter → old exit 0, new exit 1; the unplanted baseline exit 0 on both. On the
real sources of the 13 samples, `--check` still passes all 13 (10 words checked each, was 9; run
through a wrapper that masks the values). Not testable here: the two workflow changes (#38's
`publish.yml` half, #42) — they run on GitHub.

**2026-11-06, third pass — that day's own fixes reviewed cold (owner: "yes fix all"; ledger
#44–#47):** 34/34 on `bun test` (50 s) and `node --test` on Node 24.21 and 22.18; baked HTML
byte-identical on the samples (`7f283563…`) and the client set (`a19e5ad1…`); `compat` → patch.
Tests extended rather than added: the CSS-scoping test pins `:where(svg[data-s3d-scope="r9-"]) text`,
`svg:where([…])` for a rule on `svg`, and that no selector carries the scope's weight (#44), and
settles `body[class~="dark"]`, `html[lang|=en]` (on `lang="en-GB"`), `html[lang=fr]` and
`body[data-x]` (dropped), `body.dark:not(.y)` → `.rs9:not(.y)` (#46); the sanitizer test strips
every spacer and fills Company → "cannot read the project-details layout" (#45); the redactor test
plants three addresses (plain, `%40`, `@`) → `emails: 3 redacted, 0 left`, none echoed, and
keeps `noreply@anthropic.com`, `git@github.com`, `test@example.invalid`, `a@b.example`,
`@jrmarcum/…@1.1.7`, `checkout@v5` (#47). **Inverted:** the three changed files at HEAD → all three
tests fail; a direct print showed HEAD giving `svg[data-s3d-scope="r9-"] text` and
`.rs9[lang|=en] q … .rs9[lang=fr] s` with the `[class~=…]` rule gone. **Chrome, measured
(dump-dom of computed styles):** `font="31px serif"` on `<text>` → 16px (ignored); a bare `text`
rule under `svg[data-s3d-scope]` beats `.rs0 svg text` (red), under `:where(…)` it loses, as the
unscoped original does (green).
🔁 **Superseded 2026-11-07 (#72):** the confinement is gone — an SVG sheet that cannot be hoisted
exactly now MOVES to its report's scoped sheet; the CSS-scoping test § 5 pins that instead.

**2026-11-06, fourth pass (owner: "fix all"; ledger #48–#51):** 35/35 on `bun test` (52 s) and
`node --test` on Node 24.21 and 22.18; baked HTML byte-identical (`7f283563…`, `a19e5ad1…`);
`compat` → patch. New: "an empty path argument is rejected" (`""` first, `" "` second, run from a
folder holding a report → exit 1, nothing compiled; on HEAD's `main.ts` it COMPILED that report).
Extended: the CSS test settles `html[lang=EN-gb]` on `lang="en-GB"` (kept), `[lang="EN-GB" s]` and
`body[class="X DARK"]` (dropped) -- inverted by switching off only the caseless list: that
assertion, and only it, fails; the npm-fence case now stands a fake JSR answering "attested"
first and asserts "Rekor log ID: 81" and the fence's message. Chrome, measured: `html[lang=EN]`
matches `lang="en"`; `[lang=EN s]` and `body[class=DARK]` on `class="dark"` do not.

**2026-11-06, fifth pass (owner: "fix all three"; ledger #52–#54):** 37/37 on `bun test` (52 s) and
`node --test` on Node 24.21 and 22.18; baked HTML byte-identical (`7f283563…`, `a19e5ad1…`); the
CLI's `refs:` line unchanged now that it calls the core's guard. `compat` → **minor** (4 added).
New tests:
| test | asserts |
|---|---|
| a second batch starts clean (#52, #54) | in a FRESH process (the counters are module-level): batch 1 with the fallback delimiters and one bad expression, then a clean batch → `failed` 1 and `1 x "$"` without the reset, 0 / none / converted 1 / every audit counter 0 after `resetBakeState()`; `findBrokenReferences`: a correct bake `{references 2, unresolved 1, broken []}` (a source-dangling `#gone` excused), a sheet still naming `#g` → `[{report 0, target "g"}]`, report 0's dangling `#grad` does not excuse report 1's broken one |
| private paths stay ignored (#53) | `git check-ignore --no-index` on `local/…`, `cmem/local/…`, `cmem/transcript/…`, `CompiledPDF/` at three depths, `.mathjax-fonts/`, `dist/`; a committed sample is NOT ignored |
**Inverted:** HEAD's core, `main.ts` and `.gitignore` → both fail ("core.resetBakeState is not a
function"; "cmem/local/environment.md is NOT ignored"). **The browser example, live:** the bundle
built, `tests/` served on 127.0.0.1, the example loaded in headless Chrome in an iframe and Bake
clicked twice — both logs: 338 expressions, 0 failed, 2 loaders / gates / stray tokens, `refs: 0 id
reference(s), 0 broken`, the refused-`[...]` warning, "Ready to print." (without the reset the
second would have read 676 / 4).

**2026-11-06, sixth pass (owner: "fix all"; ledger #55):** 38/38 on `bun test` (54 s) and
`node --test` on Node 24.21 and 22.18; `compat` → still minor (no new export). New test "the bake
carries no event handlers or javascript: URLs" (benign inputs: an `onclick` attribute removed, a
`javascript:` link → `#`, another attribute's text and an ordinary link untouched; the assembled
document carries the CSP `<meta>`); fails on HEAD's core. ⚠️ **The baked hashes changed by design**,
by exactly one line: `cbdd3221…` (samples), `7d5664f6…` (client set); with the CSP line removed
they hash to `7f283563…` / `a19e5ad1…`; 100 and 380 pages, PASS. Measured in Chrome along the way:
`--blink-settings=scriptEnabled=false` makes `--print-to-pdf` write no file (exit 0, empty stderr),
so it is not used; the sandbox (no `--no-sandbox`) prints normally on Windows; a CSP `<meta>`
`script-src 'none'` blocks an inline handler and still prints.

**2026-11-06, seventh pass (owner: "yes"; ledger #56–#58):** 39/39 on `bun test` (58 s) and
`node --test` on Node 24.21 and 22.18; baked hashes unchanged (`cbdd3221…`, `7d5664f6…`); `compat`
→ minor (no new export). New test "maths fonts: cached per MathJax version, adopted once, kept
only if they are fonts", against a fake font server on 127.0.0.1 behind the test hook
`S3D_FONT_ORIGIN` (loopback only; it changes where bytes come from, never the cache key), each
build in a fresh working folder: (1) fetched → PASS, one cache folder naming `mathjax@3.2.2`, no flat
file; (2) a 200 `text/html` page → exit 1 "did not return a font (text/html", nothing cached; (3) a
flat cache of an earlier release with the server answering 500 → PASS, adopted, the flat files
gone; (4) a cached file overwritten with text → fetched again (`wOFF`). Inverted: HEAD's `main.ts`
→ fails at (1), "cached flat, without its version". The checkout's own cache migrated on its first
build, offline. #58 (the sandbox on Linux) has no test here: it needs a Linux non-root Chrome. **Measured on CI
the same day:** `1b1e498` pushed to the throwaway branch `ci/sandbox-check` (owner's choice over
pushing `main`); run 42306618122 on `ubuntu-latest`, 3 min 10 s, all four jobs green — sample build
31 s, `bun test` 67 s, `node --test` 76 s, runtime matrix 129 s, npm proof 112 s, each rendering
with Chrome, no `S3D_CHROME_NO_SANDBOX` in the workflows. Read from the public jobs API; the logs
need an authenticated admin request (`gh` absent here), so the build's own sandbox line was not
read. WSL was not a stand-in: no Chrome or runtimes, `sudo` needs a password, and its kernel lacks
`apparmor_restrict_unprivileged_userns`.

**2026-11-06, eighth pass (owner: "fix all"; ledger #59, #60):** 40/40 on `bun test` (59 s) and
`node --test` on Node 24.21 and 22.18; `compat` → minor (no new export). Baked hashes `cc563a15…`
(samples), `a3a6a2af…` (client set); without the CSP line, `7f283563…` / `a19e5ad1…`; 100 / 380
pages, PASS, no external-ref warning. New test "the render loads nothing from another host": the
sample with six references to a counting server on 127.0.0.1 (double-, single-, un-quoted `src`,
`srcset`, an inline-style and a head-sheet `url()`; every `<img>` `alt=""`, or Chrome's
broken-image icon counts as an image paint) → PASS, "6 external ref(s)", **0 requests**. Inverted
with only the policy put back to #55's: "the render made 5 request(s) to another host". Extended:
the font test refuses a download cut to half its size ("did not return a font (font/woff, …"); the
scripting test reads each CSP directive and that `<meta>` / `<base>` leave the body. HEAD's core +
`main.ts` under the new tests: all three fail.

**Same day, `--help` (owner: "add that to the '--help' section … so it is covered"):** REQUIREMENTS
now explains Chrome's sandbox and `S3D_CHROME_NO_SANDBOX=1`. New test "--help names every
environment variable the CLI reads": the list is main.ts's own `rt.env("…")` reads (the
`S3D_FONT_` test hooks excepted), plus `CHROME_PATH`; fails on the previous help ("does not mention
S3D_CHROME_NO_SANDBOX"). 41/41 on `bun test`; `compat` unchanged (the gate reads USAGE and
OPTIONS only).

**2026-11-06, the full-project review (owner: "All, in order A→E"; ledger #61–#65):** four
reviewers in parallel (core, CLI/runtime, release/CI, tests/config/docs); every finding re-run or
reasoned, fixed as its class. **44/44 on `bun test` and `node --test` on Node 26.12.0, 24.21.0 and
22.18.0** (Node 26 added to every local run and to CI: `ci.yml`'s `node-suite` matrix, 22.18 / 24 /
26). New tests: group A (maths-as-prose in every route, body boundary, quote-aware tags, CSS
mapping, labels per report, removal counts; and links — a symlinked report compiled, a broken link
or folder `*.html` refused, a hard-linked output refused); group C (settings, folder output, the
`.unverified.pdf` name, `runWithTimeout`); group D (multi-line notes scrubbed whole; POSIX paths,
entity emails, a looser residue check). Changed to match deliberate behaviour: unknown-delimiter
87 expressions / 270 TeX commands (no bare `$` in the fallback), `:hover` dropped and `:not(.y)`
settled. Every new test fails on the previous code. Baked hashes: byte-identical after A–D;
group E narrowed the CSP font source, so `37792fe3…` (samples) / `ae70d5e0…` (client set), the old
`7f283563…` / `a19e5ad1…` without that line. Group B's workflow changes: both files parse; the
pinning steps, run verbatim in bash against the real remote and JSR, 7/7 verdicts right; the 1.2.0
release gate passes from Git Bash (it failed: `tar: Cannot connect to C:`) and PowerShell. Not run
here: the workflows themselves (the next release), the Linux branch of the redactor test (CI).

**2026-11-06, zip input (roadmap task 16; owner: "Build it now"):** **48/48 on `bun test` and
`node --test` on Node 26.12, 24.21 and 22.18.** The 4 new tests use their own zip writer and
reader (`testZip` / `testUnzip`, built on `node:zlib`), never the tool's.
- **The PASS test** builds the 13 samples as a zip in the forms other tools write too: stored,
  data descriptors, a comment. The reports must come back byte-identical, the comment kept, nothing
  but `pack.html` beside the zip, and a re-run must replace the PDF rather than add a second.
- **A failing build** (the hidden-content control, zipped) leaves the zip byte-identical.
- **16 refused shapes** in the core, and through the CLI: a non-report entry, an output argument,
  `--no-verify`, a missing zip, and a user's own `pack.html` beside the zip.
- **The update check** catches a changed report byte, PDF byte or comment, a different PDF, and a
  dropped entry.

Inversions: with the CRC check off, or the every-byte check off, the refusal test fails.

By hand on the samples' zip, made by Windows `tar -a`: PASS on Bun, Deno and Node 22.18. The
result is read by Windows `tar` (14 entries) and .NET's `ZipFile` (14, sizes match). ⚠️ Feeding a
zip to `tar` on STDIN from a Bun `spawnSync` under-read it (73 entries; 75 by path). That was the
pipe, not the zip.

The owner's 75-report export: read in memory, counts only, 23 ms; a round trip through
`zipWithFile` / `checkZipUpdate` passed. Folder builds' baked HTML is unchanged (`37792fe3…`,
`ae70d5e0…`).

**2026-11-06, the full build of the 75-report export, on a copy in `local/skyciv-zip-test/`
(owner: "proceed with the test build"):**
- **The first run FAILED:** 1 word missing ("blue"), in reports 73 and 74 (#66).
- **Diagnosed without printing client values:** tokens were shown only if they also occur in
  the public samples, everything else masked. The cause, `\color{blue}{…}`, is a TeX setting the
  verification expected to print.
- **After `a41961f`:** PASS, 75/75 per report, 195 words / 1,176 numbers (the 196th was "blue");
  `pack.pdf` added, 76 entries read by .NET and `tar`. The 48-report set is unchanged
  (174 / 660, `ae70d5e0…`).
- **The suite:** 49/49 on Bun and Node 26.12 / 24.21 / 22.18. The new test fails on the
  previous code.

**2026-11-06, CI after the push** (owner: "commit and push"; `57b2e23..39f2f16`, 27 commits):
run 42327019979, **all 7 jobs green**:
- types / format / lint / compat / build;
- the JSR checks (Deno);
- the runtime matrix;
- the npm tarball proof;
- the new `node-suite` on Node 26, 24 and 22.18.

What that run covered for the first time:
- the reworked `ci.yml` (the node-suite matrix, the concurrency group);
- the full-review fixes, the zip code and #66 on Linux, including the Linux branch of the
  redactor test that "Not run here" above left to CI.

Still unexercised: `publish.yml`, until the next release. Read via GitHub's public API
(`curl`), since `gh` is not installed on this machine.

**2026-11-06, the second full-project review (owner: "All, in order A→E"; #67–#71):** 52/52 on
`bun test` and on Node 26.12 / 24.21 / 22.18. Five new tests, one per group, each run against the
previous code and failing there (A on cells typeset as one expression; B on compiling over the
user's zip; C on path tails; D on the unexported type; E's reader self-check). The bar was raised
to THREE real sets, all byte-identical after every group: samples `37792fe3…`, the 48-report set
`ae70d5e0…`, the 75-report zip `8c1a8887…` (counts 173/342, 174/660, 195/1,176). The sanitizer
was checked on the real 48 with values stripped (48 accepted), never printing one.
- The 75-report copy in `local/skyciv-zip-test/` was refreshed from the untouched download: its
  old `pack.pdf` predates the own-PDF mark and is now (rightly) refused as a user's file.
- fnm v1.39.0's digest was matched against GitHub's published one before it was pinned in CI.
- ✅ Since run: the Linux branches, on the push of `68ef6e0` (CI 42337350760, all 7 jobs); and
  `publish.yml`'s new jobs, in the 1.2.0 release (run 42337922832: the SemVer gate on the runner,
  `record`, `finalize`, all green).
- ⚠️ Probing: a temporary debug copy of the redactor's patterns went stale and misled one run (a
  residue hit read from an old pattern) — re-read the real script's output, not a copy's.

**2026-11-07, the third full-project review (owner: "Fix all in the order you showed from A -
E"; #72–#76):** 59/59 on `bun test`; Node's legs left to CI (no Node on this shell's PATH).
Seven new tests — "review 3, group A" (11 sections), "group B" (4), "group C: the redactor …",
"every committed sample holds the sanitizer's placeholders", "group E: the README's first run" and
"… every graphics and structure check can fail", "release: an unknown argument is refused" — and
extensions (the entity control's byte-for-byte bake, the sanitizer's entity and row-shape cases,
`verify-release --github`, the workflow assertions). **Inverted section by section:** a scratch
script cut each numbered section into its own copy of the test and ran it in a worktree of the
previous commit; every section failed there. The entity check was inverted by swapping `lt`/`gt`
in the bake's table (passed before, fails now); the committed-samples test by planting a filled
Company in a worktree's sample. All three real sets byte-identical after every group (a
harness that prints only hashes and allow-listed count lines, never report text).
- ⚠️ **`git worktree remove --force` on a worktree holding a `node_modules` JUNCTION:** git left
  the junction, so the repo's `node_modules` survived (checked: `bun install --frozen-lockfile`
  → "no changes") — but remove the link FIRST (`[IO.Directory]::Delete(<junction>)`, not
  recursive), then the worktree.
- ⚠️ **`bun fmt` skips git-ignored files**, so the format canary's planted files must NOT be
  ignored (measured: "4 problem(s)"); Biome lints them regardless.
- ⚠️ **Not testable here:** Chrome writing a PDF and exiting non-zero. Bun and Node, as a
  stand-in "Chrome", fail on its `file://` entry point before a preload (`BUN_OPTIONS=--preload`)
  runs (measured).
- ✅ Since run: the pinned actions, review 3 on Linux and Node 22.18 / 24 / 26 (CI 42397073197 on
  `847de49`, all 7 jobs); `publish.yml`'s new job graph in the 1.3.0 release (run 42397518507,
  every job green).

**2026-11-07, the fourth full-project review (owner: "A-E", then "yes" to testing what was left
reasoned; #77–#81):** 63 tests — 62 pass and 1 skip on Windows (`bun test`); the skipped one
passes in WSL. New: ".htm is refused by name", "review 4, groups A and B" (9 sections), "group E:
the runtime's exits, with a stand-in Chrome (POSIX)", "group E: the browser example, driven in
Chrome"; extended: the sanitizer's row and residue cases, the committed-samples test (row numbers
only), the redactor's cases, `verify-release --github` (a path-aware fake GitHub), the release's
test-hook fence, the workflow assertions (read as code). **Inverted** four ways, each against the
code before its fix: the A/B sections by the section-cutting script in a worktree; the sanitizer,
the redactor and the workflow by probe scripts (each case planted, run on both trees); the POSIX
test by reverting each fix alone in a WSL clone (the interrupt section reached by cutting
sections 2–3 from a copy); the browser test by removing each of the page's three fixes in turn.
All three real sets byte-identical (`37792fe3…`, `ae70d5e0…`, `8c1a8887…`); the real 48 still pass
the sanitizer; the local transcripts' residue counts equal or lower under the new redactor.
- **A stand-in "Chrome" works on POSIX:** a script whose shebang is the test runtime's own
  `process.execPath`, given Chrome's arguments (it writes the PDF `--print-to-pdf=` names, or
  none, or exits 1). Windows does not honour a shebang, so that test is skipped there — the
  "not testable here" above holds for Windows only.
- **Slowing a rename for an interrupt test:** a preload (`bun --preload`, `node --require`) that
  wraps `require("node:fs/promises").rename` — the runtime's `import("node:fs/promises")` sees it
  (measured on Bun; Node through `syncBuiltinESMExports()`) — marks the start in a file, waits 3 s.
- **Driving the browser example:** headless Chrome with `--remote-debugging-port=0`; the port read
  from `DevToolsActivePort` in its profile; a page target's WebSocket (global in Bun and Node 22+);
  wait for `document.readyState === "complete"` before clicking — the log's static "Ready." is
  there before the module has run (the first try clicked too early).
- **Running the POSIX test locally:** in WSL, a scratch clone in the WSL home (not `/mnt/…`: the
  checkout's `node_modules` holds the Windows build of the native canvas), `bun install
  --frozen-lockfile`, the checkout's `.mathjax-fonts/` copied in, then `bun test … -t "stand-in
  Chrome"`. WSL's Bun matches the project's (1.4.4 since 2026-11-07; it had been 1.4.3). Delete
  the clone after.
- ⚠️ The review-3 stderr test detaches its helper into its own process group, so it cannot see a
  group reap: the new test's helper shares the parent's group, as Chrome's helpers do.

**2026-11-07/08, the fifth full-project review (owner: "I agree fix all", then "fix D first, then
do E and C"; #82–#86):** 68 tests — 66 pass and 2 skip on Windows (the two POSIX ones, which pass
in WSL). The first review whose fix CHANGED the real sets' baked HTML (A's restored selector
weight), proved two ways with scratch harnesses that print only counts: the new bake equals the old
once the weight-only `:is(…, *)` selectors are removed (all three sets), and the PDFs carry the same
text at the same positions on every page (pdf.js text items with x, y; samples 100/100, the 48 set
380/380). `bun run runtimes`: six runtimes, one document, `487321f24fb9`.
- ⚠️ **Run the WHOLE suite after a group whose output changes.** Group A was committed after its
  own tests and their neighbours passed; two older tests that pinned scoped selector strings broke
  and were found only by the full run in E. They now compare with the weight-only selectors removed
  (what a selector matches), leaving weight to the review-5 test.
- ⚠️ **Process-wide state needs a fresh process in a test.** MathJax's `\unicode` font cache lives
  as long as the process: a review-5 section poisoned a later review-4 check. Both now bake their
  `\unicode` reports in a child process (`unicodeFailures`).
- **WSL from this shell:** pass shell text as a FILE (`wsl.exe -- bash <script>`), run from
  PowerShell — Git Bash rewrites `/mnt/c/…` arguments into Windows paths, and `bash -lc '…$VAR…'`
  lost its variables on the way.
- **Inverting a workflow gate:** plant each regression into the REAL `publish.yml` (restored in a
  `finally`) and run the workflow test — 11 regressions, each fails it, the real file passes.
- **A privacy rule is measured on the local transcripts before it is kept** (counts only, the
  redactor's own `--check`, old against new): the first email rule redacted `"\"@scope/…"` and
  `@v5` (74 false residues), and the first name-learning pass read prose between slashes (path
  residues 44 → 106). Each was found this way, narrowed, and re-measured. To see WHAT matched
  without seeing the text, print shapes (letters → `a`/`A`, digits → `9`).
- ⚠️ **Writing test input from the shell mangles backslashes**: `printf '%s\\acme'` and a
  `bun -e` template both turned `\a` into an escape, and the redactor looked broken twice. Write
  inputs from a script file (`writeFileSync`), never through a shell string.
- **A redactor test that depends on the disk** builds its folder under the test's work directory
  and writes the path with the platform's separator, so it runs on Windows and on Linux CI — the
  first version passed on Windows and failed in WSL (the POSIX rule lacked the learned names).

**2026-11-08, the class-by-class review, class B (roadmap task 18; #87 `3555326`, #88 `8b5a113`):**
71 tests, all passing on Bun on Windows (the 2 POSIX ones skip there). Three class-B tests: "class B:
the verification checks values whole" (9 sections), "class B, iteration 2: lists, signs, units,
split tokens, printed names" (6), and the end-to-end "what the PDF draws" (8 planted cases: transparent,
white, faint and near-white text; a cut, a clipped and a tiny image; a diagram title with no caption).
All three real sets PASS with the baked HTML unchanged (`487321f2…`, `da92578d…`, `f0922226…`);
`bun run runtimes` one document, `487321f24fb9`.
- **Inverting a multi-section unit test:** a scratch harness runs each numbered `  // N.` section
  ALONE inside a worktree of the commit before (`git worktree add --detach <dir> HEAD`, its
  `node_modules` a junction to the repo's). One failing assertion stops a test, so a whole-test run
  proves only the first section. Every section must fail there. The end-to-end cases are inverted by
  running the old `main.ts` on the planted folders: all exit 0 there. To remove the worktree, delete
  the junction first (`[System.IO.Directory]::Delete`), then `git worktree remove --force`;
  `git -C <worktree>` from this shell trips git's ownership check (a temp folder), so use the main
  repo.
- **Vacuity, the check that started class B:** for each source token, delete every occurrence from
  the PDF text and see whether it is still "found". It was 30% of the samples' numbers and 15% of
  the words before #87, then 1% and 0%. ⚠️ It deletes EVERY occurrence; re-check 2 found that
  deleting ONE still passes 64% of member_0's numbers (task 18 item 8). Measure both ways.
- **What Chrome writes, measured from its PDFs (pdf.js 6 operator lists):**
  - text is drawn at alpha 0.87;
  - `opacity` is a transparency group (`beginGroup`) whose `ca` multiplies the alpha set inside it;
  - a clip arrives as `clip`/`eoClip` BEFORE the `constructPath` it clips to, whose `args[2]` is
    the path's min/max box in the space of the current transform;
  - an image is the unit square under the transform;
  - the PDFs are TAGGED (Table/TR/TD/TH/H3 in the structure tree, marked content on the text);
  - `page.objs.get(name)` gives an image's decoded pixels (the sample's: 370×400 RGB).
  Separate numbers on one line stand at least 4.3 text heights apart in the samples' PDF and the
  48 set's (a counts-only probe).
- ⚠️ A test helper that builds a report with a heading also expects the heading's own tokens (the
  "1" of `MEMBER # 1`): leave the heading out when asserting a body's exact numbers.
- ⚠️ **`$'` in a `String.replace` replacement string is "the text after the match"** (and `$&`,
  `` $` ``, `$1` are special too): planting a config with `['$','$']` wrote garbage into the
  report, and the test looked like a code bug. Plant with a FUNCTION replacement.
- The section-inversion harness must find a test whose name the formatter put on its own line
  (`test(\n  "…"`), and its end at the next top-level `test(` — a formatted multi-argument test
  closes with `},\n);`, not `});`. The first version split the wrong test and reported sections
  that do not exist.
- **Measure vacuity by deleting ONE occurrence**, not all (task 18 group 1): it found the counting
  asymmetries — a surplus on the PDF side hides a lost occurrence.

⚠️ **CI caught what Windows could not (2026-11-05, the first v1.1.6 tag):** the redactor test failed
on GitHub's Ubuntu runner — `fromHere` only knew a DRIVE-letter checkout, so a POSIX checkout
(`/home/…`), its Claude slug (`-home-…`) and POSIX homes passed through untouched. The CI gate in
`publish.yml` refused ("CI passed on the tagged commit": failure), so NOTHING was published; the
tag was moved to the fix by the release's designed retry. Reproduced with no runner log (it needs
auth; no `gh` here) by running the Chrome-free tests in WSL Ubuntu (Bun, no Chrome) on a clone.
Fixed: POSIX checkouts and `/home/<u>`, `/Users/<u>`, `/root` homes and their slugs; the test now
also asserts the checkout path itself is gone. 7/7 Chrome-free tests on WSL, 24/24 on Windows.
🔁 Then the retry itself was refused: `compat.ts release 1.1.6` took the newest tag, the stranded
`v1.1.6`, as its baseline ("1.1.6 is not above v1.1.6") — the gate never allowed for the retry
`publish.ts` supports by design. Fixed: a release excludes its own tag (`git describe --exclude
v<X.Y.Z>`); measured: `release 1.1.6` → vs v1.1.5, patch, samples PASS, exit 0; `release 1.1.5` →
still refused.

**Same day, the review of the 1.1.6 range (owner: "If it is possible, we will need a fix for any
future reports where that possible becomes probable"):** 28/28 on `bun test`, `node --test` on Node
24.21 and the 22.18 floor; the 11 Chrome-free tests 11/11 on Linux (WSL); the 48-report client set
unchanged (8286 / 0 failed, 0 missing, 48/48, 380 pages). New: the **MathJax limitations** test
(roadmap task 8 § "MathJax limitations", M1–M4 — 🔒 owner: re-check on every MathJax update) calls
`bakeBody`/`bakeStyle` directly, no Chrome; it also pins prose `id = 4` staying prose (attributes
are read inside tags only, after the maths is converted) and a `data-type` `<style>` being read.
Release tests: a file staged beforehand stays staged and is refused, not committed as the bump
(pathspec commit; the undo is now `--soft` + unstage the three, which keeps the developer's
index); the JSR test hook is loopback-only, announced, and can never let a release tag; a timing
typo is an error; a reset that fails vs an index that cannot be unstaged are reported separately;
`compat.ts release <tagged>` refuses without `--unpublished`. **Inverted:** no rethrowing
`formatError` → "unknown entity passed"; attributes read over the whole text → "prose was
rewritten as an attribute". MathJax's error boxes, measured: 0 `<mjx-merror` elements in both
bakes (the 1 match each was the stylesheet rule).

⚠️ **The page count is layout, not content — never pin it.** The first CI run (40733829258) failed
`/^100 pages,/`: GitHub's Ubuntu runner renders the 13 samples to **103** pages (Windows: 100),
with everything else identical — 0 missing, 13/13 per report, PASS. Fonts differ by platform. The
suite asserts ≥ 1 page per report instead; conservation is what the counts of words, numbers,
images and diagrams prove.

⚠️ The sample is ALREADY sanitized, so its fields hold the placeholders the sanitizer writes —
re-sanitizing it reports them as leaks (7 "survivors"). The fixture plants invented values instead.

Measured 2026-10-28: 13/13 on `bun test` (≈20 s), `node --test` on Node 24 and the 22.18 floor.
**Inverted 2026-10-28** (one-time harness: mutate, run `bun test`, require exactly the intended test
to fail): guard disabled → the two guard tests; set-wide conservation never missing → hidden content;
per-report check disabled → the two-copy row; unknown flags accepted → unknown flag; stale PDF not
removed → stale PDF; positional paths not made absolute → relative paths; sanitizer ignoring the
leaked word → both sanitizer tests (the clean one pins its token count); an unrun control file → the
coverage test. 8/8. NOT inverted: the positive controls' baselines and the `$$` assertion. (First
run: all 8 caught but the harness read 0 passes — `bun test` prints only failures off a TTY.)
CI runs both runners in its checks job. The format scope names `tests/build.test.ts` as a FILE;
the format canary still refuses `tests` or any other path under it.

🔁 Corrected 2026-10-28: control 3 above was recorded as 172 words / 119 numbers missing; the
current samples give **171 / 114** (measured by this suite).

