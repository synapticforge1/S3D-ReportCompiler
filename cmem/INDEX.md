# cmem — Portable Project Memory for s3d-reportcompiler

This folder is the **authoritative, portable project memory**, committed to git so it travels with
every clone. **What this is:** a build that turns a folder of SkyCiv structural design reports (HTML)
into one combined, verified PDF, on Deno, Node, Bun and in a browser — see [overview.md](overview.md).

🚫 **This is the *only* memory store for the project.** Nothing here is copied into a machine-local
memory store, and no project fact is recorded in one — agent/assistant memory features included,
under whatever name. A machine-local copy is invisible to every clone, drifts silently, and cannot be
reviewed in a diff. If it is worth remembering, it goes in a topic file here and gets committed.

⏭️ **Current state and open work: [roadmap.md](roadmap.md)** — the status line lives there, once.

## Policy

- **This index stays one line per file.** No status narrative here or in `CLAUDE.md`; it goes in
  [roadmap.md](roadmap.md). Bootstrap (`CLAUDE.md` + this file) stays under about 10 KB.
- **One topic per file; absolute dates; a written number is a claim with a date** — re-derive it
  before quoting or acting on it (the 1.0.4 status was stale for 2½ months; roadmap § Current state).
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
- **Client data:** `local/` (the real report set), `CompiledPDF/` and `cmem/transcript/` are
  gitignored whole; only sanitized samples are committed ([roadmap.md](roadmap.md) task 3).
- **The one exception — the maintainer address** (owner, 2026-10-26): it may appear as the git commit
  author/committer address, in a registry manifest's author field, and in ONE committed `cmem/` note
  naming the maintainer contact. This repo has no such note; the address is not written here.
- **Scan before committing**, binaries too (`-I` skips them):
  `git grep -n -i -E '[A-Za-z]:[\\/]+(Programs|Users|scoop|tools)[\\/]|/[a-z]/(Programs|Users)/'`,
  then the same with `-a`. Judge each hit by the test above.

## Workspace

This repo is one of the sibling repos reviewed by the workspace one folder up (since 2026-10-26).
**At session start, read `../cmem/workspace-correspondence.md`, then the letters in
`../cmem/handoffs.md` addressed to this repo.** The workspace rules (`../cmem/working-rules.md`) are
the common floor; this folder governs inside the repo. Nothing is written into a sibling repo from
here. The triggers "update the project memory" (audit for stale live claims, not just edit) and
"look for code issues" (silent fall-throughs first) are the workspace's, `../cmem/INDEX.md`.

## Files

| file | what it holds |
|---|---|
| [overview.md](overview.md) | What the input actually is, and why it cannot be printed naively |
| [design-decisions.md](design-decisions.md) | ⚠️ The load-bearing choices **with the numbers** — do not silently revert |
| [architecture.md](architecture.md) | Three modules, one runtime adapter, why the core has no I/O |
| [verification.md](verification.md) | What "nothing was lost" proves, its two limits, and the costliest lessons |
| [known-issues.md](known-issues.md) | Template assumptions, the `$` ambiguity, the full bug ledger |
| [testing.md](testing.md) | How to test, especially the **negative controls** |
| [licensing.md](licensing.md) | Verified dependency licences (MIT project) |
| [roadmap.md](roadmap.md) | **Current state** and open tasks, incl. the owner's workspace items (task 11) |
| [bun-migration.md](bun-migration.md) | The move off Deno (JSR kept): what was measured, the seven steps, the owner's decisions |
| [practices.md](practices.md) | ⭐ The working rules this project paid for, each with its evidence |
| [best-practices.md](best-practices.md) | The workspace's 28 ★ convergent rules — a stamped verbatim COPY, never edited here |
| [process-log.md](process-log.md) | How it was built: what was tried, what was measured, which claims were wrong |
| [../tests/controls/](../tests/controls/README.md) | The negative-control scripts, path-free, runnable from any checkout |
| `transcript/` | The verbatim session record — ⚠️ **gitignored** (machine paths + client identifiers) |

## Read in this order

1. [overview.md](overview.md), then [design-decisions.md](design-decisions.md) — three of the
   choices look obviously improvable until you see the measurements.
2. [architecture.md](architecture.md), [verification.md](verification.md),
   [known-issues.md](known-issues.md), [testing.md](testing.md).
3. [roadmap.md](roadmap.md) before starting work; [practices.md](practices.md) before changing
   anything load-bearing (§11–§14 came from packaging and releasing; §15 is the Bun-script convention).
