/**
 * The review gate (workspace review standard § 9, letter H37 (d): "the release tooling runs the review
 * set as its first step"). The review is agent work and cannot run inside a script, so
 * `bun run release` checks its RESULT, as LeptonPad's gate does (from which this is adapted,
 * 2026-11-19): the git-ignored `cmem/review-issues.md` must say `Review complete: <commit>` — written
 * by the main agent only when a re-review came back empty in every class and the full suite passed —
 * and nothing the review covers may have changed between that commit and the release.
 *
 * What may change after the reviewed commit: the bump commit's files (the three version files and
 * `npm-dist.sha256`) and project memory (`cmem/`, the issues file excepted). Anything else is code
 * the review did not read.
 */

/** The file the gate reads (git-ignored; scripts/check-privacy.ts refuses it tracked). */
export const ISSUES_FILE = "cmem/review-issues.md";

/** What a bump commit may hold (scripts/bump.ts commits exactly these). */
export const BUMP_FILES = ["jsr.json", "package.json", "src/report_core.ts", "npm-dist.sha256"];

/**
 * The reviewed commit recorded in the issues file's text, or the reason it has none. One line,
 * `Review complete: <7–40 hex digits>`; `none`, a missing line or two such lines are refusals.
 */
export function reviewedCommit(text: string): { commit: string } | { refusal: string } {
  // A UTF-8 byte-order mark (a Windows editor's) would hide a first-line match.
  // (By code point: `bun fmt` turns the escape for U+FEFF into the invisible character itself.)
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = [...body.matchAll(/^Review complete:[ \t]*(\S*)[ \t]*\r?$/gm)];
  if (lines.length === 0) return { refusal: `no "Review complete:" line in ${ISSUES_FILE}` };
  if (lines.length > 1)
    return { refusal: `more than one "Review complete:" line in ${ISSUES_FILE}` };
  const value = lines[0][1];
  if (value === "none" || value === "") {
    return { refusal: `${ISSUES_FILE} says no review is complete ("Review complete: none")` };
  }
  if (!/^[0-9a-f]{7,40}$/.test(value)) {
    return { refusal: `"Review complete: ${value}" is not a commit id` };
  }
  return { commit: value };
}

/** The paths (as `git diff --name-only` prints them) that changed code the review did not read. */
export function unreviewedFiles(changed: readonly string[]): string[] {
  return changed.filter(
    (p) => !(BUMP_FILES.includes(p) || (p.startsWith("cmem/") && p !== ISSUES_FILE)),
  );
}
