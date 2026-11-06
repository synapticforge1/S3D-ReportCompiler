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

The second line, for anyone who points the output into the input folder, changed on 2026-11-05: a
previous bake is recognised by its CONTENT (its fixed title and first report wrapper), whatever its
name, and skipped and named in the output; only `browser_example.html` is still skipped by name. It
used to skip `<output>.html` by name wherever the output was, which silently dropped a real report
of that name from the package, and from both sides of the verification. And an output that would
land on a source report (compared by real path, so junctions, symlinks and subst drives count) is
refused outright. **Keep tooling and examples out of the reports directory.**

### MathJax's limitations are worked around, not removed

Four MathJax 3.2.2 behaviours the bake depends on (async entity tables, U+00A0 in `\text{}`, TeX
errors that typeset instead of throwing, CHTML emitting no SVG): the list, the workarounds and the
test that pins them are in [roadmap.md](roadmap.md) task 8 § "MathJax limitations", M1–M4.
🔒 **Re-check them on every MathJax update** (owner, 2026-11-05).

### The render runs no report code (since 2026-11-06, ledger #55)

The baked document is built from **user-supplied report files**, so its premise was wrong that
`--no-sandbox` was safe because "the input is a document this tool generated itself". Now, in
layers: the bake strips `<script>` blocks AND inline event-handler attributes and `javascript:`
URLs; the assembled document forbids scripting itself (a Content-Security-Policy `<meta>`,
`script-src 'none'; object-src 'none'` — it needs none; measured in Chrome: a handler that ran
without it is blocked with it, and the PDF still prints); and `--no-sandbox` is passed only as root
(a container), where Chrome cannot start without it. ⚠️ Not by Chrome's
`--blink-settings=scriptEnabled=false`: with it `--print-to-pdf` writes NO file, exit 0, empty
stderr (measured 2026-11-06). The "0 scripts" warning counts handler attributes too. ⚠️ The verification
proves every source word and number is PRESENT — it does not prove nothing was added, which is why
the render itself must not be able to change the document.

### Remaining template assumptions

Maths handling is fully template-driven (delimiters read from each document). These are not:

| Assumption | Failure mode |
|---|---|
| `<div id="loading">` is the spinner | spinner survives — **visible** |
| `visibility: hidden` appears only on the reveal gate | un-hides something meant to stay hidden — **visible** |
| `height: 100%` only on wrappers | layout distortion — **visible** |
| Diagram labels for the split check | check silently no-ops — **reported as `0 diagram(s) checked`** |
| Report-heading pattern | count mismatch — **fails loudly** |
| The project-details layout (`Label:  [mathin]\text{  }[mathin]value<br>`), for the sample sanitizer | it refuses: "cannot read the project-details layout" (since 2026-11-06, #45) — **fails loudly** |

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
| 27 | `npx jsr add @jrmarcum/s3d-reportcompiler` installs on Node | **npm 12.2.0, bundled with Node 24.21.0, refuses it**: `EALLOWREMOTE: Fetching packages of type "remote" have been disabled`, because JSR's npm registry serves the tarball from a URL npm 12 classes as remote and `allow-remote` defaults to `none`. npm 10.9.9 (Node 22) has no such setting; npm 11.20.0 (Node 26) defaults to `all`. Fix: `npm_config_allow_remote=all` for the install (measured: installs, runs). 🔁 **Narrowed 2026-10-28** (binaryang re-measured it for ledger C21; re-measured here the same day): only the ALIAS install `jsr add` performs is refused — a direct `npm install @jsr/jrmarcum__s3d-reportcompiler@1.0.4` with `@jsr:registry=https://npm.jsr.io` in `.npmrc` succeeds on npm 12.2.0 with `allow-remote` = `none`, and the CLI runs (`--version` → 1.0.4); the package is then named `@jsr/…`. ⚠️ Probe with a `package.json` in the folder: without one npm writes into the nearest parent project (binaryang's note) | no — loud, but on the current LTS's default npm |
| 28 | `bunx jsr add @jrmarcum/s3d-reportcompiler` installs with Bun | the jsr CLI picks the package manager from the lockfile; a fresh project has none, so it ran `npm install` (here: "'npm' is not recognized"). **`bunx jsr add --bun`** installs through Bun and writes the project `.npmrc` itself; the README's `~/.bun/bin/.npmrc` step is not needed | no |
| 29 | `bun install -g @jsr/jrmarcum__s3d-reportcompiler` and `bunx @jrmarcum/s3d-reportcompiler` give a command | **JSR's npm packages carry no `bin`** (1.0.4's manifest keys: name, version, homepage, type, dependencies, exports, `_jsr_revision`), so there is nothing to run; `bunx` exits 1. binaryang's guide F4 said so. Node and Bun run `node_modules/@jrmarcum/s3d-reportcompiler/main.js` instead; a global command exists only through Deno or a clone | **yes** for `bun install -g` — it installs and gives no command |

Also measured, not a bug: the README said "Node 22.6+". That holds for the INSTALLED package (JSR
serves compiled JavaScript; 22.6.0 PASSES) but not for a clone, whose `main.ts` needs Node's
unflagged type stripping — 22.6.0 and 22.17.1 fail with `ERR_UNKNOWN_FILE_EXTENSION`, 22.18.0
passes. `engines.node` is now `>=22.18.0`, and `bun run runtimes` checks that floor.

### ✅ Gone 2026-10-28: pdfjs polyfill warnings (measured 2026-10-26)

**Resolved by roadmap task 14** (pdfjs-dist 6.4.299 + `@napi-rs/canvas` 1.0.11): no "Cannot polyfill"
line on Deno, Bun or Node, and every verification count unchanged. The 2026-10-26 record follows.

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

### Found during the fourth code review (2026-11-06)

Owner: "yes" to all seven. None of #33–#37 occurs in the 13 samples or the 48-report client set
(surveyed first), and the baked HTML of both is byte-identical after the fixes; they are latent,
for the next template. Tests and inversions: [testing.md](testing.md) § Test suite.

| # | Bug | Silent? |
|---|---|---|
| 31 | **A previous PDF that could not be deleted was read back as this run's output.** The stale-PDF guard (#11) deleted it with `removeQuietly`, which swallows every error — and a PDF open in a viewer on Windows cannot be deleted or written, but CAN be read. Chrome failed to write, exited 0; the old PDF was "Created" (`--no-optimize`) or the build crashed on a raw `EBUSY` after "rendered: X MB" (default). Fixed: the build refuses before baking when the file is still there | **yes**, with `--no-optimize` |
| 32 | **A third positional argument was ignored.** `reports C:\My Docs\out.pdf` unquoted wrote a PDF named `C:\My`; the rest vanished. The #12 class (unknown flags), for positionals. Fixed: more than two is an error naming each | **yes** |
| 33 | **SVG `<style>` hoisting lost conditions and properties.** A rule inside `@media screen` was hoisted as unconditional (rules were matched at any depth); a property with no presentation attribute (`font`, the shorthand) became an ignored attribute, and the sheet was deleted. Fixed: top-level rules only, a property allow-list (SVG 1.1 + `paint-order`, `vector-effect`; not `transform`); anything else keeps the sheet and warns | **yes** |
| 34 | **`<style>` blocks that stayed in the body applied to EVERY report** — a body sheet outside an `<svg>` (never read by `bakeStyle`), and an SVG sheet that could not be hoisted (inline-SVG `<style>` is document-wide in HTML); their `#id` selectors matched nothing once ids were renamed. Fixed: body sheets move to the scoped sheet; kept SVG sheets are confined to their own `<svg data-s3d-scope="rN-">`, ids renamed | **yes** — cosmetic leaks, but across reports |
| 35 | **`html`/`body` selector mapping.** `html body p` → `.rs0 body p` (dead); `body.dark p` → `.rs0 .dark p` (a descendant's class); `p:not(.a, .b)` split at its inner comma (rule dropped); `body + p` → `.rs0 + p` (the NEXT report). Fixed: the leading root chain maps to the wrapper; `.class`/`#id` qualifiers on html/body are settled against the source's own tag; selector lists split at top-level commas; sibling-of-root selectors dropped | **yes** |
| 36 | **`id=` inside another attribute's value was read as an id** — by the bake (renamed `alt="Member id = 4"` to `id=r0-4`, and steered reference rewrites by "4") AND by main.ts's reference guard, which then refused a correct build ("broken by the bake") once the bake was fixed. Both now read a tag's attributes in order, each value whole — written separately, per [design-decisions.md](design-decisions.md) §9 | bake: **yes**; guard: no — a false refusal |
| 37 | **The verification's entity decoder** threw a `RangeError` on `&#99999999;` (stopping verification), decoded no hex references and no named symbols (`&deg;` left "deg" expected in the PDF: a false failure, or masked by "degrees"), and decoded `&amp;#60;` twice. Fixed: one pass, its own table (markup + engineering symbols + Greek), impossible references → U+FFFD as a browser reads them | no — loud, or masked |

⚠️ **The pattern again: #36's second half was in the checker.** Fixing the bake alone made the
guard refuse a correct build, which only the inversion (HEAD `main.ts`, fixed core) showed.

### Found during the review of `scripts/` and the workflows (2026-11-06)

Owner: "fix all". Tests and inversions: [testing.md](testing.md) § Test suite.

| # | Bug | Silent? |
|---|---|---|
| 38 | **A release could be cut from any branch.** `publish.ts` never checked the branch, and `ci.yml` runs on every branch, so `publish.yml`'s "CI passed" gate was satisfied: a feature branch with an upstream pushed itself and its tag, and unmerged code went to JSR and npm, immutably. With no upstream, the behind-check was skipped without a word. Fixed: `publish.ts` step 0b refuses unless HEAD is on `main` tracking `origin/main` (before anything is committed); `publish.yml`'s `ci-green` job refuses a tagged commit not on `main` (compare API) | **yes** |
| 39 | **The sample sanitizer passed fields it did not know.** The project-details block has eight fields; three are scrubbed, and Project ID, Company and Client — empty in all 48 client reports — were never looked at: filled, they were copied into the committed `tests/` with a ✅, because the residue check only looks for values it removed. And that check skipped words under 3 characters and non-ASCII ones, so initials ("JM") or a Greek name left NOTHING to check ("0 token(s) verified absent ✓"). Fixed: any field of that layout other than the three and `Date` / `Project Units` must be empty; residue words of 2+ characters in any script, Unicode word boundaries; a removed value with no checkable word is refused | **yes** — client data into a public repo |
| 40 | **`bun run release` reported success with npm unpublished.** Its last step asked JSR only; the npm job runs after, from the same tag, and failed once (1.1.1). Fixed: `verify-release --npm` (passed by the release) requires the version on npm WITH provenance (`dist.attestations.provenance`), exit 4 otherwise | **yes** |
| 41 | **`verify-release --wait` could call a good release unattested.** `deno publish` makes the version visible, then signs and posts its provenance; a look in between saw `rekorLogId: null` and printed "cannot be fixed … bump and release again". Reasoned from how `deno publish` sequences the two, not observed here (no Deno). Fixed: 8 more looks under `--wait` before that verdict | **yes** — and its advice burns a version |
| 42 | **A push to `main` during a release's CI run failed the release.** `ci.yml` cancelled superseded runs on every branch, so the tagged commit's run became "cancelled" and `publish.yml` refused. Fixed: no cancellation on `main` | no — loud |
| 43 | **`verify-release` ignored unknown flags** (`--wiat` → one look → "not on JSR" right after a release). Fixed: usage error, exit 64 | **yes** |

### Found reviewing that day's own fixes (2026-11-06, third pass)

Owner: "yes fix all". Three of the four were bugs IN the fixes above, found by re-reading them
cold; none touches the current reports (baked HTML byte-identical after).

| # | Bug | Silent? |
|---|---|---|
| 44 | **#34's confinement raised specificity.** Kept SVG rules were prefixed `svg[data-s3d-scope="rN-"]`, so a diagram's bare `text` rule (0-0-1) began to beat the report's own `.rs0 svg text` (0-1-2) it lost to in the source — measured in Chrome (red where the source was green). Fixed: the scope sits in `:where()` (`:where(svg[…]) text`; a rule on `svg` itself becomes `svg:where([…])`), weightless; Chrome measured green again | **yes** |
| 45 | **#39's field guard was blind on a template without the `[mathin]` spacer** — which the scrub itself tolerates. It read no row, and passed a filled Company with ✓. Fixed: the three scrubbed fields must be among the rows it read, or it refuses ("cannot read the project-details layout") | **yes** |
| 46 | **#35's root-qualifier handling, two forms.** The qualifier was read up to the first `~`/`+`/`>`, so `body[class~="dark"] p` lost its rule as a "sibling of body"; and attribute qualifiers were left on the wrapper, so `html[lang=en] p` became `.rs0[lang=en] p`, matching nothing. Fixed: the qualifier is read bracket-, paren- and quote-aware; attribute selectors (`=`, `~=`, `|=`, `^=`, `$=`, `*=`, presence, the `i` flag) are settled against the source tag like classes and ids | **yes** |
| 47 | **The transcript redactor ignored email addresses** (it checked the username and paths; the privacy rule forbids emails too). Fixed: addresses — plain, `%40`, `@` — become `<email>` and count as residue; the trailer's `noreply@anthropic.com`, `git@github.com` and RFC 2606/6761 example/test domains stay. Never echoed | **yes** — latent while the transcript is untracked |

A fourth pass the same day (owner: "fix all") found four more: two in that day's fixes (#48, #49),
one older behaviour beside #32's new argument check (#50), one old generator (#51):

| # | Bug | Silent? |
|---|---|---|
| 48 | **A test passed for the wrong reason, over the network.** `verify-release`'s "the npm hook is fenced" case set only a fake npm, so the script asked the REAL JSR about 9.9.9, stopped at "not on JSR" (exit 2) and passed on "non-zero" -- the fence never ran (offline, the same). Fixed: a fake JSR answers "attested" first; the case asserts the fence's own message | **yes** — a check that could not fail |
| 49 | **#46's attribute settling compared every value with case.** HTML compares a listed set of attribute values caselessly in selectors (`lang`, `dir`, `type`, …; not `class` or `id`): Chrome matches `html[lang=EN]` on `lang="en"`, not with the `s` flag (measured). Settled case-sensitively, the rule was dropped as never applied. Fixed: that list (the HTML standard's), with `i` / `s` honoured | **yes** |
| 50 | **An empty path argument meant "here".** `"$DIR" out.pdf` with DIR unset passed "", which resolved to the working directory and compiled whatever was there. The #32 class. Fixed: refused, naming its position | **yes** |
| 51 | **`control-unknown-delimiter.ts` did not check its own edit** -- it printed "config removed: false" and went on, so a sample change could have turned it into another control (config present: the fallback path never taken). Fixed: it throws, like every other generator. It applies to today's sample, so this changed no run | no — latent |

A fifth pass (owner: "fix all three"), over what no pass had opened — the browser example, the
ignore rules, the tool configuration:

| # | Bug | Silent? |
|---|---|---|
| 52 | **A second batch inherited the first's state.** `mathStats`, `audit` and the delimiter / warning sets are module-level and only grow: fine for the CLI (one build per process), wrong for `tests/browser_example.html` (every click of Bake) and any library caller baking twice. Measured: a clean report alone → 0 failed, no leftovers; after a batch with one bad expression and the fallback delimiters → "1 failed" and a stranded `$` from "$5 per bolt" — refused. Fixed: `resetBakeState()` (new export), called by the browser example before each bake; in headless Chrome two bakes now print the same counts (338, not 676) | no — false refusals and misattributed warnings, never a false pass |
| 53 | **`cmem/local/` was not git-ignored.** The workspace rules put private machine facts there; `/local/` covers only the top-level folder (`git check-ignore`: tracked). Fixed: `/cmem/local/`, and a test that every private path stays ignored | **yes** — a commit would have carried them |
| 54 | **The reference guard ran in the CLI only** (`main.ts`): the browser path and library callers had no protection against a bake breaking a gradient, clip or marker reference, and the browser example showed none of the CLI's warnings. Fixed: `findBrokenReferences()` moved into the core (new export, still written apart from the bake's own attribute reading, design-decisions §9); the CLI and the browser example both run it; the example prints the warnings too | **yes**, off the CLI |
| 55 | **The render could run code carried by a report.** The bake removed `<script>` blocks but kept inline event-handler attributes; Chrome printed with JavaScript on and `--no-sandbox` everywhere, and the "0 scripts" check did not count handlers. Verification proves presence, not absence of additions. Fixed in layers (§ "The render runs no report code" above). None in the real set: the baked HTML differs by exactly the one CSP `<meta>` line (removed, it hashes to the old `7f283563…` / `a19e5ad1…`); new references `cbdd3221…` (samples), `7d5664f6…` (client set); pages unchanged (100, 380) | **yes** |

| 56 | **The font cache would serve an old MathJax version's fonts after an upgrade.** `.mathjax-fonts/` was flat, keyed by file name only, while the URL carries the version (`mathjax@3.2.2`): an update (roadmap task 8) would have embedded the old fonts beside the new stylesheet, with nothing to notice it (verification reads text, not glyphs). Fixed: one folder per URL directory (`cdn.jsdelivr.net_npm_mathjax@3.2.2_…`); an earlier release's flat cache is adopted once, offline (every release so far used 3.2.2) | **yes** |
| 57 | **A download that was not a font was cached and embedded.** Only the HTTP status was checked: a 200 login page (captive portal) or proxy page became a "font" in this and every later build, the maths falling back to whatever the host has. Fixed: kept only with a WOFF/WOFF2 signature (`wOFF`/`wOF2`); refused otherwise with nothing cached ("did not return a font … a captive portal or a proxy page?"); a cached non-font is fetched again; a plain error, not a stack trace | **yes** |
| 58 | **#55's sandbox could keep Chrome from starting on a non-root Linux host** (Ubuntu 24.04 restricts the user namespaces Chrome's sandbox uses; `ubuntu-latest` is 24.04). Not reproducible here (Windows). Loud if it happens — no PDF — but Chrome's message was easy to miss. Fixed: `S3D_CHROME_NO_SANDBOX=1` opts out (off by default; the build says "sandbox: OFF (…)" whenever it is off), and a no-PDF failure naming the sandbox explains it. ✅ **Checked on CI 2026-11-06** (run 42306618122, branch `ci/sandbox-check`, commit `1b1e498`, `ubuntu-latest`): every Chrome render passed with the sandbox ON — the sample build, both test suites, the runtime matrix, the npm proof; the workflows do not set the opt-out, and GitHub's hosted runners run jobs as the non-root `runner` user. ⚠️ The logs were not read (they need an authenticated admin request; `gh` is not installed here): "sandbox on" rests on that runner fact, not on the absence of the build's "sandbox: OFF" line | no — loud |

⚠️ **#52 and #54 add four exports, so the next release is a MINOR (1.2.0), not 1.1.8:** `compat`
says 0 removed, 0 changed, 4 added (`BakedReport`, `ReferenceCheck`, `findBrokenReferences`,
`resetBakeState`). `api-surface.txt` re-baselined to 73 lines in its own commit (Rule 5).

Also confirmed that pass, not changed: #33's premise (Chrome ignores `font="…"` on SVG `<text>`;
computed 16px).

⚠️ **The pattern, sharper: a fix is new code, and gets reviewed like it.** Three of four findings
here were in fixes written hours earlier, each passing its own tests — tests written to the fix's
own idea of the problem. A cold re-read with a measurement (Chrome, a planted template) found them.

⚠️ **While measuring #39, a session printed three real field values to its terminal** (a `sed`
mask that did not apply). Nothing reached a file. Count such fields with a script that prints
only filled/empty — never mask client data after the fact.

### The pattern

Reviews 1–2 found builder bugs; reviews 4–5 found **checker** bugs. As the pipeline hardened, risk moved
into the verification code. Reviews 3 and 5 found no bugs at all — only undocumented reasoning, which is
its own failure mode: a risk reasoned about in conversation and never committed to the file is invisible
to whoever reads it next.

Two controls, two different catches: the **conservation check** caught the self-inclusion bug (#17-adjacent,
the 49-report build); the **negative control** caught the stray-semicolon bug (#15), which conservation
alone missed because the dropped rule was cosmetic and lost no words or numbers.
