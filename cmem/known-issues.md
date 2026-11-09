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

Six MathJax 3.2.2 behaviours the bake depends on (async entity tables, U+00A0 in `\text{}`, TeX
errors that typeset instead of throwing, CHTML emitting no SVG, the two packages that turn errors
into text, definitions that outlive their report): the list, the workarounds and the tests that pin
them are in [roadmap.md](roadmap.md) task 8 § "MathJax limitations", M1–M6.
🔒 **Re-check them on every MathJax update** (owner, 2026-11-05).

### The render runs no report code and loads nothing from outside (since 2026-11-06, ledger #55, #60)

🔁 Since #60 the same `<meta>` also forbids every outside load (`default-src 'none'`; images and
fonts from embedded data; MathJax's font origin for the browser path) and report bodies lose
`<meta>` / `<base>`: measured with a counting server, 5 requests during the render before, 0 after.
The text below is #55's.


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
| 34 | **`<style>` blocks that stayed in the body applied to EVERY report** — a body sheet outside an `<svg>` (never read by `bakeStyle`), and an SVG sheet that could not be hoisted (inline-SVG `<style>` is document-wide in HTML); their `#id` selectors matched nothing once ids were renamed. Fixed: body sheets move to the scoped sheet; kept SVG sheets are confined to their own `<svg data-s3d-scope="rN-">`, ids renamed. 🔁 Superseded by #72 (2026-11-07): such a sheet now moves to its report's scoped sheet | **yes** — cosmetic leaks, but across reports |
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
| 44 | **#34's confinement raised specificity.** Kept SVG rules were prefixed `svg[data-s3d-scope="rN-"]`, so a diagram's bare `text` rule (0-0-1) began to beat the report's own `.rs0 svg text` (0-1-2) it lost to in the source — measured in Chrome (red where the source was green). Fixed: the scope sits in `:where()` (`:where(svg[…]) text`; a rule on `svg` itself becomes `svg:where([…])`), weightless; Chrome measured green again. 🔁 Moot since #72: nothing is confined any more | **yes** |
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

| 59 | **#57's font check passed a download cut short** — only the 4-byte signature was read, and a file truncated mid-download still starts `wOFF`. Fixed: the total length the WOFF/WOFF2 header records (bytes 8–11) must equal the file's size; all 22 MathJax fonts record theirs exactly (measured) | **yes** |
| 60 | **The render could load content from other hosts.** The document is meant to be hermetic, but nothing enforced it: the check counted double-quoted `href`/`src="http…"` only (1 of 7 spellings, measured) and only warned, and the policy (#55) governed scripts alone. Measured with a counting server on 127.0.0.1: under that policy Chrome made 5 requests during the render; whatever came back would sit in a sealed PDF, and verification proves presence, not absence of additions. Fixed: the CSP forbids every outside load (`default-src 'none'`, images and fonts from data only, MathJax's font origin kept for the browser path, `base-uri` / `form-action` closed) → 0 requests; `<meta>` and `<base>` leave report bodies (a refresh is no policy's to stop); the count reads every spelling. The real set loads nothing (its only external host is the SVG namespace, `www.w3.org`): baked HTML differs by the policy line only | **yes** |

### The full-project review (2026-11-06, four reviewers in parallel)

Owner: "a comprehensive look … that covers everything", then "All, in order A→E", and "make
sure the fix is for all conditions that could occur like this, not just this specific case".
Four independent reviewers (core, CLI/runtime, release/CI, tests/config/docs) reported ~40
findings; each was re-run or reasoned before fixing, and fixed as its CLASS. One row per group;
the commits carry the detail. Baked HTML byte-identical on both sets after A–D; E changed the
CSP line only.

| # | Class (group) | Silent? |
|---|---|---|
| 61 | **Wrong content could pass (A, `4d44dc4`).** Maths left as prose (unread quoted config keys, `\u` escapes, an all-refused config falling back to a bare `$`, a guard blind to undeclared delimiters and to failures without a command); a report that was a SYMLINK dropped with PASS (12 of 13 compiled) and hard links past the overwrite guard; text outside `<body>` dropped by bake AND verification; tags read up to the first `>` even inside quotes (in all 48 client reports); CSS ids renamed in attribute values, `html > X`, `:not` judged on the wrapper, `@scope` unscoped; MathJax labels leaking across reports; uncounted removals. All re-run on the old code | **yes** |
| 62 | **A release could publish a commit other than its tag's (B, `ca113f8`).** No concurrency per tag, the npm job checking out the tag by NAME, no tag-vs-version or "JSR 404" check before `deno publish`, the dispatch path skipping every gate, `npm-prove` comparing exports with JSR's LATEST, a queued main CI run cancellable, `tar` failing from Git Bash. Pinning steps run verbatim against the real remote and JSR: 7/7 verdicts right | **yes** |
| 63 | **A build could say something other than what happened (C, `e683ae2`).** Mis-set settings ignored, a folder as output, an unverified PDF under the final name, the HTML of a failed build deleted, no wall-clock bound on Chrome, Ctrl-C leaking the temp profile, test-hook fonts in the real cache | mixed |
| 64 | **Privacy tools missed the class (D, `0769a96`).** The sanitizer cut notes at the first `<br>` (safe today: all 48 use newlines, counted); the redactor passed `/srv`-style paths, and its email residue check could not fail | **yes** |
| 65 | **Tests that could not fail, and false docs (E, `bfa5e32`).** Linux-vacuous redactor cases, a silent root `return`, a filter-dependent check, unchecked generator edits, `tests/controls/` never formatted or linted, the CSP allowing all of jsDelivr, stale README/control claims | **yes** |
| 66 | **The verification expected TeX settings in the PDF (`a41961f`, found by the first real SkyCiv zip, 2026-11-06).** `\color{blue}{…}` in 2 of 75 reports: "blue" reported missing from a correct PDF, the build FAILED, the zip was left untouched (as designed). Fixed as the class of non-printing arguments (colours, spacing, `\phantom`, labels, environment specs, MathJax extensions); [verification.md](verification.md) § How the tricky parts work | no: a false FAIL, loud |

## The second full-project review (2026-11-06, four reviewers again; owner: "All, in order A→E")

37 findings, each re-run or reasoned before fixing, fixed as its class. Baked HTML byte-identical
on ALL THREE real sets after every group: samples `37792fe3…`, the 48-report set `ae70d5e0…`, the
75-report zip `8c1a8887…`; checked counts unchanged (173/342, 174/660, 195/1,176).

| # | Class (group) | Silent? |
|---|---|---|
| 67 | **The bake read markup differently from a browser (A, `dd0e22e`).** Maths paired across element boundaries (two stray delimiters typeset the table cells between them as one expression) and inside attributes (a `title=` broke its tag open into the page); `<br>` in maths typeset as "<"; `<!-->`, `<!--->`, `</script >` cut the text after them from bake AND verification; `<noscript>` kept though not drawn; the spinner removal took any element with `id="loading"` and its subtree; `visibility:hidden` lifted from EVERY rule; `line-height/max-height:100%` rewritten. The verifier skipped text after `\\color` and after an unclosed group | **yes** (the worst two passed a wrong PDF) |
| 68 | **A user's file could be replaced or deleted (B, `43695fc`).** `reports pack.zip` deleted the zip before building; `reports site/index.pdf` replaced (and with `--no-keep-html` deleted) site/index.html; a stale verified PDF outlived later zip builds under the zip's name; "zip unchanged" printed after it was replaced; a renamed zip could not be rebuilt; a timeout over 2^31-1 ms fired at once; Chrome's exit status never read; a kill waited on a pipe; Ctrl-C ended 1 or 130 by chance | **yes** |
| 69 | **The privacy tools took the prefix, not the path (C, `0b41eac`).** The redactor replaced `X:\Users\<name>` and left `\OneDrive - <employer>\Jobs\<client>\…` (and a spaced username's surname), with a residue check that could not see it; `//server/share` passed. The sanitizer wrote a file with an unfound field unscrubbed, scrubbed a decoy "Designer:" line instead of the real row, and never saw labels with digits or punctuation. Zip-build output was not git-ignored | **yes** |
| 70 | **The release path could publish what it did not check (D, `fb76ba1`).** A manual run from an old `release/v*` copy of the workflow; an npm-only run publishing a commit JSR never got; "already on npm" success for any commit; the SemVer gate only on the developer's machine; CI read from any event's run; write access in the job that runs `bun install`; a failed branch push skipping npm; an unpinned install script piped to bash; non-exported types invisible to the compat gate; two unchecked dependency lists | **yes** (latent; nothing published wrongly) |
| 71 | **Tests that could not fail, and false docs (E, `9be2626`).** The zip-refusal test never compared the zip; the test's zip reader hid duplicate names and never read local headers; a symlink test that needs a Windows privilege; README "byte for byte", missing exports and flags; stale control counts | **yes** |

✅ **Owner action (#70), closed 2026-11-06** (owner: "if everything is merged into main and
committed and ready for release 1.2.0 then we can delete the branches", then "All merged
branches"). Checked first:
- the tree was clean on main;
- every branch was fully merged (0 commits outside main);
- `compat.ts release 1.2.0` allowed a minor (v1.1.7's samples PASS);
- types, format and lint passed.

Each `release/v*` named exactly its tag's commit. Deleted:
- on GitHub, the 11 `release/v1.0.0` … `release/v1.1.7` branches and the merged `deps/bun-install`,
  `npm/publish-job`, `step5/test-suite` and `step7/jsr-json`; all carried old `publish.yml` copies
  without the main-only guard;
- locally, the 7 merged work branches (`git branch -d`, which refuses an unmerged one).

Only `main` remains; the 11 version tags keep every released commit. Consequence: an npm-only "Run
workflow" for a version released BEFORE 1.2.0 is now refused (no `release/<tag>` to match). Every
such version is already on npm, so none needs one. From 1.2.0 on, the `record` job writes the
branch, with today's workflow in it.

⚠️ **The next release is a MINOR (1.2.0):** `compat` → 0 removed, 0 changed, **19 added vs
v1.1.7**; `api-surface.txt` 88 lines (each re-baseline in its own commit, Rule 5).

Also confirmed that pass, not changed: #33's premise (Chrome ignores `font="…"` on SVG `<text>`;
computed 16px).

⚠️ **The pattern, sharper: a fix is new code, and gets reviewed like it.** Three of four findings
here were in fixes written hours earlier, each passing its own tests — tests written to the fix's
own idea of the problem. A cold re-read with a measurement (Chrome, a planted template) found them.

⚠️ **While measuring #39, a session printed three real field values to its terminal** (a `sed`
mask that did not apply). Nothing reached a file. Count such fields with a script that prints
only filled/empty — never mask client data after the fact.

## The third full-project review (2026-11-07, four reviewers again; owner: "Fix all in the order you showed from A - E")

38 findings across the core, the CLI and runtime, the release path, and the tests and docs; the
highest-severity ones re-run by the coordinator before fixing. None occurs in the 13 samples or
either real set: the baked HTML is byte-identical on all three after every group (samples
`37792fe3…`, the 48-report set `ae70d5e0…`, the 75-report zip `8c1a8887…`; counts 173/342,
174/660, 195/1,176). Each new test was run section by section against the previous commit, and
each section fails there.

| # | Class (group) | Silent? |
|---|---|---|
| 72 | **The bake could ADD, hide or carry content where verification proves only presence (A).** An undefined TeX command (`\phiM_n`) typeset as red text and counted converted (`noundefined` in `AllPackages`; M5); one report's `\renewcommand{\phi}{0.9}` printed the next report's `\phi M_n` as `0.9 M_n`, through `resetBakeState()` too (M6); a CSS comment naming `@import` deleted rules to the next `;` and left an open `/*` that swallowed later reports' sheets, and `/*` in a string did the same; an SVG sheet confined to its own `<svg>` though HTML applies it to the page (diagram 2 lost diagram 1's `display:none`), `</svg >` and nested SVGs cut short, `!important` and low-weight rivals lost when hoisted; ids in nested CSS not renamed; delimiters and the reveal gate read from commented-out scripts; the reference guard excused a broken reference after `<!-->`; non-UTF-8 reports decoded to U+FFFD on both sides (`decodeReport`, new export); `\begin{array}[t]{lcr}` and `\eqref{key}` expected in the PDF (false FAIL); a "spinner" drawing an embedded image removed by both bake and check, and the check reading `id=` inside a title | **yes** (all but the two false FAILs) |
| 73 | **The CLI could leave or say the wrong thing (B).** An earlier `pack.verified.pdf` held open in a viewer survived a later SUCCESSFUL zip build beside the new zip (`removeQuietly`, the #31 class), and a failed zip build never mentioned it — now removed before the render, or the build refuses; folder reports decoded leniently (now `decodeReport`, as the zip and the browser example); `runWithTimeout` waited as long as a helper held Chrome's stderr and then reported a timeout for an exit 0 (now settles 2 s after the exit); Ctrl-C during verification or the zip write let the build rename or replace while "nothing was finished" was printed; the font download had no time limit, and a cache that could not be written read as "check the network"; a locked or mis-encoded zip was blamed on its layout; `browser_example.html` skipped under a count only; `--keep-html --no-keep-html` settled silently; a per-user Chrome and the Linux package/snap names not found; two Bake clicks interleaved in the browser example | **yes** (the first three) |
| 74 | **Client data could reach a committed file, or the terminal (C).** The sanitizer's residue check blanked entities in the removed value and searched the raw file, so a name written as `&#…;` references (nothing to look for) or spelled `M&uuml;ller` in the title passed with ✓ — both sides now decoded with the full HTML table; its "other fields must be empty" guard read only rows in the exact template shape — now every `Label:` left in the scrubbed block must be one it read; it PRINTED the values it removed (now counts); and nothing checked the COMMITTED samples (now a test: every row of every sample is a placeholder, kept, or empty). The transcript redactor passed `~\…`, `%USERPROFILE%\…`, `$env:…`, `$HOME\…`, a drive-less `\Users\…`, `file://host/…`, `file:///srv/…`, VS Code's `file:///d%3A/…` and `vscode://file/…`, `%5C`-encoded and JSON-escaped (`\/`) paths, and addresses with a non-ASCII domain, a quoted local part or a full-width `＠`; its drive and network residue checks used the rules' own anchors — now looser than every rule | **yes** |
| 75 | **The release path could strand a version, or run code beside its credential (D).** `cancel-in-progress: true` per tag could stop a run after `deno publish` and before `record` wrote `release/<tag>`, leaving a version on JSR that npm-only recovery refuses for good (now queued, not cancelled; the tag re-checks already stop an outdated run; the score poll moved to its own job so `record` follows JSR at once); both publishing jobs held `id-token: write` — the credential JSR and npm trust — while running `bun install`, the compatibility gate (MathJax, pdf.js, the native canvas), the upload check and tsc (now `checks` and `npm-build` run those with no token; `publish` installs with scripts off; `npm` publishes the built artifact, with no `scripts`), and every action floated on a tag (now pinned to commits, both workflows); an npm-only "Run workflow" never made the GitHub release, and nothing checked for one (`finalize` runs on dispatch; `verify-release --github`, passed by the release, exit 5); the compat gate ignored the CLI's environment variables (`cli-env` lines); `publish.ts` ignored unknown arguments (exit 64); `versionUrl` / `NpmInfo` exported for nobody; the lint canary's file not ignored (the FORMAT canary's cannot be: `bun fmt` skips ignored files, measured); the `overrides` pins reach no consumer (now said in the README) | **yes** (latent; nothing published wrongly). ✅ The new job graph ran green on its first run, the 1.3.0 release (publish run 42397518507, 2026-11-07) |
| 76 | **Tests that could not fail, untested paths, false docs (E).** The `&lt;`/`&gt;` control passed a bake that swapped them (every `λ < λp` printed `λ > λp`; inverted and measured) — the test now requires the control's bake to equal the sample's; the image-split, missing-image, diagram-split, report-count and blank-page checks and `compareEachReport`'s `checked: false` had no failing case; the README's first run (no paths: `HTMLFilesToBeCompiled/` or the working directory, `CompiledPDF/combined_report.pdf`) and `--version` were never run; a temp-profile check counted the SHARED temp folder (now its own); a final loop that could not fail, removed; the browser example's "all warnings" missing four; `THIRD-PARTY-NOTICES.md` naming `deno.json`, six files, `deno check`, and no TypeScript (whose `NOTICE.txt` it now names); the README's runtime-matrix hash from before 1.2.0 and a CSP said to forbid every outside load (it allows MathJax's font folder, for the browser path). ⚠️ Still untested, reasoned only: Chrome writing a PDF and exiting non-zero (`main.ts` refuses it) — a stand-in "Chrome" needs a binary that takes Chrome's arguments; Bun and Node fail on its `file://` entry point before any preload runs (measured). ✅ Tested since review 4 (#81) on POSIX: a shebang script IS such a binary there | **yes** (the control; the rest latent or docs) |

## The fourth full-project review (2026-11-07, four reviewers again; owner: "A-E")

Findings across the core, the CLI and runtime, the release path, and the tests, docs and privacy
tooling; every medium-or-higher one reproduced by its reviewer, the top ones re-checked by the
coordinator. None occurs in the 13 samples or either real set (no CDATA sheet, `@layer`,
`\DeclarePairedDelimiter`, head content, `.htm` file): the baked HTML stays byte-identical on all
three (`37792fe3…`, `ae70d5e0…`, `8c1a8887…`). Two of the silent ones were in the 54eb5b2 sheet-move
code itself. Each new test case fails (or leaks) on the commit before it.

| # | Class (group) | Silent? |
|---|---|---|
| 77 | **The bake drew what the source did not, for the next template (A, `36a3e4e`).** An SVG `<style>` read as HTML text: a CDATA-wrapped `.lbl{display:none}` became an invalid rule (the hidden label printed), a `<!-- -->` rule came alive — now read as SVG parses it (`svgSheetText`; markup or an unclosed CDATA refused); `@layer a, b;` dropped as a stray token and layer names shared page-wide (one report's order ruled the next) — now kept, and each report's names its own; mathtools' `\DeclarePairedDelimiter` map and `\mathtoolsset` options outlived the per-report reset (`\phi M_n` printed `(M)_n`), and `\unicode`'s module-private font cache cannot be reset — now cleared / restored, and a `\unicode` after an earlier report's `\unicode[…]` is refused; another diagram's MOVED sheet ignored as a hoist rival; a `<div>` or text inside `<head>` (or with no `</head>`) dropped by bake and check alike; `:where(body)`, `:is(html, body)` and a leading `* >` scoped to match nothing; an unclosed `<svg>` with a sheet crashed as "internal"; `.htm` files silently skipped by a folder build (12/13, PASS) — now refused by name; a marked `.html` in a zip taken for the old PDF. Two reports defining one `@font-face` family / `@keyframes` / `@counter-style` / `@property` differently now warn (page-wide names; not renamed) | **yes** (all but the crash) |
| 78 | **The verifier did not check what definitions print (B, `36a3e4e`).** `\newcommand` / `\def` / `\DeclareMathOperator` bodies were dropped from the expected text, though they print at every use — now expected, their `#1` blanked (a macro defined and never used now FAILS, the safe direction); `\unicode[…][font]`, `\newtagform`, `\usetagform`, `\Newextarrow`, `\DeclarePairedDelimiter(X)`, `\mathtoolsset`, and `multlined`/`aligned`/`gathered` options were expected as text (false FAIL) | **yes** (the first) |
| 79 | **Client data could pass the privacy tooling (C, `39533d8`).** The sanitizer's block guard compared LABELS: a second `<b>Client</b>:` row, a Client whose first line was blank, a line with no colon all passed — now row by row, each label once; its residue check missed a legacy `&auml` (no `;`) and a decomposed or full-width name — now decoded and NFKC on both sides; the committed-samples test PRINTED a failing row and value (now row numbers only). The redactor left `"<path> Steel"` for a quoted folder name with a space (now a quoted path goes whole), passed `smb://` / `afp://` / `//<IP>/` shares, a clipped `…@brumby-mail.o` and `bob@[192.168.1.1]` (its email residue used the rule's own domain), and ate prose after a home path, a code span's backtick and trailing punctuation. ⚠️ Partly so (review 5, #84): "a quoted path goes whole" held for a fixed list of path starts only, and the prose fix for one shape of line | **yes** |
| 80 | **The release path's own checks could be satisfied wrongly (D, `5476818`).** The workflow test matched a trailing `# --ignore-scripts` comment, missed `npm ci` / `bun i` / `bunx` / `npx`, `uses:` with two spaces or `docker://`, and asserted no job's permissions; `checks` and `publish` floated Deno `v2.x` separately; "Run workflow" resolved a moved tag without comparing `release/<tag>`; the npm artifact lived 1 day; only `S3D_JSR_API` fenced a release; `--github` did not compare the tag's commit to `release/<tag>`; npm-prove read any non-200 from npm.jsr.io as "not on JSR yet", and its fetches and check-runtimes' had no timeout; `npx serve` unpinned | **yes** (latent; not yet exercised by a release) |
| 81 | **CLI and runtime loose ends (E).** After the 2 s exit grace Chrome's helpers were left running (now its POSIX process group is killed); a `CHROME_PATH` launcher that exits at once resolves early (now said in the docs and the "no PDF" error); `pack.verified.pdf` removed without a word, and its refusal blamed Chrome; an interrupt during a final rename could clean up beside it (now held until the rename ends, and the finished file named); an uncreatable output folder ended in a stack trace; a font cache that could not be written failed a build whose fonts had arrived (now a warning); the browser example kept the last good preview after a refusal, lost a thrown error, and said nothing when its local bundle was stale; the default-layout test depended on an earlier test's font cache; `S3D_CHROME_TIMEOUT_MS` was documented only in a changes row. ✅ Tested since (owner: "yes", the same day): the group reap, the launcher hint and the interrupt hold by a POSIX test with a stand-in Chrome (a shebang script run by the test's runtime; the rename slowed by a preload) — run in WSL here and on CI's Linux runners, skipped on Windows; the browser example by a test that drives it in headless Chrome over the DevTools protocol (bundle built into the work folder; a stale one made by dropping `decodeReport` from its exports). Each fix, reverted alone, fails its test | partly |

## The fifth full-project review (2026-11-07/08, four reviewers again; owner: "I agree fix all", then "fix D first, then do E and C")

Findings in every area, most reproduced by the reviewers (the core's in headless Chrome, the
CLI's in WSL), the top ones re-checked by the coordinator. Two classes were in review 4's own new
code (the interrupt hold, Chrome's own process group). For the first time a fix CHANGED the real
sets' baked HTML: A's restored selector weight — and only by the added weight-only selectors
(identical once removed), with every page of the samples' and the 48 set's PDFs carrying the same
text at the same positions (100/100, 380/380). New reference hashes: samples `487321f2…`, the 48
set `da92578d…`, the zip `f0922226…`; the six-runtime matrix bakes `487321f24fb9` everywhere.

| # | Class (group) | Silent? |
|---|---|---|
| 82 | **The cascade the source had was not kept (A, `eb56708`).** Mapping `html`/`body`/`:root` onto the wrapper dropped their weight (`body .x{display:none}` lost to a later `.x{display:block}`; `body#main` lost an id) — restored with `:is(#s3d-w, *)`-style fillers by a real `specificity()`; the hoist's rival check skipped `:is(text)` / `:not(rect)` as heavier; a rule hoisted onto HTML inside `<foreignObject>`; a `<style>` before `<head>` read by neither half of the bake; a top-level `:scope` scoped to match nothing; the reveal gate opened an `!important` hide its script could not, and an `@layer a, b;` before the gated rule kept it shut (false FAIL); an aliased `\unicode` set the font cache unseen; a `<style>` inside `<template>` / `<textarea>` applied (and the textarea lost its text); `svgSheetText` decoded with the verifier's table | **yes** (all but the gate's false FAIL) |
| 83 | **Interrupts and hang-ups said the wrong thing, or let Chrome outlive the build (B, `ef8a70d`).** An interrupt during a final rename that then failed said "this is complete" and deleted the verified PDF; one after the rename said "nothing was finished"; the asynchronous cleanup let the build go on beside it; review 4's own process group for Chrome meant a hung-up terminal (SIGHUP, unhandled) left Chrome to write its PDF after the build died; `.shtml` / `.mhtml` / `.mht` left out with PASS; a folder at `<out>.unverified.pdf` blamed on Chrome; a cache that could not be written deleted the earlier release's fonts anyway | **yes** (most) |
| 84 | **Client data could still pass the privacy tooling (C).** The redactor: a name with an apostrophe (`O'Brennick Steel`) left `'Brennick Steel\…`, exit 0; review 4's "a quoted path goes whole" covered a fixed list of starts only — a POSIX root outside it, a `file:` scheme, `~` / `%USERPROFILE%` in quotes and curly quotes kept the folder name's second word, and so did two spaces and a spaced username at a line's end (review 4's own change); it still ate prose up to a later file name or drive; addresses clipped before the dot or at the "@", dot-less, or double-encoded (`%2540`) passed, and so did `//host.corp/…`; it PRINTED 70 characters around a surviving username. Now one quoted-path rule for every start (closing only where no letter follows), case-sensitive continuation words that never start lowercase or reach a drive, addresses by a shared domain shape (never a version or `name@scope/…`), intranet hosts, the username by line number. Measured on the local transcripts (counts only): every path residue equal or lower, 0 email residues (two false ones — `"\"@scope/"` in JSON, `@v5` — found and removed first). The sanitizer: its block could end before the field rows (an empty `<div></div>` after the heading), so a filled Client row passed with ✅ — the block must now hold every field row; its residue check read markup, so a soft hyphen, a zero-width space, a tag inside the name, or the name inside a longer word hid it — now text with invisible characters removed and tags removed, five-letter tokens also as substrings. The real 48 still pass. 🔁 **Then the one limit left documented, fixed on request** (owner, 2026-11-08: "fix the last item noted also"; `D:\Jobs\acme steel`, unquoted, at a path's end, left "steel" — no rule can tell it from prose): the redactor now LEARNS spaced folder names from the same file — inside a rooted path with a separator after them, or as a segment of a quoted path that is nothing but a path — and from the DISK: it runs where the transcript was made, so for a path followed by words it takes the longest run of up to six that exists as a folder. Learned names are taken whole at a path's end (drive, POSIX and home paths), and their later words left after a placeholder count as residue. A first version learned from any two slashes of prose (285 "names" in one transcript, path residues up 44 → 106) — measured, then narrowed to rooted paths and name-like words (20 names; every residue count equal or lower than before). Left: a name written once, unquoted, for a folder no longer on the machine | **yes** |
| 85 | **The release path could strand a version, or check less than it said (D, `5d1d7b1`).** A `deno publish` that uploads and then fails (status poll, provenance signing) left the version on JSR with `record` and npm skipped and no recovery (re-runs refused at JSR's 404, dispatch at the missing branch) — now followed on `uploaded`, with JSR's 200 required; JSR could publish a number npm can never take (npm reuses none); an empty Deno version silently floated the pin; the npm package that ships was never proven in the release; `--github` did not compare npm's `gitHead`; the workflow test missed `#` in quotes, a quoted or spaced `id-token`, scripts run by path or from `node_modules`, and job names with `_` or digits; the timing hooks not fenced | **yes** (latent; not yet exercised by a release) |
| 86 | **Tests and docs (E).** `verify-pdf-text.ts` printed page 1's text — a client's project details on a real build — unasked (now `--show-text`); it and `export-transcript.ts` had no test; a root-only skip in a lock case was silent; the browser test could leave its server running if Chrome failed to start; a broken relative link in the roadmap; the browser example's unpinned `npx serve`; the README's runtime matrix quoted the pre-review-5 hash (re-run: six runtimes, `487321f24fb9`); the changes table had no row for what is unreleased (reviews 4 and 5) | partly |

## Class-by-class review (2026-11-08; owner: fix one class completely, re-check it, then the next)

Six read-only reviewers, one per CLASS of issue across the whole project (A output fidelity, B
verification gaps, C privacy, D release integrity, E lifecycle and errors, F tests and docs). Each
class is fixed, then re-checked by a fresh reviewer of that class alone before the next begins.

| # | Class | Silent? |
|---|---|---|
| 87 | **B — the verification checked substrings, not values.** Numbers were searched as substrings of a stream with all spaces removed, and the PDF's text items were joined with nothing: `0.9` passed as `0.95`, `125` as `1250`, `1,250` as `250`, cells "12" "5" as "125" (30% of the samples' numbers would have passed deleted); signs, separators and exponents split numbers (`-12.5` → `12.5`, `1,000` → `1.000`, `1.5e-3` → `1.5e3`); words were three ASCII letters or more (`OK` → `NG`, `kN` → `mm`, `λ` → `φ`, `mm²` → `mm³`), and command names were deleted from the whole report's words (`\max` hid a "Max" heading); text drawn transparent or white, an image cut by a page break whose totals agreed with a lost one, and a diagram cut while another on its page was whole all passed; maths left as prose behind a delimiter the bake could not read passed (the guard read the bake's delimiters, §9); one token-named `\newcommand` blanked every later `#7`; an id two reports share went unseen by the reference guard, and `href=" #g"` was no reference; content before the first report's heading belonged to no report; legacy and Latin-1 entities, a `<template>` and an SVG `<title>` / `<desc>` were false FAILs. Fixed (verification.md § Comparison technique): the PDF read with its gaps, tokens matched whole, signed / separated / exponent numbers, two-letter words of any script and every non-ASCII symbol case and all, TeX glyphs expected, the PDF-side checks above. All three real sets pass; vacuity 1% / 0%. ⚠️ Still unseen: text under an opaque box, a diagram's drawing | **yes** (all but the false FAILs) |
| 88 | **B, re-check 1 — what #87's rules still let through.** A comma after any digit was read as a thousands separator: `max(12.5,300.2)` gave no number at all and `(1,2)` only "1", and the samples write `\max(96.982,50.675)`. A bare number was found after a sign (`12.5` → `-12.5`). Words were lower-cased, so `MN` → `mN` and `MPa` → `mPa` passed. White and invisible were exact tests: `#fefefe`, `opacity: 0.02` and `rgba(…, 0.02)` all passed, and a group's alpha was replaced, not multiplied. An image clipped away by `overflow: hidden`, or drawn 1 px square, passed. `\max` / `\min` / `\sin` were blanked though they print their names; `^\circ` expected nothing. False FAILs: a spaced binary minus (`M_{u} -0.537` prints "- 0.537"), prose `m^2` / `x_1` read as TeX residue, a phrasing tag or zero-width character inside a token (`<b>0</b>.95`), a letter-spaced number. Fixed: a comma is a separator only inside a whole integer of groups; no bare number after a sign, a signed one may print its minus spaced; a word of three letters or fewer keeps its case (found as written or in capitals); every channel ≥ `0xF0` is white, alpha ≤ 0.1 is invisible, multiplied through groups; an image under 2 pt or less than half inside its clip fails; operator names expected, `\circ` → ∘; residue only in its braced form; phrasing tags join, zero-width characters dropped; digits may stand 0.35 heights apart (the nearest separate numbers in both PDFs: 4.3). All three real sets pass, baked HTML unchanged. ⚠️ Left, and why: one-letter units (`12 m` → `12 N`; a single letter is in every report, so checking it alone proves nothing); grey on grey (no background in the PDF's text check); an image's pixels; a number broken across lines (`word-break: break-all`; a line break is never joined, else rows would join; it fails, the loud direction); maths with bare marks only (`$12.5+3$`; its characters are still all checked). 🔒 **Superseded the same day (owner: "We need fixes not limits"):** each of these, and the two older limits (a diagram's drawing, reports paired by position), is scoped as a fix in roadmap task 18, with re-check 2's findings | **yes** (all but the false FAILs) |
| 89 | **B, re-check 2 (task 18 group 1) — presence was enough, and the counts did not match.** Each word and number had only to appear ONCE in its report's pages: 64% of member_0's numbers occur twice or more, so a changed second `30.483`, a deleted line and `STATUS PASS` → `FAIL` all passed. A word split over a line break passed (`k` / `N`); the capitals stand-in let `mN` pass as `MN` (10⁹) anywhere; text at 0.17 pt, or `scale(0.01)`, passed; `#eeeeee` on the white page passed. Fixed: every occurrence counted, per report — a token found fewer times is named with its counts, `30.483 (2 of 3)`; one space between letters, never a line break; capitals stand in only for a source word with none, on an all-capital PDF line, and only beyond the occurrences the source's own capital token claims; text under 2 pt fails; contrast against the white page under 3:1 (WCAG's large-text floor) fails, replacing the near-white test — the real sets' lowest is 8.6:1 and smallest text 3.61 pt, both now on the build's `legible:` line. **Found while fixing it, both from counting:** the two sides must be counted by ONE matcher (by tokens, the source's `t_{w}` was no "tw" while its printed "t w" matched one, and the PDF's surplus hid a deleted `of`, `tw`, `Pr`, `ry`); a Greek symbol no longer blocks a Latin word's boundary (`\phi P_{c}` prints "ϕPc"); the headings' own `OF` had been counted as `of` too. One-occurrence vacuity on member_0: 0 of 114 numbers, 0 of 218 words (deleting ONE occurrence of each, in turn). The hidden-row control now names all 24 words and 7 numbers of the row | **yes** |
| 90 | **B (task 18 group 2) — a maths config only running it could tell.** `parseDelimiters` read a config key only as an array literal; `inlineMath: D` (a variable) counted as NO config, the default delimiters stood in, the report's own (`@@`, `$`) were never applied, and its maths printed as prose. The guard looks for the delimiters the bake read, and the LaTeX check for the standard ones, so a report PASSED with `@@x = 4471@@` printed raw (measured end to end). Fixed both sides: the bake follows a variable to its last array assignment (in its script, then the scripts that ran before), and REFUSES anything else (`makeDelims()`, `D.concat(E)`, a variable assigned a call), naming every such report, nothing written. The verification reads each source's delimiters with its own code (main.ts `declaredDelimiters`, §9), over-inclusively — every script, any type, live or not — and fails a report whose own pages print a declared pair around text. ⚠️ So a DEAD config (inside `<noscript>`, say) whose delimiters the prose prints fails too, though a browser shows the same: the loud direction, accepted. All three real sets pass, baked HTML unchanged | **yes** |
| 91 | **B (task 18 group 3) — reports paired with the PDF only by position.** `compareEachReport` compared segment k with source k; two reports exchanged in assembly were each checked against the other's source, and passed whenever the shared template text and the member number elsewhere on the page supplied the tokens (measured on a unit pair). Nothing checked the package's ORDER either: a change to `sortReportNames` would ship member_10 before member_2. Fixed: segment k's printed heading must equal source k's, member number included (spaces and case aside), or the per-report check does not run and says "exchanged or out of order" (a failure); the build order must be the verification's own reading order (main.ts `readingOrder`, §9: digits as numbers, the rest as text, ties in any order). Inverted: the exchanged pair passes on the commit before; the order check by mutation (the build's sort made plain → "reports out of reading order: member_10_report.html before member_2_report.html"). All three real sets pass | **yes** |
| 92 | **B (task 18 group 4) — a number checked alone.** The value was still printed, so a changed unit or operator passed: `12 m` → `12 N`, `30.483 <` → `>` (the sample's own slenderness check), `12.5+3` → `12.5-3`, `85%` → `85`; no ASCII operator was a token, so an empty cell's `-` → `+` passed too. Fixed: each number is counted WITH its neighbours — the unit, word, operator or `%` right after it and the operator right before it, a sign counting as the operator before its digits — and `<`, `>`, `=`, `+`, `%` and every `-` are counted symbols. ⚠️ The design that held, after three that failed the correct samples: source pairs only WITHIN one run of text (an element's own text or one maths expression: every non-phrasing tag, display maths and TeX `\\` end a run), because across elements the page's reading order is the layout's (a verdict box made "1.0 STATUS" a pair the page prints in another order); on the PDF side any whitespace is a space, as a run may wrap ("360-16" / "LRFD"); a Greek symbol is a neighbour on its own (`2\phi P_c` prints "2ϕPc"). The report's own declared maths delimiters are blanked from the source text (a `%%` delimiter is no expected `%`), read by the verification's reader, now in the core (`declaredDelimiters`), which also names a declared pair printed in a report's own pages ("@@..@@ printed as prose"). Neighbour vacuity on member_0: each of 203 units, operators and `%` beside a number changed in turn — 0 still pass; one-occurrence vacuity 0 / 114 numbers, 0 / 223 words. The controls now miss 223 / 116 and name the hidden row's 26 words and 21 numbers. ✅ Its last gap closed the same day (owner: "fix the last gap in group 4 before moving to group 5"): a unit in a cell of its own was not paired with its number, so two rows' units exchanged (`12 m`, `5 N` → `12 N`, `5 m`) kept every number and unit and passed. The cells of one table row are now one run (a row prints left to right; Chrome's PDF keeps that order, measured end to end); a row's end still ends a run, so a row's last value and the next row's label are no pair. All three real sets pass, baked HTML unchanged | **yes** |
| 93 | **B (task 18 group 5) — a token wrapped across lines failed a correct PDF.** `word-break: break-all` printed 77.531234 as "77.5" / "312" / "34" on three lines; the page text had line breaks inside the number and the build FAILED (the loud direction — but a false FAIL; words alike, `Ax` / `ial`). Measured: Chrome gives every block element its own marked content, and the wrapped pieces share one; it writes NO space at a line's end even at an ordinary word wrap, so the PDF cannot say which kind of wrap it was. Fixed: `pageText` (now reading marked content) writes a SOFT BREAK (U+2028) at a wrap within one element between two letters or digits, and the core joins each one only where one of the report's own numbers or words stands whole across it (`resolveSoftBreaks`); every other is a line break. ⚠️ Decided one break at a time: read all one way, the ordinary wrap after "LC3" made "377.531234". ⚠️ Tooling: the Edit and Write tools turn a ` ` escape into the literal character, which is a line terminator inside a regex literal (a syntax error) — the code builds it from `0x2028`. All three real sets pass, baked HTML unchanged | **no** (it failed loudly) |
| 94 | **B (task 18 group 6) — text read against the white page only, and never seen under what was drawn over it.** Measured end to end on the commit before: grey on grey (`#777` on `#888`, 4.5:1 against white, 1.26:1 against its own background) PASSED; a value under an absolutely positioned white box PASSED (it is still in the text layer); black text on a black image PASSED; white text on a dark band, and on a dark image, FAILED correct pages. Fixed in `readPdf`: every filled rectangle (pdf.js 6: moveTo, three lineTo, closePath) and image is kept with its clipped box, colour, alpha and paint order; every visible text show gets its box from the text matrix, font size and glyph widths. The colour behind a show is the paints before it holding its centre, each laid over the one under it by its alpha, from the white page up — an image sampled from its own pixels under the text; contrast under 3:1 against it fails; an opaque (alpha ≥ 0.9) fill or image painted after it over half its box or more is "text covered". The real sets' lowest is still 8.6:1, none covered. **Found on the way:** a positioned table cell is painted after the rest of its table (measured: after the next row), so group 4's cell pairs failed a correct page; a cell pair now holds if its cells are neighbours in the page's order OR on one VISUAL line in any order (the CLI appends each page's visual lines after U+2029 for the core; content order for everything else), and `pageText` no longer ends a line where pdf.js only jumped back left on the same baseline. ⚠️ A parameter RENAME is an API change to the gate (`compareEachReport`'s `pageTexts` → floor major): renamed back. ⚠️ Still not seen: a non-rectangular shape over text (curves are never covers or backgrounds) | **yes** (grey on grey, covered, dark on a dark image) |
| 95 | **B (task 18 group 7a) — images counted, never looked at.** The check counted image paints per report; what each showed was never compared, so an image drawn otherwise than its source (measured: `filter: grayscale(1)`, rasterised by Chrome at 576×624) and an image in a format nothing read (WebP) both PASSED. Measured on Chrome's PDFs: a PNG or GIF is written as its decoded pixels at FULL resolution (also when displayed smaller), a GIF's FIRST frame, transparency as an alpha mask; a JPEG as its own bytes (DCTDecode, byte for byte); a WebP re-encoded as pixels; an SVG `<img>` as paths. Fixed: `drawnImages(source)` (core, a NEW EXPORT — floor minor, its own commit `5b8906f`) gives each report's drawn images in order from the verification's own extraction; main.ts decodes each with its OWN decoders — PNG (every colour type and depth, palette, tRNS, Adam7, on `node:zlib`), GIF (LZW, first frame, transparency, interlace), JPEG through pdf.js from a scratch pdf-lib PDF (its bytes unchanged, so equal pixels) — and compares it, both composited over white, within 2 levels of 255 a channel (Chrome's alpha rounding measured under 1), with the image painted on the report's own pages. Anything else FAILS by name ("image/webp is not verified"). All 136 images of the three real sets identical; 11 format variants pass (alpha, 16-bit, palette+tRNS, 1-bit grey, interlaced, displayed at a quarter size, gamma chunk, GIF transparent / interlaced / animated, JPEG). ⚠️ Still to come: WebP (group 7b, owner: own decoders); an SVG `<img>` is drawn as paths, so it fails on the image COUNT today — group 8 checks it as geometry and must leave it out of the count | **yes** |
| 96 | **B (task 18 group 8a) — only a rectangle was a cover or a background.** #94 kept filled RECTANGLES only, so a value under a rounded white box (`border-radius`, drawn with curves) PASSED, dark text on a dark circle PASSED, and white text on it FAILED a correct page (measured on the commit before). Fixed: every filled path is flattened into polygons on the page (pdf.js 6 path commands; a curve in 8 segments), kept with its fill rule (non-zero or even-odd) and its clip; a paint is behind text when it holds the text box's centre, and covers it when half or more of a 7 by 3 grid of points in the text box falls inside it (a rectangle's or an image's polygon is its box). All three real sets pass, unchanged; ⚠️ the builds take about a quarter longer (client set 44 s, was 35 s), every text show tested against every filled shape of its page | **yes** |
| 97 | **B (task 18 group 8b) — a diagram's drawing was never checked.** Only its title and caption were (on one page, in order); a curve redrawn, a colour changed, a grid line lost or added, a label moved all PASSED. Measured on Chrome's PDFs: each SVG shape is one path in the shape's OWN coordinates (relative commands resolved), under the element's SVG transform times one base transform for the drawing; a fill and a stroke are two paths; curves and arcs are Béziers; a dashed stroke is one path of its dash segments, or — wider than a device unit — the FILL of the dashes' outlines; a stroke thinner than a unit is a hairline (width 0) at alpha × width; a gradient is a shading pattern (even with one stop), a gradient with stop-opacity a tiling pattern under a luminosity mask; a marker is its own shapes under its own transform; a line of zero length draws nothing (a client set's charts write `y1="NaN"`: 408 grid lines in 14 reports). Fixed: `src/report_svg.ts` (not in the exports map) reads each drawing (`drawnSvgs`, its own commit `e309acd`) — every shape, transforms composed, the cascade of the report's stylesheets and the drawing's own (descendant and child selectors, specificity, `!important`, inline, `@media print`), dashes, opacity, gradients (linear and radial, href chains, units, transform, spread), markers (viewBox, ref point, markerUnits, orient), `<use>`, nested `<svg>` — and matches every fill and stroke to one PDF path: the same outline (flattened, both ways), under the shape's transform times the base found by a vote, in the same colour (a gradient by sampling both sides at points of the shape), alpha and width; no other path painted among them; every label at its anchor, along its own direction. Named, never passed: a filter, a mask, a `<pattern>` paint, a gradient with stop-opacity, `<foreignObject>`, `<image>`, a style rule it cannot match that could reach an SVG element. All three real sets pass (1277, 4874, 5491 paints and labels); a bake mutation that changes one colour and one radius fails, naming both. ⚠️ Builds take longer: 52 s for the 48 set (35 s before groups 6-8). ⚠️ Still to come: an SVG `<img>` (fails on the image count today) and WebP (7b) | **yes** |

### The pattern

Reviews 1–2 found builder bugs; reviews 4–5 found **checker** bugs. As the pipeline hardened, risk moved
into the verification code. Reviews 3 and 5 found no bugs at all — only undocumented reasoning, which is
its own failure mode: a risk reasoned about in conversation and never committed to the file is invisible
to whoever reads it next.

Two controls, two different catches: the **conservation check** caught the self-inclusion bug (#17-adjacent,
the 49-report build); the **negative control** caught the stray-semicolon bug (#15), which conservation
alone missed because the dropped rule was cosmetic and lost no words or numbers.
