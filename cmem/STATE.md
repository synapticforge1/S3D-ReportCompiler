# STATE: s3d-reportcompiler

Updated: 2026-11-19, at the end of the session (H38 memory migration; H37 review standard and release path)

## Version
- Released: 1.5.0 on 2026-11-10 (JSR and npm, provenance on both); the next release gates to a MINOR
- Working branch: `main`; stash `trial: table rewrite in progress` is target 2's
- Unreleased on `main`: the native renderer (default for reports with no maths and no drawing), #118–#130

## Now
- Task 19, target 1 (a production release with both renderers): T1-3 review, after round 2
- #128 (native in-page links) committed as `1b2dfe3`; its three runs were not recorded as seen
- H37 in place: CI only publishes; `bun run release` reads the review record, then runs every gate locally
- Workspace letters: H41–H43, H38, H37 done and answered; H39 not started

## Review
- Run for: target 1 (T1-3), under the 2026-11-12 process; H37's standard applies from the next round
- Position: none in progress; `Review complete: none` (the release refuses until a review completes)
- Open issues: 9 (R1–R9 in `cmem/review-issues.md`, from T1-3)
- Platforms passed: win-x64 (local); linux-x64 Ubuntu (CI's last runs, every test job green on `e6fcbd5`)

## Next
1. Re-run #128's three checks: the 36ft report natively (PASS, every link with a destination), the samples, the suite
2. H39: `host.ts`, its gate and `--self-check`
3. The review (H37: five classes, one loop) over everything since 1.5.0, then T1-4's release
4. The class-B re-check 3, groups B–F ([native-renderer.md](native-renderer.md) "Needed either way")

## Waiting on owner
- Chrome in WSL (`sudo apt install …`), so the release runs the Linux suite (platforms.md)
- The GitHub Support request to drop pre-purge commits (H19)
- The release level and the word "release" for T1-4

## Read next
- [native-renderer.md](native-renderer.md): the production plan and the start-of-session list
- [release.md](release.md) § "How a release is made": the H37 release path, before any release
- `../workspace/cmem/review-process.md` and [review-process.md](review-process.md): before the review
