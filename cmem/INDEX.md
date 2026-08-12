# cmem — Portable Project Memory for s3d-reportcompiler

This folder is the **authoritative, portable project memory**. It lives inside the project tree, so it
travels with the project (USB drive, clones, GitHub) and is **committed to git** — unlike a
machine-local memory store. Same convention as `wasmrt`/`wazmrt`.

**Format:** plain Markdown — one focused topic file per domain, so any single concern can be reviewed
without wading through one giant file. Keep files small and single-topic.

🚫 **This is the *only* memory store for the project.** Nothing here may be copied into a machine-local
memory store, and no project fact may be recorded in one — including agent/assistant memory features,
under whatever name. Information stays **100% portable at all times**. A machine-local copy is invisible
to every clone, drifts out of date silently because nothing in the repo references it, and cannot be
reviewed in a diff. If it is worth remembering, it goes in a `cmem/` topic file and gets committed.

**What this is:** a build that turns a folder of SkyCiv structural design reports (HTML) into one
combined, verified PDF. Runs on Deno, Node, Bun and in a browser. See [overview.md](overview.md).

---

## ✅ Status (2026-08-08) — working, verified on all four runtimes

| | |
|---|---|
| Output | **380 pages, 3.35 MB** (~3,354,900 bytes) from 48 reports |
| Maths | 8,286 expressions typeset, **0 failed** |
| Verification | 174 words / 660 numbers checked, **0 missing**; 48 image paints for 48 expected; 48 diagrams intact; 0 surviving LaTeX; 0 blank pages |
| Runtimes | Deno, Node, Bun — **byte-identical baked HTML**; browser bakes and prints |
| Published | **JSR `@jrmarcum/s3d-reportcompiler` v1.0.3**, score **100**, global install works |
| Attestation | 1.0.0 ✅ · 1.0.1 ✅ · **1.0.2 ❌ · 1.0.3 ❌** (both published locally) |
| Next release | **1.0.4 is staged** — bumped and committed, awaiting `deno task release` |

⚠️ **Two releases in a row went out unattested**, because `deno publish` was run instead of the
release task. No tag, no release branch, no Rekor entry for either. **The cause was the name**: `deno
publish` and `deno task publish` differ by one word and do entirely different things, and the
reasonable assumption was that the registry command routed through Actions. It does not.

**The task is now `deno task release`, and there is no `publish` task at all** — deliberately, so the
word is not typeable here and the near-collision has nowhere to start. `deno task publish` now answers
`Task not found` and lists `release`. See [known-issues.md](known-issues.md) #26 and [practices.md](practices.md) §14.

🔒 **The real fix is registry-side:** JSR can be set to *require* publishing from a GitHub Actions
workflow, which makes a workstation `deno publish` fail outright. That is prevention rather than
detection, and it should be enabled on the package settings at jsr.io.

⚠️ **Correction (2026-08-08): the PDF is not byte-reproducible, and an earlier note here saying the
three runtimes produce "byte-identical output" was measured on the wrong artifact.** Chrome stamps its
own render time into `/CreationDate` and `/ModDate`, so *two consecutive Deno builds of identical input
differ in hash* — the difference has nothing to do with the runtime. What is genuinely identical across
Deno, Node and Bun is the **baked intermediate HTML**, verified by sha256
(`a19e5ad1…6277` on all three). That is also the meaningful test, since Chrome is the same binary in
all three cases. The exact byte count of the PDF drifts for the same reason, so it is quoted
approximately above rather than to the byte.

For comparison, the two things this replaced: a render-then-merge approach produced **9.46 MB / 356
pages**, and the manual Bluebeam shrink of that file produced **3.46 MB**. This build beats the manual
step and removes it.

---

## ⏭️ Open work — [roadmap.md](roadmap.md)

**Task 7** is the one real capability gap: conservation is a set union across reports, not per report.
**Task 8** is the deferred MathJax 3 → 4 decision, with an acceptance baseline.

Settled: licence (MIT — task 6 ✅), cwd-relative defaults (task 2 ✅), the repository-contents decision
(task 3 ✅ — sanitized samples only, the client set lives in the git-ignored `local/`), the transcript,
which is no longer tracked (tasks 1 and 4 ✅ by that decision), and the first commit and release
(task 5 ✅).

Published at `github.com/jrmarcum/S3D-ReportCompiler` and `jsr.io/@jrmarcum/s3d-reportcompiler`. Git
needs `safe.directory` set for the D: drive before it will run at all — see
[roadmap.md](roadmap.md) task 5.

## Read in this order

1. **[overview.md](overview.md)** — what the input actually is, and why it cannot be printed naively
2. **[design-decisions.md](design-decisions.md)** — ⚠️ the load-bearing choices **with the numbers**.
   Do not silently revert these; three of them look obviously improvable until you see the measurements
3. **[architecture.md](architecture.md)** — three modules, one runtime adapter, why the core has no I/O
4. **[verification.md](verification.md)** — what "nothing was lost" actually proves, and its two limits
5. **[known-issues.md](known-issues.md)** — template assumptions, the `$` ambiguity, the full bug ledger
6. **[testing.md](testing.md)** — how to test, especially the **negative controls**
7. **[licensing.md](licensing.md)** — verified dependency licences
8. **[roadmap.md](roadmap.md)** — open tasks and repository decisions
9. **[practices.md](practices.md)** — ⭐ the working rules this project paid for, each with the evidence.
   General enough to outlive this codebase; read before starting anything similar. §11 and §12 came
   from the first release failing, and are the two most likely to save someone else a bad afternoon

### The record of how it was built

- **[process-log.md](process-log.md)** — the route taken: what was tried in what order, what the
  measurements said, and which of my own claims turned out to be wrong. Read this to understand *why*
  the code looks like it does rather than just *what* it does.
- **[../tests/controls/](../tests/controls/)** — the actual test scripts used, recovered from the
  session file history with their machine paths removed so they run from any checkout. They moved out
  of `cmem/` and into `tests/` when the repository was restructured: they are executable tests, and
  `tests/` is where tests live. See [../tests/controls/README.md](../tests/controls/README.md).
- **`transcript/`** — the verbatim session record, in two parts. ⚠️ **Untracked by owner decision**
  (2026-08-08): it carries absolute paths from the machine it was recorded on and client identifiers
  from the report excerpts, so it stays local and is listed in `.gitignore`. It is therefore the one
  part of this memory that does *not* travel with a clone; everything durable from it belongs in the
  topic files here.

---

## The lessons that cost the most to learn

⚠️ **A converter that reports success is not the same as a correct document.** Three separate failure
modes in this project were *silent*: an unrecognised delimiter (480 expressions typeset as prose while
the log said `0 failed`), a stale PDF read back after a failed render, and a CSS rule dropped by the
scoping refactor. None raised an error. All three are why the build now verifies itself and exits
non-zero. See [verification.md](verification.md).

⚠️ **Faithful HTML rendering requires an HTML engine.** This is not a limitation of one tool — the
markup has no appearance until an engine computes one, and every engine computes it differently. The
original script used WeasyPrint, which has no JavaScript engine, and would have produced ~400 blank
pages. See [design-decisions.md](design-decisions.md).

⚠️ **As the pipeline hardened, the bugs moved into the checker.** Reviews 1–2 found bugs in the
builder; reviews 4–5 found bugs in the verification code — an image count that assumed one figure per
report, a blank-page test that would flag a diagram-only page, a diagram check that silently no-ops.
A broken check is more dangerous than a broken build: it fails in the safe-looking direction.

⚠️ **The verification caught a bug introduced by the hardening.** Adding `browser_example.html` to the
folder made it a 49th report. The build refused to ship. Conversely, the **stray-semicolon** bug — the
CSS scoping silently deleting a rule from every report — was found only by a **negative control**,
because the dropped rule was cosmetic and lost no words or numbers. Both kinds of test are load-bearing.
