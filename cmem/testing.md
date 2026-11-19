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

**Every test runs HERE, not on GitHub (🔒 since 2026-11-19, letter H37: "CI only publishes").**
`bun run release` runs them all before it pushes (release.md § "How a release is made"): the suite on
Bun and on Node 22.18 / 24 / 26 through fnm (`fnm exec --using=<v> node --test …`), the runtime
matrix, the npm proof, and the suite in WSL (`linux-x64`) when WSL has Bun and Chrome. `ci.yml`, which
repeated them on every push, is retired. What needs Deno (🔒 owner, 2026-10-28: no Deno on this
machine) is JSR's own pre-publish checks — `deno check`, `deno doc --lint src/*.ts` (docs coverage, a
scored JSR criterion), `deno check --doc --config jsr.json src/*.ts` (the JSDoc examples compile),
`deno publish --dry-run` — and those run in `publish.yml`'s `checks` job, before the tag. Deno's TEST
legs are not run: Node covers the V8 engine (letter H39). `runtimes` and `npm:prove` print
`· deno: not run here`, so that is never silent.

### ⚠️ A dry run in your working tree is not a rehearsal for CI

`deno publish --dry-run` passes locally because `node_modules` is already there from development. CI
starts from a bare checkout. To actually rehearse the release, clone into a temp directory and run it
with nothing installed:

```bash
git clone <repo> /tmp/cirepro && cd /tmp/cirepro
deno publish --dry-run          # must fail without deps — that IS the CI condition
bun install --frozen-lockfile && deno publish --dry-run  # must succeed
```

(That needs Deno — on this machine it runs in CI only; `publish.yml`'s `checks` does exactly this.)
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
math:     87 expressions, 0 failed          ← note: "0 failed"
ERROR: unrendered mathematics reached the baked document.
  270 TeX command(s): \lambda, \dfrac, \max, \sqrt, \frac, \rightarrow
exit=1     pdf produced: False
```

⚠️ **The converter reported `0 failed` while 270 TeX commands survived.** That is the whole point: an
unmatched delimiter never errors. (97 / 250 until 2026-11-06, when the fallback lost its bare `$`;
the suite asserts 87 / 270.)

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

Columns: test · asserts.

- the 13 samples — exit 0; 2203 expressions, 0 failed; ≥ 1 page per report (never an exact count — below); 0 missing; per-report 13/13; 13 images, 13 diagrams; 0 LaTeX, 0 blank; PASS
- unknown delimiter — exit 1; "87 expressions, 0 failed" AND the guard's error, 270 TeX commands (97 / 250 before 2026-11-06); never verifies; no PDF
- colliding `{{..}}` — exit 1; the guard's error, 205 TeX commands; no PDF
- hidden content, one report — exit 1; 223 words / 116 numbers missing (171 / 114 before class B, 2026-11-08; 218 before
  the ASCII operators counted); 1 blank page; "content missing from the PDF"; **no new `compiled_reports_*` temp profile
  left** (2026-11-05)
- a row hidden in the 2nd of two copies — exit 1; set-wide **0 missing** (pinned — the union limit), per-report
  `b_report.html: 26 word(s), 21 number(s) -- design (3 of 4), moment (2 of 6), …` since operators and neighbours are
  counted (2026-11-08; 24 / 7 with occurrences only; 6 words, then 5, before); NOT "missing from the PDF"
- custom delimiters declared — exit 0; 169 expressions; ≥ 1 page; PASS
- `$$..$$` in a second report — exit 0; 338 expressions; the two-delimiter-set warning; per-report 2/2; no `$$` in the bake
- `&lt;` / `&gt;` inside expressions (2026-11-05) — exit 0; 169 expressions, 0 failed (the same report as custom delimiters); PASS
- SVG `url(#id)` references (2026-11-05) — exit 0; PASS; the bake holds `url(#r0-ctl-grad)`, `url(#r0-ctl-clip)`,
  `url('#r0-ctl-grad')`, `marker-end` → `r0-ctl-arrow`, no old id, and `url(#ctl-undefined)` untouched. Reads the bake:
  verification cannot see a lost paint server. 2026-11-06: `title="see id=ctl-t"` untouched, `2 unresolved, 0 broken`
  (#36)
- `<style type="text/css">`, a quoted SVG `font-family`, a `media="print"` block (2026-11-05) — exit 0; the audit line
  identical to custom delimiters' (1 loader, 1 gate, 3 height, 0 @page, 1 stray token); PASS; no hoist warning; the bake
  has `font-family="&quot;Arial&quot;, sans-serif"`, `@media print { … }`, no `<style>` left in the SVG
- the redactor (2026-11-05) — a fixture built at run time from the checkout's own path: checkout (`\`, `\\`, `/`), home,
  other-drive and slug paths all replaced, a URL kept, exit 0; a username outside any path → exit 1 "not safe to
  publish", and `--check` exits 1 too
- `verify-release`, fake JSR (2026-11-05) — attested → 0; attested + yanked → 3; **unattested + yanked → 1** (provenance
  first); unattested → 1; 404 → 2 "not on JSR"; 503 → 2 "Could not ask … not a verdict"; a server that never answers → 2
  at the 500 ms test timeout; `--wait` over two 503s then attested → 0, "could not ask JSR (1/60): HTTP 503 — retrying",
  3 requests
- release refuses when JSR cannot answer (2026-11-05) — throwaway clone (package.json one version behind, push URL not a
  remote), fake JSR 503 → exit 1 "Could not ask JSR … (HTTP 503)", "undid the local bump", HEAD back where it was,
  nothing tagged
- release undo that cannot run (2026-11-05) — `.git/index.lock` written while JSR is asked → "could NOT undo … do not
  push it", the bump commit remains; a commit made while JSR is asked → "HEAD is not the bump commit any more; left as
  is", that commit untouched
- output named like a report, other folder (2026-11-05) — exit 0; 1 report compiled; no `skipped:`
- output onto a source report (2026-11-05) — `d_report.pdf`, `d_report.html`, `D_REPORT.pdf` into the input folder: each
  exit 1, "would overwrite a source report", nothing compiled, the report byte-identical
- a previous bake in the input folder (2026-11-05) — second run exit 0; 1 report; `skipped: 1 tool-owned` (recognised by content, not name)
- unknown flag — exit 1; `Unknown option(s): --no-optimise`; nothing compiled
- stale PDF, a "Chrome" that writes nothing — non-zero; "Chrome produced no PDF"; no `Created`; the stale PDF is gone (the stub is the test's own runtime as `CHROME_PATH`)
- relative input/output paths (#22) — exit 0; `out/custom-name.pdf` and `.html` exist
- sanitizer, clean / leaked — invented values planted in all three fields of a sample under a temp `local/` (no client data): ✓ 6 tokens verified absent / ❌ `1 removed term(s) still present: Zorblax`
- every `tests/controls/control-*.ts` is exercised — "a run of nothing is not a pass"

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
Columns: test · asserts.

- a third positional argument (#32) — exit 1; `Too many arguments (3)`, each argument listed, the quoting hint; nothing compiled
- a previous PDF that cannot be removed (#31) — a REAL one-page PDF held open the way a viewer holds it (Windows: a
  PowerShell child, `FileShare.Read`; POSIX: the folder `chmod 555`, skipped as root); the test runtime as "Chrome",
  `--no-optimize --no-verify` → exit 1 "Could not remove the previous PDF", no `Created`, the old PDF byte-identical
- CSS scoping, SVG sheets, attributes, entities (#33–#37) — `core` imported, no render: `html body p` → `.rs9 p`; `body
  + p` dropped; `p:not(.a, .b)` one selector; `body.dark` settled against `<body class="x dark">` (`body.light` dropped,
  `:hover` kept on the wrapper); a body `<style>` in the scoped sheet and out of the fragment; an SVG `@media` rule and
  a `font` shorthand NOT hoisted, kept under `svg[data-s3d-scope="r9-"]` (`svg {…}` → the scope itself, `#t` → `#r9-t`);
  `alt="Member id = 4"` untouched; `&deg;`/`&phi;`/`&#x3C6;` decode, `&#99999999;` → U+FFFD, `&amp;#60;` once
The SVG-references control adds `<a title="see id=ctl-t" href="#ctl-t">` (now `2 unresolved, 0
broken`). **Inverted:** HEAD's `main.ts` + `report_core.ts` under the new tests → all four fail for
their own reasons; the locked-PDF case reproduced #31 end to end (exit 0, `Created …` for a PDF
never written). HEAD's `main.ts` alone (bake fixed) → the reference guard REFUSED the correct
build, "1 broken by the bake … #r0-ctl-t": the checker needed its own fix. Chrome 2026-11-06:
`@scope (svg[…]) { svg {…} }` does NOT match the scoping root (scoped selectors are relative), so
kept SVG sheets are prefixed by attribute selector instead -- no `@scope` dependency.


The dated record of what each review added: [archive/testing-history.md](archive/testing-history.md).
The packaging checks (compat, runtimes, JSR, npm): [testing-packaging.md](testing-packaging.md).

## Browser

```bash
bun run bundle:browser
npm run serve          # file:// blocks fetch
```

Open `tests/browser_example.html`, click **Bake**. Expect the same delimiter line, `169 converted, 0 failed`
for one report, `0 scripts` in the output, and a rendered preview.

Verified in headless Chrome with `--allow-file-access-from-files` and `--dump-dom`: the baked HTML
rendered inside an iframe with the MEMBER heading present, matching the server-side numbers exactly.

Since review 4 (2026-11-07) this is also a test, "group E: the browser example, driven in Chrome":
it serves the page, a freshly built bundle and two reports on 127.0.0.1 and clicks **Bake** over
the DevTools protocol — a good bake fills the preview, one that throws is logged and empties it,
and a stale bundle (no `decodeReport`) logs "rebuild the bundle". The local bundle the manual steps
above use is git-ignored and goes stale between pulls: the page now says so.

## Inspecting the output by hand

The baked document is written next to the PDF on every build (`--no-keep-html` discards it after a
successful render). Useful checks on it:

- `display:none`, `visibility` — should be neutralised or absent
- `.rs0 ;` — a malformed scoped selector; means the semicolon fix regressed
- `<script` and `https?:` — must both be zero

To rasterise PDF pages for visual inspection, `pdfjs-dist` plus `@napi-rs/canvas` works under Deno once
`Path2D` and `DOMMatrix` are set as globals from the canvas package.

