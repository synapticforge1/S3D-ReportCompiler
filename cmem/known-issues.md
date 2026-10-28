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
| 23 | **The first release workflow failed: `deno publish` could not resolve `mathjax-full`.** `deno.json` sets `"nodeModulesDir": "manual"`, so Deno reads npm dependencies from an on-disk `node_modules` — and the workflow never created one. Fixed by adding an `npm ci` step before publish | no — failed loudly, and before publishing anything |
| 24 | **The globally installed command did nothing and exited 0.** `deno install -g` installs the `.` export, not the `bin` field, and `.` is `report_core.ts` — a pure library. The binary installed successfully, ran, defined some functions and exited cleanly, including for `--version`. Fixed by adding a `./cli` export pointing at `main.ts` | **yes** — the most silent failure in the ledger: successful install, zero output, exit 0 |

⚠️ **Bug 24 shipped in 1.0.0, and the README documented the broken command.** Every gate passed:
types, fmt, doc lint, `deno publish --dry-run`, and builds on three runtimes — because all of them
exercise `main.ts` *directly*. Nothing exercised the installed entrypoint. It was found by a user
installing it, which is the worst way to find it.

The same shape as #23 one step further out: **the release pipeline was tested, the thing the release
produces was not.** Post-publish, install the package the way the README tells someone to and run it.

| # | Bug | Silent? |
|---|---|---|
| 25 | **The fix for #24 missed the release it was written for.** `v1.0.1` was tagged at the commit *before* the `./cli` export landed, so 1.0.1 published without it and the global install stayed broken. JSR versions are immutable, so it could only be corrected by burning 1.0.2 | **yes** — the release succeeded, scored 100 and was attested; only the missing export gave it away |

⚠️ **`git tag` tags whatever HEAD happens to be, and says nothing about it.** `scripts/publish.ts`
now refuses to tag when the working tree has uncommitted tracked changes or HEAD is behind its
upstream, refuses outright when the version is already on JSR, and **prints the commit and subject it
is about to tag** so the release is visible before it is cut.

⚠️ **The first version of that guard was itself broken, and proved it immediately.** The JSR check
`fetch`ed without `--allow-net` in the task definition; the resulting `NotCapable` was caught by a
`catch` written for "offline, keep going", so the guard reported nothing and the script force-pushed
a tag onto an already-published version — the exact act it existed to prevent. It now distinguishes a
missing permission (a broken guard: refuse) from real network trouble (warn and continue).

**A guard that cannot run must not report success** — [practices.md](practices.md) §2, learned again
the hard way, in the guard written to enforce it.

**#24 and #25 are fixed in 1.0.2**, verified by installing from JSR and running it:
`--version` → `1.0.2`, `-h` → the full usage text.

| # | Bug | Silent? |
|---|---|---|
| 26 | **1.0.2 AND 1.0.3 were published from a workstation, not through GitHub Actions**, so neither carries provenance. No tag, no release branch, no Rekor entry for either — while 1.0.0 and 1.0.1 are attested. JSR versions are immutable, so neither can be fixed in place | **yes** — both publishes succeeded and JSR reports score 100, because the score does not include provenance |

✅ **1.0.4 restored provenance**: released through `deno task release` on 2026-08-12, attested (Rekor
`2439323008`, re-verified 2026-10-26). 1.0.2 and 1.0.3 stay unattested forever.

⚠️ **The second loss is the important one.** After 1.0.2, the response was documentation: a warning
in the script header, a contrast table in the roadmap, and a verification step that reports the
damage afterwards. **1.0.3 was then lost the same way.** Documentation does not intervene at the
moment someone types a command.

**Root cause: the names.** `deno publish` and `deno task publish` differ by one word and do opposite
things. The owner's account — *"I thought that was what was happening, that is why I was asking when
it popped up in the jsr instead of the github actions"* — is a naming failure, not a discipline one.
`deno publish` reasonably reads as *the way you publish this package*.

**Fixed by renaming the task to `deno task release` and removing the `publish` task entirely** — an
alias was considered and rejected, because keeping the word available is what keeps it in muscle
memory. `deno task publish` now answers `Task not found` and lists the real one. See
[practices.md](practices.md) §14.

✅ **JSR refuses — settled 2026-10-28 (owner):** with the GitHub repository linked, JSR requires
publishing from a GitHub Actions workflow by default, and the link is in place (`githubRepository`
= `synapticforge1/S3D-ReportCompiler`, read 2026-10-26). A workstation `deno publish` is therefore
refused at the registry, not merely detected afterwards. Deliberately NOT confirmed by trying one:
a probe of a live publish command is a run of it (roadmap § Release path). Kept for the record: this
section used to say "Still worth doing: make JSR refuse".

⚠️ **Score 100 does not mean the release was done correctly.** That is the trap here: JSR reports
1.0.2 at 100, identical to the two attested releases, because provenance is not a scored criterion.
The only way to see the difference is to ask for `rekorLogId` directly, or to notice that no tag and
no release branch were created.

⚠️ A local `deno publish` is not blocked by anything and produces a perfectly good package. The rule
"always release with `bun run release`" (`deno task release` until 2026-10-26) is enforced only by habit — `deno publish` typed directly
still works, and silently costs the attestation.

### Not a bug, but it will look like one — Deno's minimum dependency age

Immediately after a release, `deno install` may **silently install the previous version**, and then
report an error describing *that* version:

```
$ deno install -g -n s3d-reportcompiler -A jsr:@jrmarcum/s3d-reportcompiler/cli
error: Unknown export './cli' for '@jrmarcum/s3d-reportcompiler@1.0.1'.
```

The export exists in 1.0.2. Deno applies a **24-hour minimum dependency age** by default as a
supply-chain measure and resolves to the newest version older than that — so a just-published version
is invisible, and the error names the fallback. `--reload` does not help; this is policy, not cache.

```bash
deno install -g -n s3d-reportcompiler -A --min-dep-age=0 jsr:@jrmarcum/s3d-reportcompiler/cli
```

Worth knowing before diagnosing a phantom packaging bug: the message points at the wrong version, and
everything about it looks like a broken publish.

### Consumer installs off Deno — three README claims that did not hold (measured 2026-10-26)

Found by installing the PUBLISHED 1.0.4 into a scratch project and running it on every runtime
([testing.md](testing.md) § "Runtime matrix"). All three were in the README; all three are fixed
there.

| # | Claim | What actually happens | Silent? |
|---|---|---|---|
| 27 | `npx jsr add @jrmarcum/s3d-reportcompiler` installs on Node | **npm 12.2.0, bundled with Node 24.21.0, refuses it**: `EALLOWREMOTE: Fetching packages of type "remote" have been disabled`, because JSR's npm registry serves the tarball from a URL npm 12 classes as remote and `allow-remote` defaults to `none`. npm 10.9.9 (Node 22) has no such setting; npm 11.20.0 (Node 26) defaults to `all`. Fix: `npm_config_allow_remote=all` for the install (measured: installs, runs) | no — loud, but on the current LTS's default npm |
| 28 | `bunx jsr add @jrmarcum/s3d-reportcompiler` installs with Bun | the jsr CLI picks the package manager from the lockfile; a fresh project has none, so it ran `npm install` (here: "'npm' is not recognized"). **`bunx jsr add --bun`** installs through Bun and writes the project `.npmrc` itself; the README's `~/.bun/bin/.npmrc` step is not needed | no |
| 29 | `bun install -g @jsr/jrmarcum__s3d-reportcompiler` and `bunx @jrmarcum/s3d-reportcompiler` give a command | **JSR's npm packages carry no `bin`** (1.0.4's manifest keys: name, version, homepage, type, dependencies, exports, `_jsr_revision`), so there is nothing to run; `bunx` exits 1. binaryang's guide F4 said so. Node and Bun run `node_modules/@jrmarcum/s3d-reportcompiler/main.js` instead; a global command exists only through Deno or a clone | **yes** for `bun install -g` — it installs and gives no command |

Also measured, not a bug: the README said "Node 22.6+". That holds for the INSTALLED package (JSR
serves compiled JavaScript; 22.6.0 PASSES) but not for a clone, whose `main.ts` needs Node's
unflagged type stripping — 22.6.0 and 22.17.1 fail with `ERR_UNKNOWN_FILE_EXTENSION`, 22.18.0
passes. `engines.node` is now `>=22.18.0`, and `bun run runtimes` checks that floor.

### Not a bug: pdfjs polyfill warnings (measured 2026-10-26)

The verification step prints pdfjs's own warnings, and they differ by runtime:

| runtime | printed | verification |
|---|---|---|
| Deno 2.9.8 | `Cannot polyfill \`Path2D\`` | 173 words / 342 numbers; 13/13 images, 13 diagrams intact |
| Bun 1.4.4, Node 24.21 | `…\`DOMMatrix\``, `…\`Path2D\`` | identical |

pdfjs 4.6.82 fills both in from the optional `canvas` package, which is deliberately not installed
(`.npmrc` `omit=optional`). Both are used only by pdfjs's canvas RENDERER and its in-browser ink
editor — never by the text and operator-list reading the verification does, which is why every count
and the baked document are identical on all three runtimes. Do not stub them or mute the warning
(that turns a loud "rendering may be broken" into silence). The real fix is roadmap task 14.

### The release sweeps uncommitted edits into its commit (found 2026-10-26)

| # | Bug | Silent? |
|---|---|---|
| 30 | **The release commits whatever is uncommitted in `deno.json`, `package.json` and `src/report_core.ts`** — step 2 of `scripts/publish.ts` runs `git add` on exactly those three files before the dirty-tree pre-flight looks, so an unfinished edit to the core module is swept into the "bump version" commit and released. Pinned by the step-4 equivalence case `pub-sweeps-core` (original and port alike); then it FIRED for real on 2026-10-26 (bun-migration, roadmap § Release path) — stopped only because other files were dirty too | **yes** — the commit is titled "bump version", so nothing says code went with it |

✅ **#30 fixed 2026-10-26** (step 4, part 3): `publish.ts` step 0 compares those three files with
`HEAD` (staged and unstaged) and refuses unless every changed line is a version line — the exact
output of `bun run bump`. Proved on Bun and Node: refuses a code edit in `report_core.ts`, a staged
`package.json` edit and a non-version `deno.json` edit (no commit, no tag); still releases after a
real `bump`, with the release commit touching exactly the three files. Inverted: guard disabled →
all three refusal cases fail.

⚠️ **Bug 23 is a gap between two decisions that were each right.** `nodeModulesDir: "manual"` was
chosen so Deno reads the same `node_modules` as Node and Bun, which is what preserves `.npmrc`'s
`omit=optional` and the identical-output property. The workflow was copied from a sibling project that
has **no npm dependencies at all** (`nodeModulesDir: "none"`), so it had nothing to install and no
install step to copy. Neither decision was wrong; the seam between them was never tested.

⚠️ **Why local checks could not have caught it:** `deno publish --dry-run` passed on a working tree
that already had `node_modules` from development. Reproducing it took a **clean clone with no
`npm install`** — which is what CI actually is. A dry run in a dirty tree is not a rehearsal.

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
