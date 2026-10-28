/**
 * The compatibility gate (workspace rule, 🔒 owner 2026-09-20; letter H6). "Backward compatible" is
 * a gate result, never a judgment made at bump time.
 *
 *   bun run surface                 write api-surface.txt from the current tree (Rule 5: commit that
 *                                   re-baseline on its own, before any bump)
 *   bun scripts/compat.ts check     is the committed snapshot current? print the floor vs the last tag
 *   bun scripts/compat.ts gate <patch|minor|major>
 *                                   refuse a stale snapshot, refuse a bump below the floor, and run
 *                                   the previous tag's samples on the new code (bump.ts runs this)
 *   bun scripts/compat.ts release <version>
 *                                   the same gate for the version about to be tagged (publish.ts)
 *
 * THE SURFACE (Rule 1), generated, never hand-written:
 *   - `export`   the `exports` map in jsr.json (deno.json at tags before step 7) — a surface grep
 *                cannot see;
 *   - `symbol`   every symbol in the `.d.ts` tsc emits for each export, one line each, comments
 *                removed and whitespace collapsed (moving a line or editing prose is not a change);
 *   - `cli-flag` / `cli-usage`  the options and the USAGE shapes `main.ts --help` prints.
 * Not covered, by design: exit codes and the CLI's prose (not machine-readable from --help), and
 * the npm dependencies' own types (the tag's surface is generated against today's node_modules).
 *
 * THE FLOOR (Rule 2): anything removed or changed → major; anything added → minor; nothing → patch.
 * "Changed" includes widening (an added optional parameter reads as changed), so the floor can be
 * higher than strictly needed — never lower.
 *
 * BEHAVIOUR (Rule 3): for a patch or minor, the PREVIOUS tag's sample reports must build and PASS
 * their verification with the NEW code. (A `tests/` suite does not exist yet — roadmap task 12
 * step 5; when it does, it joins this.)
 *
 * Uses node: builtins and spawns tsc (from node_modules), `git` and `tar` — no Deno (owner,
 * 2026-10-28: "the goal is to be deno free on this machine"; this used `deno doc --json` until then).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SNAPSHOT = join(ROOT, "api-surface.txt");
const SELF = [process.execPath, ...process.execArgv];
type Kind = "patch" | "minor" | "major";
const RANK: Record<Kind, number> = { patch: 0, minor: 1, major: 2 };

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 << 20 });
  return {
    code: r.status ?? 1,
    out: r.stdout ?? "",
    err: `${r.stderr ?? ""}${r.error?.message ?? ""}`,
  };
}

/**
 * Split declaration text into its top-level statements, comments removed and whitespace collapsed
 * to single spaces. Strings are skipped whole, so a `;` or brace inside one never splits.
 */
function statements(dts: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < dts.length; i++) {
    const c = dts[i];
    if (c === "/" && dts[i + 1] === "*") {
      const end = dts.indexOf("*/", i + 2);
      i = end < 0 ? dts.length : end + 1;
      cur += " ";
      continue;
    }
    if (c === "/" && dts[i + 1] === "/") {
      const end = dts.indexOf("\n", i);
      i = end < 0 ? dts.length : end;
      cur += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < dts.length && dts[j] !== c) j += dts[j] === "\\" ? 2 : 1;
      cur += dts.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
    if (c === "}" || c === ")" || c === "]" || (c === ">" && dts[i - 1] !== "=")) depth--;
    if (c === ";" && depth === 0) {
      out.push(cur.replace(/\s+/g, " ").trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.replace(/\s+/g, " ").trim());
  return out.filter(Boolean);
}

/** The exported symbols of one emitted `.d.ts`: [name, kind, declaration] (overloads joined). */
function declarations(dts: string): Array<[string, string, string]> {
  const byName = new Map<string, [string, string[]]>();
  for (const s of statements(dts)) {
    const m = s.match(
      /^export (?:declare )?(?:async )?(function|const|let|var|type|interface|class|enum|namespace) ([A-Za-z_$][\w$]*)/,
    );
    if (!m) {
      // `import …` and the empty `export {}` carry no API; anything else exported is unread.
      if (/^export\b/.test(s) && s !== "export {}")
        throw new Error(`unrecognised export: ${s.slice(0, 120)}`);
      continue;
    }
    const kind =
      { const: "variable", let: "variable", var: "variable", type: "typeAlias" }[m[1]] ?? m[1];
    const entry = byName.get(m[2]) ?? [kind, []];
    entry[1].push(s);
    byName.set(m[2], entry);
  }
  return [...byName].map(([name, [kind, defs]]) => [name, kind, defs.join(" ; ")]);
}

/** Emit `.d.ts` for `files` of the package at `root` into a temp dir; returns the dir. */
function emitDeclarations(root: string, files: string[]): string {
  const out = mkdtempSync(join(tmpdir(), "s3d-dts-"));
  const config = join(out, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: ["node"],
        typeRoots: [join(root, "node_modules", "@types")],
        strict: true,
        skipLibCheck: true,
        declaration: true,
        emitDeclarationOnly: true,
        rewriteRelativeImportExtensions: true,
        rootDir: root,
        outDir: join(out, "d"),
      },
      files: files.map((f) => join(root, f)),
    }),
  );
  const tsc = run(
    process.execPath,
    [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", config],
    root,
  );
  if (tsc.code !== 0) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(`tsc declaration emit failed in ${root}:\n${(tsc.out + tsc.err).trim()}`);
  }
  return join(out, "d");
}

/** The surface of the package rooted at `root`, as sorted tab-separated lines. */
function surface(root: string): string[] {
  const lines: string[] = [];
  // jsr.json since bun-migration step 7 (2026-10-28); a tag cut before it (v1.0.4) has deno.json.
  const manifestFile = ["jsr.json", "deno.json"].find((f) => existsSync(join(root, f)));
  if (!manifestFile) throw new Error(`no jsr.json or deno.json in ${root}`);
  const manifest = JSON.parse(readFileSync(join(root, manifestFile), "utf8"));
  const exportsMap: Record<string, string> = manifest.exports ?? {};
  const dts = emitDeclarations(root, Object.values(exportsMap));
  try {
    for (const [spec, path] of Object.entries(exportsMap)) {
      lines.push(`export\t${spec}\t${path}`);
      const file = join(dts, path.replace(/\.ts$/, ".d.ts"));
      if (!existsSync(file)) throw new Error(`tsc emitted no declarations for ${path}`);
      for (const [name, kind, decl] of declarations(readFileSync(file, "utf8"))) {
        // `export declare const VERSION = "x.y.z"` changes with every bump: the package's version
        // is not API. Normalized for that one symbol only — its kind is still compared.
        const def =
          name === "VERSION" ? decl.replaceAll(`"${manifest.version}"`, `"<VERSION>"`) : decl;
        lines.push(`symbol\t${spec}\t${name}\t${kind}\t${def}`);
      }
    }
  } finally {
    rmSync(join(dts, ".."), { recursive: true, force: true });
  }
  // The CLI. The first line carries the version, which a bump changes: normalized out.
  const help = run(SELF[0], [...SELF.slice(1), join(root, "main.ts"), "--help"], root);
  if (help.code !== 0)
    throw new Error(`main.ts --help exited ${help.code} in ${root}:\n${help.err}`);
  const text = help.out.replace(/\r\n/g, "\n").split("\n");
  let section = "";
  for (const raw of text) {
    if (/^[A-Z][A-Z "']+$/.test(raw.trim()) && !raw.startsWith(" ")) {
      section = raw.trim();
      continue;
    }
    if (!raw.trim()) continue;
    // Usage line = the command shape before the two-space gap that starts its description.
    if (section === "USAGE") lines.push(`cli-usage\t${raw.trim().split(/\s{2,}/)[0]}`);
    if (section === "OPTIONS" && /^-/.test(raw.trim())) {
      for (const flag of raw
        .trim()
        .split(/\s{2,}/)[0]
        .split(/,\s*/))
        lines.push(`cli-flag\t${flag.trim()}`);
    }
  }
  return [...new Set(lines)].sort();
}

const keyOf = (l: string) => {
  const f = l.split("\t");
  return f[0] === "symbol" ? `symbol\t${f[1]}\t${f[2]}` : f[0] === "export" ? `export\t${f[1]}` : l;
};

/** Classify old → new. Returns the floor and the lines that set it. */
function diff(oldLines: string[], newLines: string[]) {
  const oldMap = new Map(oldLines.map((l) => [keyOf(l), l]));
  const newMap = new Map(newLines.map((l) => [keyOf(l), l]));
  const removed: string[] = [],
    changed: string[] = [],
    added: string[] = [];
  for (const [k, l] of oldMap) {
    if (!newMap.has(k)) removed.push(k);
    else if (newMap.get(k) !== l) changed.push(k);
  }
  for (const k of newMap.keys()) if (!oldMap.has(k)) added.push(k);
  const floor: Kind = removed.length || changed.length ? "major" : added.length ? "minor" : "patch";
  return { floor, removed, changed, added };
}

function lastTag(): string {
  const r = run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD"], ROOT);
  if (r.code !== 0) throw new Error(`no v* tag reachable from HEAD: ${r.err}`);
  return r.out.trim();
}

/** Extract `paths` of `tag` into a temp dir, with this repo's node_modules linked in. */
function extractTag(tag: string, paths: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "s3d-compat-"));
  const tar = join(dir, "tag.tar");
  const a = run("git", ["archive", "--format=tar", "-o", tar, tag, ...paths], ROOT);
  if (a.code !== 0) throw new Error(`git archive ${tag}: ${a.err}`);
  const x = run("tar", ["-xf", tar, "-C", dir], ROOT);
  if (x.code !== 0) throw new Error(`tar: ${x.err}`);
  rmSync(tar);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
  return dir;
}

/** The surface at `tag`: its committed snapshot if it has one, else generated from its files. */
function surfaceAt(tag: string): string[] {
  const snap = run("git", ["show", `${tag}:api-surface.txt`], ROOT);
  if (snap.code === 0) return snap.out.replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  const manifestFile =
    run("git", ["cat-file", "-e", `${tag}:jsr.json`], ROOT).code === 0 ? "jsr.json" : "deno.json";
  const dir = extractTag(tag, [manifestFile, "package.json", "main.ts", "src"]);
  try {
    return surface(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function committed(): string[] {
  if (!existsSync(SNAPSHOT))
    throw new Error("api-surface.txt is missing — run `bun run surface` and commit it");
  return readFileSync(SNAPSHOT, "utf8").replace(/\r\n/g, "\n").split("\n").filter(Boolean);
}

function printDiff(d: ReturnType<typeof diff>, from: string) {
  console.log(
    `  surface vs ${from}: ${d.removed.length} removed, ${d.changed.length} changed, ${d.added.length} added → floor ${d.floor}`,
  );
  for (const [label, list] of [
    ["removed", d.removed],
    ["changed", d.changed],
    ["added", d.added],
  ] as const) {
    for (const k of list.slice(0, 20))
      console.log(`    ${label.padEnd(7)} ${k.replace(/\t/g, " ")}`);
    if (list.length > 20) console.log(`    … ${list.length - 20} more ${label}`);
  }
}

/** Rule 3: the previous tag's sample reports must PASS on the new code. */
function previousSamples(tag: string): boolean {
  const dir = extractTag(tag, ["tests/HTMLFilesToBeCompiled"]);
  try {
    const out = join(dir, "out", "combined_report.pdf");
    const r = run(
      SELF[0],
      [...SELF.slice(1), join(ROOT, "main.ts"), join(dir, "tests/HTMLFilesToBeCompiled"), out],
      ROOT,
    );
    const pass = r.code === 0 && /PASS: every source word and number present/.test(r.out + r.err);
    console.log(
      `  ${pass ? "✅" : "❌"} ${tag}'s sample reports on the new code: ${pass ? "PASS" : `exit ${r.code}`}`,
    );
    if (!pass)
      console.log(
        (r.out + r.err)
          .trim()
          .split("\n")
          .slice(-8)
          .map((l) => `     ${l}`)
          .join("\n"),
      );
    return pass;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gate(kind: Kind, label: string): number {
  const now = surface(ROOT);
  const snap = committed();
  if (now.join("\n") !== snap.join("\n")) {
    console.error(
      "❌ api-surface.txt is STALE — the code's surface differs from the committed snapshot:",
    );
    printDiff(diff(snap, now), "the committed snapshot");
    console.error(
      "   Re-baseline in its OWN commit first (Rule 5): `bun run surface`, review, commit.",
    );
    return 1;
  }
  const tag = lastTag();
  const d = diff(surfaceAt(tag), snap);
  console.log(`compat gate for ${label} (${kind}):`);
  printDiff(d, tag);
  if (RANK[kind] < RANK[d.floor]) {
    console.error(
      `❌ a ${kind} bump is below the floor: the surface change since ${tag} needs ${d.floor}.`,
    );
    return 1;
  }
  if (kind !== "major" && !previousSamples(tag)) {
    console.error(
      `❌ ${tag}'s samples fail on the new code — a behaviour change; a ${kind} is not allowed.`,
    );
    return 1;
  }
  console.log(`✅ ${kind} allowed (floor ${d.floor}).`);
  return 0;
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "surface") {
    const lines = surface(ROOT);
    if (process.argv.includes("--write")) {
      writeFileSync(SNAPSHOT, `${lines.join("\n")}\n`);
      console.log(`wrote api-surface.txt: ${lines.length} line(s)`);
    } else console.log(lines.join("\n"));
  } else if (cmd === "check") {
    const now = surface(ROOT);
    const snap = committed();
    const stale = now.join("\n") !== snap.join("\n");
    console.log(
      stale
        ? "❌ api-surface.txt is STALE"
        : `✅ api-surface.txt is current (${snap.length} lines)`,
    );
    if (stale) printDiff(diff(snap, now), "the committed snapshot");
    const tag = lastTag();
    printDiff(diff(surfaceAt(tag), snap), tag);
    process.exit(stale ? 1 : 0);
  } else if (cmd === "gate" && (arg === "patch" || arg === "minor" || arg === "major")) {
    process.exit(gate(arg, `a ${arg} bump`));
  } else if (cmd === "release" && /^\d+\.\d+\.\d+$/.test(arg ?? "")) {
    const tag = lastTag();
    const [a, b] = [tag.slice(1).split(".").map(Number), arg.split(".").map(Number)];
    const kind: Kind | null =
      b[0] > a[0]
        ? "major"
        : b[0] === a[0] && b[1] > a[1]
          ? "minor"
          : b[0] === a[0] && b[1] === a[1] && b[2] > a[2]
            ? "patch"
            : null;
    if (!kind) {
      console.error(`❌ ${arg} is not above ${tag}.`);
      process.exit(1);
    }
    process.exit(gate(kind, `v${arg}`));
  } else {
    console.error(
      "usage: compat.ts surface [--write] | check | gate <patch|minor|major> | release <X.Y.Z>",
    );
    process.exit(2);
  }
} catch (e) {
  console.error(`❌ compat: ${(e as Error).message}`);
  process.exit(1);
}
