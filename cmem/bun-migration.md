# bun-migration.md — moving the toolchain off Deno, keeping JSR (SCOPE, not started)

**Status 2026-10-26: scoped, owner decisions taken (end of file), no step started.** Requested by the owner 2026-10-26 ("scope this
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

Deno 2.9.8, Bun 1.4.4, at `a57cd72`.

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

1. **`jsr.json` becomes the one manifest (F1).** Move `name` / `version` / `license` / `exports` /
   `publish` out of `deno.json`; `--config jsr.json` on every `deno publish` (CI and dry runs) until
   step 7; `sync-version.ts`, `bump.ts`, `publish.ts`, `verify-release.ts` read `jsr.json`. A check
   that fails if `deno.json` carries `name` or `version` again (a copy left there WINS). **Done
   when** the dry run lists the same files as before.
   ⚠️ **Risk binaryang did not have: runtime dependencies.** binaryang ships none; this package's
   three npm deps reach `deno publish` through `deno.json`'s import map. UNMEASURED: whether
   `deno publish --config jsr.json` still resolves them (from `package.json`, or a `jsr.json`
   `imports`), and what JSR then records as the package's dependencies. Measure in a scratch clone
   first: compare the dry run's file list AND the published dependency list.
2. **`tsconfig.json` + `bun check`.** `strict` (Deno's default), `types: ["node"]`, `@types/node`
   pinned to the Node floor (not `^22.10.2`), `erasableSyntaxOnly: true` to prove F7. `bun check`
   (Bun ≥ 1.4.3; mind the `check` script-shadowing trap). **Done when** it accepts what `deno check`
   accepts and reports the same error on a planted fault. `deno doc --lint` / `deno check --doc` are
   JSR-score checks: they stay on Deno with the publish (owner: "the jsr items").
3. **Format: `bun fmt`; lint: Biome.** 🔒 Owner rule, 2026-10-26: use a tool "unless bun can
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
   set-union case (`control-hidden-row-two-reports`) is pinned as passing, so the day task 7 fixes
   it the test fails and is re-recorded (★ 2.6). Guard "ran nothing": every control file must be
   exercised. Each assertion inverted once before it counts. Needs Chrome, so it is a CI job with a
   browser, not a unit test. May land before step 4 if it runs the controls through Deno at first.
6. **CI and the release path.** Add a `ci.yml` gate (none exists): `bun check`, dprint, the sample
   build on Bun, Node LTS lines from Node's schedule (22, 24 today; **26 becomes LTS on
   2026-10-28**) and a Deno leg while consumers use Deno — Chrome is on GitHub's Ubuntu runners
   (UNMEASURED with this build). `publish.yml`: keep `setup-deno` + `deno publish --config jsr.json`
   (F2: never `npx jsr publish`; a `package.json` makes it skip the type check); move the `deno eval`
   report logic into a TS script run by a pinned `setup-bun`. **Proved only by one real release**
   with `deno task release`'s successor and `verify-release` showing a Rekor id.
7. **Delete `deno.json`** (there is no `deno.lock`); drop `--config jsr.json`; pin the absence with a
   check. Watch: `deno publish` then type-checks with `tsconfig.json` but does NOT load
   `@types/node`; `nodeModulesDir: "manual"` goes with it (re-measure that `deno publish` still
   finds `node_modules`); `deno task install` (global CLI from the tree) needs a replacement;
   `.vscode` `deno.enable` off.

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
- **npm as a second registry** (guide § 5b): 🔒 **NO for this package** (owner, 2026-10-26: "we will
  not publish this to npm"). JSR only; `package.json` stays `"private": true`.
- **The bump gate** (workspace working-rules § Git: a surface snapshot that sets the floor and
  refuses a lower bump) does not exist here; binaryang built it into its bump script. Separate item,
  but step 4 rewrites `bump.ts` anyway.

## Owner decisions (2026-10-26)

1. Lint: "yes, unless bun can perform the same task" → Biome for lint (Bun 1.4.4 has no linter);
   the same rule makes `bun fmt` the formatter (step 3).
2. `spike-pdfmake.ts`: "retire it if it is not being used" → retired (unused, measured).
3. The test suite: "yes add the test suite" → step 5.
4. npm: "we will not publish this to npm" → JSR only.
5. Order: "yes" → push first and decide the H19 purge before step 1, because a purge rewrites
   history and must not land between these branches (roadmap task 11).
