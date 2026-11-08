# Controls & Spikes

The scripts that were actually used to test this build, recovered from the session's file history so
they travel with the repository. **The hardcoded sample path has been replaced** with a URL resolved
relative to the script, so they run from any checkout.

Each builds a small input folder; point the build at it and check the outcome against
[../../cmem/testing.md](../../cmem/testing.md). **`bun run test` does all of that** since
2026-10-28 ([`../build.test.ts`](../build.test.ts)), asserting each control's own failure reason, and
it fails if a `control-*.ts` here is not exercised — add a test with any new control.

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
| `control-unknown-delimiter.ts` | `@@..@@` with the tex2jax config removed | guard refuses; `87 expressions, 0 failed` then `270 TeX command(s)` (250 before 2026-11-06, when the fallback lost its bare `$`), **no PDF**. The generator throws if either edit does not apply (since 2026-11-06; it used to print "config removed: false" and go on) |
| `control-hidden-content.ts` | `#calculations { display: none }` in a **single** report | `171 words, 114 numbers missing` (172 / 119 on the samples of an earlier date), 1 blank page, exit 1 |
| `control-custom-delimiters-colliding.ts` | `{{..}}` — collides with LaTeX braces | guard refuses; truncated expressions leave LaTeX behind |
| `control-hidden-row-two-reports.ts` | one table row hidden in the second of two identical reports | since 2026-10-28: per-report check `b_report.html: 5 word(s) … internal, forces, absolute, force, bending`, exit 1 — the set-wide check alone still reports 0 missing |

⚠️ `control-hidden-content.ts` uses **one** report deliberately. Its two-report sibling PASSED when it
should have failed until 2026-10-28 — conservation was only a set union; the per-report check closes
that (see [../../cmem/verification.md](../../cmem/verification.md)).

## Positive controls — each must PASS, matching the baseline

| Script | Injects | Expected |
|---|---|---|
| `control-custom-delimiters.ts` | `@@..@@` and `%%..%%` **declared in the config** | identical to the baseline report: 169 expressions, 0 failed, PASS (page counts are layout and are never pinned -- they follow the platform's fonts; the "8 pages, 9,486 chars" once quoted here was one machine's, 2026-08-08) |
| `control-dollar-delimiters.ts` | second report switched to `$$..$$` | both render correctly; 0 stray `$` |
| `control-math-entities.ts` | every relational `<` / `>` inside an expression written as `&lt;` / `&gt;` | identical to baseline: 169 expressions, 0 failed (failed every one before 2026-11-05: TeX read the `&`) — and since 2026-11-07 the test proves "identical": the control's bake must equal the untouched sample's byte for byte. Until then it checked words and numbers only, which hold no relation symbol, so a bake that swapped `<` and `>` passed |
| `control-style-attributes.ts` | every `<style>` as `<style type="text/css">`, a quoted SVG `font-family`, one `media="print"` block | PASS with the baseline's audit counts; the quoted value escaped, the print block still `@media print` (before 2026-11-05 the typed sheets were dropped silently) |
| `control-svg-references.ts` | a gradient, clip path and marker in the diagram, used via `url(#id)` — bare, quoted, and `&quot;`-quoted as a saved page has it; plus a `data-id` that must stay untouched, an unquoted `id=`/`href=` pair, and `title="see id=ctl-t"` beside `href="#ctl-t"` (2026-11-06) | PASS, and the bake's references name the renamed ids (`r0-…`); the title's "id=" is text to the bake AND to the reference guard (`2 unresolved, 0 broken`). The build passed before 2026-11-05 too, with the references dangling, so the test reads the bake |

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
| `verify-pdf-text.ts` | dump what text a PDF actually contains, page by page. The standalone precursor to the built-in verification; the simplest way to inspect an arbitrary PDF. Pass the PDF; with none it reads `tests/CompiledPDF/combined_report.pdf`, the output of a build run from `tests/`. Prints counts (pages, characters, report headings); `--show-text` adds page 1's first 400 characters — never by default, since page 1 of a real build is a client's project details |
| `export-transcript.ts` | export a Claude Code session log to readable Markdown, into the git-ignored `cmem/transcript/`: the record stays on the machine it was made on (owner, 2026-08-08), and `redact-paths.ts` is the gate before it is ever shared. Strips base64 page renders, truncates tool results |
| `redact-paths.ts` | replace absolute machine paths with `<project>` / `<workspace>` / `<home>` / `<path>` and their slugs with `<project-slug>` / `<home-slug>` / `<path-slug>`; the checkout and workspace are found from the script's own location. A path is replaced WHOLE wherever its end can be told (2026-11-06, review 2; review 5): inside quotes, to the closing quote (`"`, `'`, a backtick, curly quotes; an apostrophe between letters, `O'Brennick`, is part of a name); unquoted, through folder names with spaces that a separator follows, and at the end into words that do not start lowercase (`… Acme Steel`, `… Job 41`) — an unquoted last folder name with a LOWERCASE word after a space cannot be told from prose, and quote such paths. A home path runs to its end -- a spaced username, `OneDrive - <employer>`, the client folder below -- not just `X:\Users\<name>`; only this checkout's and workspace's own tails stay readable. `//server/share` counts as a network path. Any other absolute POSIX path of two or more segments (`/srv/…`, `/Volumes/…`, `/tmp/…`) becomes `<path>`, but not a URL's path or a regex literal. Since 2026-11-07 also a home written without its drive or through a shell's name for it (`\Users\…`, `~\…`, `%USERPROFILE%\…`, `$env:USERPROFILE\…`, `$HOME/…`), a `file://host/…` URI and any local `file:///…` or `vscode://file/…` URI, and percent-encoded (`%3A`, `%5C`, `%2F`) or JSON-escaped (`\/`) separators. Shares named by `smb://` / `afp://` / `nfs://` / `cifs://` / `webdav://`, `//<IP>/…` and `//<host>.corp/…` (or `.local`, `.lan`, `.internal`, …) are network paths. Email addresses (plain, `%40`, `%2540`, `@`, `&#64;`, `&commat;`, the full-width `＠`; letters of any script, a quoted local part; an address-literal domain; clipped anywhere, dot-less) become `<email>` (2026-11-06; review 5), but not a version or an action ref (`react@18.3.1`, `owner/action@v5`), except the trailer's `noreply@anthropic.com`, `git@github.com` and the RFC 2606/6761 example and test domains; they are counted, never echoed. Exits 1 if the username, any drive path or any email survives (since 2026-11-05; it used to say "redacted." and exit 0) — and each residue check is meant to be LOOSER than the rule it checks (a spaced or "(at)" address, any POSIX path), so it can find what the rules missed; review 5 found two that were not (a clipped address, a quoted folder name with a space), now fixed. A surviving username is reported by line number, never with the text around it. `--check` reports without writing; `--user=NAME` and `--folder=NAME` override what is detected from the environment |
