# testing-packaging.md: the checks on what is shipped

Split 2026-11-19 from `testing.md` (H38), verbatim: the compatibility gate, the runtime matrix, the JSR upload
check and the npm package. How the build and the suite are tested: [testing.md](testing.md).

## Compatibility gate — "backward compatible" is a gate result (workspace letter H6)

`scripts/compat.ts`, since 2026-10-28. **`bun run compat`** reports whether the committed
[`api-surface.txt`](../api-surface.txt) is current and the floor since the last tag; **`bun run
surface`** re-baselines it (Rule 5: an intended surface change is its OWN commit, before any bump).
`bun run bump <kind>` runs the gate before writing anything; `bun run release` runs it on the version
it is about to push, and `publish.yml`'s `checks` job again before CI tags it (since 2026-11-10,
[release.md](release.md)).

**The surface** (69 lines on 2026-10-28): the `exports` map; every exported symbol in the `.d.ts`
that tsc (node_modules, `emitDeclarationOnly`) emits for each export, one line per symbol — comments
removed, whitespace collapsed, overloads joined; the CLI's options and `USAGE` shapes from `--help`.
`VERSION`'s literal is normalized to `<VERSION>` (its type is the version string, which every bump
changes — without that, every bump read as breaking). An export the reader does not recognise, or a
tree that does not type-check, FAILS the gate (fail closed). At a tag with no snapshot (`v1.0.4`), the
surface is GENERATED from the tag: `git archive` into a temp dir with this repo's `node_modules` linked
(a bare archive cannot resolve the npm types — measured).

**No Deno since 2026-10-28** (owner: "the goal is to be deno free on this machine"). Until then the
symbols came from `deno doc --json`. Switch proven: the tsc reader names the SAME 69 lines' symbols,
kinds, exports and CLI lines as the `deno doc` snapshot; the floor vs `v1.0.4` is unchanged (minor —
`compareEachReport`, `PerReportResult`, `ReportConservation` added); re-baselined in the same commit
as the reader (the format changed, so the old snapshot could not stay). Inverted (one-time harness,
mutate → `compat check` → restore): doc-comment edit → current, exit 0; parameter widened, optional
parameter added, export removed, export added, type field added, return type changed → stale with
THAT symbol named, exit 1; a type error in the tree → refused. 8/8. (Two mutants first failed for
harness reasons — they were not valid TypeScript, so the gate refused them as type errors.)

**The floor:** removed or changed → major; added → minor; nothing → patch ("changed" includes widening,
so the floor can be high, never low). **Rule 3:** for a patch or minor, the PREVIOUS tag's sample
reports must build and PASS on the new code. **Blind spots, by design:** exit codes and the CLI's prose;
the npm dependencies' own types; behaviour the samples do not exercise (the `node:test` suite of task 12
step 5 joins Rule 3 when it exists). CI does not repeat the check on the tag yet (task 12 step 6).

**Inverted 2026-10-28** (one-time harness, scratch clone carrying the uncommitted gate, the real
`v1.0.4`; the release cases pushed to a SCRATCH bare origin): 12 / 12 — baseline patch allowed with
v1.0.4's samples PASS; stale snapshot refused; removed export → patch and minor refused, major allowed;
added export → patch refused, minor allowed; retyped parameter → major; a CLI flag renamed in `--help`
→ major; equations rendered as `""` with the surface unchanged → v1.0.4's samples FAIL, patch refused;
floor read from a tag's COMMITTED snapshot; `release 1.0.5` allowed, `1.0.4` refused; a refused bump
writes nothing; bump → release tags `v1.0.5`; a hand-edited version below the floor → release refused,
nothing tagged. (Two cases first failed for harness reasons — stderr ordering, and a mutation that hit
the header comment's `--no-optimize` instead of the help line — and a filter that selected NO case
printed "every inversion behaves"; the harness now refuses an empty run.)

## Runtime matrix — every Node LTS line, Bun, Deno

🔒 Owner, 2026-10-26: "make sure this repo is able to be used by all LTS versions of node, and bun,
and deno". Two ways to use it, and they have different floors — test both.

**From a clone: `bun run runtimes`** ([`scripts/check-runtimes.ts`](../scripts/check-runtimes.ts)).
Reads Node's release schedule (never a hand-kept list), builds the 13 samples on the
`engines.node` floor, every current LTS line and a line becoming LTS within 30 days (each via
`fnm exec --using=…`), then on Bun and Deno; fails unless every build PASSES its verification, the
CLI reports the runtime that was meant to run, and every baked HTML is byte-identical. A Node
fnm lacks FAILS with the `fnm install` (never skipped); a schedule fetch failure fails. Inverted
2026-10-26: `--also=22.17.1` → ❌ `ERR_UNKNOWN_FILE_EXTENSION` (below the floor), `--also=20.0.0` →
❌ "run: fnm install 20.0.0"; exit 1 for both, the six real rows still ✅.

Measured 2026-10-26 (Windows 11, Chrome on PATH; LTS lines from the schedule: 22 Jod, 24 Krypton,
26 from 2026-10-28):

| runtime | from the clone | the published 1.0.4, installed |
|---|---|---|
| Node 22.6.0 | ❌ `ERR_UNKNOWN_FILE_EXTENSION` (`.ts` needs a flag) | ✅ CLI + library |
| Node 22.17.1 | ❌ same | ✅ |
| Node 22.18.0 (floor) | ✅ | ✅ |
| Node 22.23.3 | ✅ | ✅ |
| Node 24.21.0 | ✅ | ✅ (install needs `npm_config_allow_remote=all`, #27) |
| Node 26.12.0 | ✅ | ✅ |
| Bun 1.4.4 | ✅ | ✅ (`bunx jsr add --bun`, #28) |
| Deno 2.9.8 (= `deno upgrade lts`) | ✅ | ✅ (`deno run -A jsr:…@1.0.4/cli`) |

Every ✅ baked the same document, sha256 `7F283563003F…` — clone and package alike. The
installed-package column is a procedure, not a committed script yet: a scratch project,
`bunx jsr add --bun @jrmarcum/s3d-reportcompiler@<ver>` (or `npx jsr add` with the allow-remote
variable), then `node|bun node_modules/@jrmarcum/s3d-reportcompiler/main.js <reports> <out.pdf>`
and an `import` of `.` and `./runtime`. It belongs in the release path once there is one off
Deno (bun-migration step 6) — it is the check that would have caught #27–#29.

Not a support promise, by design: Bun has no LTS line (the version on PATH is tested); Deno's is
whatever `deno upgrade lts` names. Node lines leave the matrix when the schedule ends them, and
`engines.node` must be raised then too (22 ends 2027-04-30).

## JSR upload check — `bun scripts/jsr-upload-check.ts` (CI and `publish.yml`; needs Deno)

What `deno publish` would UPLOAD, read from the tarball — because its exit code has lied (step 1:
"Successfully published" on a package whose prefix imports became `./…`). It publishes to a fake JSR
on `127.0.0.1` (`JSR_URL`, a dummy `--token`, `--no-provenance`) and requires: no `deno.json`; the
files exactly `publish.include`; in every `.ts` file each import specifier equal to the source's,
resolved through `jsr.json` `imports` (relative, `node:` and the package's own name in doc examples
unchanged), in order; everything else byte-identical; at least one bare specifier rewritten.
Measured 2026-10-28 (Deno 2.9.8, the step-7 tree): ✅ 7 files, 8 rewritten specifiers — the same
eight as the step-1 baseline and the real 1.0.4 (`mathjax-full` ×6, `pdf-lib`, `pdfjs-dist`).

⚠️ **The fake must answer `GET …/versions/<v>` with 404.** Answered 200, `deno publish` treated
the version as published, uploaded NOTHING and exited 0 — measured while writing the check; the
check fails a run with no tarball.

**Inverted 2026-10-28** (one-time harness, scratch copies): clean → exit 0; step 1's C1 (`deno.json`
with `imports` + `nodeModulesDir`, `--config jsr.json`) — `deno publish` exited 0 again, the check
❌ the `deno.json` and every `./mathjax-full/…`, `./pdfjs-dist/…` specifier, exit 1; C2 (`deno.json`
`nodeModulesDir` only, `jsr.json` without `imports`) — ❌ `./pdf-lib` etc., exit 1. 3/3. (C2 first
crashed on the missing `imports` — exit 1 for the wrong reason; fixed to report it.)

## npm package — `bun run npm:build && bun run npm:prove` (roadmap task 15)

`npm:build` ([`scripts/npm-build.ts`](../scripts/npm-build.ts)) emits JS + `.d.ts` into `dist/`
with tsc 7 (`tsconfig.npm.json`, `rewriteRelativeImportExtensions`), gives `main.js` a Node shebang,
and GENERATES `dist/package.json` (name `@synapticforge1/s3d-reportcompiler`, version from
`deno.json`, `bin`, dependencies from `package.json`, `engines.node` = pdfjs-dist's own floor,
22.13.0). `dist/` is git-ignored.

`npm:prove` ([`scripts/npm-prove.ts`](../scripts/npm-prove.ts)) tests what users get, not the tree:
`npm pack`; no `.ts` source ships; every path the manifest names, plus `LICENSE`,
`THIRD-PARTY-NOTICES.md` and `README.md` (required whatever `files` says), is in the tarball; the bin
has a Node shebang; the tarball installs with npm into a scratch project outside the repo; on the
engines floor, every Node LTS line, Bun and Deno it imports `.` and `./runtime` and the INSTALLED CLI
PASSES and bakes the source's document (`7f283563003f`); `npm exec` runs it; a consumer type-checks
against the shipped `.d.ts`; the export list equals JSR's own npm build of the package. Measured
2026-10-28: all ✅, exit 0.

**Inverted 2026-10-28** (one-time harness, one mutant per run on a fresh build, each must exit 1
with ITS check ❌): types path to a missing file; the Deno shebang kept; the CLI throwing on start
(❌ on every runtime); `./runtime` dropped (❌ imports and ❌ export list vs JSR);
a `.ts` source leaked into the tarball; `compareEachReport` deleted from the `.d.ts` (❌ consumer
type-check); `THIRD-PARTY-NOTICES.md` dropped from `files`. 7/7 caught.
⚠️ **`npm pack` and an install from the tarball are NOT the publish path.** Found 2026-10-28 by
the first `npm publish --dry-run` (npm 12.2.0): it called the generated bin `"./main.js"` invalid
and REMOVED it — a published package with no command, with only a warning — while pack, install,
`npm exec` and every check above passed. `npm-build` now writes `"main.js"`, and `npm:prove`
checks that the dry run corrects nothing (inverted: the old `"./main.js"` → ❌ with npm's own
warning, exit 1). `publish.yml`'s npm job runs the same refusal before the real publish.
⚠️ **The dry run runs on a COPY under `<version>-prove.0` (`--tag prove`).** Once 1.1.4 was on npm,
a dry run of the tree's own version failed "You cannot publish over the previously published
versions" — CI on main went red on every commit after the release (runs from 19:28Z, 2026-10-28),
which the `publish.yml` CI gate would have turned into a refused next release. Fixed and re-inverted
(the old bin still ❌). The workflow's step skips a version npm already has.

⚠️ **Dropping `LICENSE` from `files` is not a breakage**: npm packs `LICENSE`, `README` and
`package.json` regardless — the first mutant tried was that one, and the proof correctly passed it.

