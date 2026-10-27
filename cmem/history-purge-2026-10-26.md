# history-purge-2026-10-26.md — the H19 path purge, and the old → new commit map

**What:** this machine's project path had been committed in `cmem/roadmap.md` (a `safe.directory`
example) from `387cbd9` on, so it sat in every later commit, in the trees tagged `v1.0.0`,
`v1.0.1`, `v1.0.4`, and in the three `release/v*` branches, all public. It was fixed at HEAD in
`a57cd72` (now `bd2599287`). On 2026-10-26 the owner chose to purge it from history too ("Purge
now"; workspace letter H19, privacy rule in [INDEX.md](INDEX.md) § Privacy). The published JSR
packages never contained it (`deno.json` `publish.include` has no `cmem/`).

## How it was done

- One-time Bun scripts in a mirror clone on an NTFS scratch directory: `git fast-export --all
  --show-original-ids --signed-commits=verbatim`, the ONE literal replaced by `<repo-root>` in
  every data payload (lengths recomputed), `git fast-import` into an empty bare repository.
- **9 replacements, 9 blobs** — the scan over every object found only that string; the other hits
  are elided examples (`C:\Users\<user>\…`, `c:\Users\...`) that name no machine, and stay.
- The root commit was made on GitHub's web UI and is GitHub-signed. A first run with the default
  (signatures dropped) changed its id although nothing in it changed; the run used for the push
  kept signatures verbatim, so **the root keeps its id** `7c3d2d2cb`.

## How it was verified (before the push)

- Every one of 23 commit pairs: identical author, committer, dates and message; parents map
  through the table; the tree is either identical (3) or differs ONLY by the one `roadmap.md` line
  (20). Inverted: two pairs swapped in the map → 4 pairs reported bad, exit 1.
- `main`'s tip tree unchanged (`9c0068085b28`); `git fsck --full` clean; 233 objects before and
  after; same seven refs.
- Pushed with `--force-with-lease` per ref (pinned to the mirrored values). Read back with
  `ls-remote`; a fresh mirror clone from GitHub scanned clean.

## What the push triggered — a prediction that was WRONG

Moving the three `v*` tags re-ran `publish.yml` three times (runs `40423981379`, `40423980289`,
`40423980996`; all "failure"). The prediction was that `deno publish` would refuse the existing
version and stop the job. **It did not: `deno publish` SKIPS an already-published version and exits
0**, so the job ran on — "Create release branch" succeeded (a no-op: the branch was already at
that commit) and only "Create GitHub Release" failed (the release exists). Checked afterwards:
refs unchanged, the three GitHub Releases unchanged (dated 2026-08), JSR still 1.0.0–1.0.4 with
1.0.4 attested (Rekor `2439323008`). Harmless HERE only because every later step was a no-op —
the workspace rule says why to read the workflow before moving tags (working-rules § Git).

## What did not change, and cannot

- **JSR provenance names the PRE-purge commits** (`ef8773cb3` for 1.0.0, `602f0f11d` for 1.0.1,
  `12e84db8c` for 1.0.4). JSR versions are immutable; translate through the table.
- **GitHub still serves old commits by hash** until a GitHub Support request purges them (🗓️ OWNER,
  workspace open-work).
- Commit messages and the quoted outputs in [practices.md](practices.md) / [process-log.md](process-log.md)
  (`tagging 8ff6093 …`) keep the old ids as history; live `git show` pointers were translated.
- Every other clone must re-clone or `fetch --force` + `reset --hard origin/main`; this clone was
  realigned, its reflog expired and `gc --prune=now` run (1 pack, fsck clean, `387cbd9` gone).

## The map (old → new, `main` order; tags and `release/v*` branches at the marked rows)

| old | new | subject |
|---|---|---|
| `7c3d2d2cb` | `7c3d2d2cb` | Initial commit (unchanged) |
| `387cbd9b5` | `d5a6d4833` | Restructure for JSR publication as @jrmarcum/s3d-reportcompiler |
| `c2c051a1e` | `e4cec5a96` | Document all public exports; verify third-party licence compliance |
| `a89a6a72a` | `5baa39774` | Fix release workflow: install npm deps before deno publish |
| `ef8773cb3` | `8192c39d1` | Force the tag push in publish.ts so a failed release can be retried — **v1.0.0** |
| `9721fa574` | `c5f9f7baf` | Add a module doc to the ./runtime entrypoint |
| `d3635e09e` | `d3497e53b` | bump version to v1.0.1 |
| `602f0f11d` | `befc61fe8` | Update project memory after the first release — **v1.0.1** |
| `8ff6093fc` | `59ed8a865` | Fix global install, and make the CLI explain itself |
| `5fdff7520` | `d872a83b4` | Guard the publish script against tagging the wrong commit |
| `631395aaa` | `5f5cce377` | Fail the publish guard when it cannot run, and give it net access |
| `d3c356845` | `4ee6d17d7` | Record the 1.0.1 miss in project memory; bump to 1.0.2 |
| `ff090ae6d` | `1d00d40ee` | Document the 1.0.2 release: ./cli fixed, provenance lost |
| `967cfbe0e` | `788af629b` | Close the release loop: verify provenance, and document every function |
| `48b94efdd` | `e034e3dc2` | Add deno task install / install:jsr / uninstall |
| `35e07aa6d` | `dd7263727` | bump version to v1.0.3 |
| `388464fb1` | `d488baec7` | Update project memory for the 1.0.3 release |
| `6283fa05c` | `025a50114` | Rename the release task; bump to 1.0.4 |
| `12e84db8c` | `9cdf0b06f` | Remove the publish task entirely; record why an alias was rejected — **v1.0.4** |
| `17aa1afef` | `43f895823` | Complete the memory sweep for the packaging round |
| `48ae20dbb` | `4856337b8` | Record the rule that shell-style scripts are Bun TypeScript |
| `a57cd721d` | `bd2599287` | Conform to the workspace floor (letter H26) |
| `ea0bcaecb` | `16c38909f` | Scope the move off Deno; record the owner's decisions; retire the pdfmake spike |
