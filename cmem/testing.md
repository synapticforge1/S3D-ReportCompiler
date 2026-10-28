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
checkout (`npm ci`), and runs what needs Deno, installed per run by `setup-deno`: `deno check`,
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
npm ci && deno publish --dry-run  # must succeed
```

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
| hidden content, one report | exit 1; 171 words / 114 numbers missing; 1 blank page; "content missing from the PDF" |
| a row hidden in the 2nd of two copies | exit 1; set-wide **0 missing** (pinned — the union limit), per-report `b_report.html: 5 word(s) … internal, forces, absolute, force, bending`; NOT "missing from the PDF" |
| custom delimiters declared | exit 0; 169 expressions; ≥ 1 page; PASS |
| `$$..$$` in a second report | exit 0; 338 expressions; the two-delimiter-set warning; per-report 2/2; no `$$` in the bake |
| unknown flag | exit 1; `Unknown option(s): --no-optimise`; nothing compiled |
| stale PDF, a "Chrome" that writes nothing | non-zero; "Chrome produced no PDF"; no `Created`; the stale PDF is gone (the stub is the test's own runtime as `CHROME_PATH`) |
| relative input/output paths (#22) | exit 0; `out/custom-name.pdf` and `.html` exist |
| sanitizer, clean / leaked | invented values planted in all three fields of a sample under a temp `local/` (no client data): ✓ 6 tokens verified absent / ❌ `1 removed term(s) still present: Zorblax` |
| every `tests/controls/control-*.ts` is exercised | "a run of nothing is not a pass" |

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
