# Testing

## The build tests itself

The build verifies its own output and **exits non-zero** if the PDF no longer reproduces its
sources, so running the build *is* the test. Since 2026-10-28 `bun run test` runs it, and every
control, as a `node:test` suite (§ Test suite below).

Defaults resolve from the **working directory**, so which folder you stand in selects the input set:

```bash
bun run check                            # types (bun check)
bun run test                             # the samples + every control (bun test; test:node = node --test)
bun run format:check                     # formatting (main.ts, src/, scripts/) + its canary
bun run lint                             # Biome + its canary
bun run runtimes                         # every Node LTS line and Bun — one baked document
bun run compat                           # api-surface.txt current? floor since the last tag
bun run npm:build && bun run npm:prove   # the npm tarball, installed and run
bun run verify-release <version>         # after a release: did it get an attestation?

cd tests && bun ../main.ts               # the 13 committed samples
cd local && bun ../main.ts               # the real 48-report set
cd local && node ../main.ts              # same, on Node
```

**On GitHub, not here: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)**, on every push
and PR (🔒 owner, 2026-10-28: no Deno on this machine). It repeats the checks above from a bare
checkout (`bun install --frozen-lockfile`; `npm ci` until 2026-10-28), and runs what needs Deno, installed per run by `setup-deno`: `deno check`,
`deno doc --lint src/*.ts` (docs coverage, a scored JSR criterion), `deno check --doc src/*.ts` (the
JSDoc examples compile), `deno publish --dry-run` (JSR validation, slow types included), and the
Deno legs of `runtimes` and `npm:prove` (`--deno`; `--install-node` installs the Node lines with
fnm). Locally those two scripts print `· deno: runs in CI`, so the gap is never silent.

### ⚠️ A dry run in your working tree is not a rehearsal for CI

`deno publish --dry-run` passes locally because `node_modules` is already there from development. CI
starts from a bare checkout. To actually rehearse the release, clone into a temp directory and run it
with nothing installed:

```bash
git clone <repo> /tmp/cirepro && cd /tmp/cirepro
deno publish --dry-run          # must fail without deps — that IS the CI condition
bun install --frozen-lockfile && deno publish --dry-run  # must succeed
```

(That needs Deno — on this machine it runs in CI only; the JSR job does exactly this.)
This is how bug #23 was found, one failed release too late: the workflow had no `npm ci`, so
`deno publish` could not resolve `mathjax-full` under `"nodeModulesDir": "manual"`.

Expected on the 13-report sample set (`tests/`):

```
100 pages, 0.99 MB
math:     2203 expressions, 0 failed
checked:  173 words, 342 numbers from 13 source(s)
missing:  0 word(s), 0 number(s)
graphics: 13 image paint(s), 13 expected; 13 diagram(s) checked, intact
PASS
```

Expected on the 48-report set:

```
380 pages, 3.35 MB
math:     8286 expressions, 0 failed
missing:  0 word(s), 0 number(s)
graphics: 48 image paint(s), 48 expected; 48 diagram(s) checked, intact
PASS
```

### ⚠️ Do not compare PDFs by hash

Chrome stamps its own render time into `/CreationDate` and `/ModDate`, so **two consecutive builds of
identical input produce different bytes** — on the same runtime. A hash comparison across runtimes
therefore proves nothing, and an earlier "byte-identical output on all three runtimes" note in
[INDEX.md](INDEX.md) was comparing the wrong artifact.

Compare the **baked HTML** instead. It is deterministic, it is what the three runtimes actually
produce differently or not, and Chrome is the same binary in all three cases:

```bash
cd local
for r in "deno run -A" "node" "bun run"; do
  $r ../main.ts --no-verify >/dev/null 2>&1
  sha256sum CompiledPDF/combined_report.html   # kept by default now
done
# all three: a19e5ad15e3f9c7588bd1a6a412dde39f18658b239043b2c30337fb7ecfc6277
```

## ⚠️ Negative controls — a check that cannot fail proves nothing

Every one of these found a real bug or validated a real guard. Reproduce them by building a small input
folder and pointing the build at it.

### 1. Unknown delimiter → the guard must refuse

Remove the `tex2jax` config and wrap display maths in `@@..@@`.

```
math:     97 expressions, 0 failed          ← note: "0 failed"
ERROR: unrendered mathematics reached the baked document.
  250 TeX command(s): \lambda, \dfrac, \max, \sqrt, \frac, \rightarrow
exit=1     pdf produced: False
```

⚠️ **The converter reported `0 failed` while 250 TeX commands survived.** That is the whole point: an
unmatched delimiter never errors.

### 2. Custom delimiters declared in the config → must work

Rewrite the config to declare `@@..@@` (display) and `%%..%%` (inline) and rewrite the body to match.
Expect output **identical to the baseline**: 169 expressions, 8 pages, 9,486 characters extracted.

⚠️ Do **not** use `{{..}}` for this test. `}}` occurs constantly inside LaTeX (`\frac{E_{s}}{F_{y}}`),
so expressions truncate at the first inner `}}`. That is a pathological delimiter choice which would
break MathJax too — and the guard correctly caught it (`exit=1`, no PDF).

### 3. Hidden content → conservation must fail

Inject `#calculations { display: none; }` into a **single** report's stylesheet — `display:none` is
deliberately *not* neutralised by the bake step, so only the verification can catch it.

```
missing:  172 word(s), 119 number(s)
latex:    0 surviving, 0/1 reports, 1 blank page(s)
VERIFICATION FAILED
exit=1
```

⚠️ **Use one report, not two copies** — for THIS control, which targets the set-wide check. With two
copies a duplicate report supplies the tokens the hidden one lost, and the set-wide check passes;
discovering that is how the set-union limit came to light. Since 2026-10-28 the per-report check
catches the two-copy case too: `control-hidden-row-two-reports` now FAILS on its own (verification.md
§ limit 1, closed).

⚠️ **This control is also how bug #15 was found.** The first attempt passed because the injected rule
was itself being dropped — by the stray-semicolon defect in the CSS scoper. The control failing to fail
was the symptom.

### 4. Failed render with a stale PDF present → must not report success

Point `CHROME_PATH` at a stub binary that produces nothing, with a previous `combined_report.pdf` in
place.

```
error: Chrome produced no PDF.
exit=1     stale PDF still present: False
```

Before the fix this printed `Created … 380 pages, 3.35 MB` — a silent stale success.

### 5. Unknown flag → must be rejected

```
$ deno run -A main.ts --no-optimise
Unknown option(s): --no-optimise
Supported: --keep-html, --no-keep-html, --no-optimize, --no-verify, --version, --help
exit=1
```

### 7. Relative output path → must still produce a PDF (regression, bug #22)

```bash
cd /tmp/ctl && deno run -A <repo>/main.ts "reports" "out/custom-name.pdf"
# must create out/custom-name.pdf AND out/custom-name.html
```

⚠️ Chrome does not resolve a relative `--print-to-pdf` and **exits 0 after failing to write**. Both
positional paths are now resolved to absolute before use. The defaults never exercised this, because
they are built from an absolute `rt.cwd()` — only the CLI override form could reach it.

### 6. Sanitizer residue check → a leaked term must fail

`scripts/sanitize-report.ts` rewrites the Project Name / Designer / Project Notes fields, then searches
its own output for every word it removed. Confirm it can fail by injecting the project name somewhere
the field rewrite will not reach:

```bash
# copy a report, append the real project name to its MEMBER heading, then:
bun scripts/sanitize-report.ts --check negctl_report.html
# ❌ negctl_report.html: 2 removed term(s) still present: …
# exit=1
```

⚠️ Match on **word boundaries, not substrings**. A substring test flags "Inc" inside "Including",
and quieting those false positives means widening the ignore list until the check can no longer fail.
The ignore list currently holds exactly one word (`design`), and every entry in it must be a word
*observed* surviving for an innocent reason — not one guessed at in advance.

## Test suite — `bun run test` / `bun run test:node` (bun-migration step 5, 2026-10-28)

[`tests/build.test.ts`](../tests/build.test.ts): `node:test` + `node:assert` only, so ONE file runs on
`bun test` and `node --test` (`--test-concurrency=1`; every case renders with Chrome). Each case
builds with the runtime running the test (`process.execPath`) and asserts the exit code AND its
reason. It automates the negative controls above and `tests/controls/README.md`:

| test | asserts |
|---|---|
| the 13 samples | exit 0; 2203 expressions, 0 failed; ≥ 1 page per report (never an exact count — below); 0 missing; per-report 13/13; 13 images, 13 diagrams; 0 LaTeX, 0 blank; PASS |
| unknown delimiter | exit 1; "97 expressions, 0 failed" AND the guard's error, 250 TeX commands; never verifies; no PDF |
| colliding `{{..}}` | exit 1; the guard's error, 205 TeX commands; no PDF |
| hidden content, one report | exit 1; 171 words / 114 numbers missing; 1 blank page; "content missing from the PDF"; **no new `compiled_reports_*` temp profile left** (2026-11-05) |
| a row hidden in the 2nd of two copies | exit 1; set-wide **0 missing** (pinned — the union limit), per-report `b_report.html: 5 word(s) … internal, forces, absolute, force, bending`; NOT "missing from the PDF" |
| custom delimiters declared | exit 0; 169 expressions; ≥ 1 page; PASS |
| `$$..$$` in a second report | exit 0; 338 expressions; the two-delimiter-set warning; per-report 2/2; no `$$` in the bake |
| `&lt;` / `&gt;` inside expressions (2026-11-05) | exit 0; 169 expressions, 0 failed (the same report as custom delimiters); PASS |
| SVG `url(#id)` references (2026-11-05) | exit 0; PASS; the bake holds `url(#r0-ctl-grad)`, `url(#r0-ctl-clip)`, `url('#r0-ctl-grad')`, `marker-end` → `r0-ctl-arrow`, no old id, and `url(#ctl-undefined)` untouched. Reads the bake: verification cannot see a lost paint server. 2026-11-06: `title="see id=ctl-t"` untouched, `2 unresolved, 0 broken` (#36) |
| `<style type="text/css">`, a quoted SVG `font-family`, a `media="print"` block (2026-11-05) | exit 0; the audit line identical to custom delimiters' (1 loader, 1 gate, 3 height, 0 @page, 1 stray token); PASS; no hoist warning; the bake has `font-family="&quot;Arial&quot;, sans-serif"`, `@media print { … }`, no `<style>` left in the SVG |
| the redactor (2026-11-05) | a fixture built at run time from the checkout's own path: checkout (`\`, `\\`, `/`), home, other-drive and slug paths all replaced, a URL kept, exit 0; a username outside any path → exit 1 "not safe to publish", and `--check` exits 1 too |
| `verify-release`, fake JSR (2026-11-05) | attested → 0; attested + yanked → 3; **unattested + yanked → 1** (provenance first); unattested → 1; 404 → 2 "not on JSR"; 503 → 2 "Could not ask … not a verdict"; a server that never answers → 2 at the 500 ms test timeout; `--wait` over two 503s then attested → 0, "could not ask JSR (1/60): HTTP 503 — retrying", 3 requests |
| release refuses when JSR cannot answer (2026-11-05) | throwaway clone (package.json one version behind, push URL not a remote), fake JSR 503 → exit 1 "Could not ask JSR … (HTTP 503)", "undid the local bump", HEAD back where it was, nothing tagged |
| release undo that cannot run (2026-11-05) | `.git/index.lock` written while JSR is asked → "could NOT undo … do not push it", the bump commit remains; a commit made while JSR is asked → "HEAD is not the bump commit any more; left as is", that commit untouched |
| output named like a report, other folder (2026-11-05) | exit 0; 1 report compiled; no `skipped:` |
| output onto a source report (2026-11-05) | `d_report.pdf`, `d_report.html`, `D_REPORT.pdf` into the input folder: each exit 1, "would overwrite a source report", nothing compiled, the report byte-identical |
| a previous bake in the input folder (2026-11-05) | second run exit 0; 1 report; `skipped: 1 tool-owned` (recognised by content, not name) |
| unknown flag | exit 1; `Unknown option(s): --no-optimise`; nothing compiled |
| stale PDF, a "Chrome" that writes nothing | non-zero; "Chrome produced no PDF"; no `Created`; the stale PDF is gone (the stub is the test's own runtime as `CHROME_PATH`) |
| relative input/output paths (#22) | exit 0; `out/custom-name.pdf` and `.html` exist |
| sanitizer, clean / leaked | invented values planted in all three fields of a sample under a temp `local/` (no client data): ✓ 6 tokens verified absent / ❌ `1 removed term(s) still present: Zorblax` |
| every `tests/controls/control-*.ts` is exercised | "a run of nothing is not a pass" |

**2026-11-05 (owner: "yes" to the code review's fixes 1–4 and 7):** 18/18 on `bun test` (31 s),
`node --test` on Node 24.21 and the 22.18 floor. ⚠️ Node here comes from **fnm**, whose PATH is
per-shell: a fresh shell has no `node`, and under `bun run` the name falls to Bun's own shim, which
fails on `node:test`'s `after()` ("Cannot use afterAll() outside of the test runner"). That is the
shell, not the suite: load fnm first (`fnm env --shell powershell | Out-String | Invoke-Expression`,
then `fnm use <version>`). Node 24's default reporter prints no `# tests` line; `--test-reporter=tap`
does.
Run against the pre-fix `main.ts` and `report_core.ts` with the new tests kept: exactly the five
new checks failed (temp profile, entities, SVG references, named-like-report, overwrite), 13 passed.
The previous-bake test passes on both, by design: it guards the content-based skip that replaced
the name-based one.

**Same day, the review's remaining six (owner: "fix items 1-6"):** 20/20 on `bun test` and on
`node --test` (Node 24.21). Against the pre-fix `report_core.ts`: the style, entity and SVG tests
fail — the SVG one now by the build's own new guard ("the bake broke id references that resolved
in the sources", main.ts, a distinct-unresolved-target count against the sources), so a dangling
reference fails the BUILD, not only the test. The 13 samples hold 0 id references, so only that
control exercises the guard. `publish.ts`'s undo, proved in a throwaway clone with an unusable push
URL: package.json one version behind → the bump commit made → "ALREADY published on JSR" → "undid
the local bump commit", HEAD unchanged, package.json left modified. `verify-release`: 1.1.5 →
exit 0 (Rekor `3547861777`), 9.9.9 → exit 2; the yanked (exit 3) and HTTP-error branches are
unexercised (no yanked version, no outage to hand).

**Same day, the review of those fixes (owner: "fix the 10 issues"):** 21/21 on `bun test` and
`node --test` (Node 24.21). New coverage: the SVG control adds `url(&quot;#id&quot;)` (how a
browser serializes a saved inline style), a `data-id` (must stay untouched — `\bid=` used to
match it), and an unquoted `id=`/`href=` pair, and pins the guard's line (`1 unresolved, 0 broken
by the bake`); the previous-bake test adds a run under ANOTHER output name (the old bake is
skipped and named, not compiled as a second copy); a new test refuses an output reached through a
junction / directory symlink; the redactor test adds Git Bash `/d/…`, WSL `/mnt/d/…`, a folder
name with spaces, and UNC paths single and JSON-escaped; the `D_REPORT.pdf` case runs on Windows
only (it is the same file only where the filesystem folds case). **Inverted** (one fix reverted at
a time, then restored): no entity quotes → the BUILD fails, "broken: ctl-clip"; name-only bake
skip → the previous-bake test; string paths instead of real paths → the link test. The guard's
set comparison (vs the old count) was not inverted in that round — 🔁 **done the same day, next
round:** the SVG control now plants a reference already dangling in the source INSIDE the loading
spinner the bake removes; with the bake broken on purpose (no entity quotes), the old COUNT guard
let the build PASS (only the test's own read of the bake failed), the SET guard failed the build,
"broken: ctl-clip". `&nbsp;` in maths now decodes to U+00A0, measured with a one-time MathJax 3.2.2 probe: maths
mode renders it like a space, `\text{A  B}` does not (two U+00A0 kept, two spaces collapse). The
undo in `publish.ts` re-proved in a throwaway clone; its pre-flight now REFUSES when JSR cannot be
asked (it used to continue).

**Same day, the untested items (owner: "run tests on the yet untested items"):** 24/24 on `bun
test`, `node --test` on Node 24.21 and the 22.18 floor. The release scripts read the JSR API's base
URL from `S3D_JSR_API` (and `S3D_JSR_TIMEOUT_MS`, `S3D_JSR_RETRY_MS`) — test hooks, unset in real
use — so a fake JSR on 127.0.0.1 drives every verdict (rows above). The fake runs in the test's own
process, so those tests spawn asynchronously; `spawnSync` would block the server's event loop.
Still unexercised: nothing in the three review rounds.

**2026-11-06, the fourth review (owner: "yes" to its seven fixes; ledger #31–#37 in
[known-issues.md](known-issues.md)):** 31/31 on `bun test` (47 s) and `node --test` on Node 24.21
and the 22.18 floor. **Baked HTML byte-identical** before and after on the 13 samples (sha256
`7f283563…20d8`) and the 48-report client set (`a19e5ad1…6277`, the roadmap's figure); the client
set's verification lines unchanged. A survey first found NONE of the seven constructs in either
set (bare `html`/`body` selectors only, no body `<style>`, the one SVG sheet is
`text { font-family: sans-serif; }`, no `id=` inside a value, no entity beyond the six markup
ones), so identity was the bar. `bun run compat`: 0 removed / changed / added → patch. New tests:
| test | asserts |
|---|---|
| a third positional argument (#32) | exit 1; `Too many arguments (3)`, each argument listed, the quoting hint; nothing compiled |
| a previous PDF that cannot be removed (#31) | a REAL one-page PDF held open the way a viewer holds it (Windows: a PowerShell child, `FileShare.Read`; POSIX: the folder `chmod 555`, skipped as root); the test runtime as "Chrome", `--no-optimize --no-verify` → exit 1 "Could not remove the previous PDF", no `Created`, the old PDF byte-identical |
| CSS scoping, SVG sheets, attributes, entities (#33–#37) | `core` imported, no render: `html body p` → `.rs9 p`; `body + p` dropped; `p:not(.a, .b)` one selector; `body.dark` settled against `<body class="x dark">` (`body.light` dropped, `:hover` kept on the wrapper); a body `<style>` in the scoped sheet and out of the fragment; an SVG `@media` rule and a `font` shorthand NOT hoisted, kept under `svg[data-s3d-scope="r9-"]` (`svg {…}` → the scope itself, `#t` → `#r9-t`); `alt="Member id = 4"` untouched; `&deg;`/`&phi;`/`&#x3C6;` decode, `&#99999999;` → U+FFFD, `&amp;#60;` once |
The SVG-references control adds `<a title="see id=ctl-t" href="#ctl-t">` (now `2 unresolved, 0
broken`). **Inverted:** HEAD's `main.ts` + `report_core.ts` under the new tests → all four fail for
their own reasons; the locked-PDF case reproduced #31 end to end (exit 0, `Created …` for a PDF
never written). HEAD's `main.ts` alone (bake fixed) → the reference guard REFUSED the correct
build, "1 broken by the bake … #r0-ctl-t": the checker needed its own fix. Chrome 2026-11-06:
`@scope (svg[…]) { svg {…} }` does NOT match the scoping root (scoped selectors are relative), so
kept SVG sheets are prefixed by attribute selector instead -- no `@scope` dependency.

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

## Compatibility gate — "backward compatible" is a gate result (workspace letter H6)

`scripts/compat.ts`, since 2026-10-28. **`bun run compat`** reports whether the committed
[`api-surface.txt`](../api-surface.txt) is current and the floor since the last tag; **`bun run
surface`** re-baselines it (Rule 5: an intended surface change is its OWN commit, before any bump).
`bun run bump <kind>` runs the gate before writing anything; `bun run release` runs it on the version
it is about to tag.

**The surface** (69 lines on 2026-10-28): the `exports` map; every exported symbol in the `.d.ts`
that tsc (node_modules, `emitDeclarationOnly`) emits for each export, one line per symbol — comments
removed, whitespace collapsed, overloads joined; the CLI's options and `USAGE` shapes from `--help`.
`VERSION`'s literal is normalized to `<VERSION>` (its type is the version string, which every bump
changes — without that, every bump read as breaking). An export the reader does not recognise, or a
tree that does not type-check, FAILS the gate (fail closed). At a tag with no snapshot (`v1.0.4`), the
surface is GENERATED from the tag: `git archive` into a temp dir with this repo's `node_modules` linked
(a bare archive cannot resolve the npm types — measured).

**No Deno since 2026-10-28** (owner: "the goal is to be deno free on this machine"). Until then the
symbols came from `deno doc --json`. Switch proven: the tsc reader names the SAME 69 lines' symbols,
kinds, exports and CLI lines as the `deno doc` snapshot; the floor vs `v1.0.4` is unchanged (minor —
`compareEachReport`, `PerReportResult`, `ReportConservation` added); re-baselined in the same commit
as the reader (the format changed, so the old snapshot could not stay). Inverted (one-time harness,
mutate → `compat check` → restore): doc-comment edit → current, exit 0; parameter widened, optional
parameter added, export removed, export added, type field added, return type changed → stale with
THAT symbol named, exit 1; a type error in the tree → refused. 8/8. (Two mutants first failed for
harness reasons — they were not valid TypeScript, so the gate refused them as type errors.)

**The floor:** removed or changed → major; added → minor; nothing → patch ("changed" includes widening,
so the floor can be high, never low). **Rule 3:** for a patch or minor, the PREVIOUS tag's sample
reports must build and PASS on the new code. **Blind spots, by design:** exit codes and the CLI's prose;
the npm dependencies' own types; behaviour the samples do not exercise (the `node:test` suite of task 12
step 5 joins Rule 3 when it exists). CI does not repeat the check on the tag yet (task 12 step 6).

**Inverted 2026-10-28** (one-time harness, scratch clone carrying the uncommitted gate, the real
`v1.0.4`; the release cases pushed to a SCRATCH bare origin): 12 / 12 — baseline patch allowed with
v1.0.4's samples PASS; stale snapshot refused; removed export → patch and minor refused, major allowed;
added export → patch refused, minor allowed; retyped parameter → major; a CLI flag renamed in `--help`
→ major; equations rendered as `""` with the surface unchanged → v1.0.4's samples FAIL, patch refused;
floor read from a tag's COMMITTED snapshot; `release 1.0.5` allowed, `1.0.4` refused; a refused bump
writes nothing; bump → release tags `v1.0.5`; a hand-edited version below the floor → release refused,
nothing tagged. (Two cases first failed for harness reasons — stderr ordering, and a mutation that hit
the header comment's `--no-optimize` instead of the help line — and a filter that selected NO case
printed "every inversion behaves"; the harness now refuses an empty run.)

## Runtime matrix — every Node LTS line, Bun, Deno

🔒 Owner, 2026-10-26: "make sure this repo is able to be used by all LTS versions of node, and bun,
and deno". Two ways to use it, and they have different floors — test both.

**From a clone: `bun run runtimes`** ([`scripts/check-runtimes.ts`](../scripts/check-runtimes.ts)).
Reads Node's release schedule (never a hand-kept list), builds the 13 samples on the
`engines.node` floor, every current LTS line and a line becoming LTS within 30 days (each via
`fnm exec --using=…`), then on Bun and Deno; fails unless every build PASSES its verification, the
CLI reports the runtime that was meant to run, and every baked HTML is byte-identical. A Node
fnm lacks FAILS with the `fnm install` (never skipped); a schedule fetch failure fails. Inverted
2026-10-26: `--also=22.17.1` → ❌ `ERR_UNKNOWN_FILE_EXTENSION` (below the floor), `--also=20.0.0` →
❌ "run: fnm install 20.0.0"; exit 1 for both, the six real rows still ✅.

Measured 2026-10-26 (Windows 11, Chrome on PATH; LTS lines from the schedule: 22 Jod, 24 Krypton,
26 from 2026-10-28):

| runtime | from the clone | the published 1.0.4, installed |
|---|---|---|
| Node 22.6.0 | ❌ `ERR_UNKNOWN_FILE_EXTENSION` (`.ts` needs a flag) | ✅ CLI + library |
| Node 22.17.1 | ❌ same | ✅ |
| Node 22.18.0 (floor) | ✅ | ✅ |
| Node 22.23.3 | ✅ | ✅ |
| Node 24.21.0 | ✅ | ✅ (install needs `npm_config_allow_remote=all`, #27) |
| Node 26.12.0 | ✅ | ✅ |
| Bun 1.4.4 | ✅ | ✅ (`bunx jsr add --bun`, #28) |
| Deno 2.9.8 (= `deno upgrade lts`) | ✅ | ✅ (`deno run -A jsr:…@1.0.4/cli`) |

Every ✅ baked the same document, sha256 `7F283563003F…` — clone and package alike. The
installed-package column is a procedure, not a committed script yet: a scratch project,
`bunx jsr add --bun @jrmarcum/s3d-reportcompiler@<ver>` (or `npx jsr add` with the allow-remote
variable), then `node|bun node_modules/@jrmarcum/s3d-reportcompiler/main.js <reports> <out.pdf>`
and an `import` of `.` and `./runtime`. It belongs in the release path once there is one off
Deno (bun-migration step 6) — it is the check that would have caught #27–#29.

Not a support promise, by design: Bun has no LTS line (the version on PATH is tested); Deno's is
whatever `deno upgrade lts` names. Node lines leave the matrix when the schedule ends them, and
`engines.node` must be raised then too (22 ends 2027-04-30).

## JSR upload check — `bun scripts/jsr-upload-check.ts` (CI and `publish.yml`; needs Deno)

What `deno publish` would UPLOAD, read from the tarball — because its exit code has lied (step 1:
"Successfully published" on a package whose prefix imports became `./…`). It publishes to a fake JSR
on `127.0.0.1` (`JSR_URL`, a dummy `--token`, `--no-provenance`) and requires: no `deno.json`; the
files exactly `publish.include`; in every `.ts` file each import specifier equal to the source's,
resolved through `jsr.json` `imports` (relative, `node:` and the package's own name in doc examples
unchanged), in order; everything else byte-identical; at least one bare specifier rewritten.
Measured 2026-10-28 (Deno 2.9.8, the step-7 tree): ✅ 7 files, 8 rewritten specifiers — the same
eight as the step-1 baseline and the real 1.0.4 (`mathjax-full` ×6, `pdf-lib`, `pdfjs-dist`).

⚠️ **The fake must answer `GET …/versions/<v>` with 404.** Answered 200, `deno publish` treated
the version as published, uploaded NOTHING and exited 0 — measured while writing the check; the
check fails a run with no tarball.

**Inverted 2026-10-28** (one-time harness, scratch copies): clean → exit 0; step 1's C1 (`deno.json`
with `imports` + `nodeModulesDir`, `--config jsr.json`) — `deno publish` exited 0 again, the check
❌ the `deno.json` and every `./mathjax-full/…`, `./pdfjs-dist/…` specifier, exit 1; C2 (`deno.json`
`nodeModulesDir` only, `jsr.json` without `imports`) — ❌ `./pdf-lib` etc., exit 1. 3/3. (C2 first
crashed on the missing `imports` — exit 1 for the wrong reason; fixed to report it.)

## npm package — `bun run npm:build && bun run npm:prove` (roadmap task 15)

`npm:build` ([`scripts/npm-build.ts`](../scripts/npm-build.ts)) emits JS + `.d.ts` into `dist/`
with tsc 7 (`tsconfig.npm.json`, `rewriteRelativeImportExtensions`), gives `main.js` a Node shebang,
and GENERATES `dist/package.json` (name `@synapticforge1/s3d-reportcompiler`, version from
`deno.json`, `bin`, dependencies from `package.json`, `engines.node` = pdfjs-dist's own floor,
22.13.0). `dist/` is git-ignored.

`npm:prove` ([`scripts/npm-prove.ts`](../scripts/npm-prove.ts)) tests what users get, not the tree:
`npm pack`; no `.ts` source ships; every path the manifest names, plus `LICENSE`,
`THIRD-PARTY-NOTICES.md` and `README.md` (required whatever `files` says), is in the tarball; the bin
has a Node shebang; the tarball installs with npm into a scratch project outside the repo; on the
engines floor, every Node LTS line, Bun and Deno it imports `.` and `./runtime` and the INSTALLED CLI
PASSES and bakes the source's document (`7f283563003f`); `npm exec` runs it; a consumer type-checks
against the shipped `.d.ts`; the export list equals JSR's own npm build of the package. Measured
2026-10-28: all ✅, exit 0.

**Inverted 2026-10-28** (one-time harness, one mutant per run on a fresh build, each must exit 1
with ITS check ❌): types path to a missing file; the Deno shebang kept; the CLI throwing on start
(❌ on every runtime); `./runtime` dropped (❌ imports and ❌ export list vs JSR);
a `.ts` source leaked into the tarball; `compareEachReport` deleted from the `.d.ts` (❌ consumer
type-check); `THIRD-PARTY-NOTICES.md` dropped from `files`. 7/7 caught.
⚠️ **`npm pack` and an install from the tarball are NOT the publish path.** Found 2026-10-28 by
the first `npm publish --dry-run` (npm 12.2.0): it called the generated bin `"./main.js"` invalid
and REMOVED it — a published package with no command, with only a warning — while pack, install,
`npm exec` and every check above passed. `npm-build` now writes `"main.js"`, and `npm:prove`
checks that the dry run corrects nothing (inverted: the old `"./main.js"` → ❌ with npm's own
warning, exit 1). `publish.yml`'s npm job runs the same refusal before the real publish.
⚠️ **The dry run runs on a COPY under `<version>-prove.0` (`--tag prove`).** Once 1.1.4 was on npm,
a dry run of the tree's own version failed "You cannot publish over the previously published
versions" — CI on main went red on every commit after the release (runs from 19:28Z, 2026-10-28),
which the `publish.yml` CI gate would have turned into a refused next release. Fixed and re-inverted
(the old bin still ❌). The workflow's step skips a version npm already has.

⚠️ **Dropping `LICENSE` from `files` is not a breakage**: npm packs `LICENSE`, `README` and
`package.json` regardless — the first mutant tried was that one, and the proof correctly passed it.

## Browser

```bash
bun run bundle:browser
npm run serve          # file:// blocks fetch
```

Open `tests/browser_example.html`, click **Bake**. Expect the same delimiter line, `169 converted, 0 failed`
for one report, `0 scripts` in the output, and a rendered preview.

Verified in headless Chrome with `--allow-file-access-from-files` and `--dump-dom`: the baked HTML
rendered inside an iframe with the MEMBER heading present, matching the server-side numbers exactly.

## Inspecting the output by hand

The baked document is written next to the PDF on every build (`--no-keep-html` discards it after a
successful render). Useful checks on it:

- `display:none`, `visibility` — should be neutralised or absent
- `.rs0 ;` — a malformed scoped selector; means the semicolon fix regressed
- `<script` and `https?:` — must both be zero

To rasterise PDF pages for visual inspection, `pdfjs-dist` plus `@napi-rs/canvas` works under Deno once
`Path2D` and `DOMMatrix` are set as globals from the canvas package.
