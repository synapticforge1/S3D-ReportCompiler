# Review process — targeted agent code reviews, security reviews, hardening reviews

🔒 **Owner, 2026-11-12:** "scope out the QA/QC process that we have been using for this project. I
would like to pass it back to the workspace for inclusion in each project … include the code review
process in this repo for the 'targeted agent code reviews', 'the security reviews' and the
'hardening reviews'." This file is that process, written from what was RUN here (2026-11-06 →
2026-11-12), not from a plan; each rule names the evidence that put it here. It sits beside the
workspace's "commit", "push" and "release" (INDEX § Owner commands; `../cmem/release-process.md`).

**For the workspace** (correspondence row C46): §§ 1–5 are written to be lifted into any repo as
they stand. What is THIS repo's -- its reference sets, its hashes, its threat surface -- is marked
**[S3D]**; another repo substitutes its own.

---

## 1. The floor — every review, whatever its kind

### 1.1 Who reviews, and what they are given

- **Fresh reviewers, not the author.** A reviewer that did not write the code and is not handed the
  author's conclusions. An agent handed a hypothesis tends to return it confirmed; one handed the
  CODE finds what the author could not see. (T1-3 round 1, 2026-11-12: three fresh reviewers found
  27 silent mis-drawings in a renderer whose own tests all passed, #123.)
- **One reviewer per area, scopes that do not overlap**, run in parallel. Three or four per round
  has been the useful size: full-project reviews used four (core; CLI/runtime; release/CI;
  tests/config/docs), T1-3 used three (routing and join; the renderer; the verification).
- **The brief is the reviewer's only context** (template: § 5). It names the goal, the files, the
  commit range, the documents to read first, what to attack, how to run things, the limits (read
  only, own scratch folder, no client data), and the report's shape. Never the author's verdict.
- **Read-only.** A reviewer never edits the repository, commits, pushes or tags; experiments live in
  its own scratch folder. It never reads client data **[S3D: `local/`]**.

### 1.2 What a finding must carry

File and line; the defect; a **concrete scenario** (this input → this wrong output / crash);
whether it was RUN or only reasoned; **severity**; confidence. And what the reviewer checked and
found sound — "nothing found in X" is a result, and its absence hides a gap.

**Severity, measured, never inherited** (workspace best-practice 5.10): **silent wrong output >
crash > loud refusal of correct work > cosmetic**. A wrong result that PASSES ranks above
everything **[S3D: a dropped or changed value in a certified calculation that still looks right]**.

### 1.3 What happens to a finding

1. **Re-verified by the author with a run before anything is changed** — the reviewer's own
   reproducer first, then the author's. A reviewer can be confidently wrong; so can the author:
   the #121 rule, believed sound and committed with its tests, was shown too permissive by a
   reviewer's run (anagram titles accepted, #125) — and the author's own "Chrome writes no link
   targets here" was disproved the same way (#124).
2. **Fixed as its CLASS, not its instance** (🔒 owner, 2026-11-06: "make sure the fix is for all
   conditions that could occur like this, not just this specific case"). Name the class in the
   commit and the record; test a member the finding did not show.
3. **A test that fails without the fix.** Run the new test against the commit BEFORE the fix
   ("inverted"), section by section — one failing section can hide another that would pass
   (practices §17). Where the fix has parts, a **mutant per part** (remove one part, the test must
   fail for that part's reason). A test that cannot fail for the reason it names is not a test
   (practices §2). If no test can see a line, the line goes, or is said to be unseen.
4. **The reference results still hold** after every group **[S3D: the 13 samples bake to
   `487321f2…` and PASS; the 48 set `da92578d…`; the 75-report zip; the 36ft report natively —
   design-decisions §10, roadmap § Current state]**. A change to them is a finding until explained.
5. **One commit per group of related fixes**, the test with it; an API-surface re-baseline in a
   commit of its own **[S3D: `bun run surface`]**; the gate run before each commit.
6. **Recorded** (§ 4): the ledger row, the dated measurement, the corrected claim.

### 1.4 Rounds — a fix is new code

**After fixing, the fixes are reviewed again, by fresh reviewers, as new code** (practices §16).
Every round here found something in the round before's fixes: 2026-11-06 ran eight rounds (7, 6, 4,
4, 3, 1, 3, 2 findings; most of rounds 3–4's were in fixes written hours earlier); the fifth
full-project review found two wrong-PASS defects in code a review had just cleared. **Stop when a
round finds nothing in the previous round's fixes and nothing silent anywhere** — not after a
fixed number. Two empty rounds in a row on the same axes mean the axes are stale, not that the code
is clean (workspace 5.12): change the axes before declaring it done.

### 1.5 Who decides

The findings are presented to the owner **verified and ranked**, grouped (A, B, C …), with a
recommendation; the owner chooses scope and order ("fix all", "A→E", "fix D first"). Nothing is
pushed, tagged or released by a review — only by the owner's "push" / "release". CI's run on the
pushed commit is part of done: a review's tests have not run on Linux / every runtime until it
has **[S3D: `ci.yml`'s 7 jobs]**.

---

## 2. Targeted agent code review

**What:** a review aimed at a defined change or area, by agents, in rounds (§ 1.4). The default
kind, run:
- **after a feature or a change set lands** (T1-1's routing and join → T1-3 round 1);
- **on the previous round's fixes** (round 2 …);
- **before any release**, on everything since the last one;
- **when the owner asks for a full-project review** — the same process with the areas covering the
  whole repository (§ 2.2).

### 2.1 Scoping the round

1. Fix the **commit range** (`git log <base>..HEAD`) and list what changed, by area.
2. Choose **3–4 areas** with no overlap; each gets one reviewer. Cut along the risk, not the file
   tree: "the routing and the join", "the renderer's fidelity", "the verification on joined
   PDFs" — not "main.ts, report_core.ts".
3. For each area write the **attack list**: the questions most likely to find a SILENT defect in
   it (the brief's "Questions worth attacking (not exhaustive)"). Ask what the change can ADD, HIDE
   or CARRY OVER, not only what it can lose (practices §17).
4. Name the **regression risk**: what was right before that the change could break, and the
   previous commit to compare against.

### 2.2 Its variants (each run here)

| variant | areas | when | here |
|---|---|---|---|
| change review | the change's own areas | after a step | T1-3 round 1 (3 reviewers, #123–#125) |
| fix review (cold) | the fixes of the round before | every round after the first | 2026-11-06 rounds 2–8 (#44–#60); T1-3 round 2 |
| full-project review | core; CLI/runtime; release/CI; tests/config/docs | on the owner's word, before a minor | five, 2026-11-06 → 08 (#61–#86) |
| class-by-class review | ONE class of issue across the repo, re-checked by a fresh reviewer of that class until clean, then the next | when findings cluster by kind | task 18 (🔒 owner, 2026-11-08): classes B, A, C, E, D, F — **[S3D]** A output fidelity, B verification gaps, C privacy, D release integrity, E lifecycle and errors, F tests and docs |

---

## 3. Security review

**What:** a review of what an untrusted input, a hostile environment or a compromised step could do
— run as its own pass, by reviewers briefed on the threat surface below, because a functional
review asks whether the output is right, not what the input can make the tool do.

### 3.1 The surfaces (each with what was found or settled here)

1. **Untrusted input runs nothing and loads nothing.** **[S3D: a report is HTML/CSS/JS/SVG/images
   from outside.]** Scripts, event handlers and `javascript:` URLs stripped; a Content-Security-
   Policy in the document forbidding scripts and every outside load — **measured: 5 network
   requests during a render before, 0 after** (#55, #60); Chrome's sandbox kept on, except as root,
   and checked on CI's real Linux runners (#58).
2. **Malformed input is a refusal, never a crash or a guess.** A bare `%` in a data URI crashed the
   native render (#123); a malformed zip, an unreadable entry, an encoding the decoder cannot
   prove (`decodeReport`, 1.3.0) — each refused by name.
3. **Archives and paths.** Nothing unpacked to disk; entries read in memory; folders, zip64,
   encryption, data outside entries refused (task 16); an output that would overwrite an input
   refused, and a user's file never deleted by a refusal (the second full-project review found two
   ways it was: #67–#71).
4. **Resources.** Time limits on every external process (`S3D_CHROME_TIMEOUT_MS`, a hard cap a
   timer can hold), memory measured on the largest real input (the 36ft report's peak, roadmap
   task 19); a huge input fails loudly, never half-written.
5. **The release path (supply chain).** Publishing only from CI with provenance (OIDC), never from
   a workstation (#26); actions and tools pinned by SHA-256; registry read-backs fatal; tokens
   scoped (`contents: write` only where needed); no `gh` (H30) **[S3D: release.md]**.
6. **Dependencies.** `bun audit` / `npm audit` at each review; every licence verified from the
   installed package, redistributed files with their licence (THIRD-PARTY-NOTICES.md).
7. **Privacy.** No secret, personal datum or machine path in any committed file, message or
   package; client data never committed, published or printed — diagnosed by showing only tokens
   that also occur in the public samples (INDEX § Privacy). A scan STOPS a push; it does not report
   beside it (process-log, 1.2.0).

### 3.2 How it is run

- **Planted hostile inputs, measured** — a report that tries to fetch, a handler, a hidden
  `@import`, a broken byte — never "the code looks safe".
- **In the environment that will run it** (practices §11): the sandbox on CI's Linux runners, not
  only on Windows.
- **Each surface's finding gets the § 1.3 treatment**; a security fix is reviewed again cold — the
  sixth pass turned the sandbox on, the seventh found hosts where it could not start (#58).

---

## 4. Hardening review

**What:** making a working feature fit for release: every environment it will run in, every way it
can fail, every limit written down, the shipped artifact proven. **A lens, not a task** (workspace
5.12): run it on each feature before its release, and whenever the environments change.

### 4.1 The axes (T1-2, 2026-11-12, is the worked example)

1. **Every environment, from the artifact users get.** Linux and Windows; every supported runtime
   line; the INSTALLED package, not the working tree; a clean clone, not a tree with
   `node_modules` (practices §11) **[S3D: Bun, Node 22.13 floor / 22 / 24 / 26, Deno in CI;
   `npm:prove` installs the tarball and runs it on each — its native leg found #122]**.
2. **Every failure path ends in a message, and nothing is lost by failing.** No stack traces; on
   refusal or interrupt nothing is deleted, renamed or half-written; an earlier output named and
   left (#122: a font file altered by one byte crashed instead of saying so).
3. **Limits written down by name** — what the feature refuses or cannot do, for users, read from
   the code's own refusals and kept in step with it **[S3D: README "What the native renderer draws,
   and what it refuses"]**.
4. **Resources measured** on the largest real input, with the numbers dated.
5. **The evidence re-run** on every real reference set, and recorded as the release's evidence.
6. **CI covers it** — the feature's tests run on every CI platform and runtime; where the machine
   cannot prove something (no Deno here), it is named as CI's half and waits on the push.
7. **Inverted:** each hardening check is shown able to fail (an altered font must fail every
   runtime's leg).

---

## 5. The brief — a template

```
You are an adversarial <kind> reviewer for <repo> at <path> (<platform>; <runtime>).
Find real defects. Do NOT modify any file in the repository; do not commit, push or tag. Work in
your own scratch folder under the system temp folder. Never read <client-data paths>.

WHAT THE TOOL IS, and what failure costs: <two lines; the worst outcome named>.
Read first: <the repo's pointer file>, <the design records for this area>.

YOUR SCOPE: <the area>, <commit range: `git log <base>..HEAD`, `git show <sha> -- <files>`>,
<the functions / files by name>.

ATTACK (not exhaustive): <the questions most likely to find a SILENT defect here; what the change
can add, hide or carry over; bypasses of any new guard; regressions against <previous commit>>.

HOW TO TEST: <the entry points, harnesses, a fixture, how to compare against the previous commit,
the reference results that must still hold>.

REPORT: findings, most severe first — file:line, the defect, a concrete scenario (input → wrong
output / crash), whether you ran it, severity (silent wrong output > crash > loud refusal of
correct work > cosmetic), confidence. Say what you checked and found sound. Under <N> words.
```

---

## 6. Records — where each result goes [S3D layout; any repo's equivalents]

| what | where |
|---|---|
| each finding fixed: what, measured, the class, the fix, the test, the inversion | [known-issues.md](known-issues.md) — one ledger row, `#n` |
| what was found and NOT fixed (older, loud or cosmetic), with why | known-issues.md, "Recorded, not fixed" after the round's rows |
| a claim found wrong (in memory, docs or a commit) | corrected where it stands, marked 🔁 with the date and the row that found it |
| the round: reviewers, scope, counts, what is next | [roadmap.md](roadmap.md), under the task |
| the test runs and their numbers | [testing.md](testing.md) |
| what was believed against what was measured | [process-log.md](process-log.md) |
| a lesson that changes how work is done | [practices.md](practices.md) |

The commit message names the round and the ledger rows (`Review T1-3, round 1: … (#123–#125)`).
