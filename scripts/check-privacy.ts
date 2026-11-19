/**
 * The privacy gate (workspace review standard, letter H37 § 10: "the privacy and credential scan" is a
 * GATE, run locally, not a review; H37 (b): it refuses `cmem/review-issues.md` tracked). Ported
 * 2026-11-19 from LeptonPad's `scripts/check-privacy.ts` (itself from binaryang's) to this repo's rules
 * (cmem/working-rules.md § Privacy).
 *
 * What it reads:
 *   - every tracked file (`git ls-files`), whatever its encoding, and every new file not yet added that
 *     is not ignored (`--others --exclude-standard`);
 *   - with `--commits <range>`, the message of every commit in the range (`git log`).
 *
 * What it refuses:
 *   - a TRACKED private file: `cmem/review-issues.md`, anything under `cmem/local/`, `local/` or
 *     `.claude/` — each is gitignored, but `git add -f` still commits it;
 *   - a drive path that records one machine's layout: a drive letter then `Users` or `Programs` and a
 *     real folder name (either slash, JSON-escaped too), the same under WSL's `/mnt/<letter>` and Git
 *     Bash's `/<letter>/`, a macOS home, a Linux home (except the CI runner's). A placeholder segment
 *     (`<user>`, `…`, `...`) names no machine and passes (working-rules § Privacy: "is it
 *     machine-specific?");
 *   - a private key block, the token shapes of GitHub, npm, AWS, Slack, Google, Stripe, a JSON Web
 *     Token, a quoted secret assignment, and a password inside a URL unless the host is local or a
 *     placeholder;
 *   - an email address, except a service's (`noreply@…`, `…@users.noreply.github.com`,
 *     `git@github.com`) and a reserved example domain. This repo has no maintainer-contact note, so no
 *     personal address is allowed anywhere in the tree.
 *
 * A hit is printed with its file and line and the match MASKED (its first three characters), and
 * exits 1. Never print a secret whole, even to say it was found.
 *
 *   bun scripts/check-privacy.ts [--commits <range>]
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One finding: where, what kind, and the match masked. */
export interface Leak {
  where: string;
  kind: string;
  masked: string;
}

/** A path segment that is a placeholder, not a folder on one machine. */
const REAL = String.raw`(?![\\/<.…*%$])`;

/**
 * The invented identities this repo's own fixtures and examples use, so a path or address built from
 * one names no machine: `me` (the README's and `--help`'s example), `u` (the redactor's slug note),
 * and the redactor's planted users `qwertyu`, `zorblax`, `Kestrel Brumby` (tests/build.test.ts).
 * A real user name is never added here — a leak is fixed in its file.
 */
const SYNTHETIC = /^(?:me|u|qwertyu|zorblax|kestrel(?:[ ._]brumby)?)(?=$|[\\/ "'.@])/i;

/** The folder name after `Users` / `Programs` / `home` in a matched path. */
function userSegment(path: string): string {
  return path.replace(/^.*?(?:Users|Programs|home)(?:\\\\?|\/)+/, "");
}
const SEP = String.raw`(?:\\\\?|\/)+`;

const RULES: { kind: string; re: RegExp }[] = [
  {
    kind: "drive path",
    re: new RegExp(String.raw`\b[A-Za-z]:${SEP}(?:Users|Programs)${SEP}${REAL}[^\s'"\`]+`, "g"),
  },
  {
    kind: "drive path",
    re: new RegExp(String.raw`\/mnt\/[a-z]\/(?:Users|Programs)\/${REAL}[^\s'"\`]+`, "g"),
  },
  {
    kind: "drive path",
    re: new RegExp(String.raw`(?<![\w.:/])\/[a-z]\/(?:Users|Programs)\/${REAL}[^\s'"\`]+`, "g"),
  },
  {
    kind: "home path",
    re: new RegExp(String.raw`\/Users\/${REAL}[A-Za-z][\w.-]*\/[^\s'"\`]*`, "g"),
  },
  {
    kind: "home path",
    re: new RegExp(String.raw`\/home\/(?!runner\/)${REAL}[a-z][\w.-]*\/[^\s'"\`]*`, "g"),
  },
  { kind: "private key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
  { kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "AWS key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "Stripe key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  {
    kind: "JSON Web Token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    kind: "secret assignment",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][^'"\s$]{8,}['"]/gi,
  },
  {
    kind: "URL password",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]+@(?!localhost\b|127\.0\.0\.1\b|\[::1\]|[^\s/'"`]*(?:xxxx|example|\bHOST\b))[^\s/'"`]+/gi,
  },
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Addresses that name no person: a service's, a reserved example domain. */
const NOT_PERSONAL =
  /^(?:[^@\s]+@users\.noreply\.github\.com|no-?reply@[^@\s]+|git@github\.com|[^@\s]+@example\.(?:com|org|net)|[^@\s]+@[^@\s]+\.(?:example|test|invalid))$/i;

/**
 * Findings checked by hand and found to name nothing private, each by place and kind, with why.
 * Commit messages cannot be changed once pushed, so a false positive in one is listed here rather
 * than rewritten; a FILE's false positive is fixed in the file instead.
 */
export const KNOWN: readonly { where: string; kind: string; why: string }[] = [];

/** The first three characters, then stars: enough to find it, never enough to use it. */
export function mask(s: string): string {
  return `${s.slice(0, 3)}${"*".repeat(Math.max(3, Math.min(12, s.length - 3)))}`;
}

/** Every leak in `text`, named `name` (a repo-relative path, or `commit <sha>`). */
export function findLeaks(name: string, text: string): Leak[] {
  const out: Leak[] = [];
  text.split("\n").forEach((line, i) => {
    const where = `${name}:${i + 1}`;
    for (const { kind, re } of RULES) {
      for (const m of line.matchAll(re)) {
        if (kind.endsWith("path") && SYNTHETIC.test(userSegment(m[0]))) continue;
        out.push({ where, kind, masked: mask(m[0]) });
      }
    }
    for (const m of line.matchAll(EMAIL)) {
      const addr = m[0];
      // `user:pass@host` inside a URL is a credential, not an address: the URL rule judges it.
      if (/:\/\/[^\s/@]*$/.test(line.slice(0, m.index))) continue;
      if (NOT_PERSONAL.test(addr) || SYNTHETIC.test(addr)) continue;
      out.push({ where, kind: "email address", masked: mask(addr) });
    }
  });
  return out;
}

/** The leaks not in {@link KNOWN}. */
export function unknown(leaks: readonly Leak[]): Leak[] {
  return leaks.filter((l) => !KNOWN.some((k) => k.where === l.where && k.kind === l.kind));
}

/**
 * What a file SAYS, whatever its encoding — EVERY file is read. UTF-16BE by its byte-order mark;
 * UTF-8 when there is no NUL; anything else as BOTH Latin-1 and UTF-16LE, so a secret written in
 * either is seen.
 */
export function textOf(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.from(b.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (!b.includes(0)) return b.toString("utf8");
  const even = b.length - (b.length % 2);
  return `${b.toString("latin1")}\n${b.subarray(0, even).toString("utf16le")}`;
}

/** The PRIVATE files among `tracked` (paths as `git ls-files` prints them). */
export function privateFilesTracked(tracked: readonly string[]): string[] {
  return tracked.filter(
    (f) =>
      f === "cmem/review-issues.md" ||
      f.startsWith("cmem/local/") ||
      f.startsWith("local/") ||
      f.startsWith(".claude/"),
  );
}

/** Parses `--commits R`; anything else is refused. */
export function parseArgs(argv: string[]): { commits: string | undefined } {
  let commits: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--commits" && (v === undefined || v.startsWith("--"))) {
      throw new Error("--commits needs a value");
    }
    if (a === "--commits") commits = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return { commits };
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
  return r.stdout;
}

if (import.meta.main) {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`check-privacy: ${(e as Error).message}`);
    process.exit(2);
  }
  const root = process.cwd();
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const privateOnes = privateFilesTracked(tracked);
  if (privateOnes.length > 0) {
    console.error("check-privacy: private file(s) TRACKED — untrack them (git rm --cached):");
    for (const f of privateOnes) console.error(`  ${f}`);
    process.exit(1);
  }
  // New files not yet added are read too (not the ignored ones): the next commit would carry them.
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean);
  const leaks: Leak[] = [];
  let files = 0;
  for (const f of [...tracked, ...untracked]) {
    let text: string;
    try {
      text = textOf(readFileSync(join(root, f)));
    } catch {
      continue; // listed but deleted in the working tree
    }
    files++;
    leaks.push(...findLeaks(f, text));
  }
  let commits = 0;
  if (args.commits !== undefined) {
    for (const entry of git(["log", "--format=%H%n%B%x00", args.commits]).split("\0")) {
      const body = entry.trim();
      if (body === "") continue;
      commits++;
      leaks.push(...findLeaks(`commit ${body.slice(0, 12)}`, body.slice(body.indexOf("\n") + 1)));
    }
  }
  if (files < 50) {
    console.error(
      `check-privacy: only ${files} files read — the listing is broken, not the tree clean`,
    );
    process.exit(1);
  }
  const found = unknown(leaks);
  if (found.length > 0) {
    console.error(`check-privacy: ${found.length} finding(s) (masked):`);
    for (const l of found) console.error(`  ${l.where}: ${l.kind} ${l.masked}`);
    process.exit(1);
  }
  console.log(
    `check-privacy: clean — ${files} files${commits ? `, ${commits} commit messages` : ""}`,
  );
}
