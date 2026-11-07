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
// Email addresses too (2026-11-06): each becomes <email>, except the few that
// name no one (see isPublicEmail).
//
// Exit codes: 0 clean · 1 the username, a drive path or an email SURVIVES (written
// anyway unless --check, so the residue is visible; a chained commit must stop).

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

// A folder name may hold spaces ("Program Files", "OneDrive - Acme Ltd"); an intermediate segment
// may therefore run across single spaces, as long as a separator follows it. The LAST segment
// runs across spaces only when it ends in a file extension ("Quarry Job.zip"), so prose after a
// path is not swallowed -- and a file name with a space no longer leaves its second word behind.
const MID = `${SEGMENT}(?: ${SEGMENT})*(?=${SEP})`;
const LAST = String.raw`(?:${SEGMENT}(?: ${SEGMENT})*?\.[A-Za-z0-9]{1,8}(?![\w.])|${SEGMENT})`;
const ANY_PATH = `${DRIVE}(?:${SEP}${MID})*${SEP}${LAST}`;
// A network path, \\server\share\..., single- or JSON-escaped; not after a word,
// a ":" or another backslash, so a drive path's own separators never start one. And //server/share
// with forward slashes (a dotless host: a dotted one is a URL's, `//cdn.example.org/…`).
// Never right after a placeholder's ">": `<project>\\src\\…` is this checkout's own public tail.
const UNC =
  String.raw`(?<![\w:\\>])(?:\\{4}|\\{2})[A-Za-z0-9_.$-]+\\{1,2}${SEGMENT}(?:${SEP}${MID})*(?:${SEP}${LAST})?` +
  String.raw`|(?<![\w:/\\>])//[A-Za-z0-9_$-]+/${SEGMENT}(?:/${MID})*(?:/${LAST})?`;
// An absolute POSIX path: "/" then two or more path-like segments (no regex metacharacters); a
// middle segment may hold single spaces ("/srv/Client Jobs/…"), the last one as LAST does.
const PSEG = String.raw`[\w.~@%+-]+`;
const POSIX_PATH = String.raw`(?<![\w.:/\\>-])\/(?:${PSEG}(?: ${PSEG})*\/)+(?:${PSEG}(?: ${PSEG})*?\.[A-Za-z0-9]{1,8}(?![\w.])|${PSEG})`;
/**
 * The whole of a path below a home folder: the username (which may hold a space) and every
 * segment after it. The home rule used to replace `X:\Users\<name>` alone, and the rest stood --
 * `<home>\OneDrive - <employer>\Jobs\<client>\…`, a surname after a spaced username -- while the
 * residue check, looking for drive paths only, said "0 drive path(s) after" (2026-11-06 review).
 */
const HOME_TAIL = `${SEGMENT}(?: ${SEGMENT})*(?:${SEP}${MID})*(?:${SEP}${LAST})?`;

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
      path: [driveRe(drive[0]), ...segs.map(escapeRe)].join(SEP),
      slug: [drive[0], "", ...segs].join("-"),
    };
  }
  if (drive === "") {
    // "/home/u/repo": Claude's slug is "-home-u-repo".
    return {
      path: String.raw`(?<![\w.~-])${SEP}${segs.map(escapeRe).join(SEP)}`,
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
      .map(escapeRe)
      .join("[^A-Za-z0-9]")}`,
    "gi",
  );

// A whole folder name ends here: a separator, whitespace, a quote, or the end. Without it the
// rules matched the FRONT of a longer sibling (`…\synapticforge1-backup\client-acme\…` became
// `<workspace>-backup\client-acme\…`, with no drive left for the residue check to find); now a
// sibling falls through to the generic path rules below, which take it whole.
const END = String.raw`(?![^\\/\s"'])`;
const SLUG_END = "(?![A-Za-z0-9_.-])";

// Longest first: the project path extends the home path, so replacing the home
// path first would strand the remainder.
const RULES: Array<[RegExp, string]> = [
  // This checkout and its workspace, found from where this script lives.
  ...(PROJECT
    ? ([[new RegExp(`${PROJECT.path}${END}`, "gi"), "<project>"]] as Array<[RegExp, string]>)
    : []),
  ...(WORKSPACE
    ? ([[new RegExp(`${WORKSPACE.path}${END}`, "gi"), "<workspace>"]] as Array<[RegExp, string]>)
    : []),
  ...(PROJECT
    ? ([
        [new RegExp(`${slugRule(PROJECT.slug).source}${SLUG_END}`, "gi"), "<project-slug>"],
      ] as Array<[RegExp, string]>)
    : []),
  // A named work folder, if one was given, is the longest match and goes first.
  ...(WORK_FOLDER
    ? [
        [
          rule(`Users${SEP}${SEGMENT}${SEP}${SEGMENT}${SEP}${escapeRe(WORK_FOLDER)}`),
          "<project>",
        ] as [RegExp, string],
      ]
    : []),
  // A home folder and EVERYTHING below it (HOME_TAIL), in any separator.
  [rule(`Users${SEP}${HOME_TAIL}`), "<home>"],
  // POSIX homes: /home/<user> (Linux), /Users/<user> (macOS), /root -- and everything below.
  [
    new RegExp(
      String.raw`(?<![\w.~-])\/(?:(?:home|Users)\/${HOME_TAIL.replaceAll(SEP, "/")}|root(?:\/${MID.replaceAll(SEP, "/")})*(?:\/${LAST})?)`,
      "g",
    ),
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
  // Any other absolute POSIX path of two segments or more -- /srv/…, /Volumes/…, /tmp/…, /opt/… --
  // which records a machine's layout as much as a home folder does; they used to pass untouched,
  // "0 drive path(s) after" (2026-11-06 review). Not after a word, ".", ":" or "/" (so not a URL's
  // path or a relative one), and only path-like segments (so not a regex like /^#./).
  [new RegExp(POSIX_PATH, "g"), "<path>"],
];

/**
 * An email address, its "@" written plainly, URL-encoded or JSON-escaped. The privacy rule
 * forbids an email in any committed file (one maintainer contact excepted, never in a transcript),
 * and a transcript holds them -- `git log` prints authors, a config read prints one -- yet this
 * script looked only at the username and paths: an address passed as clean (2026-11-06).
 */
const EMAIL =
  /[A-Za-z0-9._%+-]+(?:@|%40|\\u0040|&#0*64;|&#x0*40;|&commat;)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi;

/**
 * The residue check's email pattern, deliberately LOOSER than {@link EMAIL}: spaces around the
 * "@", "(at)" / "[at]" spellings. A residue check made of the same pattern as the redaction can
 * never find what the redaction missed -- it was 0 by construction (2026-11-06 review).
 */
const EMAIL_RESIDUE =
  /[A-Za-z0-9._%+-]+\s*(?:@|%40|\\u0040|&#0*64;|&#x0*40;|&commat;|[([]at[)\]])\s*[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi;

/**
 * Addresses that name no one: the commit trailer's, GitHub's SSH user, and the reserved example
 * and test domains (RFC 2606 / 6761) the test suite writes. Everything else is redacted.
 */
const isPublicEmail = (e: string) => {
  const plain = e.replace(/%40|\\u0040/i, "@");
  return (
    /^(?:noreply@anthropic\.com|git@github\.com)$/i.test(plain) ||
    /@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|example|invalid|test|localhost)$/i.test(plain)
  );
};

/**
 * Paths left after redaction, read LOOSER than the rules (a check made of the rules' own patterns
 * finds nothing they missed): any drive letter and separator; a network path either way round;
 * a placeholder that a path still continues from -- `<home>\Jobs\…`, `<home> Surname\…`,
 * `<path>/…` (only this checkout's and workspace's own tails are public); any slug left.
 */
const drivePaths = (s: string) => [
  ...(s.match(new RegExp(`${DRIVE}${SEP}`, "g")) ?? []),
  ...(s.match(/(?<![\w:>])(?:\\\\|\/\/)[A-Za-z0-9_$-]+[\\/]\S/g) ?? []),
  // A slug placeholder stands for one folder NAME, so a file below it is not a path tail.
  ...(s.match(
    /<(?:home|path|unc-path)>(?:(?:\\{1,2}|\/)[^\s"'<>]| [^\s"'<>\\/]+(?:\\{1,2}|\/))/g,
  ) ?? []),
  ...(s.match(/(?<![A-Za-z0-9])[A-Za-z]--[A-Za-z0-9]/g) ?? []),
  // Looser than the POSIX redaction rule (any segment characters), for the same reason as
  // EMAIL_RESIDUE: a check that matches only what the rules replace cannot fail.
  ...(s.match(/(?<![\w.:/\\>-])\/(?:[^/\s"'<>()]+\/)+[^/\s"'<>()]+/g) ?? []).filter(
    (p) => !/^\/(?:[^/]*\/)*[^/]*[\^$*?|[\]{}]/.test(p), // a regex literal, not a path
  ),
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

let emailHits = 0;
text = text.replace(EMAIL, (e) => {
  if (isPublicEmail(e)) return e;
  emailHits++;
  return "<email>";
});
if (emailHits > 0) applied.push(`${emailHits} → <email>`);

const userRe = new RegExp(escapeRe(USER), "gi");
const count = (s: string) => (s.match(userRe) ?? []).length;
const before = count(original);
const after = count(text);

console.log(`file:      ${targetLabel}`);
console.log(`rules hit: ${applied.length ? applied.join(", ") : "none"}`);
console.log(`username:  ${before} occurrence(s) before, ${after} after`);

if (after > 0) {
  const sample = [...text.matchAll(new RegExp(`.{0,70}${escapeRe(USER)}.{0,70}`, "gi"))].slice(
    0,
    5,
  );
  console.log("remaining context:");
  for (const s of sample) console.log(`  …${s[0].replace(/\s+/g, " ")}…`);
}

const leftPaths = drivePaths(text);
// Counted, never printed: a residue may be a client's name (it used to print the first five).
console.log(`paths:     ${leftPaths.length} path(s) or path tail(s) after`);

// Counted, never printed: the residue is the very thing that must not be shown.
const leftEmails = (text.match(EMAIL_RESIDUE) ?? []).filter(
  (e) => !isPublicEmail(e.replace(/\s+/g, "").replace(/[([]at[)\]]/i, "@")),
);
console.log(`emails:    ${emailHits} redacted, ${leftEmails.length} left`);

// A residue is a failure, not a note: it used to print "redacted." and exit 0,
// so a chained commit went ahead with the username still in the file.
const clean = after === 0 && leftPaths.length === 0 && leftEmails.length === 0;

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
  console.error("❌ the username, a drive path or an email survives -- not safe to publish.");
  process.exit(1);
}
