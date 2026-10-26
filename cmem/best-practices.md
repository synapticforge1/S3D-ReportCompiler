# best-practices.md — the workspace's convergent rules (a stamped COPY)

This project's own rules, each with the incident that paid for it, are in
[practices.md](practices.md). **This file is not that.** It is the copy every repo under the
workspace carries of the workspace's **★ convergent** rules — rules two or more repos derived
without reading each other — so the method travels with a clone and can be cited as "workspace
2.1" here and in the source alike.

**Copied from synapticforge1/cmem/best-practices.md on 2026-10-26** (workspace letters H6, H24,
H26, H27; the stamp wording is the one `memory-conventions.md` prescribes). **Source:** the
workspace's `cmem/best-practices.md` (`../../cmem/best-practices.md` from this folder, when the
repo sits in the workspace). **28 rules**, every bullet the source marks ★, copied VERBATIM under
the source's `§` headings, origin tags and all. A ★ rule is changed in the source and re-copied,
never edited here. Checked on 2026-10-26 by a one-time script comparing the number and the
whitespace-normalized text of each rule against the source: 28 = 28, 0 differences; the check was
inverted (one word changed in a copy → exactly that rule reported).

Origin tags name the sibling repos that paid for each rule; none of them is this project. The rules
this project paid for itself — several are the same lesson found independently (compare 1.1 with
practices §3, 2.3 with §2, 7.11 with §14) — are in [practices.md](practices.md).

## ★ The convergent rules

### §1 Evidence and measurement

- **1.1 ★ An exit code is not evidence; diff the OUTPUT counts, per file.** Exit-0 runs silently
  dropped passes in four repos; binaryen-ts's serious defects were valid wasm with the wrong value;
  wabt-ts's `wat2wasm` silently deleted an instruction. [wabt-ts + binaryen-ts + wazmrt + wasmtk + wasmrt]
- **1.2 ★ A green suite is evidence about the tests, not the code.** The fuzzer had zero `makeLoad`
  / `makeBreak`; `deno test tests/` collected 513 of 908 and exited 0. [binaryen-ts + wabt-ts]
- **1.3 ★ Re-derive before quoting any number; a count in prose is a dated claim.** Counts were
  cited eight days stale; artifacts doubled while "smallest binary" was the goal; three commit
  messages contradicted their own diffs. [every repo]
- **1.4 ★ When the corpus can move, the denominator is a measurement, and a comparison must print
  it.** The failure total matched on both sides by coincidence after +4 files; four totals were
  computed over zero modules because `--enable-all` is not a `wasm-opt` flag. [wasmrt + binaryang]
- **1.11 ★ Validate the harness against a known positive; an extreme number is evidence about the
  harness, and a broken harness can score BETTER.** 1937/1937 failing; give it an input it must
  fail on. [wabt-ts + binaryen-ts]

### §2 Gates and tests

- **2.1 ★ A new test that has never failed has not been shown to test anything: invert it and
  watch it fail for the RIGHT reason.** A baseline probe appended a WAT comment and could not fire;
  deleting the release guard left twelve tests green; a mutant caught by a different check is a bad
  mutant. [wazmrt + wabt-ts + binaryen-ts + binaryang + wasmtk]
- **2.3 ★ A gate that cannot fail is decoration; a gate with no trigger, a goal with no gate, a
  gate that only prints, and a property asserted in a doc comment are all preferences.** `| tail`
  swallowed the oracle monitor's status; `check-bridge-corpus.ts` exited 0 either way; "exhaustive
  over `Op`" ended in `_ => return None` and shipped four ungated ops. [wazmrt + wasmrt + binaryang]
- **2.4 ★ The local gate must BE CI's gate: read the steps from the workflow file.** 65 unpushed
  commits were red by CI's standard; `tasks.md` went binary to grep from NUL bytes because the
  hygiene gate was scoped to what the compiler reads, not what the workflow reads. [binaryang + wabt-ts]
- **2.16 ★ A change's own new surface is the one place the audit that produced it will not look —
  re-run the governing audit against the new members before landing.** The `--update-baseline` path
  OOMed; the day's own suites passed throughout six silent CLI regressions. [wazmrt + wasmrt + wasmtk]

### §3 Producer/consumer pairs and oracles

- **3.1 ★ A round trip proves agreement with yourself; when a bug is visible only to a third party
  the test has to BE a third party — hand the bytes to an outside reader as a GATE, not a habit.**
  Legacy EH: wabt-ts parsed it, V8 ran it, wasi 417/417 green, wasmtime rejected all ten modules;
  `(ref any)` emitted as an internal tag byte and `try_table`'s label off by one in assembler,
  validator and interpreter alike — wasmtime refused both in one afternoon. [wazmrt + binaryen-ts + wabt-ts + wasmrt + wasmtk]
- **3.2 ★ Agreement between components that learned the convention from each other is not
  evidence, and there can be three.** Decoder and encoder shared a catch-depth off-by-one; every
  round trip was byte-identical and green. [binaryen-ts + wabt-ts + wazmrt + wasmrt]
- **3.3 ★ Producer/consumer pairs are the recurring blind spot; fix the gap, not a post-process
  workaround, and pin both directions.** T13.22 cancelling off-by-ones across a repo boundary,
  invisible for four releases; fixing one direction turned silent accept into loud reject. [binaryang + wazmrt + wabt-ts]
- **3.8 ★ A stale vendored snapshot is indistinguishable from live data without recorded
  provenance: stamp source + date in the change that creates it, and never let a check read an
  artifact it did not just produce.** A 2020 `proposals/threads/` snapshot was filed against us; a
  frozen 272-file copy filed seven "invalid" modules that run clean; a size gate read yesterday's
  artifact. [wabt-ts + wasmtk + wasmrt + wazmrt]
- **3.10 ★ A claim about another project's code is a hypothesis until you grep their source; a
  stated BENEFIT is a hypothesis about someone else's code.** "wabt-ts accepts try_table" (the
  writer could not encode it); the wasm-c-api "drop-in" payoff never existed — the loaders use
  `wasmtime_*`. [wasmtk + wasmrt + wazmrt]

### §4 Where defects hide

- **4.1 ★ One authoritative enumeration; a second copy drifts into silence; one reader per grammar
  production, and a production has more than one site.** `deepCopy` covered 29 of 79 kinds; the heap
  type table existed three times; a private `skip_const_expr` refused two valid modules; reftype was
  read as valtype at the table-type site for the project's whole life. [binaryen-ts + wabt-ts + wasmrt + wazmrt]
- **4.2 ★ A value read and discarded is a decision; a wrong decode made harmless by a guard in
  another file is a load-bearing coincidence.** `r.readU32(); // table index`; three reserved bytes;
  `br_on_cast` flags, the elemkind byte, element flags `8`. [binaryen-ts + wabt-ts + wasmrt]
- **4.3 ★ Silent-wrong output is the worst class and where every serious defect has been: ask "what
  would a wrong answer look like?" first, and prefer a hard error over a stub.** A feature can be
  decoded, validated, printed and never execute (the start function, five releases). [wasmrt + wasmtk + wabt-ts]
- **4.16 ★ A rationale expires; the code it justified does not: a comment justifying a deviation
  names the authority it defers to; "by design" and "out of scope" age badly by definition; a stale
  rationale is worse than none.** "Mirroring the oracle" survived the oracle's retirement five weeks;
  the `import.meta.main` ban's reason expired while the rule stayed right for another reason.
  [wasmrt + wazmrt + binaryang]

### §5 Investigating

- **5.1 ★ Prove, do not assume: prove the REASON, not just the answer; UNVERIFIED is a legitimate
  status.** Four read-not-verify claims were wrong when run; a `--features` alias rationale was
  right by luck. [wazmrt + wasmrt]
- **5.2 ★ Identify the LAYER before naming a cause; the stage that REPORTS a failure is usually
  not the stage that caused it; finding a real defect at a layer is not evidence it causes your
  symptom — vary one thing.** "Memory-grow ordering" was decoder reordering; a symptom caused by the
  development drive's FILESYSTEM (exFAT) was diagnosed wrong three times. [wazmrt + binaryen-ts + wasmtk + wasmrt]

### §6 Recording and claims

- **6.1 ★ A written result is a CLAIM: a commit message, a status line, a doc of a safety guard, a
  contract row verified by reading. Compare it to the artifact; put a pin where the tool enforces
  it.** `8d9ba0cb9` (was `b8fafaa3f` before binaryang's 2026-10-23 purge; corrected here 2026-10-26, ledger C8) said "pin to 132" and left 116; prose has no failure mode. [binaryang + wabt-ts + wasmrt]
- **6.2 ★ Write down the thing you only said out loud; write the negatives (what was varied, what
  held fixed), the calibration, and what you did NOT check; distinguish clean / measured /
  UNMEASURED.** Knowledge that exists only in a conversation is operationally identical to
  knowledge nobody has. [wabt-ts + binaryang]
- **6.3 ★ Record findings that were WRONG so they are not fixed again; a retraction re-checks the
  REASONING, not the requirement; a correction is a dated claim too; a reopen condition is not
  self-checking.** [wazmrt + wasmtk + binaryen-ts + wabt-ts]

### §7 Tooling that lies

- **7.1 ★ Do not author file CONTENT through a shell heredoc; scripts go in files, always; commit
  messages through `-F <file>`.** Four corruption modes (escapes eaten, long commands truncated,
  backticks substituted, `$$` templates), five corruptions including a NUL byte in `.gitattributes`;
  broken five times by the rule's own author. [binaryang + wasmtk + wazmrt + wasmrt]
- **7.2 ★ When the exit code IS the measurement, do not pipe.** `deno fmt --check | tail -1`
  committed a failing check; `| tail -20` swallowed the oracle monitor. [wasmtk + wasmrt + wabt-ts]
- **7.3 ★ A change that silently does nothing is indistinguishable from one that worked: prefer
  "fail if absent" over "act if present"; edit scripts assert each match exactly once; read back;
  omission is not reset.** Seven no-ops in one register (replace without asserting the target, an
  omitted workspace key, a `--dry-run` that bumped). [binaryang + wazmrt + wasmrt]
- **7.6 ★ Line endings: pin in `.gitattributes` wildcard-first; measure with a positive control;
  never fix with `git config`; test inputs whose bytes feed a digest are never whitespace-trimmed.**
  `grep -c '\r'`=140, `grep -c $'\r'`=0, `grep -cU $'\r'`=184 on the same file. [wasmtk + binaryang + wazmrt + wasmrt]

### §8 Working across repos

- **8.1 ★ Read freely, write never: nothing is written into a sibling's tree — not its source, not
  its `cmem/`, not its copy of the contract — unless the owner directs that write, and then it is
  logged in both memories.** Two destructive overwrites on 2026-08-19; a commit that laundered
  authorship. [wasmrt + wazmrt + binaryang + wabt-ts]
