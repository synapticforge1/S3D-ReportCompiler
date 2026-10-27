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

import { readFile, writeFile } from "node:fs/promises";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string | URL) => readFile(p, "utf8");

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith("--"));
const check = argv.includes("--check");

const flagValue = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

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

const rule = (body: string) => new RegExp(`[A-Za-z]:${SEP}${body}`, "gi");

// Longest first: the project path extends the home path, so replacing the home
// path first would strand the remainder.
const RULES: Array<[RegExp, string]> = [
  // A named work folder, if one was given, is the longest match and goes first.
  ...(WORK_FOLDER
    ? [[
      rule(`Users${SEP}${SEGMENT}${SEP}${SEGMENT}${SEP}${escape(WORK_FOLDER)}`),
      "<project>",
    ] as [RegExp, string]]
    : []),
  [rule(`Users${SEP}${SEGMENT}${SEP}AppData`), "<home>/AppData"],
  [rule(`Users${SEP}${SEGMENT}`), "<home>"],
  // Claude Code flattens a working directory into a slug for its own storage
  // paths -- e.g. "C--Users-<name>". No separators, so the rules above miss it.
  [/[A-Za-z]--Users-[A-Za-z0-9_.-]+/g, "<home-slug>"],
  [/[A-Za-z]--[A-Za-z0-9_-]+--[A-Za-z0-9_.-]+/g, "<path-slug>"],
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
  const sample = [
    ...text.matchAll(new RegExp(`.{0,70}${escape(USER)}.{0,70}`, "gi")),
  ].slice(0, 5);
  console.log("remaining context:");
  for (const s of sample) console.log(`  …${s[0].replace(/\s+/g, " ")}…`);
}

if (check) {
  console.log("\n--check: nothing written.");
  process.exit(0);
}

if (text === original) {
  console.log("nothing to redact.");
  process.exit(0);
}

await writeFile(target, text);
console.log("redacted.");
