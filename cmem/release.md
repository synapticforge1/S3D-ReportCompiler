# Releasing — the process, and the Release History

🔒 **One place for release records (owner, 2026-11-10, workspace D3 / letter H33): this file, §
"Release History", newest first, a summary of what changed in each version.** The records that
were spread over [roadmap.md](roadmap.md) (the "Latest release" and "Attestation" rows, task 5,
task 15) are gathered here; those places now point here.

The workspace process this follows: `../cmem/release-process.md` §§ 5–8 (the twelve slots
U1–U12, the owner's order D1). The owner's words (letter H34): **"release" = "push", then this
process.** Nothing is bumped, pushed or released unless the owner says so.

## How a release is made (since 2026-11-10)

🔒 **The owner's order (2026-11-10): "the CI to check first, then push the tag, and then create the
release page from the tag, then publish the package to the registry."** No tag is made on a
machine any more.

```bash
bun run bump patch | minor | major    # the level is required; refuses a dirty tree (untracked
                                      # files count) and a level below the compatibility floor;
                                      # commits "bump to vX.Y.Z" (the three version files only)
bun run release -- --dry-run          # every guard and the cold gate; pushes nothing
bun run release                       # the same, then pushes main ONLY, reads it back, and
                                      # waits for verify-release --wait --npm --github
```

`bun run release` ([scripts/publish.ts](../scripts/publish.ts)) refuses, with nothing pushed:
a tree with any change (untracked counted); HEAD not on `main` tracking `origin/main`; `main` not
exactly `origin/main` + one commit; that commit not `bump to v<jsr.json version>`, or touching
anything but the version lines of `jsr.json` / `package.json` / `src/report_core.ts`, or the three
disagreeing; the tag present locally or on origin; JSR not answering 404 or npm unable to take the
number (a registry that cannot answer refuses; a test hook refuses outside `--dry-run`); the
compatibility gate in release mode or the type check failing (the JSR upload check needs Deno, so
only CI runs it: ci.yml on every push, `checks` before the tag). Then
`git push origin main` (never forced) and `git ls-remote` must read the commit back.

[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) runs on every push to `main`:

| job | permission | what |
|---|---|---|
| `checks` | contents, actions: read | is this a release (jsr.json's version untagged, or tagged on THIS commit = a re-run)? If so: both registries free, ci.yml green on this commit, the JSR upload check, the compatibility gate (`--unpublished`) |
| `tag` | contents: write | `github-api.ts tag`: the annotated `vX.Y.Z` on this commit via REST, read back; one on another commit is refused |
| `release` | contents: write | `github-api.ts release`: the Release page from the tag, H32's recipe |
| `jsr` | id-token: write | skip if JSR has it, else `deno publish`; the Rekor read-back, **fatal** |
| `npm-build` | contents: read | build + prove the npm package; an artifact (7 days) |
| `npm` | id-token: write | that artifact; skip if npm has it from this commit (gitHead); `npm publish` (OIDC); the provenance read-back, **fatal** |

Every tool sha256-pinned (Bun 1.4.4, Deno 2.9.8, Node 24.21.0, fnm 1.39.0); the two actions left
(`upload-artifact`, `download-artifact`) pinned to commits; `permissions: {}` at the top;
token-less clones; scripts in the write-token jobs fetched alone at the commit; every request
limited to 30 s (`github-api.ts`) or `--max-time`. Each commit of main is its own concurrency
group, never cancelled.

**Failure (U12):** "Re-run failed jobs" in that run — each job skips what is done. Never a new tag
for the same code, never a moved tag. If the version cannot be published at all, bump again.

### The slots, and what this repo records instead (§ 7 of the workspace process)

| slot | here |
|---|---|
| U1–U3 | `bun run bump <level>` — gate `compat.ts gate <level>` (floor from `api-surface.txt` since the last tag; the last tag's samples on a patch / minor) |
| U4 | `bun run release` as above; `--dry-run` |
| U5 | `checks` — the full test suite is ci.yml's, required green on the commit rather than re-run |
| U6–U7 | `tag`, `release` |
| U8 | `jsr`, `npm-build` → `npm`. ⚠️ **Exception, recorded:** the `jsr` job runs `bun install --frozen-lockfile --ignore-scripts` beside `id-token`, because jsr.json's `"nodeModulesDir": "manual"` (one `node_modules` for every runtime — [architecture.md](architecture.md)) makes `deno publish` need one on disk. Lockfile-exact, integrity-checked, nothing installed runs. A Deno-side resolution was ruled out by the owner (2026-11-10: Bun solutions only) |
| U9 | as above. ci.yml's own tool pins are outside H33's list and unchanged |
| U10 | `verify-release --wait --npm --github` at the end of `bun run release`, plus an install from npm into a scratch folder (recorded per release below) |
| U11 | this file. **No `CHANGELOG.md`**: the README's "Breaking Changes" table is the user-facing record, this file the release record |
| U12 | as above |

**Measured by 1.4.0 (2026-11-10), the first release under this order:** JSR accepts the OIDC
publish from a run on `refs/heads/main` whose tag `github-actions[bot]` made, attested (the
workspace U6 ⚠️, from binaryang's bot-pushed tag, does not hold here); npm's trusted publisher
(`publish.yml` and the repository, no branch, no environment) accepts the push-to-main trigger,
with provenance. The rehearsal before it (best-practices 7.22): § 1.4.0 below.

### Reading a release back as a user: `verify-release`

```bash
bun run verify-release                              # jsr.json's version, one look
bun run verify-release 1.0.1                        # audit any version
bun run verify-release -- --wait --npm --github     # what `bun run release` runs at the end
```

Exit codes: **0** attested (and with `--npm` on npm with provenance, with `--github` a Release page
at the commit JSR got) · **1** published but NOT attested · **2** not published yet, or JSR could
not be asked · **3** attested but yanked · **4** (`--npm`) npm lacks the version, its provenance,
or an answer · **5** (`--github`) no page, a tag not at the commit JSR got (`release/<tag>` up to
1.3.0, the tag itself after), npm's `gitHead` another commit, or no answer · **64** usage. Under
`--wait`, a JSR record without `rekorLogId` gets 8 more looks (`deno publish` attaches it after the
upload). npm lists **1.1.0, 1.1.4–1.1.7, 1.2.0, 1.3.0**; 1.1.1–1.1.3 never reached it and npm never
takes those numbers; the stray `0.0.0-stage` was deprecated, then unpublished, by the owner
(2026-11-05).

### Traps

- 🚫 **Never `deno publish`** from a machine: no provenance, permanently (1.0.2 and 1.0.3). JSR
  now refuses it for this linked package (owner, 2026-10-28). There is deliberately no `publish`
  task.
- ⚠️ **`deno task release` runs the real release** (Deno falls back to `package.json` scripts).
  Never probe a release command by running it; `bun run` with no arguments lists them.
- ⚠️ "0 failed" in a green run is not the read-back: the `jsr` and `npm` jobs read the attestation
  back themselves now, and `verify-release` does it again as a user.

## Release History

Newest first. Run ids are `publish.yml` runs unless named. "Attested" = JSR `rekorLogId` present;
npm provenance = `dist.attestations.provenance`.

### 1.5.0 — 2026-11-10 · minor · tag `v1.5.0` (annotated, made by CI) on `3be72b4`

**Read back:** the third attempt's run on `3be72b4`, all six jobs green (Rekor and npm
provenance read back fatally in CI); `verify-release 1.5.0 --npm --github` → exit 0 (JSR
attested, Rekor `3797459486`; npm with provenance; the Release at the commit JSR got, npm's copy
of it); installed from npm into a scratch folder: `--version` → 1.5.0, `VERSION` 1.5.0,
`drawnSvgAncestors` and `readerBody` exported. ⚠️ The gate limit the 1.5.1 request found stays
open: `bun run bump patch` on an unreleased version is judged by the requested level against
the last tag, not by the version it makes.


**What changes:** group 9 — the report's text and every diagram label printed in the weight,
style, colour and size their sources give (known-issues #115–#117); `drawnSvgAncestors` and
`readerBody` added (the README's 1.5.0 row).
**How:** owner "push then release"; level asked, given: minor. Release notes `f690633`; `bun run
bump minor` (v1.4.0's samples PASS) → `bump to v1.5.0` (`accd4c4`); `bun run release --no-wait`
pushed `main`. **Refused twice, as designed — nothing tagged, nothing published (JSR 404):**
(1) CI's JSR docs lint failed on `accd4c4` (group 9b's exported `Rule` / `matches` named the
private `Selector`; the owner pasted the log) — fixed in `5b0e107`; (2) CI on `5b0e107` was
CANCELLED, so `checks` refused that run too. The owner then asked for 1.5.1; the bump gate
refused a PATCH: it judges the requested level against v1.4.0 (floor minor), not knowing 1.5.0
was never released (a gate limit, recorded). Owner's choice: **release 1.5.0** — this memory
commit's push re-armed it (`jsr.json` 1.5.0, untagged), and it went through.

### 1.4.0 — 2026-11-10 · minor · tag `v1.4.0` (annotated, made by CI) on `2138fa8`

**What changed:** 6 API additions — `linkedImages`, `inlineLinkedImages` (an image a report links
to is fetched at build time and inlined, so it prints instead of drawing blank), `drawnImages`,
`drawnSvgs`, `sniffImageType`, `./runtime` `fromFileUrl`; class B's stricter verification
(known-issues #87–#114: whole tokens with units and operators, as often as the source has them,
in their own report; legibility against what is drawn beneath; images pixel for pixel, WebP by the
package's own decoder; diagrams shape by shape, every filter primitive judged); the output
changes and new refusals of the README's 1.4.0 row. **The first release in the owner's order
(H33): CI checked, then tagged, then made the page, then published.**
**Read back:** publish run on `2138fa8`, all six jobs green — `checks`, `tag`, `release`, `jsr`
(Rekor read-back fatal: passed), `npm-build`, `npm` (provenance read-back fatal: passed).
⚠️ **Measured, U6's open question:** JSR accepted the OIDC publish from a run on
`refs/heads/main` whose tag `github-actions[bot]` made — attested, Rekor `3794118812`.
`verify-release 1.4.0 --npm --github` → exit 0: JSR attested, npm with provenance, the GitHub
Release at the commit JSR got (`2138fa8`, CI's tag -- no `release/` branch any more) and npm's
copy of it (its first `--github` try got HTTP 403: the anonymous API limit, spent by watching CI;
re-run after the reset). Installed from npm into a
scratch folder: `--version` → 1.4.0; `drawnImages`, `linkedImages`, `sniffImageType` exported.

**How:** owner "push then release, then start group 9 items"; the level asked and given: minor (the
gate's floor, 6 additions). Release notes merged first (README `4f656b8`); `bun run bump minor`
(v1.3.0's samples PASS) committed `bump to v1.4.0` (`88e8fbe`); `bun run release` passed every
guard and pushed `main`. **First attempt refused by CI, as designed:** ci.yml failed on Linux
(known-issues #114: a displacement doubt searched short; JSR's docs lint), so publish run
42898552697's `checks` failed and every later job was skipped — no tag, JSR 404, npm free. The
local wait ended at exit 2 ("not on JSR yet", no verdict). The fix commit goes on top of the bump;
jsr.json still said 1.4.0 with no tag, so the fix's push (`2138fa8`) re-armed the release from
that commit, and it went through.

**H33 rehearsal, 2026-11-10** (best-practices 7.22; nothing reached GitHub or a registry): in a
scratch clone whose `origin` was a scratch bare repository, `bump major` committed `bump to v2.0.0`
(three files, gate: floor minor, major allowed); `release --dry-run` passed every guard against
the real JSR and npm (2.0.0: 404, free) and pushed nothing; `release --no-wait` pushed `main`,
read it back, made no tag; a second run refused ("already origin/main"). `publish.yml` parsed, its
32 `run:` steps pass `bash -n`, and the new steps ran read-only against the real GitHub, JSR and
npm (with refusing `npm` / `deno` stand-ins): 1.3.0 on main's HEAD → not a release; at v1.3.0's
commit → a re-run; 9.9.9 → new, free on both; 1.3.0 not free → refused; the JSR and npm publish
steps skip 1.3.0; both read-backs pass (Rekor `3742524174`; npm SLSA provenance, gitHead =
v1.3.0's commit); npm's copy judged against another commit → refused.

### 1.3.0 — 2026-11-07 · minor · tag `v1.3.0` on `4699dd8`

**What changed:** the third full-project review (known-issues #72–#76). Added `decodeReport(bytes,
name)`. Now refused where they used to pass: a non-UTF-8 report (or another charset over
non-ASCII bytes), an undefined TeX command, `--keep-html` with `--no-keep-html`. Each report's TeX
starts without the previous report's macros; an SVG `<style>` that cannot be hoisted exactly moves
to its report's stylesheet. Samples and both real sets bake byte-identically.
**How:** owner "update the project memory files then push, bump and then release". Main pushed
first (`847de49`), CI run 42397073197 green; `bun run bump minor` (4 added vs v1.2.0, v1.2.0's
samples PASS); `bun run release --no-wait`. Publish run 42397518507, every job green (the
review-3 graph, #75). **Read back:** JSR attested, Rekor `3742524174`; npm provenance;
`verify-release 1.3.0 --wait --npm --github` exit 0; installed from npm in a scratch project:
`--version` 1.3.0, `decodeReport` exported. `release/v1.3.0` = `4699dd8`.

### 1.2.0 — 2026-11-06 · minor · tag `v1.2.0` on `138f6e3`

**What changed:** SkyCiv zip input (`s3d-reportcompiler pack.zip`, the verified PDF added into the
zip; `readZipReports`, `zipWithFile`, `checkZipUpdate`); `findBrokenReferences()`,
`resetBakeState()`, `bakeRemovals`, `cssWarnings`, `bakeWarnings`; on `/runtime`
`runWithTimeout`, `MAX_TIMEOUT_MS`, `listNames`, `fileIdentity` (19 additions). The baked document
carries a CSP; the render runs no report code; Chrome keeps its sandbox; a PDF is
`<name>.unverified.pdf` until it passes; the CLI refuses a non-`.pdf` output, a mistyped setting,
an unreadable entry. Two full-project reviews (#61–#71), #66.
**How:** owner "update the project memory files and release 1.2.0". Main pushed first (`68ef6e0`),
CI run 42337350760 green; `bun run bump minor` (19 added, v1.1.7's samples PASS). Publish run
42337922832, every job green. **Read back:** JSR attested, Rekor `3729552596`; npm provenance;
GitHub release `v1.2.0`; `release/v1.2.0` = `138f6e3`.

### 1.1.7 — 2026-11-05 · patch · tag `v1.1.7` on `9fd873b`

**What changed:** a TeX error fails the build instead of typesetting a red error box (M3); every
named entity decodes inside maths (M1); attributes read inside tags only; the per-report reference
guard; release-script hardening (pathspec bump commit, exact undo, fenced JSR test hook,
`compat --unpublished`, shared `scripts/jsr-api.ts`).
**How:** owner "release 1.1.7", first attempt; gate patch vs v1.1.6 (its samples PASS). Publish
run 42079741086. **Read back:** JSR attested, Rekor `3697712013`; npm `latest` with SLSA
provenance, 10 files.

### 1.1.6 — 2026-11-05 · patch · tag `v1.1.6` on `f26f030`

**What changed:** the three code-review rounds' fixes (silent losses, release-script gaps); the
redactor covers POSIX checkout and home paths.
**How:** owner "do the patch release". Three tags' worth of attempts, none published wrongly: the
first `v1.1.6` failed CI on Linux (the redactor missed POSIX paths) and the CI gate published
nothing; the retry was refused by the compat gate (it took the stranded tag as its baseline —
hence `--unpublished`); publish run 42070536432 green on `f26f030`. **Read back:** JSR attested,
Rekor `3696801217`; npm 1.1.6 by OIDC with provenance, `latest`.

### 1.1.5 — 2026-10-28 · patch · tag `v1.1.5` on `0794a2b`

**What changed:** dependencies installed with Bun (`bun.lock` replaces `package-lock.json`); the
global CLI installed with Bun; `publish.yml` publishes nothing unless CI passed on the tagged
commit; npm job OIDC only (the token path removed).
**How:** owner "bump and release". The first release through `publish.yml`'s CI gate (run
40759837547: "CI passed on the tagged commit", then JSR, then npm) and the first installed from
`bun.lock`; the first from the org with no `deno.json`, run from Bun. `bun run release`'s wait was
outlasted by the CI gate (exit 2 "not on JSR yet", then attested) — `verify-release --wait` raised
from 5 to 15 min. **Read back:** JSR attested, Rekor `3547861777`; npm provenance.

### 1.1.4 — 2026-10-28 · patch · tag `v1.1.4` on `dcc90c3`

**What changed:** nothing in the library since 1.1.0 — the first version on both registries with
provenance. npm's half failed in the release run (the package existed, but no trusted publisher
matched it: the entry had been made before the package; the token fallback hit `EOTP`). The owner
set the trusted publisher ON the package (`npm trust github … --file publish.yml --repo
synapticforge1/S3D-ReportCompiler`: no branch, no environment), deleted the token secret, and
"Re-run failed jobs" published it by OIDC (roadmap task 15). **Read back:** JSR attested, Rekor
`3546339510`; npm SLSA provenance.

### 1.1.3 · 1.1.2 · 1.1.1 — 2026-10-28 · patches · tags on `fcb6706`, `5d1551a`, `a0365c9`

**What changed:** nothing in the library since 1.1.0; each was an attempt at the npm publish job
(1.1.1 added it and kept npm from dropping the bin; 1.1.2 and 1.1.3 tried a bootstrap token).
**JSR only:** their npm publishes failed (1.1.1: OIDC exchange failed, npm fell back to
setup-node's placeholder token — run 40739241100; 1.1.2: run 40744332897; 1.1.3: the token was
read but npm's 2FA refused it, EOTP — run 40746815045). npm never takes those numbers. **Read
back:** JSR attested, Rekor `3544876876` (1.1.1), `3545629708` (1.1.2), `3546011937` (1.1.3).

### 1.1.0 — 2026-10-28 · minor · tag `v1.1.0` on `5d091ec`

**What changed:** `compareEachReport` and its two types (per-report conservation, task 7);
`pdfjs-dist` 4.6.82 → 6.4.299, so **the Node floor rises from 22.6 to 22.13** (the owner released
it as a minor); the `@xmldom/xmldom` 0.9.12 override. The first version on npm, published **by
hand** (a trusted publisher can only be set on an existing package), so without npm provenance.
**Read back:** JSR attested, Rekor `3544353215`; npm "with NO provenance" (as recorded).

### 1.0.4 — 2026-08-12 · patch · tag `v1.0.4` on `9cdf0b0`

**What changed:** the release process restored (the task renamed `release` so it cannot be
confused with `deno publish`; pre-flight guards; provenance verification; full function docs).
**How:** `deno task release`; the first attempt failed before publishing — the workflow had no
dependency install for `"nodeModulesDir": "manual"` (#23) — and the tag push had to be forced to
retry. **Read back:** attested, Rekor `2439323008` (re-verified 2026-10-26).

### 1.0.3 · 1.0.2 — 2026-08 (between 1.0.1 and 1.0.4) · ❌ unattested

**What changed:** 1.0.2 added the `./cli` export (the global install works from it, #24, #25);
1.0.3 only the release process. Both were published with a workstation `deno publish`: no tag, no
`release/` branch, no GitHub release, **no Rekor entry**, immutable (#26). JSR scores them 100
regardless — provenance is not scored.

### 1.0.1 — 2026-08-08 · patch · tag `v1.0.1` on `befc61f`

**What changed:** a module doc on the `./runtime` entrypoint. Cut one commit before a fix it was
meant to ship (#25) — why the release prints the commit it releases. **Read back:** attested.

### 1.0.0 — 2026-08-08 · tag `v1.0.0` on `8192c39`

The first release: JSR `@jrmarcum/s3d-reportcompiler`, score 100, four runtimes declared.
**Read back:** attested.

Tags `v1.0.0`, `v1.0.1`, `v1.0.4` were moved by the [2026-10-26 history purge](history-purge-2026-10-26.md);
JSR's provenance names the pre-purge commit ids. The `release/v*` branches up to 1.1.7 were
deleted 2026-11-06 (known-issues #70); `release/v1.2.0` and `release/v1.3.0` remain, and
`verify-release --github` still compares them where they exist.
