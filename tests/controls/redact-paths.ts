// redact-paths.ts
//
// Replace absolute machine paths in an exported transcript with placeholders,
// so a public repository does not carry the author's username and directory
// layout. Roadmap task 1.
//
//   bun tests/controls/redact-paths.ts [file] [--check] [--user=NAME]
//                                              [--folder=NAME]
//
// Defaults to cmem/transcript/session-transcript.md, resolved relative to this
// script. --check reports what would change without writing.
//
// Only paths are touched. Report content is left alone -- the report's own
// "Designer:" value is document metadata belonging to the calculations, not a
// path, and removing it would falsify the record.
//
// ⚠️ The username and work-folder name are taken from the environment or from
// --user / --folder, never hardcoded. A redaction tool that names the thing it
// redacts republishes it in a tracked file -- and only works for one person.
//
// ⚠️ A transcript embeds tool inputs as JSON, so the same path appears both
// literally (c:\Users\...) and JSON-escaped (c:\\Users\\...). A separator
// pattern that only matches a single backslash silently misses every escaped
// occurrence -- which is most of them. Hence SEP below.
//
// ⚠️ Not only home paths (2026-11-05). The privacy rule names ANY path that
// records this machine's layout -- `X:\<folder>\…` as much as `C:\Users\…` --
// and until then this script left every checkout path standing. Now: this
// checkout and its parent folder become <project> / <workspace> (found from the
// script's own location, so nothing is named here), any other drive path becomes
// <path>, and Claude's flattened slugs of them (`X--<folder>-…`) <path-slug>.
//
// Exit codes: 0 clean · 1 the username or a drive path SURVIVES (written anyway
// unless --check, so the residue is visible; a chained commit must stop).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string | URL) => readFile(p, "utf8");

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith("--"));
const check = argv.includes("--check");

const flagValue = (name: string): string | undefined =>
  argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");

// Whose name to count, and which work folder to collapse. Both are discovered
// rather than baked in, so this runs for anyone and names nobody in the source.
const USER = flagValue("user") ?? process.env.USERNAME ?? process.env.USER ?? "";
const WORK_FOLDER = flagValue("folder");

if (!USER) {
  console.error("Could not determine the username; pass --user=NAME.");
  process.exit(1);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A path separator as it may appear: forward slash, one backslash, or the
// doubled backslash of a JSON-encoded string.
const SEP = String.raw`(?:\\{1,2}|/)`;
const SEGMENT = String.raw`[^\\/\s"']+`;

/**
 * A drive, as every shell on this machine spells it: `D:` (Windows; not preceded
 * by a letter or digit, so "https://" never reads as one), and the POSIX forms of
 * the same drive -- `/d` (Git Bash), `/mnt/d` (WSL), `/cygdrive/d` -- each only
 * where a separator follows. The POSIX forms used to pass straight through, and
 * Git Bash output is ordinary in these transcripts.
 */
const driveRe = (letter = "[A-Za-z]") =>
  String.raw`(?:(?<![A-Za-z0-9])${letter}:|(?<![\w.~-])/(?:mnt/|cygdrive/)?${letter}(?=/))`;
const DRIVE = driveRe();
const rule = (body: string) => new RegExp(`${DRIVE}${SEP}${body}`, "gi");

// A folder name may hold spaces ("Program Files"); an intermediate segment may
// therefore run across single spaces, as long as a separator follows it. The
// LAST segment stops at a space, so prose after a path is never swallowed.
const MID = String.raw`${SEGMENT}(?: ${SEGMENT})*(?=${SEP})`;
const ANY_PATH = String.raw`${DRIVE}(?:${SEP}${MID})*${SEP}${SEGMENT}`;
// A network path, \\server\share\..., single- or JSON-escaped; not after a word,
// a ":" or another backslash, so a drive path's own separators never start one.
const UNC = String.raw`(?<![\w:\\])(?:\\{4}|\\{2})[A-Za-z0-9_.$-]+\\{1,2}${SEGMENT}(?:${SEP}${MID})*(?:${SEP}${SEGMENT})?`;

/**
 * This checkout, and the folder holding it, in any separator and any drive spelling. A
 * POSIX checkout (`/home/<user>/…`, as on Linux and macOS, CI included) counts as much as a
 * Windows one: it once returned nothing there, and the checkout path and its slug went
 * through untouched (caught by CI on the first 1.1.6 tag, 2026-11-05).
 */
const fromHere = (rel: string) => {
  const abs = fileURLToPath(new URL(rel, import.meta.url)).replace(/[\\/]+$/, "");
  const [drive, ...segs] = abs.split(/[\\/]+/);
  if (segs.length === 0) return null;
  if (/^[A-Za-z]:$/.test(drive)) {
    return {
      path: [driveRe(drive[0]), ...segs.map(escape)].join(SEP),
      slug: [drive[0], "", ...segs].join("-"),
    };
  }
  if (drive === "") {
    // "/home/u/repo": Claude's slug is "-home-u-repo".
    return {
      path: String.raw`(?<![\w.~-])${SEP}${segs.map(escape).join(SEP)}`,
      slug: ["", ...segs].join("-"),
    };
  }
  return null;
};
const PROJECT = fromHere("../../");
const WORKSPACE = fromHere("../../../");

/** A path's flattened slug: Claude writes `D:\a\b` as `D--a-b` (and `.`/`_` as `-`). */
const slugRule = (slug: string) =>
  new RegExp(
    `(?<![A-Za-z0-9])${slug
      .split(/[^A-Za-z0-9]/)
      .map(escape)
      .join("[^A-Za-z0-9]")}`,
    "gi",
  );

// Longest first: the project path extends the home path, so replacing the home
// path first would strand the remainder.
const RULES: Array<[RegExp, string]> = [
  // This checkout and its workspace, found from where this script lives.
  ...(PROJECT ? ([[new RegExp(PROJECT.path, "gi"), "<project>"]] as Array<[RegExp, string]>) : []),
  ...(WORKSPACE
    ? ([[new RegExp(WORKSPACE.path, "gi"), "<workspace>"]] as Array<[RegExp, string]>)
    : []),
  ...(PROJECT ? ([[slugRule(PROJECT.slug), "<project-slug>"]] as Array<[RegExp, string]>) : []),
  // A named work folder, if one was given, is the longest match and goes first.
  ...(WORK_FOLDER
    ? [
        [
          rule(`Users${SEP}${SEGMENT}${SEP}${SEGMENT}${SEP}${escape(WORK_FOLDER)}`),
          "<project>",
        ] as [RegExp, string],
      ]
    : []),
  [rule(`Users${SEP}${SEGMENT}${SEP}AppData`), "<home>/AppData"],
  [rule(`Users${SEP}${SEGMENT}`), "<home>"],
  // POSIX homes: /home/<user> (Linux), /Users/<user> (macOS), /root.
  [
    new RegExp(String.raw`(?<![\w.~-])/(?:home|Users)/[^/\s"']+|(?<![\w.~-])/root(?=/)`, "g"),
    "<home>",
  ],
  // Claude's slug of a POSIX home path: "-home-<user>-…".
  [/(?<![A-Za-z0-9-])-(?:home|Users)-[A-Za-z0-9_.-]+/g, "<home-slug>"],
  // Claude Code flattens a working directory into a slug for its own storage
  // paths -- e.g. "C--Users-<name>". No separators, so the rules above miss it.
  [/(?<![A-Za-z0-9])[A-Za-z]--Users-[A-Za-z0-9_.-]+/g, "<home-slug>"],
  // Any other slug of a drive path: one letter, "--", then the flattened rest.
  [/(?<![A-Za-z0-9])[A-Za-z]--[A-Za-z0-9][A-Za-z0-9_.-]*/g, "<path-slug>"],
  // Last: any network path, then any drive path still standing.
  [new RegExp(UNC, "g"), "<unc-path>"],
  [new RegExp(ANY_PATH, "g"), "<path>"],
];

/** Drive or network paths left after redaction (a placeholder matches neither). */
const drivePaths = (s: string) => [
  ...(s.match(new RegExp(`${DRIVE}${SEP}${SEGMENT}`, "g")) ?? []),
  ...(s.match(new RegExp(UNC, "g")) ?? []),
];

// The label is derived here rather than by testing `typeof target` later: args[0]
// is typed `string`, so control-flow analysis narrows `target` to string at any
// later use and the URL branch of a ternary becomes `never`.
const defaultTarget = new URL("../../cmem/transcript/session-transcript.md", import.meta.url);
const target = args[0] ?? defaultTarget;
const targetLabel = args[0] ?? defaultTarget.href;

const original = await readText(target);
let text = original;
const applied: string[] = [];

for (const [pattern, replacement] of RULES) {
  const hits = (text.match(pattern) ?? []).length;
  if (hits > 0) applied.push(`${hits} → ${replacement}`);
  text = text.replace(pattern, replacement);
}

const userRe = new RegExp(escape(USER), "gi");
const count = (s: string) => (s.match(userRe) ?? []).length;
const before = count(original);
const after = count(text);

console.log(`file:      ${targetLabel}`);
console.log(`rules hit: ${applied.length ? applied.join(", ") : "none"}`);
console.log(`username:  ${before} occurrence(s) before, ${after} after`);

if (after > 0) {
  const sample = [...text.matchAll(new RegExp(`.{0,70}${escape(USER)}.{0,70}`, "gi"))].slice(0, 5);
  console.log("remaining context:");
  for (const s of sample) console.log(`  …${s[0].replace(/\s+/g, " ")}…`);
}

const leftPaths = drivePaths(text);
console.log(`paths:     ${leftPaths.length} drive path(s) after`);
for (const p of leftPaths.slice(0, 5)) console.log(`  ${p}`);

// A residue is a failure, not a note: it used to print "redacted." and exit 0,
// so a chained commit went ahead with the username still in the file.
const clean = after === 0 && leftPaths.length === 0;

if (check) {
  console.log(`\n--check: nothing written.${clean ? "" : " NOT CLEAN."}`);
  process.exit(clean ? 0 : 1);
}

if (text !== original) {
  await writeFile(target, text);
  console.log("redacted.");
} else {
  console.log("nothing to redact.");
}
if (!clean) {
  console.error("❌ the username or a drive path survives -- not safe to publish.");
  process.exit(1);
}
