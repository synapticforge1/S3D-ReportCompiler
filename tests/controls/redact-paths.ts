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

// A path separator as it may appear: forward slash, one backslash, the doubled backslash of a
// JSON-encoded string, the JSON-escaped slash `\/`, or percent-encoded (`%5C`, `%2F`) as in a
// `file:` or `vscode:` URI -- those passed whole, "0 path(s) after" (2026-11-07 review).
const SEP = String.raw`(?:\\{1,2}\/?|\/|%5[Cc]|%2[Ff])`;
// A segment ends at an encoded separator too: run across `%5C`, a percent-encoded path was one
// long "segment", and the space-tolerant username part then swallowed the prose after it.
// Not a backtick either: a path in a Markdown code span took the closing "`" and the prose after it.
// An apostrophe BETWEEN letters is part of a name (`O'Brennick Steel`): ending the segment there
// left "'Brennick Steel\calc.html" behind, exit 0 (2026-11-07 review 5).
const NAME_LETTER = "[A-Za-zÀ-ɏ]";
const SEGMENT = String.raw`(?:(?!%5[Cc]|%2[Ff])(?:[^\\/\s"'\x60]|(?<=${NAME_LETTER})'(?=${NAME_LETTER})))+`;
/** `word` matched in any case, for the rules that must stay case-SENSITIVE elsewhere ({@link CONT}). */
const ci = (word: string) =>
  word.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
// A last segment does not end in sentence punctuation: "…\job41," kept the comma's sentence whole
// but took the comma, and "(see …\x)" its ")" (review 4).
const SEG_END = String.raw`(?<![,.;:)\]}])`;

/**
 * A drive, as every shell on this machine spells it: `D:` (Windows; not preceded
 * by a letter or digit, so "https://" never reads as one), and the POSIX forms of
 * the same drive -- `/d` (Git Bash), `/mnt/d` (WSL), `/cygdrive/d` -- each only
 * where a separator follows. The POSIX forms used to pass straight through, and
 * Git Bash output is ordinary in these transcripts.
 */
const driveRe = (letter = "[A-Za-z]") =>
  String.raw`(?:(?<![A-Za-z0-9])${letter}(?::|%3[Aa])|(?<![\w.~-])/(?:mnt/|cygdrive/)?${letter}(?=/))`;
const DRIVE = driveRe();
// Case-sensitive ("g"): the continuation rules below tell a capitalised word from a lowercase one.
const rule = (body: string) => new RegExp(`${DRIVE}${SEP}${body}`, "g");
const USERS = ci("Users");

// A folder name may hold spaces ("Program Files", "OneDrive - Acme Ltd", and two in a row): an
// intermediate segment may therefore run across spaces, as long as a separator follows it -- but
// never into a drive (`from D:\a and then E:\b` was one path to the "E:"). A LAST segment, with no
// separator after it to prove it is still a path, continues only into words that do not start
// lowercase ({@link CONT}: "Acme Steel", "Job 41", not "to the folder and opened README.md", which
// the extension branch used to reach lazily across the sentence; review 5).
const NOT_DRIVE = "(?![A-Za-z](?::|%3[Aa]))";
const CONT = String.raw`(?: +${NOT_DRIVE}(?![a-z\u00DF-\u00FF])${SEGMENT})`;
const MID = `${SEGMENT}(?: +${NOT_DRIVE}${SEGMENT})*(?=${SEP})`;
const LAST = String.raw`(?:${SEGMENT}${CONT}*?\.[A-Za-z0-9]{1,8}(?![\w.])|${SEGMENT}${CONT}*${SEG_END})`;
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
// Each "/" may be JSON-escaped (`\/srv\/clients\/…`, as a transcript's JSON holds it).
const POSIX_PATH = String.raw`(?<![\w.:/\\>-])\\?\/(?:${PSEG}(?: ${PSEG})*\\?\/)+(?:${PSEG}(?: ${PSEG})*?\.[A-Za-z0-9]{1,8}(?![\w.])|${PSEG})`;
/**
 * The whole of a path below a home folder: the username (which may hold a space) and every
 * segment after it. The home rule used to replace `X:\Users\<name>` alone, and the rest stood --
 * `<home>\OneDrive - <employer>\Jobs\<client>\…`, a surname after a spaced username -- while the
 * residue check, looking for drive paths only, said "0 drive path(s) after" (2026-11-06 review).
 */
// The username runs across spaces where a separator follows it, or -- at the end -- into
// capitalised words ({@link CONT}): `C:\Users\<name> and then` took "and then" as the name (review
// 4), and a spaced `C:\Users\Kestrel Brumby` at a line's end then left "Brumby" (review 5).
const HOME_TAIL = `${SEGMENT}(?:(?: +${NOT_DRIVE}${SEGMENT})+(?=${SEP})|${CONT}+)?(?:${SEP}${MID})*(?:${SEP}${LAST})?`;

/** Host suffixes that name a private network, never a public site. */
const INTRANET_TLD = String.raw`(?:corp|local|lan|internal|intranet|home|lab|localdomain|ad)(?![\w.-])`;

/** Where a home is written through a shell's name for it (`~`, `%USERPROFILE%`, `$HOME`, `$env:…`). */
const HOME_VARS = ["USERPROFILE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ONEDRIVE", "TEMP", "TMP"];
const HOME_NAME = String.raw`(?:~|%(?:${HOME_VARS.map(ci).join("|")})%|\$env:(?:${[...HOME_VARS, "HOME"].map(ci).join("|")})|\$\{?HOME\}?)`;

/**
 * Where a quoted path starts: an optional `file:` / `vscode:` scheme, then a drive, a network
 * path either way round, any absolute POSIX path of two segments, or a home through its shell name.
 * Review 5: only a fixed list of POSIX roots counted (`"/data/jobs/Zorblax Quarry"` kept
 * "Quarry"), and a scheme, `~` or `%USERPROFILE%` in quotes was not a quoted path at all.
 */
const QUOTED_START = String.raw`(?:file:\/\/\/?|vscode:\/\/file\/)?(?:${DRIVE}${SEP}|\\{2,4}[A-Za-z0-9_.$-]+\\|\/\/[A-Za-z0-9_.$-]+\/|\/[\w.~@%+-]+\/|${HOME_NAME}${SEP})`;
/**
 * A path written inside quotes, taken to the closing quote: there a last folder name may hold
 * spaces, and the unquoted rules stop it at the first one -- `cd "D:\Jobs\Acme Steel"` became
 * `"<path> Steel"`, the employer's name left (review 4). The quote is `"`, `'` or a backtick,
 * JSON-escaped or not, and closes only where no letter follows it: `'D:\Jobs\O'Brennick Steel'`
 * does not end at `O'`. Curly quotes (`“…”`, `‘…’`) too ({@link QUOTED_CURLY}).
 */
const QUOTED_PATH = new RegExp(
  String.raw`(["'\x60])(${QUOTED_START}(?:(?!\1)[^\n])*?)(?=\\?\1(?!${NAME_LETTER}))`,
  "g",
);
const QUOTED_CURLY = new RegExp(
  String.raw`([“‘])(${QUOTED_START}[^\n”’]*?(?:’(?=${NAME_LETTER})[^\n”’]*?)*)(?=[”’](?!${NAME_LETTER}))`,
  "g",
);
/** The placeholder for a quoted path: a home's, a network path's, or a path's; its scheme kept. */
const quotedPlaceholder = (_m: string, quote: string, path: string) => {
  const scheme = /^(?:file:\/\/\/?|vscode:\/\/file\/)/i.exec(path)?.[0] ?? "";
  const bare = path.slice(scheme.length);
  const kind = new RegExp(
    String.raw`^(?:${DRIVE}${SEP}${USERS}${SEP}|\/(?:home|Users|root)\/|${HOME_NAME}${SEP})`,
  ).test(bare)
    ? "<home>"
    : /^(?:\\{2}|\/\/)/.test(bare)
      ? "<unc-path>"
      : "<path>";
  return `${quote}${scheme}${kind}`;
};

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
type Replacement = string | ((match: string, ...groups: string[]) => string);
const RULES: Array<[RegExp, Replacement]> = [
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
          rule(`${USERS}${SEP}${SEGMENT}${SEP}${SEGMENT}${SEP}${ci(escapeRe(WORK_FOLDER))}`),
          "<project>",
        ] as [RegExp, string],
      ]
    : []),
  // Any other path in quotes, whole ({@link QUOTED_PATH}, {@link QUOTED_CURLY}): a home, a network
  // path, or a path, its scheme kept.
  [QUOTED_PATH, quotedPlaceholder],
  [QUOTED_CURLY, quotedPlaceholder],
  // A home folder and EVERYTHING below it (HOME_TAIL), in any separator.
  [rule(`${USERS}${SEP}${HOME_TAIL}`), "<home>"],
  // The same home written without its drive (`\Users\<name>\…`), or through a shell's name for it
  // -- `~\…`, `%USERPROFILE%\…`, `$env:USERPROFILE\…`, `$HOME/…` -- and everything below. Each
  // passed whole, folder and client names included (2026-11-07 review). Case-sensitive, as
  // {@link CONT} needs, the names matched in any case by {@link ci}.
  [new RegExp(String.raw`(?<![\w:\\/>%])\\{1,2}${USERS}${SEP}${HOME_TAIL}`, "g"), "<home>"],
  [
    new RegExp(
      String.raw`(?:%(?:${HOME_VARS.map(ci).join("|")})%|\$env:(?:${[...HOME_VARS, "HOME"].map(ci).join("|")})\b|\$\{?HOME\}?(?![\w]))(?:${SEP}${HOME_TAIL})?`,
      "g",
    ),
    "<home>",
  ],
  [new RegExp(String.raw`(?<![\w.~-])~(?=${SEP})${SEP}${HOME_TAIL}`, "g"), "<home>"],
  // A file: URI naming a host (`file://server/share/…`): a network path the UNC rule, which never
  // starts after ":", did not see.
  [/(?<![\w])file:\/\/(?!\/)[^\s"'<>)\]]+/gi, "file://<unc-path>"],
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
  // A share named by a network URI (`smb://nas7/jobs/…`, `afp://…`, `nfs://…`), or a forward-slash
  // network path to an IP address (`//192.168.1.5/jobs/…`, which the dotless-host rule skips):
  // each passed whole (review 4).
  [/(?<![\w])(smb|afp|nfs|cifs|webdav|davs?):\/\/[^\s"'<>)\]\x60]+/gi, "$1://<unc-path>"],
  [/(?<![\w:/\\>])\/\/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\/[^\s"'<>)\]\x60]*/g, "<unc-path>"],
  // ...or to an intranet host: a dotted host is a URL's (`//cdn.example.org/…`), but not one under
  // an intranet suffix (`//fileserver7.corp/jobs/…` passed whole; review 5).
  [
    new RegExp(
      String.raw`(?<![\w:/\\>])\/\/[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*\.${INTRANET_TLD}(?::\d+)?\/[^\s"'<>)\]\x60]*`,
      "gi",
    ),
    "<unc-path>",
  ],
  // Last: any network path, then any drive path still standing.
  [new RegExp(UNC, "g"), "<unc-path>"],
  [new RegExp(ANY_PATH, "g"), "<path>"],
  // Any other absolute POSIX path of two segments or more -- /srv/…, /Volumes/…, /tmp/…, /opt/… --
  // which records a machine's layout as much as a home folder does; they used to pass untouched,
  // "0 drive path(s) after" (2026-11-06 review). Not after a word, ".", ":" or "/" (so not a URL's
  // path or a relative one), and only path-like segments (so not a regex like /^#./).
  [new RegExp(POSIX_PATH, "g"), "<path>"],
  // Last of all: a local file: or vscode: URI whose path no rule above took (`file:///srv/…`, the
  // POSIX rule never starting after "/"). One already redacted starts with a placeholder.
  [/(?<![\w])(file:\/\/\/|vscode:\/\/file\/)(?!<)[^\s"'<>)\]]+/gi, "$1<path>"],
];

/**
 * An email address, its "@" written plainly, URL-encoded or JSON-escaped. The privacy rule
 * forbids an email in any committed file (one maintainer contact excepted, never in a transcript),
 * and a transcript holds them -- `git log` prints authors, a config read prints one -- yet this
 * script looked only at the username and paths: an address passed as clean (2026-11-06).
 */
// Letters of ANY script (an internationalised domain, an accented name), a quoted local part, and
// the full-width and small "@" (U+FF20, U+FE6B): ASCII-only, each passed (2026-11-07 review).
// The domain may be an address literal (`bob@[192.168.1.1]`), and its last label one letter: a
// transcript exporter clips long lines, and `…@brumby-mail.o` passed (review 4).
// Review 5: clipped anywhere -- before the dot (`…@brumby-m`), at the "@" itself, or with no dot at
// all (`…@brumbymail`, an intranet host) -- and a double-encoded "@" (`%2540`). The domain then
// needs only one letter; a `pkg/name@version` (after a "/", no local part of its own) and a
// version (`react@18.3.1`, no letter) are not addresses.
const AT = String.raw`(?:@|＠|﹫|%2540|%40|\\u0040|&#0*64;|&#x0*40;|&commat;)`;
/** Where an address ends: the end, whitespace, a quote, a bracket, punctuation -- never a "/". */
const ADDRESS_END = String.raw`(?=$|[\s…"'<>)\]\x60,;:])`;
/**
 * The domains an address may have. Never a version (`@v5`, `@1.2.3`, `@v1.2.3`: a GitHub action
 * or package ref) and never followed by "/" (`name@scope/pkg`). Dotted with a last label of any
 * length (`…@brumby-mail.o`, clipped) or a trailing dot; dot-less (an intranet host) or empty
 * (clipped at the "@") only where the address visibly ends.
 */
const DOMAIN = String.raw`(?!v?\d+(?:\.\d+)*(?![\p{L}\p{N}-]))(?:\[[0-9A-Fa-f.:]+\]|[\p{L}\p{N}-]*\p{L}[\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)+\.?(?![/\p{L}\p{N}-])|[\p{L}\p{N}-]*\p{L}[\p{L}\p{N}-]*\.?${ADDRESS_END}|${ADDRESS_END})`;
const EMAIL = new RegExp(
  // A quoted local part (`"kestrel brumby"@…`) only with a full domain: in a transcript's JSON a
  // string ending `\"` before an "@" (`"\"@scope/pkg"`) is not an address.
  String.raw`(?<![\p{L}\p{N}/._%+-])(?:"[^"\n\\]{1,64}"${AT}[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}|[\p{L}\p{N}._%+-]+${AT}${DOMAIN})`,
  "giu",
);

/**
 * The residue check's email pattern, deliberately LOOSER than {@link EMAIL}: spaces around the
 * "@", "(at)" / "[at]" spellings. A residue check made of the same pattern as the redaction can
 * never find what the redaction missed -- it was 0 by construction (2026-11-06 review).
 */
// Its DOMAIN is looser too (review 4: it was the rule's own, so a clipped `…@brumby-mail.o` passed
// both): any address literal, or a first label holding two letters followed by a dot and anything
// -- which keeps `react@18.3.1` and `checkout@v5.1.0` (a version, not a domain) out of it.
// Review 5: looser again than the rule, now that the rule takes clipped and dot-less addresses --
// any domain with a letter, an address literal, or none (clipped at the "@"); the spaced "(at)"
// spellings as before. Still not after a "/" (`owner/action@v5`) or before a digit-only "domain".
const EMAIL_RESIDUE = new RegExp(
  // A local part has a letter or digit: a lone quote before an "@" is JSON (`"@type":`), not one.
  String.raw`(?<![\p{L}\p{N}/._%+"-])[._%+"-]*[\p{L}\p{N}][\p{L}\p{N}._%+"-]*(?:${AT}|\s*[([]at[)\]]\s*)${DOMAIN}`,
  "giu",
);

/**
 * Addresses that name no one: the commit trailer's, GitHub's SSH user, and the reserved example
 * and test domains (RFC 2606 / 6761) the test suite writes. Everything else is redacted.
 */
const isPublicEmail = (e: string) => {
  const plain = e.replace(/%2540|%40|\\u0040|＠|﹫/i, "@");
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
  // Looser than DRIVE: a digit may precede the letter, and every separator spelling counts.
  ...(s.match(/(?<![A-Za-z])[A-Za-z](?::|%3[Aa])(?:\\|\/|%5[Cc]|%2[Ff])/g) ?? []),
  ...(s.match(/(?<![\w:>])(?:\\\\|\/\/)[A-Za-z0-9_$-]+[\\/]\S/g) ?? []),
  // A file: or vscode: URI with anything left in it but its scheme and a placeholder.
  ...(s.match(/(?:file|vscode):\/\/[^\s"'<>)\]]*/gi) ?? []).filter(
    (u) => !/^(?:file:\/\/\/?|vscode:\/\/file\/)$/i.test(u),
  ),
  // A home written through a shell's name for it, or without its drive.
  ...(s.match(
    /(?<![\w.~-])~(?:\\|\/)[^\s"'<>]|%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA|ONEDRIVE)%|\$env:(?:USERPROFILE|HOME|HOMEPATH|APPDATA|LOCALAPPDATA|OneDrive)\b|\$\{?HOME\}?(?:\\|\/)|(?<![\w>])(?:\\|\/)Users(?:\\|\/)[^\s"'<>]/gi,
  ) ?? []),
  // A slug placeholder stands for one folder NAME, so a file below it is not a path tail. (A word
  // after one, before a closing quote, cannot be told from `"git -C <path> status"`; a quoted path
  // is taken whole instead, {@link QUOTED_PATH}.)
  ...(s.match(
    /<(?:home|path|unc-path)>(?:(?:\\{1,2}|\/)[^\s"'<>]| [^\s"'<>\\/]+(?:\\{1,2}|\/))/g,
  ) ?? []),
  // A share named by a network URI, or a network path to an IP address or an intranet host.
  ...(s.match(/(?:smb|afp|nfs|cifs|webdav|davs?):\/\/(?!<)\S|\/\/\d{1,3}(?:\.\d{1,3}){3}[:/]/gi) ??
    []),
  ...(s.match(
    new RegExp(
      String.raw`(?<![\w:/\\>])\/\/[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*\.${INTRANET_TLD}\/`,
      "gi",
    ),
  ) ?? []),
  ...(s.match(/(?<![A-Za-z0-9])[A-Za-z]--[A-Za-z0-9]/g) ?? []),
  // Looser than the POSIX redaction rule (any segment characters), for the same reason as
  // EMAIL_RESIDUE: a check that matches only what the rules replace cannot fail.
  ...(s.match(/(?<![\w.:/\\>-])\\?\/(?:[^/\s"'<>()]+\/)+[^/\s"'<>()]+/g) ?? []).filter(
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
  if (hits > 0) {
    applied.push(`${hits} → ${typeof replacement === "string" ? replacement : "<quoted path>"}`);
  }
  text =
    typeof replacement === "string"
      ? text.replace(pattern, replacement)
      : text.replace(pattern, replacement);
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

// Where, by line number only: the 70 characters either side it used to print were the very text it
// protects -- a client and a job number came out whole (review 5). Open the file at those lines.
if (after > 0) {
  const one = new RegExp(escapeRe(USER), "i"); // not global: `test` keeps no position
  const lines = text
    .split("\n")
    .flatMap((l, i) => (one.test(l) ? [i + 1] : []))
    .slice(0, 20);
  console.log(`remaining at line(s): ${lines.join(", ")}`);
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
