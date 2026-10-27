/**
 * Produces the committed sample reports in tests/HTMLFilesToBeCompiled/ from the
 * real client set in local/HTMLFilesToBeCompiled/ (which is git-ignored).
 *
 *   deno run -A scripts/sanitize-report.ts member_0_report.html member_1_report.html
 *   deno run -A scripts/sanitize-report.ts --check <files>   # report only, writes nothing
 *
 * WHAT IS SCRUBBED, and why only this much
 * ----------------------------------------
 * Owner decision: the identifying metadata comes out — Project Name, Designer,
 * Project Notes. The calculations themselves are academic and stay verbatim,
 * which matters, because a sample whose numbers had been altered would no longer
 * exercise the conservation check against anything real.
 *
 * The three fields sit in the report's "Project details" block in a fixed shape:
 *
 *     Project Name:  [mathin]\text{  }[mathin]<project name><br>
 *     Designer:      [mathin]\text{  }[mathin]<designer><br>
 *     Project Notes: [mathin]\text{  }[mathin]<client>\n<job number>\n<scope><br>
 *
 * The label and the inline-maths spacer are kept; only the value is replaced.
 *
 * ⚠️ The real values are deliberately NOT quoted anywhere in this file. A
 * redaction tool that documents its own examples with live data republishes
 * exactly what it removes, in a file that ships to the registry.
 *
 * WHY THIS SCRIPT CHECKS ITSELF
 * -----------------------------
 * A redaction regex that quietly matches nothing reports success and ships the
 * data anyway — this project has already been bitten by exactly that shape of
 * bug twice (see cmem/practices.md §4: a PowerShell -SimpleMatch search that
 * matched nothing and reported "clean", and a first redaction pass that took 744
 * occurrences to 538 instead of 11). So after rewriting, every word of every
 * value it removed is searched for in the output, and a survivor is a hard
 * failure rather than a warning.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";

/** UTF-8 text, a leading BOM KEPT — as `Deno.readTextFile` returned it (measured 2026-10-26). */
const readText = (p: string) => readFile(p, "utf8");

const REPLACEMENTS: Array<{ label: string; value: string }> = [
  { label: "Project Name", value: "Example Structure" },
  { label: "Designer", value: "Example Engineer" },
  { label: "Project Notes", value: "Sample report — synthetic project metadata" },
];

/**
 * Words that legitimately occur in the calculation prose, so their presence is
 * not evidence of a leak. Kept as short as the evidence allows — every entry
 * here is a hole in the residue check, so each one is a word that was OBSERVED
 * surviving for an innocent reason, not one guessed at in advance.
 */
const IGNORE_TOKENS = new Set(["design"]);

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("usage: sanitize-report.ts [--check] <report.html> [...]");
  console.error("Files are read from local/HTMLFilesToBeCompiled/ and written to");
  console.error("tests/HTMLFilesToBeCompiled/ with the same name.");
  process.exit(1);
}

const SRC_DIR = "local/HTMLFilesToBeCompiled";
const OUT_DIR = "tests/HTMLFilesToBeCompiled";

/**
 * Matches `Label:` plus the inline-maths spacer, then the value up to the `<br>`
 * that ends the row. The spacer is optional so this still works on a report that
 * does not use it; the value group is lazy so it stops at the first `<br>`.
 */
function fieldPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(${escaped}:\\s*(?:\\[[a-z]+\\]\\\\text\\{[^}]*\\}\\[[a-z]+\\])?)([\\s\\S]*?)(<br\\s*/?>)`,
    "i",
  );
}

let failures = 0;

for (const file of files) {
  const name = file.replace(/^.*[\\/]/, "");
  const srcPath = `${SRC_DIR}/${name}`;

  let html: string;
  try {
    html = await readText(srcPath);
  } catch {
    console.error(`❌ ${name}: not found at ${srcPath}`);
    failures++;
    continue;
  }

  const removed: string[] = [];
  let out = html;

  for (const { label, value } of REPLACEMENTS) {
    const pattern = fieldPattern(label);
    const match = out.match(pattern);

    if (!match) {
      // Not "nothing to do" — the field this script exists to remove is missing,
      // which means either the template changed or the pattern is wrong. Either
      // way, shipping the file would be shipping unreviewed content.
      console.error(`❌ ${name}: no "${label}:" field found — refusing to sanitize blind`);
      failures++;
      continue;
    }

    removed.push(match[2]);
    out = out.replace(pattern, `$1${value}$3`);
  }

  // ── Residue check ─────────────────────────────────────────────────────────
  // Every word of every removed value must be gone from the output.
  const tokens = [
    ...new Set(
      removed
        .flatMap((v) => v.split(/[^A-Za-z0-9]+/))
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !IGNORE_TOKENS.has(t.toLowerCase())),
    ),
  ];

  // Word-boundary, not substring: a bare substring test flags "Inc" inside
  // "Including" and would push us into ignoring genuinely identifying words to
  // quiet the false positives. Widening the ignore list to fix a sloppy matcher
  // is how a redaction check ends up unable to fail.
  const survivors = tokens.filter((t) =>
    new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(out),
  );

  if (survivors.length > 0) {
    console.error(
      `❌ ${name}: ${survivors.length} removed term(s) still present: ${survivors.join(", ")}`,
    );
    console.error("   The field was rewritten but the value appears elsewhere in the document.");
    failures++;
    continue;
  }

  const summary = removed.map((v) => JSON.stringify(v.replace(/\s+/g, " ").trim())).join(", ");
  if (checkOnly) {
    console.log(`✓ ${name}: would remove ${summary}; ${tokens.length} token(s) verified absent`);
  } else {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(`${OUT_DIR}/${name}`, out);
    console.log(`✅ ${name}: removed ${summary}; ${tokens.length} token(s) verified absent`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed. Nothing partial was shipped for them.`);
  process.exit(1);
}
