# Known Issues, Template Assumptions & Bug Ledger

## ⚠️ Live constraints

### `$` as a delimiter is inherently ambiguous

A literal dollar sign in prose — a cost in the project notes, say — either pairs with the next one and
swallows the text between, or is stranded and fails the guard. `MAX_MATH_BODY` (2000) caps the blast
radius but does not remove it.

**This is not a defect here: MathJax reads these documents exactly the same way.** The ambiguity is in
the source. Longest real body measured is 219 characters, so the cap has ~9× headroom.

### Every `.html` in `HTMLFilesToBeCompiled/` is treated as a report

Under an earlier flat layout — reports, tooling and output all in one folder — adding
`browser_example.html` produced a 49-report build. The verification caught it (`48/49 reports`, exit 1),
but the real fix was structural: **input and output now live in separate directories**, so the scan
cannot see a build artifact of its own.

The tool-owned-file guard (`combined_report.html`, `browser_example.html`) remains as a second line for
anyone who overrides the paths to point both at the same folder. Its skip count is reported when it
fires. **Keep tooling and examples out of the reports directory.**

### `--no-sandbox` is passed to Chrome

So it can run as root in a container. Only defensible because the input is a document this tool
generated itself. **Drop it if the HTML ever comes from somewhere untrusted.**

### Remaining template assumptions

Maths handling is fully template-driven (delimiters read from each document). These are not:

| Assumption | Failure mode |
|---|---|
| `<div id="loading">` is the spinner | spinner survives — **visible** |
| `visibility: hidden` appears only on the reveal gate | un-hides something meant to stay hidden — **visible** |
| `height: 100%` only on wrappers | layout distortion — **visible** |
| Diagram labels for the split check | check silently no-ops — **reported as `0 diagram(s) checked`** |
| Report-heading pattern | count mismatch — **fails loudly** |

All degrade *visibly* or *loudly* rather than producing a clean-looking document with corrupted
contents, which is the safer class. The conservation check backstops the first three.

---

## The pitch to SkyCiv — fix it upstream

The strongest version of this work is not the converter. SkyCiv already holds this content as
**structured data**: they generate the LaTeX, the section PNG and the diagram SVG, then assemble HTML.
Rendering HTML → PDF is a lossy round-trip through a format that was never the source of truth.

Three things worth telling them, all measured here:

1. **Their reports cannot be printed by anything without a JavaScript engine** — the `visibility: hidden`
   gate plus LaTeX-at-view-time.
2. **Their reports render differently on different machines.** `font-family: Lato, …` is declared with
   **no `@font-face` and no Google Fonts link** — Lato is never loaded, so it silently falls through to
   whatever the host has.
3. **They hard-depend on three CDNs at view time**, and their `tex2jax` config declares `['\[','\]']`,
   which JavaScript evaluates to a bare `[` and `]`.

Emitting **MathML** instead of LaTeX-in-delimiters would fix (1) and (3): native in 94% of browsers,
3× smaller markup than CHTML, accessible, and no MathJax needed at view time. Generating PDF from their
data model would remove the round-trip entirely — and that is the case where **Typst** becomes the right
tool.

---

## Bug ledger

Kept because the *pattern* matters more than the individual bugs.

### In the original script

| # | Bug |
|---|---|
| 1 | `./html_files` did not exist — reports were in the script's own folder |
| 2 | `entries.sort()` lexicographic: `member_0, member_10, member_11, … member_1, member_2` |
| 3 | WeasyPrint has no JS engine → ~400 blank pages. Neither it nor Python was installed |
| 4 | Concatenating 48 full documents duplicated `#report`, so `$('#report')` matched only the first |
| 5 | No base URL, no empty-input check, `merged.html` left behind, uncaught `NotFound` if the binary is missing |

### Found during review — builder

| # | Bug | Silent? |
|---|---|---|
| 6 | **480 `$..$` expressions unrendered** — only two of the configured delimiters were handled | **yes** |
| 7 | Sections split across page breaks, leaving bounding rules open | no |
| 8 | The SVG's internal `<style>` hoisted into the global stylesheet | no |
| 9 | Unescaped LaTeX in the failure fallback — 54 `[math]` bodies contain `<` | latent |
| 10 | `inlineFonts` substring substitution: a font name that is a suffix of another corrupts its neighbour's URL | latent |
| 11 | **Stale PDF read back as this run's output** after a failed render | **yes** |
| 12 | Unknown flags ignored — `--no-optimise` silently did the opposite | **yes** |
| 13 | Temp directory leaked on one error path | no |
| 14 | `const document` shadowed the DOM global (three call sites silently resolved to it) | latent |
| 15 | **Stray `;` in source CSS glued onto the next selector → browsers dropped that rule**, one per report. Introduced by the scoping refactor | **yes** |

### Found during review — the checker

⚠️ These are the dangerous ones: a broken check fails in the safe-looking direction.

| # | Bug |
|---|---|
| 16 | Image check assumed one figure per report (each has **two** `<img>`; it worked by luck) — a second figure would have failed a correct build |
| 17 | Blank-page test flagged a diagram-only page as blank |
| 18 | Diagram-split check silently no-ops on an unrecognised template — "0 splits" read as a pass |
| 19 | Verifier derived its image count using its own copy of the spinner-removal regex, so it could agree with the baker's mistakes |
| 20 | Token-set comparison reported real content as missing (PDF text arrives as fragments) |
| 21 | `<[^>]+>` tag stripper swallowed numbers after a `<` inside maths — **falsely lenient** |

### Found during the JSR restructure (2026-08-08)

| # | Bug | Silent? |
|---|---|---|
| 22 | **A relative output path given on the command line produced no PDF.** Chrome does not resolve a relative `--print-to-pdf` against the calling process's working directory; it prints `Failed to write file <path>: The system cannot find the path specified` to stderr and **still exits 0**. Fixed by resolving both positional paths to absolute via `rt.resolvePath()` before use | **yes** — only the existing stale-PDF guard turned it into a visible failure |

⚠️ **Bug 22 is worth more than its size.** The defaults were never exposed to it, because they are
built from an absolute `rt.cwd()` — so every build anyone had ever run was immune, and the CLI's
documented override was the one path that broke. It surfaced only from testing the *argument* form
rather than the default form, which is a reminder that "the tool works" usually means "the way I
invoke it works".

It also shows the earlier guard paying off a second time: Chrome exiting 0 on a write failure is
precisely the condition bug #11 introduced the "no file means failure" check for. Without it this
would have reported a successful build.

### The pattern

Reviews 1–2 found builder bugs; reviews 4–5 found **checker** bugs. As the pipeline hardened, risk moved
into the verification code. Reviews 3 and 5 found no bugs at all — only undocumented reasoning, which is
its own failure mode: a risk reasoned about in conversation and never committed to the file is invisible
to whoever reads it next.

Two controls, two different catches: the **conservation check** caught the self-inclusion bug (#17-adjacent,
the 49-report build); the **negative control** caught the stray-semicolon bug (#15), which conservation
alone missed because the dropped rule was cosmetic and lost no words or numbers.
