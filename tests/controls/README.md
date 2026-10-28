# Controls & Spikes

The scripts that were actually used to test this build, recovered from the session's file history so
they travel with the repository. **The hardcoded sample path has been replaced** with a URL resolved
relative to the script, so they run from any checkout.

Each builds a small input folder; point the build at it and check the outcome against
[../../cmem/testing.md](../../cmem/testing.md).

```bash
bun tests/controls/control-unknown-delimiter.ts /tmp/ctl
bun main.ts /tmp/ctl /tmp/ctl/out.pdf     # must fail, exit 1 (node / deno run -A work too)
```

⚠️ Pass **both** paths explicitly. The build's defaults resolve from the current working directory,
so a control run without arguments would compile whatever happens to be in `./HTMLFilesToBeCompiled`
rather than the folder the control just built.

## Negative controls — each must FAIL the build

| Script | Injects | Expected |
|---|---|---|
| `control-unknown-delimiter.ts` | `@@..@@` with the tex2jax config removed | guard refuses; `250 TeX command(s)`, **no PDF** |
| `control-hidden-content.ts` | `#calculations { display: none }` in a **single** report | `172 words, 119 numbers missing`, 1 blank page, exit 1 |
| `control-custom-delimiters-colliding.ts` | `{{..}}` — collides with LaTeX braces | guard refuses; truncated expressions leave LaTeX behind |
| `control-hidden-row-two-reports.ts` | one table row hidden in the second of two identical reports | since 2026-10-28: per-report check `b_report.html: 5 word(s) … internal, forces, absolute, force, bending`, exit 1 — the set-wide check alone still reports 0 missing |

⚠️ `control-hidden-content.ts` uses **one** report deliberately. Its two-report sibling PASSED when it
should have failed until 2026-10-28 — conservation was only a set union; the per-report check closes
that (see [../../cmem/verification.md](../../cmem/verification.md)).

## Positive controls — each must PASS, matching the baseline

| Script | Injects | Expected |
|---|---|---|
| `control-custom-delimiters.ts` | `@@..@@` and `%%..%%` **declared in the config** | identical to baseline: 169 expressions, 8 pages, 9,486 chars |
| `control-dollar-delimiters.ts` | second report switched to `$$..$$` | both render correctly; 0 stray `$` |

## Controls that taught something by not working

| Script | What it showed |
|---|---|
| `control-hidden-row-two-reports.ts` | **Passed when it should have failed — until 2026-10-28** (now a negative control, above). Two identical reports; the intact one supplied the tokens the hidden one lost. This is how the set-union limit was found — and chasing it uncovered the stray-semicolon bug that was silently dropping a CSS rule from every report |

⚠️ `redact-paths.ts` takes the username from `USERNAME`/`USER` (or `--user=`) rather than hardcoding
one. A redaction tool that names the thing it redacts republishes it in a tracked file — and only
works for the one person it was written for.

## Spikes

**Retired 2026-10-26** (owner: "retire it if it is not being used" — nothing ran or imported it, and
it imported `npm:pdfmake`, deliberately not a dependency, which would not survive the move off Deno;
[../../cmem/bun-migration.md](../../cmem/bun-migration.md)). Its verdict stays here; the script is
`git show bd2599287:tests/controls/spike-pdfmake.ts` (`a57cd72` before the 2026-10-26 history purge).

| Script | Verdict |
|---|---|
| `spike-pdfmake.ts` (retired) | pdfmake runs under Deno and handles tables, base64 PNGs and inline SVG as true vectors (110 paths, 107 strokes, 146 text ops) — but it has no CSS engine and **cannot place an SVG inline within text**, which is fatal for 87 inline expressions per report. Rejected; see [../../cmem/design-decisions.md](../../cmem/design-decisions.md) |

## Utilities

| Script | Purpose |
|---|---|
| `verify-pdf-text.ts` | dump what text a PDF actually contains, page by page. The standalone precursor to the built-in verification; the simplest way to inspect an arbitrary PDF. Defaults to the build output |
| `export-transcript.ts` | export a Claude Code session log to readable Markdown, so the record travels with the repo. Strips base64 page renders, truncates tool results |
| `redact-paths.ts` | replace absolute machine paths with `<project>` / `<home>` / `<home-slug>` / `<path-slug>` placeholders. `--check` reports without writing; `--user=NAME` and `--folder=NAME` override what is detected from the environment |
