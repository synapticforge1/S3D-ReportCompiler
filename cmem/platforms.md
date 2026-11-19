# platforms.md: where s3d-reportcompiler runs, and what each platform needs

Last verified: 2026-11-19. The support matrix (workspace review standard § 12, letter H37 (g)), then a note
per platform where there is something to say. The IDs, statuses and machine roles are the workspace's,
`../workspace/cmem/platforms.md`. Settings stay in code: each carries a comment naming its platform IDs, so
`git grep -n "Platform: "` finds every one. Machine names and paths: `cmem/local/` only.

## Support matrix

| Platform | Status | Target name | Tested on |
| --- | --- | --- | --- |
| `win-x64` | tested | none (pure TypeScript) | dev machine |
| `win-arm64` | pending | none (pure TypeScript) | no machine yet |
| `mac-x64` | pending | none (pure TypeScript) | no machine yet (Intel Mac) |
| `mac-arm64` | pending | none (pure TypeScript) | no machine yet (arm64 Mac) |
| `linux-x64` | tested | none (pure TypeScript) | GitHub's `ubuntu-latest` runners (CI, last on `e6fcbd5`, 2026-11-19); WSL next |
| `linux-arm64` | pending | none (pure TypeScript) | no machine yet |

- **What "tested" covers:** the full suite and the sample build. The package is pure source (JSR and npm), so
  there is no per-platform build; what is platform-dependent is the OS calls in `src/report_runtime.ts` (the
  `host` module of letter H39, to be named `host.ts`) and the Chrome route.
- **Per engine (letter H39):** what the package computes is tested per JavaScript engine — V8 (Node 22.18,
  24.21, 26.12 through fnm; Deno) and JavaScriptCore (Bun 1.4.4) — not per platform. The arm64 rows move to
  `runtime` once `host`'s self-check has passed on that OS; until then they are `pending`.
- **The Chrome route stays OS-dependent** (H39): a report with maths or a drawing is printed by an installed
  Chrome or Edge, which the tool finds per OS. It is tested on each OS claimed for it.
- **Tested on (the interim rule, owner 2026-11-19):** each release states `Tested on: <OS and version>
  (<platform ID>)` per platform actually run — on the Release page, in its `release.md` entry, in the README —
  and "other platforms: not yet tested" for the rest.

## Runtimes

| Runtime | Version | Engine | Where it runs |
| --- | --- | --- | --- |
| Bun | 1.4.4 | JavaScriptCore | dev machine (installed by scoop) |
| Node | 22.18 (the floor), 24.21, 26.12 | V8 | dev machine, through fnm (installed by scoop) |
| Deno | 2.9 LTS | V8 | CI's JSR checks and runtime legs (owner goal: no Deno dependency locally) |
| Browser | any with ES modules | varies | the core only (`src/report_core.ts`); no file system |

## Linux distros (`linux-x64`)

| Distro | glibc | Status | Tested on |
| --- | --- | --- | --- |
| Ubuntu, GitHub's `ubuntu-latest` | as the runner image gives it | tested: every test job green on `e6fcbd5` (run 44635013545) | CI, retired 2026-11-19 |
| Ubuntu in WSL (26.04.1 LTS on 2026-11-19) | 2.43 | tested: the POSIX-only tests, 2026-11-07/08 (version then not recorded) | dev machine's WSL |

**From 2026-11-19 the Linux runs are WSL's** (owner: "WSL Ubuntu locally"): `bun run release` runs the suite
there when WSL has Bun (installed 2026-11-19 at `~/.bun/bin`, the pinned 1.4.4 zip, sha256-checked) and a
Chrome on its PATH. ⏳ **Chrome in WSL is not installed** — it needs `sudo apt` (the owner's); until then the
release prints "linux-x64: not run, not claimed".

**glibc baseline (2.28):** unaffected. The package links nothing; it is source run by the user's runtime. Chrome
is the user's own install.

## win-x64, win-arm64

- **Chrome or Edge is found at their Windows install locations**, the per-user `%LOCALAPPDATA%` one included;
  `CHROME_PATH` overrides. Where: `findChrome()` in `src/report_runtime.ts`.
- **No process groups:** a timed-out Chrome is killed by its own handle. Where: `runWithTimeout()` in
  `src/report_runtime.ts` (`detached: !windows`).
- **Only SIGINT and SIGTERM exist.** Where: the signal handlers in `main.ts`.
- **A PDF open in a viewer cannot be deleted or written** (it can be read): a stale PDF that will not go
  refuses the build, naming it (ledger #31). Where: the stale-PDF removal in `main.ts`.

## mac-x64, mac-arm64

- **Chrome or Edge in `/Applications`.** Where: `findChrome()`.
- **Root needs Chrome's `--no-sandbox`**, as on Linux. Where: `runningAsRoot` in `main.ts`.

## linux-x64, linux-arm64

- **Chrome, Chromium or Edge from the package manager or snap.** Where: `findChrome()`.
- **Chrome's sandbox:** kept, except as root (uid 0), where Chrome cannot start with it; `S3D_CHROME_NO_SANDBOX=1`
  for a host with no usable sandbox. Measured on CI's runners with the sandbox on (2026-11-06, ledger #58).
  Where: `runningAsRoot` and `sandboxSetting` in `main.ts`.
- **Process groups:** Chrome runs in a group of its own, killed whole on a timeout; SIGHUP and SIGQUIT are
  handled too. Where: `runWithTimeout()`; the signal handlers in `main.ts`.
- **exFAT checkouts** (any OS): `git config --local maintenance.strategy gc` ([archive/roadmap-closed.md](archive/roadmap-closed.md) task 5; workspace letter H16).
