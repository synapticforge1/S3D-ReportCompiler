# Roadmap / Task List

Open work, highest priority first. Status markers: 🔴 not started · 🟡 in progress · ✅ done.

Keep this current — it is the first thing to read after [INDEX.md](INDEX.md) when picking the project
back up. **The status line lives here and nowhere else** (workspace memory policy, letter H26; moved
out of `INDEX.md` and `CLAUDE.md` on 2026-10-26).


**Where the project stands: [STATE.md](STATE.md)** (since 2026-11-19, H38; the old status table is
[archive/roadmap-state-to-2026-11-19.md](archive/roadmap-state-to-2026-11-19.md)). Closed tasks 1–7 and
12–17: [archive/roadmap-closed.md](archive/roadmap-closed.md). Open below; tasks 18 and 19 have files of their own.

---

## 🔵 8. MathJax 3 → 4 — deliberately deferred, not overlooked

`npm install` prints:

```
npm warn deprecated mathjax-full@3.2.2: Version 4 replaces this package with the scoped package @mathjax/src
```

**This is a deprecation notice, not a security advisory.** `npm audit` reported **0 vulnerabilities**
on 2026-08-08. 🔁 On 2026-10-26 it reported 1 high + 1 moderate, both `@xmldom/xmldom` 0.9.10 pinned
exactly by `speech-rule-engine` 4.1.4 under `mathjax-full` — fixed by an override to 0.9.12 on
2026-10-28 (task 13; `npm audit` 0 again), not a reason for v4.
`mathjax-full@3.2.2` is Apache-2.0, exact-pinned, and typesets all 8,286 expressions with 0 failures.

### Why staying is the right default here

⚠️ **MathJax 4 replaced the font system.** v3 ships its own woff-v2 fonts, which this build inlines from
`mathjax@3.2.2/es5/output/chtml/fonts/woff-v2` to make the document hermetic. v4 uses a different font
architecture, so `MATHJAX_FONTS` would need repointing — and **different fonts mean different glyph
metrics, different line breaking, and a different page count.**

For a sealed calculation package whose current output is a verified 380 pages, that is a material
change, not a version bump. The build would need re-verifying and the page count would very likely move
— exactly the kind of churn to avoid without a reason.

### What migration would involve, if a reason appears

1. `npm rm mathjax-full && npm i @mathjax/src` — imports map cleanly: the package's `exports` field
   routes `./js/*` → `./mjs/*`, so `@mathjax/src/js/output/chtml.js` resolves.
2. Repoint `MATHJAX_FONTS` in `report_core.ts` at the v4 font path.
3. Re-run the build on all three runtimes; the verification is the regression test.
4. Expect the page count to change, and re-baseline the figures in `INDEX.md`,
   `design-decisions.md` and `overview.md`.
5. Note the size cost: `@mathjax/src` unpacks to ~33.7 MB across 4,287 files.

**Triggers that would justify it:** a security advisory against `mathjax-full`, a TeX construct v3
cannot render, or v3 breaking on a future runtime.

### 🔁 MathJax limitations the bake works around — RE-CHECK ON EVERY MATHJAX UPDATE

🔒 Owner, 2026-11-05: "We need to note these as what they are, MathJax limitations. These will need
to be checked whenever MathJax is updated to the next version." Each is a MathJax behaviour (3.2.2,
measured 2026-11-05), not this repo's logic; the workaround lives in `src/report_core.ts`, and
**`bun run test`'s "MathJax limitations" test pins M1–M4, and "review 3, group A" M5–M6** — run them first after any MathJax
change (any version, 3.x patch included, and the v4 migration above). A failure there names the
limitation; re-measure it, then update the workaround, the test and this list together.

Columns: # · Limitation · Workaround · Pinned by.

- M1 — **Entity tables load asynchronously.** The core table has 406 names and lacks common ones (`&ge;` `&ne;`
  `&plusmn;` `&minus;` `&middot;` `&sum;` … — 45 of 76 probed); the other 2125 load on demand, which a synchronous
  `convert()` cannot wait for. — `import "mathjax-full/js/util/entities/all.js"` fills the table synchronously;
  `texFromMarkup` reads it case-sensitively (`&Delta;` ≠ `&delta;`). — each entity typesets exactly like its character;
  an unknown one fails
- M2 — **`\text{}` keeps U+00A0 but collapses ASCII spaces** (maths mode treats them alike). — `&nbsp;` decodes to U+00A0, as the DOM does, never to a space. — `&nbsp;` ≡ `&#160;` ≠ two spaces
- M3 — **A TeX error does not throw.** By default MathJax typesets an inline red error box ("Misplaced &", "Undefined
  control sequence") and returns normally — the bake would count it as converted and seal the box into the PDF. —
  `formatError` rethrows, so the error is counted as failed and the build refuses. 0 error boxes in the 13 samples and
  the 48-report client set when added. — an unknown entity (a bare `&`) counts as failed
- M4 — **CHTML must emit no `<svg>` or `<style>`.** `portableSvg` rewrites every `<text>` and hoists every SVG
  `<style>`, safe only while MathJax's own output has neither (see the ordering note on `portableSvg`). — none needed
  while it holds; switching the output to SVG would break it. — the typeset output holds no `<svg` / `<style`
- M5 — **Two packages in `AllPackages` turn errors into text** (added 2026-11-07, known-issues #72): `noundefined`
  typesets an unknown command as its red name and returns normally, so M3's `formatError` never ran for the commonest
  TeX error; `noerrors` typesets a failed expression's source. — `TEX_PACKAGES` filters both out. — "review 3, group A"
  § 1: `\phiM_n` counts as failed
- M6 — **Definitions outlive the expression** (2026-11-07, #72): `\def` / `\newcommand` / `\let` /
  `\DeclareMathOperator` / `\newenvironment` go into the `newcommand` package's `new-Command` / `new-Environment` /
  `new-Delimiter` maps, `\definecolor` into `packageData.color.model.userColors`, `\newtagform` into the tags'
  `mtFormats` — for the life of the TeX input, so one report's changed the next. — `resetTexDefinitions()` clears all
  five per report (and in `resetBakeState`), and THROWS if one is not where 3.2.2 keeps it. — "review 3, group A" § 2

Also MathJax-dependent, and covered by the full build rather than this test: the woff-v2 font path
(`MATHJAX_FONTS`, above) and the page count (the degradation baseline below).

### 📌 Decision (2026-08-08, owner): deferred until a migration is verified to cause no breakage or degradation

Adopt v4 only after it is demonstrated against the baseline below. Deprecation alone is not a reason.

⚠️ **The built-in verification proves the absence of breakage, not the absence of degradation.** It
checks that every word and number survived, that no graphic was sliced and that no LaTeX went
unrendered — so a migration that reflowed the document from 380 pages to 500 would still report
`PASS`. Degradation has to be judged separately, against these figures.

**Baseline to beat or match — `mathjax-full@3.2.2`, 48 reports:**

| Measure | Baseline | Acceptance |
|---|---|---|
| Verification | **PASS**, 0 words / 0 numbers missing | must still PASS — non-negotiable |
| Expressions | 8,286 converted, **0 failed** | must still be 0 failed |
| Pages | **380** | a change is expected; a large increase is degradation |
| Packed size | **3.35 MB** (~3,354,900 bytes; drifts slightly, see below) | material growth needs a reason |
| Intermediate HTML | 15.30 MB, 0 scripts, 0 external refs | must stay hermetic |
| Graphics | 48 image paints / 48 expected, 48 diagrams intact | unchanged |
| Equations searchable | yes — CHTML is real text | must stay text, not vector outlines |
| Runtimes | identical output on Deno, Node, Bun | unchanged |

⚠️ **Do not compare the PDFs by hash, and do not treat a small byte-count change as a regression.**
Chrome stamps the render time into `/CreationDate` and `/ModDate`, so the packed size drifts by a few
hundred bytes between runs of *identical* input on the *same* runtime. Compare the baked HTML by
hash and the PDF by page count and approximate size. See [testing.md](testing.md).

**How to judge degradation**, since no tool does it automatically:

1. Build with v4 into a **separate** output path, keeping the v3 PDF for comparison.
2. Compare the table above.
3. Rasterise the same few pages from each and look at them — `tests/controls/verify-pdf-text.ts` for the
   text side, and the page-render approach in [testing.md](testing.md) for the visual side. Equation
   spacing and line breaking are where a font change shows first.
4. Only then re-baseline the figures in `INDEX.md`, `design-decisions.md` and `overview.md`.

---

## 🔵 9. Optional hardening — scope the remaining blanket CSS rewrites

`visibility: hidden → visible` and `height: 100% → auto` are still textual replacements across each
report's stylesheet. They are audited and counted, and the conservation check backstops the failure they
would cause (hidden content = missing words and numbers).

Narrowing them to specific selectors means evaluating the CSS cascade. Deliberately not done — the
current form fails *visibly*, which is the safer class. See [known-issues.md](known-issues.md).

---

## 🔵 10. The upstream pitch to SkyCiv

The strongest version of this work is not the converter. Three findings, all measured, are worth taking
to them:

1. Their reports cannot be printed by anything without a JavaScript engine.
2. Their reports render differently on different machines — `Lato` is declared but never loaded.
3. Their `tex2jax` config declares `['\[','\]']`, which JavaScript evaluates to a bare `[` and `]`.

Emitting **MathML** would fix (1) and (3). Generating PDF from their data model would remove the
round-trip entirely — the case where **Typst** becomes the right tool.

See [known-issues.md](known-issues.md) and [design-decisions.md](design-decisions.md).

---

## 🟡 11. Workspace floor (letter H26) — one owner action left: the GitHub Support request (item 2)

Since 2026-10-26 this repo sits under the workspace's common rules (`../workspace/cmem/working-rules.md`
since 2026-11-19, letter H42; `../cmem/` before). Done in-repo on 2026-10-26: `origin` reset to the org, the stale links
fixed, the drive path at HEAD replaced, `maintenance.strategy gc` set, the ★ block copied
([best-practices.md](best-practices-shared.md)), the privacy rule recorded ([INDEX.md](INDEX.md) § Privacy),
`.gitattributes` made wildcard-first, the status line moved here. Then, the same day:

1. ✅ **Pushed** (owner: "yes").
2. ✅ **The drive path purged from history (H19)** (owner: "Purge now"), force-pushed with the three
   tags and `release/v*` branches; every commit id from `387cbd9` changed. Method, verification,
   the old → new map, and what the moved tags re-triggered: [history-purge-2026-10-26.md](archive/history-purge-2026-10-26.md).
   ⚠️ **Learned there: `deno publish` SKIPS an already-published version with exit 0**, so a
   re-run of `publish.yml` does NOT stop at the publish step — it runs on into the release-branch
   and GitHub Release steps. Harmless this time; read the workflow before ever moving a `v*` tag.
   🗓️ Still the owner's: a GitHub Support request to drop the old commits GitHub serves by hash.
3. ✅ **The five `scripts/*.ts` ran under Deno** (drift X17). Owner 2026-10-26: port them — done in
   task 12 step 4 (`129fd0a`): `scripts/` and `tests/controls/` run on Bun.
4. ✅ **JSR: require publishing from GitHub Actions** — settled 2026-10-28 (owner): it is JSR's
   default once the GitHub repository is linked, and the link is in place (#26 above).
5. ✅ **The pull line** ("At session start, read `../cmem/workspace-correspondence.md`, then the
   letters in `../cmem/handoffs.md` addressed to this repo") is in the gitignored `CLAUDE.md` on
   this machine, and INDEX § Workspace carries the same instruction for clones.

6. ✅ **The workspace memory moved (H41, H42, 2026-11-19)**: now `../workspace/cmem/`, one file per
   item in `letters/`; the pull line in `CLAUDE.md` and INDEX § Workspace updated; Tooling rule 15
   (H43, scratch) recorded in INDEX § Workspace and the reviewer brief. Answered in H41/H42/H43.
7. 🟡 **Open, scoped 2026-11-19 (owner agreed the order): three workspace letters.**
   (a) ✅ **H38 done 2026-11-19** (owner: "go"; design-decisions §11; `check-cmem`: all limits hold).
   Was: memory migration first — `check-cmem` (`../workspace/tools/check-cmem.ts --summary
   cmem`): 847 problems (no STATE.md, INDEX > 3 KB, 835 lines > 200 chars, 10 files > 25 KB;
   known-issues 151 KB, roadmap 138 KB, testing 64 KB). ⚠️ STATE.md takes over the status line
   from this file. (b) **H37** items (a)–(g): `review-process.md` from the final standard;
   `cmem/review-issues.md` gitignored + a privacy gate; open known-issues moved there; a review
   step in `publish.ts`; `ci.yml`'s test jobs removed and `publish.yml`'s "ci.yml passed" check
   replaced (a changed release job: rehearse first, never mid-release); the review words in Owner
   commands; `cmem/platforms.md`; a `Tested on:` line. (c) **H39** `host.ts`: `report_runtime.ts`
   already holds every OS call — rename or re-export (the `./runtime` export: the gate decides), a
   `check-host` gate, `--self-check`, arm64 rows `runtime`; baked hashes must not move. (b) and (c)
   come before the next release; neither touches task 19.

**Correspondence this repo opened** (`../workspace/cmem/workspace-correspondence.md`; the ledger
before 2026-11-19 is `../workspace/cmem/archive/workspace-correspondence-to-2026-11-19.md`):
- **C46 ✅ closed from this end 2026-11-19** (owner: "leave C46 for the workspace to close") —
  adopted by the workspace 2026-11-12 (letter H35), then replaced by the final standard, letter H37
  (2026-11-17); nothing more is asked of it here. The workspace session sets the status and moves
  `letters/C46.md` and its index line to `archive/`. Was: the review process (targeted agent code reviews, security reviews,
  hardening reviews) offered to the workspace for every project (🔒 owner: "pass it back to the
  workspace for inclusion in each project"). Held for the owner's review first, then amended by
  the owner: the words "review" / "security review" / "hardening review"; a round that finds
  nothing stops the review; security and hardening reviews before every release. Full text
  [review-process.md](review-process.md) at `cfab945`. This repo closes the row once the
  workspace's adoption is readable.
- **C20 ✅ closed 2026-10-28** — `--config jsr.json` corrupts a package with dependencies: binaryang's
  `jsr-deno-exit-guide.md` F1 / § 4 carry the caveat (`39c127def`, was `a846dc68f`, on its `origin/main`); wasmtk's
  `deno-exit-plan.md` P1 must prove its upload (`67686067a60`). Verified read-only by this repo.
- **C21 ✅ closed 2026-10-28** — six findings from task 12 steps 2–4: binaryang's guide § 5a carries
  all six (`97c2c0375`, was `a3d338e8e`, five re-measured), wasmtk's plan maps each to a phase (`67686067a60`).
  binaryang NARROWED (5) — only `jsr add`'s alias install is refused by npm 12 — re-measured here and
  carried into known-issues #27 and the README.
- **C27 ✅ closed 2026-10-28** (filed as C26, renumbered after a collision) — five findings from
  steps 5–7 and 1.1.0 for binaryang's guide; answered `60025f640` (local `main` at closing),
  verified read-only (bun-migration.md § "binaryang's guide update … reviewed").

**Correspondence addressed TO this repo:**
- **binaryang's C26 (2026-10-28) — ANSWERED 2026-10-28** (owner: "proceed with items 4 and 5"):
  binaryang rewrote its history a second time, so quoted binaryang ids went stale; translated
  through the table in the workspace's handoffs (the C26 bullet; since 2026-11-19
  `../workspace/cmem/archive/handoffs-to-2026-11-19.md`). Measured with a one-time read-only
  scan of every TRACKED file here for binaryang commit ids: **three were stale and are translated**
  — `a846dc68f` → `39c127def` (bun-migration.md, C20 above), `a3d338e8e` → `97c2c0375` (C21
  above), and `899b3fa5d` → `54cc098ea` (quoted only in this paragraph's earlier text); the old ids
  stay beside the new as "was". Still current, checked on a binaryang branch: `701d1043d`,
  `60025f640`, `8d9ba0cb9`; `b8fafaa3f` (best-practices 6.1) is quoted ON PURPOSE as the id
  before binaryang's FIRST purge and stays. The answer is in binaryang's row; binaryang closes it.
  (The workspace ledger's C20/C21 rows quote the old ids too — those are the workspace's to
  translate, as C26 lists.) **✅ CLOSED by binaryang 2026-11-05**: its 398-pair re-scan verified
  this repo ("S3D-ReportCompiler ✅ verified … nothing stale"); all four recipients done.

**Status of every ledger row naming this repo — re-read 2026-11-05.** Nothing in the ledger waits on
this repo. One item is the owner's (H19). The rows still open stay open only for OTHER repos; the
workspace closes them.

Columns: Row · Ledger · This repo's part.

- H26 — ✅ closed 2026-10-28 — answered (task 11 above)
- H20 — ✅ closed by the workspace 2026-11-05 — answered 2026-10-28 (one JSR path by GitHub OIDC, linked by repository id
  — architecture.md § JSR packaging); 1.1.0 → 1.1.7 released from the org measured as the proof
- C26 — ✅ closed by binaryang 2026-11-05 — verified, above
- C20, C21, C27 — ✅ closed 2026-10-28 (this repo's own) — above
- H6 — open — wasmtk H6.5b (🗓️ owner) and loader-go — ✅ **verified done by the workspace 2026-11-05**: `ci.yml` runs
  `bun run compat`, `publish.yml` publishes nothing unless CI passed on the tagged commit (testing.md § Compatibility
  gate)
- H15 — open — loader-go — ✅ verified by the workspace 2026-10-28 (scripts and controls on Bun, `129fd0a`)
- H22 — open — loader-go — ✅ verified by the workspace 2026-10-28 (the path test, INDEX § Privacy)
- H28 — open — rsxtk, loader-go — ✅ verified by the workspace 2026-10-30 (below)
- H19 — open — the owner's GitHub Support requests — purged and force-pushed 2026-10-26; 🗓️ **OWNER: the GitHub Support
  request** to drop old commits served by hash (item 2 above) — this repo's only open item in the ledger

- **H28 ✅ this repo's part VERIFIED by the workspace 2026-10-30** (ledger: "S3D ✅ (`cmem/INDEX.md:35-37`,
  'This repo has no such note')"). Re-measured 2026-11-05: the maintainer address is on commits
  only — `git grep` finds no address in any tracked file (the one email-like string is
  `test@example.invalid` in `tests/build.test.ts`), `package.json` / `jsr.json` carry no author or
  email field, no `cmem/` contact note; wabt-ts / binaryen-ts appear only as origin tags inside
  the verbatim ★ block (`best-practices.md`), no link, pin or `../` path. The row stays open in the
  ledger for rsxtk and loader-go only; the workspace closes it.

---


## 🟡 18. Class-by-class review — IN PROGRESS, class B (paused 2026-11-08)

In [class-review.md](class-review.md) since 2026-11-19.

---

## 🟡 19. A native renderer: the baked HTML to PDF with no browser — the production plan

In [native-renderer.md](native-renderer.md) since 2026-11-19; start there (▶️ "Start of the next session").
