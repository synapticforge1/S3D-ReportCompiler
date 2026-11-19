# STATE: s3d-reportcompiler

Updated: 2026-11-19, at the end of the session (the H38 memory migration)

## Version
- Released: 1.5.0 on 2026-11-10 (JSR and npm, provenance on both); the next release gates to a MINOR
- Working branch: `main` (pushed to `82417bf`); stash `trial: table rewrite in progress` is target 2's
- Unreleased on `main`: the native renderer (default for reports with no maths and no drawing), #118–#128

## Now
- Task 19, target 1 (a production release with both renderers): T1-3 review, after round 2
- #128 (native in-page links) committed as `1b2dfe3` ("update"); its three runs were not recorded as seen
- Workspace letters: H41–H43 answered; H38 migration done (design-decisions §11); H37 and H39 not started

## Review
- Run for: target 1 (T1-3), under the 2026-11-12 process; H37's standard applies from the next round
- Position: T1-3, round 3 not started (on round 2's fixes and #128)
- Open issues: 9 recorded, not fixed ([known-issues.md](known-issues.md) § Open); 0 in `review-issues.md`
- Platforms passed: win-x64 (local), linux-x64 Ubuntu (CI); matrix not written yet (H37 item g)

## Next
1. Re-run #128's three checks: the 36ft report natively (PASS, every link with a destination), the samples, the suite
2. H37 (a)–(g): review-process rewrite, `review-issues.md`, review step in `publish.ts`, tests out of CI, platforms.md
3. H39: `host.ts`, its gate and `--self-check`
4. T1-3 round 3, then the five required reviews (H37), then T1-4's release
5. The class-B re-check 3, groups B–F ([native-renderer.md](native-renderer.md) "Needed either way")

## Waiting on owner
- The GitHub Support request to drop pre-purge commits (H19)
- The release level and the word "release" for T1-4

## Read next
- [native-renderer.md](native-renderer.md): the production plan and the start-of-session list
- [roadmap.md](roadmap.md) task 11 item 7: the scope of H37 and H39
- `../workspace/cmem/review-process.md`: before T1-3 round 3 (H37 replaces this repo's process)
