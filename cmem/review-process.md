# review-process.md: this repo's slots in the review standard

Last verified: 2026-11-19. The standard is the workspace's, `../workspace/cmem/review-process.md` (final,
2026-11-17, letter H37): read it for the classes, their item lists, the boundary rules, the loop and the
severity floors. This file holds only what is this repo's (standard § 12). The process this repo ran
before it: [archive/review-process-2026-11-12.md](archive/review-process-2026-11-12.md).

## The owner's words

"review" runs the five required classes (basic, hardening, licensing, security, privacy) through one
loop; "basic review", "hardening review", "licensing review", "security review", "privacy review" and
"efficiency review" run that class alone ([working-rules.md](working-rules.md) § Owner commands).

## Issues and the review record

- **`cmem/review-issues.md`**, git-ignored (`.gitignore`), holds every open finding, every rejected one
  with its reason, and the tracking IDs `R<n>`. It never reaches GitHub.
- **`Review complete: <commit>`** — one line in that file, written by the main agent only when a
  re-review came back empty in every class and the full suite passed; `Review complete: none` otherwise.
  The release tooling reads it as its first step (standard § 9; release.md).
- Fixes are made on a local review branch, merged to `main` when the review is complete.
- A reviewer works in a folder under the main session's scratchpad; the main session deletes it when
  the round is triaged (Tooling rule 15). A reviewer never commits, pushes or releases.

## Slot: private-data paths (never given to a reviewer, never read by one)

- `local/` — the real client report sets (the 48-report set, the 36ft report, a 75-report SkyCiv zip).
- `cmem/local/` — the session transcripts and machine facts.
- `CompiledPDF/` at any depth — a build of client reports is client data.
- A zip build's outputs beside the zip (`<name>.html`, `<name>.verified.pdf`, `<name>.unverified.pdf`).
- `cmem/review-issues.md` — open findings; a reviewer is given its own class's items, not the file.

A reviewer reproduces on the committed samples (`tests/HTMLFilesToBeCompiled/`, sanitized) or on
inputs it builds itself.

## Slot: reference results (a change is a finding until explained)

- **The 13 samples:** `cd tests && bun ../main.ts` → 100 pages, PASS; baked HTML sha256 `487321f2…`
  (all three runtimes and both renderer settings that send them to Chrome).
- **The 48-report set:** 380 pages, PASS, baked `da92578d…`; 8,286 expressions, 0 failed.
- **The zip export:** baked `f0922226…`, PASS.
- **The 36ft report (native):** 7,161 pages, PASS (2026-11-12).
- **The suite:** `bun run test` — 115 tests (2026-11-19); `bun run test:node` the same file on Node.
- **The API surface:** `api-surface.txt`; `bun run compat` gives the floor since the last tag.

Where each figure was measured and how: [testing.md](testing.md), [verification.md](verification.md).

## Slot: support matrix and platform notes

[platforms.md](platforms.md).

## Slot: where the licence inventory and notices live

- [licensing.md](licensing.md) — every dependency, its version and SPDX licence, read from the
  installed package; the project's own licence (MIT).
- `THIRD-PARTY-NOTICES.md` and `LICENSE` at the root ship in both packages (`jsr.json` `publish.include`;
  `scripts/npm-build.ts` `files`); `fonts/liberation/` ships with its SIL OFL 1.1 text.
- What the OUTPUT carries: MathJax's woff-v2 fonts (Apache-2.0) are inlined into the baked HTML and
  the PDF; the Liberation fonts are embedded by the native renderer. Both count for the licensing review.

## Slot: which outputs can carry user facts

- **The combined PDF and the baked HTML** carry the reports' own content: project name, designer and
  notes are client data (that is why `local/` is ignored and the samples are sanitized).
- **A zip build** writes the verified PDF back INTO the user's zip.
- **The build log** prints the input and output paths, which name the user's folders.
- **The font cache** `.mathjax-fonts/` is written in the working directory.
- **Chrome's temporary profile** lives in the system temp folder for the render and is removed after.
- The tool makes **no network request** at run time: the baked document's CSP forbids every outside
  load (0 requests measured, known-issues § "The render runs no report code").

## Slot: gate scripts (run locally; not reviews)

`bun run release` runs them all, in this order, before it pushes (scripts/publish.ts step 6):
`bun run compat`, `bun run check` (types), `bun run format:check`, `bun run lint`, `bun run privacy`
(scripts/check-privacy.ts, the tree and the commit messages since the last tag), `bun run cmem`, `bun run
test`, the suite on Node 22.18 / 24 / 26 (fnm), `bun run runtimes`, `bun run npm:build` +
`scripts/npm-digest.ts --check` + `npm:prove`, and the suite in WSL when it is set up. Outside it:
`scripts/sanitize-report.ts`'s own self-check and `bun audit`. JSR's own checks (`deno check`, `doc --lint`,
`check --doc`, `publish --dry-run`, `jsr-upload-check.ts`) run in publish.yml's `checks` (Deno; none here).

## Slot: items that do not apply here, and why

- **Sandbox boundary (runtimes)** and **native library loading (loaders)** — this is neither.
- **Exploitable memory corruption** — pure TypeScript; no unsafe, FFI, Zig or C code.
- **Cross-implementation agreement** — APPLIES in this repo's form: the two renderers (Chrome and
  native) must give reports that pass the same verification; the joined PDF is verified as one.
- **Fuzzing** — APPLIES to this repo's parsers: the HTML reader, the zip reader, the JPEG re-coder,
  the WebP decoder, the CSS and SVG readers.
