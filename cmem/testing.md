# Testing

## The build tests itself

There is no separate test suite. The build verifies its own output and **exits non-zero** if the PDF no
longer reproduces its sources, so running the build *is* the test.

Defaults resolve from the **working directory**, so which folder you stand in selects the input set:

```bash
deno task check                          # types
deno fmt --check                         # formatting (main.ts, src/, scripts/)
deno doc --lint src/*.ts                 # docs coverage — a scored JSR criterion
deno check --doc src/*.ts                # the JSDoc examples actually compile
deno publish --dry-run --allow-dirty     # JSR validation, incl. slow types
deno task verify-release <version>       # after a release: did it get an attestation?

cd tests && deno run -A ../main.ts       # the 2 committed samples
cd local && deno run -A ../main.ts       # the real 48-report set
cd local && node       ../main.ts        # same, on Node
cd local && bun run    ../main.ts        # same, on Bun
```

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

⚠️ **Use one report, not two copies.** Conservation is a set union, so a duplicate report supplies the
tokens the hidden one lost and the control passes when it should fail. Discovering that is how the
set-union limit in [verification.md](verification.md) came to light.

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
deno run -A scripts/sanitize-report.ts --check negctl_report.html
# ❌ negctl_report.html: 2 removed term(s) still present: …
# exit=1
```

⚠️ Match on **word boundaries, not substrings**. A substring test flags "Inc" inside "Including",
and quieting those false positives means widening the ignore list until the check can no longer fail.
The ignore list currently holds exactly one word (`design`), and every entry in it must be a word
*observed* surviving for an innocent reason — not one guessed at in advance.

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

## Browser

```bash
deno task bundle:browser
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
