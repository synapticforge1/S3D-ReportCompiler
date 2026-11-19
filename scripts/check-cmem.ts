// check-cmem.ts — size gate for a project's cmem folder.
// Run from the repository root:  bun scripts/check-cmem.ts [cmem-dir] [--summary]
// Exit code 0 when every limit holds, 1 otherwise. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const LIMITS = {
  indexBytes: 3 * 1024, // INDEX.md: a router, read every session
  stateLines: 60, // STATE.md: where the project stands
  fileBytes: 25 * 1024, // every other live note
  lineChars: 200, // any line outside a code fence
};
const SKIP_DIRS = new Set(["archive", "local"]); // never read wholesale, so not limited
const STATE_HEADINGS = ["## Now", "## Review", "## Next", "## Waiting on owner"];
const FENCE = "`".repeat(3); // the marker that opens and closes a code block

const args = process.argv.slice(2);
const summaryOnly = args.includes("--summary");
const root = args.find((a) => !a.startsWith("--")) ?? "cmem";
const problems: { rule: string; text: string }[] = [];
const add = (rule: string, text: string) => problems.push({ rule, text });

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(path));
    } else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

if (!existsSync(root)) {
  console.error(`check-cmem: no folder at ${root}`);
  process.exit(1);
}
if (!existsSync(join(root, "STATE.md"))) add("state-missing", `${root}/STATE.md does not exist`);
if (!existsSync(join(root, "INDEX.md"))) add("index-missing", `${root}/INDEX.md does not exist`);

for (const path of walk(root)) {
  const rel = relative(root, path).replaceAll("\\", "/");
  const text = readFileSync(path, "utf8");
  const bytes = Buffer.byteLength(text);
  const lines = text.split(/\r?\n/);

  if (rel === "INDEX.md") {
    if (bytes > LIMITS.indexBytes)
      add("index-size", `${rel}: ${bytes} bytes, limit ${LIMITS.indexBytes}`);
  } else if (rel === "STATE.md") {
    if (lines.length > LIMITS.stateLines)
      add("state-size", `${rel}: ${lines.length} lines, limit ${LIMITS.stateLines}`);
    for (const h of STATE_HEADINGS) {
      if (!lines.includes(h)) add("state-heading", `${rel}: heading "${h}" is missing`);
    }
  } else if (bytes > LIMITS.fileBytes) {
    add("file-size", `${rel}: ${bytes} bytes, limit ${LIMITS.fileBytes}`);
  }

  let inFence = false;
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith(FENCE)) {
      inFence = !inFence;
      return;
    }
    if (!inFence && line.length > LIMITS.lineChars) {
      add("line-length", `${rel}:${i + 1}: ${line.length} characters, limit ${LIMITS.lineChars}`);
    }
  });
}

const counts = new Map<string, number>();
for (const p of problems) counts.set(p.rule, (counts.get(p.rule) ?? 0) + 1);
if (!summaryOnly) for (const p of problems) console.log(`${p.rule}  ${p.text}`);
const summary = [...counts].map(([rule, n]) => `${rule} ${n}`).join(", ");
const total = problems.length;
console.log(
  total === 0 ? "check-cmem: all limits hold" : `check-cmem: ${total} problems (${summary})`,
);
process.exit(total === 0 ? 0 : 1);
