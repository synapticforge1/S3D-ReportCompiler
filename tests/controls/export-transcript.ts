// export-transcript.ts
//
// Export a Claude Code session log to readable Markdown, so the record of how a
// change was made travels with the repository instead of living in one user's
// profile directory.
//
//   bun tests/controls/export-transcript.ts <session.jsonl> <out.md>
//
// Session logs live in ~/.claude/projects/<slug>/<session-id>.jsonl
//
// Two reductions, both deliberate:
//
//   * Base64 image data becomes a placeholder. Page renders inspected during
//     development made up 3.84 MB of a 6.46 MB log and carry nothing reviewable
//     as text.
//   * Tool results are truncated. The measurements worth keeping are in the
//     first lines of command output; a 60 KB file read is noise.
//
// Internal reasoning is not exported.

import { readFile, writeFile } from "node:fs/promises";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string) => readFile(p, "utf8");

const src = process.argv[2];
const out = process.argv[3];

if (!src || !out) {
  console.error("usage: export-transcript.ts <session.jsonl> <out.md>");
  process.exit(1);
}

const RESULT_CAP = 1200;

const strip = (s: string) =>
  s.replace(/[A-Za-z0-9+/]{300,}={0,2}/g, "[binary data omitted]");

const clip = (s: string, n: number) =>
  s.length <= n ? s : s.slice(0, n) + `\n… [${s.length - n} more characters omitted]`;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content as Record<string, unknown>[]) {
    switch (block?.type) {
      case "text":
        parts.push(String(block.text ?? ""));
        break;
      case "thinking":
        break;
      case "tool_use": {
        const input = JSON.stringify(block.input ?? {});
        parts.push(`\n**→ ${block.name}**\n\n\`\`\`json\n${clip(strip(input), 900)}\n\`\`\`\n`);
        break;
      }
      case "tool_result": {
        const body = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
          ? (block.content as Record<string, unknown>[])
            .map((c) => c?.type === "text" ? String(c.text ?? "") : "[image]")
            .join("\n")
          : "";
        parts.push(
          `\n<details><summary>result</summary>\n\n\`\`\`\n${clip(strip(body), RESULT_CAP)}\n\`\`\`\n</details>\n`,
        );
        break;
      }
      case "image":
        parts.push("\n_[screenshot / rendered page — image omitted]_\n");
        break;
    }
  }
  return parts.join("\n");
}

const lines = (await readText(src)).split("\n").filter((l) => l.trim());
const md: string[] = [];
let turns = 0;

for (const line of lines) {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }

  const kind = rec.type;
  if (kind !== "user" && kind !== "assistant") continue;

  const message = rec.message as Record<string, unknown> | undefined;
  const body = textOf(message?.content).trim();
  if (!body) continue;

  turns++;
  md.push(`\n---\n\n## ${kind === "user" ? "👤 User" : "🤖 Assistant"}\n\n${body}\n`);
}

const header = `# Session Transcript

Verbatim record of the session that produced this project, exported from the Claude Code session log
so it travels with the repository instead of living on one machine.

**${turns} turns.** Internal reasoning is not included. Base64 image data — page renders inspected
during development — is replaced by placeholders. Tool results are truncated to ${RESULT_CAP}
characters, which preserves the measurements while cutting bulk.

For the distilled version, read [../process-log.md](../process-log.md) first. This file is the primary
source behind it.

Regenerate with [export-transcript.ts](../controls/export-transcript.ts).

`;

const text = header + md.join("");
await writeFile(out, text);

console.log(`turns:  ${turns}`);
console.log(`source: ${(new TextEncoder().encode(await readText(src)).length / 1e6).toFixed(2)} MB`);
console.log(`output: ${(new TextEncoder().encode(text).length / 1e6).toFixed(2)} MB`);
