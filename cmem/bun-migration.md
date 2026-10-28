# bun-migration.md — moving the toolchain off Deno, keeping JSR (in progress: steps 2–4 done)

🔒 **Goal (owner, 2026-10-28): "the goal is to be deno free on this machine."** Deno may run only
where JSR needs it — `deno publish` on GitHub's runner, installed per run by `setup-deno` — and
nowhere on a developer machine. `npx jsr publish` is NOT the way out: measured 2026-10-28 on the
`jsr` CLI 0.14.3, it downloads a pinned Deno (v2.6.7, older than ours) and runs `deno publish` as a
subprocess, adding `--no-check` when a `package.json` exists (it does here) — Deno hidden, the type
check dropped, provenance through a subprocess (binaryang saw that fail silently). Local Deno uses to
remove: the compat gate's `deno doc --json` (→ the `.d.ts` tsc emits); `deno doc --lint`,
`deno check --doc`, `deno publish --dry-run` and `check:deno` (→ CI); the Deno legs of
`bun run runtimes` and `npm:prove` (→ the CI matrix — Deno USERS stay supported and tested there);
`deno.json` (→ step 7). Order: CI first, then the local copies come out.
**Done 2026-10-28: the compat gate** reads tsc's emitted `.d.ts` instead of `deno doc --json`
(proof and inversion in [testing.md](testing.md) § Compatibility gate).
**Done 2026-10-28: CI** — `.github/workflows/ci.yml` (step 6, first part; owner: "build the CI
workflow and push it") runs the Bun checks, compat, the sample build, JSR's Deno checks, and the
runtime matrix and npm proof WITH their Deno legs (`--deno`, `--install-node`). Locally those legs
are off by default and print `· deno: runs in CI`; `check:deno` and `build:deno` are gone; `cli:*`
install through npm. **First run green 2026-10-28** (Actions run 40725430831, commit `a2825af`):
all four jobs — checks, JSR checks (Deno), runtime matrix, npm package. The Deno legs cannot have
been skipped: with `--deno` both scripts count Deno among the required runtimes and fail if it is
missing or fails.
**Done 2026-10-28: step 7** (owner: "start step 7"). `git mv deno.json jsr.json` — the C5 layout:
manifest + `imports` + `nodeModulesDir: "manual"`, `publish.include` names `jsr.json`, `deno publish`
with no `--config`. Every reader moved (`sync-version`, `bump`, `publish` incl. its step-0 guard and
`git add`, `verify-release`, `npm-build`, `compat` — which reads `deno.json` at tags cut before
this, v1.0.4 included, measured: floor still minor), `publish.yml`'s score step, `.vscode`
(`deno.enable` off, TS validation on). The proof is a committed check, `scripts/jsr-upload-check.ts`
(testing.md § JSR upload check), run in CI's JSR job and in `publish.yml` before the real
`deno publish` — the "capture check in the release path" step 6 asked for. First CI run on the
step-7 tree (run 40727580815): checks, runtime matrix (Deno leg included) and npm ✅; JSR job ❌ at
`deno check --doc` — the JSDoc examples import `@jrmarcum/s3d-reportcompiler` by name, which only a
loaded manifest resolves, and with no `deno.json` Deno loads none for `check` (TS2307 ×3,
reproduced locally). Fixed with `--config jsr.json` on THAT step only (a type check fails loudly;
`deno publish` must never get it). `deno check` of the entry files, `doc --lint` and the dry run
passed without it. Still to come: uninstalling Deno here (owner), and `publish.yml` gating on CI plus the npm job.

**Status 2026-10-26 (end of day): steps 2, 3 and 4 DONE and merged** (`a222adf`, `78f9ac8`,
`129fd0a`); step 1 MEASURED and folded into step 7 (§ "Step 1, measured" — binaryang's step 1
silently corrupts this package). **Next: step 5** (the `node:test` suite), then 7 (`jsr.json`, no
`deno.json`), then 6 (CI + one real release). Owner decisions at the end of file. Requested by the owner 2026-10-26 ("scope this
repo's transition to bun per the guidelines in the binaryang project"). The guidelines are
binaryang's `cmem/jsr-deno-exit-guide.md` (written for the `@jrmarcum` JSR packages, this one
included; § 6 lists s3d-reportcompiler as "not surveyed — start with § 2, then § 4") and its full
record `cmem/bun-migration.md`. Read them from the sibling (`../binaryang/cmem/…`); this file holds
only what this repo measured and the plan. Findings cited as **F1–F11** are the guide's.

**Why** (guide § 1): Deno's development ends around 2027-10 (the team joined Cloudflare,
2026-10-09); JSR stays. 🔒 Owner direction for every package (2026-10-12): off Deno toward Bun,
**JSR stays the source**, **code that runs on both Bun and Node, Bun the main runtime**; Deno is kept
for the JSR items only (`deno publish`, F2). Workspace Tooling rule 1 says the same for scripts.

## The two questions (guide § 2), measured 2026-10-26

Deno 2.9.8, Bun 1.4.4, at `bd2599287` (`a57cd72` before the 2026-10-26 history purge).

**1. Does the published code call Deno? — NO.** `main.ts`, `src/report_core.ts`,
`src/report_runtime.ts` make no `Deno.*` call; the one reference is runtime detection
(`report_runtime.ts:49`, `typeof Deno !== "undefined"`). `node:fs/promises`, `node:path`,
`node:os`, `node:url`, `node:child_process` are reached by lazy `import()` inside the runtime
adapter, so the core stays browser-safe. No `jsr:` / `npm:` / `https:` prefix in shipped source;
the bare `mathjax-full/…`, `pdf-lib`, `pdfjs-dist/…` resolve through `deno.json`'s import map on
Deno and through `node_modules` on Node and Bun. No `enum`, no constructor parameter property, no
`namespace` (F7: already erasable as far as grep can tell). The build already PASSES on Deno, Node
and Bun with byte-identical baked HTML (roadmap § Current state). **So, like binaryang, only the
toolchain moves.**

**2. Does the toolchain use Deno? — YES:**

| surface | what | count |
|---|---|---|
| `deno.json` | manifest (`name`, `version`, `license`, `exports`, `bin`, `publish`), import map, `nodeModulesDir: "manual"`, `fmt`, 11 tasks | 1 file |
| type check | `deno check` (`deno task check`) | 3 entry files |
| JSR doc checks | `deno doc --lint`, `deno check --doc` | 2 files |
| format | `deno fmt` over `main.ts`, `src/`, `scripts/` | 8 files |
| lint | none in the gate today | — |
| release scripts | `scripts/*.ts` on `Deno.*` (`Command`, `args`, `exit`, `readTextFile`, `errors.NotCapable`, …); `publish.ts` and `verify-release.ts` import `../deno.json` | 5 files, ~40 calls |
| controls | `tests/controls/*.ts` on `Deno.*`; `verify-pdf-text.ts` uses an `npm:` specifier (`npm:pdfjs-dist@4.6.82`). (`spike-pdfmake.ts`, `npm:pdfmake`, retired 2026-10-26) | 9 files |
| tests | **no `deno test` suite**: the gate is the build's self-verification plus the negative controls | — |
| CI | `publish.yml` only (tag-triggered): `setup-deno`, `npm ci`, `deno publish`, and `deno eval` one-liners in the score / Rekor report step; **no CI gate workflow exists** | 1 file |
| editor | `.vscode/settings.json` `deno.enable: true` | 1 file |
| version | **three copies**: `deno.json` (source) → `package.json` + `src/report_core.ts` `VERSION`, by `sync-version.ts` | 3 files |

Already in place: `package.json` (deps exact-pinned, `@types/node`, `engines.node >=22.6`),
`package-lock.json`, `.npmrc` (`omit=optional`), and `bundle:browser` on `bun build`.

## The plan — binaryang's seven steps (guide § 4), applied here

Each step is its own branch → gate → `merge --no-ff` (workspace floor; this repo has no branching
rule of its own). **The gate for every step:** `cd tests && <runtime> ../main.ts` PASS on Deno,
Node and Bun with the baked HTML's sha256 unchanged, plus the step's own done-condition. Only step
6's real release is irreversible.

1. **`jsr.json` becomes the one manifest (F1) — MEASURED 2026-10-26: it cannot land before step 7
   here.** binaryang's recipe (manifest in `jsr.json`, `--config jsr.json` while `deno.json` lives)
   **silently corrupts this package.** See § "Step 1, measured" below; the revised order follows it.
2. ✅ **`bun check` — DONE 2026-10-26** (branch `bun/2-bun-check`). `bun run check` =
   `bun check -p tsconfig.check.json` over the same three entry files `deno task check` covers:
   `strict`, `types: ["node"]`, `erasableSyntaxOnly: true` (passes: F7 proved), `@types/node` pinned
   exact at the installed `22.20.1` (was `^22.10.2`). Measured against `deno check`: both clean;
   both report the same TS2322 at the same line:column for a planted wrong assignment in
   `report_core.ts` and a wrong use of `pdf-lib`'s real types in `main.ts` (so npm types RESOLVE);
   both refuse a planted `Deno.cwd()` (TS2304) and `Bun.file()` (TS2868). The existing
   `typeof Deno` passes in both because `report_runtime.ts:38-39` declares the shapes it reads.
   ⚠️ **Why the file is NOT `tsconfig.json`:** Deno reads a `tsconfig.json` beside `package.json`,
   and with it `deno doc --lint` printed 64 "Failed resolving types" warnings (it follows
   `types: ["node"]` into `@types/node` and cannot resolve its references); with the name Deno does
   not discover, 0. It also keeps `deno publish` on Deno's own defaults after step 7 (binaryang's
   B7 trap). Gate after the change: every check green; sample build PASS on Deno, Bun and Node 24
   with the baked HTML identical (`7F283563003F`). `deno doc --lint` / `deno check --doc` stay on
   Deno with the publish (owner: "the jsr items"). Found on the way: `package-lock.json` still
   named the package `compiled-reports` 1.0.0 — it is a FOURTH version copy that `sync-version.ts`
   does not write; `npm install` refreshed the root fields only (no resolution moved). Step 7's
   one version source must cover it.
3. ✅ **DONE 2026-10-26** (branch `bun/3-fmt-lint`: `d37ca4e` setup + lint fixes, `3a21e89` the
   reformat alone). **Format** = `bun run format` / `format:check` (`bun fmt`, `printWidth = 100`
   in `bunfig.toml`, scope `main.ts src scripts` named in ONE place); `deno.json`'s `fmt` block
   removed. The reformat (8 files, 68 lines) was compared with all whitespace removed: only
   trailing commas and three parenthesis pairs around `await` / `as` changed. **Lint** = `bun run
   lint` = `bunx @biomejs/biome@2.5.15 lint --error-on-warnings`, linter only (Biome's formatter
   and assist OFF — one formatter, Bun's). Why `bunx` and not a devDependency: Biome's binaries are
   OPTIONAL dependencies and `.npmrc` `omit=optional` (kept, for `pdfjs-dist`'s `canvas`) dropped
   them — the installed wrapper failed `Cannot find module '@biomejs/cli-win32-x64/biome.exe'`.
   Why 2.5.15: the newest release older than two weeks (2.6.0–2.6.3 were 2–5 days old). Biome's 7
   findings FIXED, none suppressed (the `exec` loop kept as `exec` in a `for` header — `matchAll`
   iterates a copy of the regex). Canaries: `check-format-canary.ts` (scope guards; misformat,
   CRLF, width+1 reported, width not; inverted: path typo, `cmem` in scope) and
   `check-lint-canary.ts` (6 rules must fire, a warning must fail; inverted: `"preset": "none"` →
   4 reported missing). Gate: all checks green; samples byte-identical on all six runtimes; the
   48-report set 380 pages / 8,286 / 0 failed, baked HTML byte-identical before and after
   (`A19E5AD15E3F…`, the 2026-08-08 hash). Original plan text follows.
   **Format: `bun fmt`; lint: Biome.** 🔒 Owner rule, 2026-10-26: use a tool "unless bun can
   perform the same task". Measured on Bun 1.4.4 the same day: **`bun fmt` exists** (native,
   "like Prettier"; JS/TS, CSS, HTML, JSON, YAML, Markdown; `--check` exits 1) — it shipped after
   binaryang chose dprint — and **`bun lint` does not** (`Script not found "lint"`). So:
   - **Format with `bun fmt`**, not dprint. Its style is Prettier's, not `deno fmt`'s, so the switch
     is ONE re-baseline commit of its own (workspace rule), proved harmless by the gate (baked HTML
     sha256 unchanged on all three runtimes). Set the print width to 100 (today's `lineWidth`).
     ⚠️ **Scope it explicitly**: bare `bun fmt` formats every supported file, which would rewrite
     `cmem/` and the byte-checked `tests/HTMLFilesToBeCompiled/*.html` — both forbidden (workspace
     Tooling rule 8). Name the paths (`main.ts src scripts tests/controls tests/*.ts`) in the
     `package.json` script and add a canary that a planted misformat inside scope is caught AND that
     a file in `cmem/` is never touched. A `fmt` script shadows the built-in (`--no-script`), the
     same trap as `check`. Count the files before and after (`deno fmt` checks 8 today).
   - **Lint with Biome**, pinned exact, linter only, per binaryang's B3 (the guide § 5a "Lint off
     Deno": write `"preset": "recommended"` yourself, enable `useAwait` / `noVar`, the lint canary).
     There is no lint today, so count findings per rule first and decide each; this is new scope,
     not a port. Revisit if a Bun release ships `bun lint`.
4. **Scripts on `node:` builtins, run by `bun`** (never `Bun.*`, so they also run on Node and still on
   Deno). The five release scripts and the ten controls. Each port is **proved equivalent by an
   output diff against its Deno original, with one input that must fail**, before the Deno one goes
   (workspace Tooling rule 1). Traps that apply here (guide § 5a): `Deno.Command` env MERGES while
   `child_process` REPLACES; `readFile` returns a pooled `Buffer`. Behaviour that disappears:
   `Deno.errors.NotCapable` handling and the `--allow-net=api.jsr.io` sandbox on `release` /
   `verify-release` — record it as a decision, not an accident. The `npm:` specifier in
   `verify-pdf-text.ts` → bare name (F3). (`spike-pdfmake.ts` retired 2026-10-26, owner: "retire it
   if it is not being used" — nothing imported or ran it.)
5. **Tests: a new `node:test` suite** (🔒 owner, 2026-10-26: "yes add the test suite"). Nothing to
   convert (no `deno test`); this is new. It runs on `bun test` and `node --test` alike (F6;
   `node:test` + `node:assert`, never `bun:test`), and asserts what `testing.md` and
   `tests/controls/README.md` today ask a person to check: the sample build PASSES with its
   baseline (100 pages, 2,203 expressions, 0 failed); each NEGATIVE control makes the build FAIL
   **for its own reason** (the expected message, not just exit 1 — a control caught by a different
   check is a bad control, ★ 2.1); each POSITIVE control passes at its baseline; the known
   set-union case (`control-hidden-row-two-reports` — FAILS since task 7, 2026-10-28; pin it as a NEGATIVE control) is pinned as passing, so the day task 7 fixes
   it the test fails and is re-recorded (★ 2.6). Guard "ran nothing": every control file must be
   exercised. Each assertion inverted once before it counts. Needs Chrome, so it is a CI job with a
   browser, not a unit test. May land before step 4 if it runs the controls through Deno at first.
6. **CI and the release path.** (Also: CI must repeat the compatibility gate on the tagged commit —
   `bun scripts/compat.ts release <version>`, workspace H6 Rule 2; the gate itself exists since
   2026-10-28.) Add a `ci.yml` gate (none exists): `bun check`, the formatter, and
   **`bun run runtimes`** (exists since 2026-10-26 — the floor, every Node LTS line from the
   schedule, Bun and Deno, one baked document; on the runner it needs fnm installed, or a
   `setup-node` matrix feeding the same checks), plus the INSTALLED-package matrix of
   `testing.md` § "Runtime matrix" before a tag (it is what caught known-issues #27–#29) — Chrome is on GitHub's Ubuntu runners
   (UNMEASURED with this build). `publish.yml`: keep `setup-deno` + `deno publish --config jsr.json`
   (F2: never `npx jsr publish`; a `package.json` makes it skip the type check); move the `deno eval`
   report logic into a TS script run by a pinned `setup-bun`. **Proved only by one real release**
   with `deno task release`'s successor and `verify-release` showing a Rekor id.
7. **Delete `deno.json`** (there is no `deno.lock`); drop `--config jsr.json`; pin the absence with a
   check. Watch: `deno publish` then type-checks with `tsconfig.json` but does NOT load
   `@types/node`; `nodeModulesDir: "manual"` goes with it (re-measure that `deno publish` still
   finds `node_modules`); `deno task install` (global CLI from the tree) needs a replacement;
   `.vscode` `deno.enable` off.

## Step 1, measured (2026-10-26) — `--config jsr.json` corrupts prefix imports, silently

Deno 2.9.8, a clean clone at `16c38909f`, `npm ci` (Node 24 via fnm). **Method:** a dry run never
shows the rewritten files, so each variant was PUBLISHED to a fake JSR — a one-time Bun server on
`127.0.0.1` (`JSR_URL=http://127.0.0.1:<port>/`, a dummy `--token`, `--no-provenance`) that saved
the uploaded tarball — and the tarball's import specifiers were read. Every request reached the
fake (its log shows the four calls of a publish); a stray request to jsr.io could not have
authenticated, and 1.0.4 exists there. **Positive control:** the baseline capture rewrites imports
exactly as the real 1.0.4 on JSR does (`npm:mathjax-full@3.2.2/js/…` ×6, `npm:pdf-lib@1.17.1`,
`npm:pdfjs-dist@4.6.82/legacy/build/pdf.mjs`; JSR's API lists the same 8 dependencies).

| variant | `deno.json` | `jsr.json` | command | result |
|---|---|---|---|---|
| baseline | full manifest + import map | — | `deno publish` | ✅ correct (= real 1.0.4) |
| B | import map + `nodeModulesDir` | manifest | `--config jsr.json` | ❌ loud: TS2307 ×7, "not a dependency and not in import map" — `deno.json` is IGNORED |
| C1 | import map + `nodeModulesDir` | manifest + import map + `nodeModulesDir` | `--config jsr.json` | ❌ **SILENT**: "Successfully published"; `pdf-lib` right, every prefix import (`mathjax-full/…`, `pdfjs-dist/…`) rewritten to `./mathjax-full/js/…` — a package that cannot load |
| C2 | `nodeModulesDir` only | manifest + `nodeModulesDir` (deps from `package.json`) | `--config jsr.json` | ❌ **SILENT**: all three, `pdf-lib` too, rewritten to `./…` |
| C3 | import map + `nodeModulesDir` | manifest + import map | `--config jsr.json` | ❌ loud: "Failed to resolve … after-prefix portion" |
| C6 | `tasks` + `fmt` only | manifest + import map + `nodeModulesDir` | `--config jsr.json` | ❌ **SILENT**, as C1 |
| C6 | same | same | `deno publish` | ❌ loud: "Missing 'name' field in deno.json" (F1) |
| **C5** | **none** | manifest + import map + `nodeModulesDir` | `deno publish` | ✅ **correct — identical specifiers to the baseline** |

In the C5 tree (no `deno.json`), `deno check` of the three entry files passes and the sample build
on Deno PASSES (100 pages, 2,203 expressions) with the baked HTML **byte-identical** to this tree's
(sha256 `7F283563…20D8`) — the Deno runtime leg survives the end state.

**What it means:** in Deno 2.9.8, an explicit `--config jsr.json` beside a `deno.json` mis-resolves
trailing-slash import-map entries (and `package.json` deps) and still reports success. binaryang
never saw it because it ships no dependencies. **The publish gate here must therefore read the
UPLOAD, not the exit code**: keep the fake-registry capture as a committed check (step 6) that
compares every rewritten specifier against the expected list before a tag.

**Handed over as ledger C20 (2026-10-26) — CLOSED 2026-10-28:** binaryang's
`jsr-deno-exit-guide.md` F1 and § 4 now carry this caveat and the upload check (`a846dc68f`, on its
`origin/main`); wasmtk's `deno-exit-plan.md` P1 must prove its upload's specifiers (`67686067a60`).
Both verified read-only by this repo, as the item's creator.

### The revised order

The manifest move and the `deno.json` deletion become ONE step, last before CI, and everything
`deno.json` still holds must leave it first:

1. ~~`jsr.json` alone~~ → folded into step 7.
2. `tsconfig.json` + `bun check` (unchanged).
3. `bun fmt` + Biome — takes `fmt` out of `deno.json`.
4. Scripts on `node:` builtins, run by `bun` from `package.json` scripts — takes `tasks` out of
   `deno.json` (`deno task release` becomes `bun run release`; `publish.ts` / `verify-release.ts`
   stop importing `../deno.json`).
   ✅ **DONE 2026-10-26** in four commits: `f8f6a3d` the faithful ports (part 1, below);
   `6a589e1` the tasks moved — `deno.json` has no `tasks`, `package.json` runs `update-version`,
   `bump`, `release`, `verify-release`, `build[:node|:deno|:sample]`, `check:deno` and the Deno
   global installs as `cli:install` / `cli:install-jsr` / `cli:uninstall` (never `install`, which npm
   runs on every `npm install`), live `deno task X` text renamed `bun run X`; `7472fe1` the release
   prints its provenance verdict and refuses to sweep non-version edits into the bump (known-issues
   #30); `ba8be2c` `bump` is SemVer 2.0.0. Each fix proved on Bun and Node by a one-time expectation
   test (24 checks + the 5-minute verdict check), the guard inverted. ⚠️ Learned: with no `tasks`,
   **`deno task <name>` runs the `package.json` script of that name** — a probe of
   `deno task release` ran the real release (roadmap § Release path).
   **Part 1 — the faithful ports, PROVED EQUIVALENT** (branch `bun/4-scripts`): the
   5 release scripts and 9 controls on `node:fs` / `node:child_process` / `process.*`, messages and
   logic unchanged. A one-time harness ran the Deno ORIGINAL (scratch clone at `78f9ac8`), the Bun
   port and the port on Node 24.21 on identical fixture trees — 42 cases: every success path, every
   refusal (bad kind, over-wide version, missing field, residue survivor, dirty tree, behind
   upstream, already on JSR), BOM inputs, the real JSR API (1.0.4 attested / 1.0.2 not / 99.0.0
   absent), and `publish.ts` against a git repo with a local bare `origin` (tags, pushed commit
   subject and file contents compared) including the 5-minute provenance wait. Result: exit code,
   stdout, stderr and every file written identical in all 42. Inverted: the bump carry limit 9 → 10
   in the port → exactly the three boundary cases reported. `verify-pdf-text` on the built sample
   PDF: identical pages / characters / headings; the one extra line on Bun and Node is pdfjs's own
   "Cannot polyfill `DOMMatrix`" (Deno has a native `DOMMatrix`) — environment, not port.
   **Measured on the way, and wrong in the plan before:** `Deno.readTextFile` KEEPS a leading BOM
   (the first port stripped it via `TextDecoder`; the harness caught 3 bytes); a BOM in `deno.json`
   or `package.json` stops Deno itself at startup ("Malformed package.json"); `Deno.errors.NotCapable`
   (the `--allow-net` guard) has no Bun / Node equivalent and is gone. **Defects found in the
   originals, kept faithfully in part 1 and fixed in their own commits:** `publish.ts` swallows
   `verify-release`'s output in step 7 (`.output()` captures it — the wait case printed 0 bytes of
   verdict); `publish.ts` step 2 `git add`s `src/report_core.ts`, so an uncommitted edit to it is
   swept into the "bump version" commit and released (case `pub-sweeps-core`); `bump.ts` is the
   retired odometer, not SemVer (workspace 🔒 2026-09-20, letter H6).
5. The `node:test` suite.
7. **One step: `jsr.json` = manifest + `imports` + `nodeModulesDir: "manual"`, `deno.json`
   deleted, `deno publish` with NO `--config`**, proved by the fake-registry capture equal to the
   baseline's specifiers and the dry run's file list (7 files, `jsr.json` in place of `deno.json`).
   The version then lives in `jsr.json` (+ its two generated copies).
6. CI and one real release, last, with the capture check in the release path.

## Also found, outside the seven steps

- **README promises to measure** (F3/F4): `README.md:150` `bunx @jrmarcum/s3d-reportcompiler` — F4
  says JSR's npm tarballs carry no `bin`, so this should not work; `README.md:135-144` puts the `@jsr`
  registry line in `~/.bun/bin/.npmrc`, an unusual location. UNMEASURED here; check both from a
  scratch directory before step 6, and rewrite the install section per F3 (`npx jsr add`,
  `bunx jsr add`, `deno add`, then one bare import).
- **`engines.node >=22.6`**: `package.json`'s `build` script runs `node main.ts` from source;
  unflagged type stripping arrived in a later 22.x (binaryang's floor is 22.18). UNMEASURED which
  floor this repo really has; consumers get compiled JS (F4) and are not affected.
- **Browser check** (guide § 5a "The web"): `report_core.ts` is the browser export; add
  `bun build --target=browser --external 'node:*'` over every export plus a source-level
  "no top-level `node:` import" rule. The `--external` flag is REQUIRED (Bun silently stubs
  `node:fs` without it).
- **WebAssembly engine (F10)** does not apply: nothing here judges a module with the host engine.
- **npm as a second registry** (guide § 5b): 🔁 **SUPERSEDED 2026-10-28** — owner: "we will post this
  to npm as well as jsr" (roadmap task 15). Was, 2026-10-26: "we will not publish this to npm".
- ✅ **The bump gate** (workspace working-rules § Git: a surface snapshot that sets the floor and
  refuses a lower bump) — built 2026-10-28, `83a2023`: `scripts/compat.ts` + `api-surface.txt`, run by
  `bump` and `release` (testing.md § Compatibility gate; workspace letter H6). Its CI half belongs to
  step 6.

## Owner decisions (2026-10-26)

1. Lint: "yes, unless bun can perform the same task" → Biome for lint (Bun 1.4.4 has no linter);
   the same rule makes `bun fmt` the formatter (step 3).
2. `spike-pdfmake.ts`: "retire it if it is not being used" → retired (unused, measured).
3. The test suite: "yes add the test suite" → step 5.
4. npm: "we will not publish this to npm" → JSR only. 🔁 **Superseded 2026-10-28:** "we will post this
   to npm as well as jsr" → roadmap task 15.
5. Order: "yes" → push first and decide the H19 purge before step 1, because a purge rewrites
   history and must not land between these branches. ✅ Both done 2026-10-26 (pushed; purged and
   force-pushed — [history-purge-2026-10-26.md](history-purge-2026-10-26.md)). Step 1 is clear.
