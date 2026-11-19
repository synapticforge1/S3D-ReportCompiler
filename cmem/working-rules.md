# working-rules.md: the standing rules for s3d-reportcompiler

Last verified: 2026-11-19. The rules, in the present tense: what this project is, memory, privacy, the layout
and commands, releasing, the traps, the workspace's rules and the owner's words. How a rule came to be:
[design-decisions.md](design-decisions.md) and [practices.md](practices.md). Moved here 2026-11-19 from
`INDEX.md` and the untracked root `CLAUDE.md` (workspace letter H38).

## What this project is

Compiles a folder of **SkyCiv structural design reports** (HTML) into one combined PDF, then proves
nothing was lost on the way. Runs on **Deno, Node, Bun and in a browser**. JSR:
`@jrmarcum/s3d-reportcompiler`; GitHub: `synapticforge1/S3D-ReportCompiler`.

These are **certified engineering calculations** (AISC 360-16 member design reports, reviewed,
archived, often sealed). A dropped value is worse than a broken layout, because it still looks right.

## Memory

🚫 **This is the *only* memory store for the project.** Nothing here is copied into a machine-local
memory store, and no project fact is recorded in one — agent/assistant memory features included,
under whatever name. A machine-local copy is invisible to every clone, drifts silently, and cannot be
reviewed in a diff. If it is worth remembering, it goes in a topic file here and gets committed.

- **The layout is the workspace memory guide's** (`../workspace/cmem/memory-guide.md`, letter H38):
  `STATE.md` (where the project stands, ≤ 60 lines, rewritten never appended, counts only) and
  `INDEX.md` (a router, ≤ 3 KB) are read first; the root `CLAUDE.md` (untracked) points at those two
  only. Open work: [roadmap.md](roadmap.md) and [known-issues.md](known-issues.md) (names kept from
  before the guide). Closed items and superseded notes: `archive/`, IDs kept. Machine-local: `local/`.
- **Limits:** any live note ≤ 25 KB; any line outside a code block ≤ 200 characters.
  `bun scripts/check-cmem.ts` checks them; run it at the end of every session and fix what it reports.
- **Session end:** rewrite `STATE.md`; move what closed to `archive/`; decisions to
  [design-decisions.md](design-decisions.md), rules here; run the check.
- **One topic per file; absolute dates; a written number is a claim with a date** — re-derive it
  before quoting or acting on it (the 1.0.4 status was stale for 2½ months; archived roadmap § Current state).
- **Never run a formatter on `cmem/`** or on `tests/HTMLFilesToBeCompiled/` (fixtures read back byte
  for byte).

## Privacy

🔒 **No secrets or personal information in any committed file, commit message, package, issue or PR**
(workspace rule, owner 2026-10-22). Everything committed is public, this folder included.

- **Secrets:** tokens, keys, passwords, `.env` contents — never. A leaked secret is rotated.
- **Personal information:** email addresses, machine names, and **drive paths that record one
  machine's layout** (a user profile, `D:\Programs\…`, AppData, a session id). **The test is "is it
  machine-specific?", not "is it absolute?"** (owner, 2026-10-23): a convention path that names
  nothing about one machine is fine. Use repo-relative paths or placeholders (`<repo-root>`).
- **Client data:** `local/` (the real report set, and since 2026-11-06 a copy of a real 75-report
  SkyCiv zip in `local/skyciv-zip-test/`), `CompiledPDF/` and `cmem/local/` (the transcript is
  `cmem/local/transcript/` since 2026-11-19) are gitignored whole; only sanitized samples are committed
  ([archive/roadmap-closed.md](archive/roadmap-closed.md) task 3). Diagnose a real
  report without printing it: show a token only if the public samples also contain it.
- **The one exception — the maintainer address** (owner, 2026-10-26): it may appear as the git commit
  author/committer address, in a registry manifest's author field, and in ONE committed `cmem/` note
  naming the maintainer contact. This repo has no such note; the address is not written here.
- **Scan before committing**, binaries too (`-I` skips them):
  `git grep -n -i -E '[A-Za-z]:[\\/]+(Programs|Users|scoop|tools)[\\/]|/[a-z]/(Programs|Users)/'`,
  then the same with `-a`. Judge each hit by the test above.

## Layout and commands

```
main.ts                        CLI entry point, orchestration
src/report_core.ts             every transform; ZERO I/O — runs in a browser too
src/report_runtime.ts          filesystem, process, browser discovery
tests/HTMLFilesToBeCompiled/   13 SANITIZED sample reports (committed)
tests/controls/                negative controls
scripts/                       release tooling, the compatibility gate, checks, sample sanitizer
api-surface.txt                the committed API surface the gate diffs (`bun run surface` to re-baseline)
local/                         ⚠️ the real 48-report client set — GIT-IGNORED
```

`CompiledPDF/` is created on demand in the working directory and is git-ignored at every depth.

```bash
bun install                           # every runtime reads this node_modules (bun.lock)
cd tests && bun ../main.ts            # the 13 committed samples
cd local && bun ../main.ts            # the real client set
bun run test                          # the samples + every control
```

## Releasing

🚫 **Never run `deno publish`** — it uploads from this machine with **no provenance**, permanently
(1.0.2 and 1.0.3 were lost that way; JSR now refuses it for this linked package). **`bun run
release` is the only way**; there is deliberately no `publish` task. `bun run bump <level>` and
`bun run release` run the **compatibility gate** — SemVer is a gate result, not a judgment. Since
2026-11-10 (H33) no machine tags: the bump is its own commit, `release` pushes `main` only, and CI
checks → tags → makes the page → publishes. ⚠️ `deno task release` also runs the real release
(Deno falls back to `package.json` scripts) — never probe it; `bun run release -- --dry-run` is
the safe look. Nothing is pushed, tagged or released unless the owner says so.
The process and every release: [release.md](release.md).

## The things most likely to bite

- ⚠️ **"0 failed" does not mean "nothing went wrong."** An unrecognised delimiter never errors; the
  LaTeX is typeset as prose (480 expressions once). The step-1b guard and step-4 verification exist
  for that; neither is optional.
- ⚠️ **Every `.html` in the input folder is a report.** Keep tooling and output out of it.
- ⚠️ **`local/` is real client data.** Never move a report to `tests/` by hand — run
  `scripts/sanitize-report.ts`.
- ⚠️ **No secrets or personal information in any committed file** — no drive paths that record this
  machine; scan before committing (§ Privacy above).
- ⚠️ **No heredocs; commit messages via `git commit -F <file>`; scripts are Bun TypeScript**
  (workspace Tooling rules; `scripts/` and `tests/controls/` run on Bun since 2026-10-26, roadmap task 12,
  [archive/bun-migration.md](archive/bun-migration.md)).

After any change, run the build: it verifies itself and exits non-zero if the PDF no longer
reproduces its sources. Never add `--no-verify` to a release path.

## Workspace

This repo is one of the sibling repos reviewed by the workspace (since 2026-10-26). Its memory is
the `workspace` repository beside this one, `../workspace/cmem/` (since 2026-11-19, letter H42; it
was `../cmem/`), and that repository is PUBLIC.
**At session start, read `../workspace/cmem/workspace-correspondence.md` (one line per open item),
then only the items addressed to this repo, `../workspace/cmem/letters/<ID>.md`** (letter H41).
Answer by appending ONE bullet under `## Answers` in the item's file —
`- **S3D-ReportCompiler, <date>:** <what was done, the commit, the check>` — the one write this repo
makes outside itself; the workspace session commits it. Only an item's creator closes it. Closed
items: `../workspace/cmem/archive/`. The workspace rules (`../workspace/cmem/working-rules.md`, the
tooling rules in `tooling-rules.md`, same numbers) are the common floor; this folder governs inside
the repo. The triggers "update the project memory" (audit for stale live claims, not just edit) and
"look for code issues" (silent fall-throughs first) are the workspace's, `../workspace/cmem/INDEX.md`.

Workspace rules recorded here (2026-11-09; full text `../workspace/cmem/tooling-rules.md`):
- 🔒 **Scratch space is bounded; project data stays in the project (H43, Tooling rule 15,
  2026-11-19).** Use only this session's own scratchpad folder, never another temp location or
  another session's folder, and never write its path into a tracked file. Delete what an item used
  once it is cleared: a one-time script after its run, a reproducer, clone or build output when its
  finding is fixed and verified, a reviewer's folder when its round is triaged. Nothing lives only in
  scratch: move what is worth keeping into the project first. Budget 200 MB per session folder;
  announce anything larger first and remove it when the step is done. "commit" ends with an empty
  scratchpad (delete what this session wrote there before the memory update). Sub-agents work under
  the main session's scratchpad and the main session removes their folders. Project notes never go
  to the assistant's per-project memory folder (checked empty 2026-11-19). Other sessions' folders
  are not swept from here.
- 🔒 **No `gh`, in CI too (H30, Tooling rule 9).** Check the repo instead (`git ls-remote`, the
  repo's files, registry APIs); the release workflow calls GitHub's REST API through
  `scripts/github-api.ts` (Bun, `GITHUB_TOKEN`); a GitHub web-UI task is an owner item.
- 🔒 **Every Bun-version notation is the latest installed Bun (H31, Tooling rule 10)** — 1.4.4 on
  Windows and in WSL (measured 2026-11-09): every `bun-version:` pin in `ci.yml` / `publish.yml`.
  When the owner installs a newer Bun, move them at the next session, gate run first; dated test
  results stay until re-run.
- 🔒 **The release CI makes the GitHub Release page (H32)**, by the recipe: the `release` job runs
  `github-api.ts release`, `contents: write` only, nothing installed; the tag must exist and peel to
  the released commit first, an existing page is done, the new one is read back. Only new tags get
  pages (no backfill).
- 🔒 **The release order (owner, 2026-11-10; H33, workspace `release-process.md` §§ 5–8): CI checks
  first, then CI pushes the tag, then the Release page from the tag, then the publish.** No machine
  tags: `bun run bump <level>` commits `bump to vX.Y.Z`, `bun run release` pushes `main` only;
  `publish.yml` runs on every push to main (checks → tag → release → jsr → npm-build → npm). The
  process, its recorded exceptions and every release: [release.md](release.md).


## Owner commands: "commit", "push", "release" (owner, 2026-11-10)

🔒 Written into every project by the workspace session on the owner's direction (2026-11-10:
"please write that into each project"; workspace `cmem/working-rules.md` Tooling rule 12, letter
H34). When the owner says:

- **"commit"** — first run "update the project memory files" (re-derive this repo's `cmem/` from
  its current state), then commit to the branch being worked on. Nothing is pushed.
- **"push"** — perform "commit", then merge the branch into `main`, then push `main` (and the
  working branch) to GitHub (`origin`) and read it back with `git ls-remote`.
- **"release"** — perform "push", then the release process: the workspace's
  `cmem/release-process.md` §§ 5–8 — CI checks first, then CI pushes the tag, then the GitHub
  Release page from the tag, then the publish to the registry — recorded in `cmem/release.md`
  § "Release History" (newest first, a summary of what changed). The level (patch / minor /
  major) is the owner's: ask if it was not given.

Each command includes the one before it, and none goes further than its own word (a "commit"
never pushes, a "push" never releases). This repo's own gate and merge rules apply at each step.

## Reading order for a new subject

1. [overview.md](overview.md), then [design-decisions.md](design-decisions.md) — three of the
   choices look obviously improvable until you see the measurements.
2. [architecture.md](architecture.md), [verification.md](verification.md),
   [known-issues.md](known-issues.md), [testing.md](testing.md).
3. [roadmap.md](roadmap.md) before starting work; [practices.md](practices.md) before changing
   anything load-bearing (§11–§14 came from packaging and releasing; §15 is the Bun-script convention;
   §16, review a fix as new code; §17, ask what a step can ADD, hide or carry over).
