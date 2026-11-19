# Known Issues, Template Assumptions & Bug Ledger

Live constraints and the issues still open. The closed ledger (#1–#130) and the review rounds:
[archive/known-issues-ledger.md](archive/known-issues-ledger.md) (since 2026-11-19, H38).

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

Columns: Assumption · Failure mode.

- `<div id="loading">` is the spinner — spinner survives — **visible**
- `visibility: hidden` appears only on the reveal gate — un-hides something meant to stay hidden — **visible**
- `height: 100%` only on wrappers — layout distortion — **visible**
- Diagram labels for the split check — check silently no-ops — **reported as `0 diagram(s) checked`**
- Report-heading pattern — count mismatch — **fails loudly**
- The project-details layout (`Label:  [mathin]\text{  }[mathin]value<br>`), for the sample sanitizer — it refuses: "cannot read the project-details layout" (since 2026-11-06, #45) — **fails loudly**

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


## Still true, and easy to mistake for a bug

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

Columns: # · Claim · What actually happens · Silent?.

- 27 — `npx jsr add @jrmarcum/s3d-reportcompiler` installs on Node — **npm 12.2.0, bundled with Node 24.21.0, refuses
  it**: `EALLOWREMOTE: Fetching packages of type "remote" have been disabled`, because JSR's npm registry serves the
  tarball from a URL npm 12 classes as remote and `allow-remote` defaults to `none`. npm 10.9.9 (Node 22) has no such
  setting; npm 11.20.0 (Node 26) defaults to `all`. Fix: `npm_config_allow_remote=all` for the install (measured:
  installs, runs). 🔁 **Narrowed 2026-10-28** (binaryang re-measured it for ledger C21; re-measured here the same day):
  only the ALIAS install `jsr add` performs is refused — a direct `npm install @jsr/jrmarcum__s3d-reportcompiler@1.0.4`
  with `@jsr:registry=https://npm.jsr.io` in `.npmrc` succeeds on npm 12.2.0 with `allow-remote` = `none`, and the CLI
  runs (`--version` → 1.0.4); the package is then named `@jsr/…`. ⚠️ Probe with a `package.json` in the folder: without
  one npm writes into the nearest parent project (binaryang's note) — no — loud, but on the current LTS's default npm
- 28 — `bunx jsr add @jrmarcum/s3d-reportcompiler` installs with Bun — the jsr CLI picks the package manager from the
  lockfile; a fresh project has none, so it ran `npm install` (here: "'npm' is not recognized"). **`bunx jsr add
  --bun`** installs through Bun and writes the project `.npmrc` itself; the README's `~/.bun/bin/.npmrc` step is not
  needed — no
- 29 — `bun install -g @jsr/jrmarcum__s3d-reportcompiler` and `bunx @jrmarcum/s3d-reportcompiler` give a command —
  **JSR's npm packages carry no `bin`** (1.0.4's manifest keys: name, version, homepage, type, dependencies, exports,
  `_jsr_revision`), so there is nothing to run; `bunx` exits 1. binaryang's guide F4 said so. Node and Bun run
  `node_modules/@jrmarcum/s3d-reportcompiler/main.js` instead; a global command exists only through Deno or a clone —
  **yes** for `bun install -g` — it installs and gives no command

Also measured, not a bug: the README said "Node 22.6+". That holds for the INSTALLED package (JSR
serves compiled JavaScript; 22.6.0 PASSES) but not for a clone, whose `main.ts` needs Node's
unflagged type stripping — 22.6.0 and 22.17.1 fail with `ERR_UNKNOWN_FILE_EXTENSION`, 22.18.0
passes. `engines.node` is now `>=22.18.0`, and `bun run runtimes` checks that floor.


### The release sweeps uncommitted edits into its commit (found 2026-10-26)

Columns: # · Bug · Silent?.

- 30 — **The release commits whatever is uncommitted in `deno.json`, `package.json` and `src/report_core.ts`** — step 2
  of `scripts/publish.ts` runs `git add` on exactly those three files before the dirty-tree pre-flight looks, so an
  unfinished edit to the core module is swept into the "bump version" commit and released. Pinned by the step-4
  equivalence case `pub-sweeps-core` (original and port alike); then it FIRED for real on 2026-10-26 (bun-migration,
  roadmap § Release path) — stopped only because other files were dirty too — **yes** — the commit is titled "bump
  version", so nothing says code went with it

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


## Open issues

Open review findings (R1–R9, from T1-3 on 2026-11-12) live in the git-ignored `cmem/review-issues.md` since
2026-11-19 (letter H37 (c); the review standard keeps open issues off GitHub). The text they had here is in git
history before that date. Their count is in [STATE.md](STATE.md).

## The pattern across the reviews

Reviews 1–2 found builder bugs; reviews 4–5 found **checker** bugs. As the pipeline hardened, risk moved
into the verification code. Reviews 3 and 5 found no bugs at all — only undocumented reasoning, which is
its own failure mode: a risk reasoned about in conversation and never committed to the file is invisible
to whoever reads it next.

Two controls, two different catches: the **conservation check** caught the self-inclusion bug (#17-adjacent,
the 49-report build); the **negative control** caught the stray-semicolon bug (#15), which conservation
alone missed because the dropped rule was cosmetic and lost no words or numbers.

