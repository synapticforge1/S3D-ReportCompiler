/**
 * Produces the committed sample reports in tests/HTMLFilesToBeCompiled/ from the
 * real client set in local/HTMLFilesToBeCompiled/ (which is git-ignored).
 *
 *   bun scripts/sanitize-report.ts member_0_report.html member_1_report.html
 *   bun scripts/sanitize-report.ts --check <files>   # report only, writes nothing
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
 * The other fields of the same "Project details" block that may hold a value:
 * not identifying, so kept verbatim. Every OTHER field in that layout must be
 * EMPTY, or the file is refused. The template also carries Project ID, Company
 * and Client -- empty in all 48 client reports (counted 2026-11-06), so nothing
 * scrubbed them, and a job that filled one would have been copied into tests/
 * with a ✅: the residue check looks only for the values it removed.
 */
const KEPT_FIELDS = new Set(["date", "project units"]);

/** Every `Label:  [mathin]\text{  }[mathin]value<br>` row of the block: [label, value]. */
const FIELD_ROW = /([A-Z][A-Za-z ]{0,40}):\s*\[[a-z]+\]\\text\{[^}]*\}\[[a-z]+\]([\s\S]*?)<br\b/g;

/**
 * Words that legitimately occur in the calculation prose, so their presence is
 * not evidence of a leak. Kept as short as the evidence allows — every entry
 * here is a hole in the residue check, so each one is a word that was OBSERVED
 * surviving for an innocent reason, not one guessed at in advance.
 */
const IGNORE_TOKENS = new Set(["design"]);

/**
 * A token as a whole word, in any script: `\b` is ASCII-only, so a name in
 * accented or non-Latin letters had no boundary to match.
 */
const wholeWord = (t: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "iu",
  );

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

  // Every field the template carries is either scrubbed below, known to be safe, or EMPTY.
  const scrubbed = new Set(REPLACEMENTS.map((r) => r.label.toLowerCase()));
  const rows = [...html.matchAll(FIELD_ROW)];
  // The guard reads only the spacer layout, while the scrub tolerates a missing spacer. On a
  // template without it the guard saw NO row and passed a filled Company with ✓ -- so the
  // fields it scrubs must be among the rows it read, or it is not reading this template.
  const seen = new Set(rows.map(([, label]) => label.trim().toLowerCase()));
  const unseen = [...scrubbed].filter((l) => !seen.has(l));
  if (unseen.length > 0) {
    console.error(
      `❌ ${name}: cannot read the project-details layout (no "Label: [mathin]\\text{…}[mathin]" ` +
        `row for ${unseen.join(", ")}) — refusing: the other fields cannot be checked.`,
    );
    failures++;
    continue;
  }
  const unreviewed = rows
    .filter(([, label, value]) => {
      const l = label.trim().toLowerCase();
      return !scrubbed.has(l) && !KEPT_FIELDS.has(l) && value.trim() !== "";
    })
    .map(([, label]) => label.trim());
  if (unreviewed.length > 0) {
    console.error(
      `❌ ${name}: field(s) ${unreviewed.map((l) => `"${l}:"`).join(", ")} hold a value this script ` +
        `does not scrub — refusing. Add each to REPLACEMENTS (or, if it identifies no one, to ` +
        `KEPT_FIELDS) first.`,
    );
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
  // Every word of every removed value must be gone from the output. Words of
  // two characters up, in any script: at three-plus ASCII only, a designer
  // written as initials ("JM") or a name in non-Latin letters left NOTHING to
  // check, and the file passed with "0 token(s) verified absent".
  const tokens = [
    ...new Set(
      removed
        .flatMap((v) => v.split(/[^\p{L}\p{N}]+/u))
        .map((t) => t.trim())
        .filter((t) => [...t].length >= 2 && !IGNORE_TOKENS.has(t.toLowerCase())),
    ),
  ];
  // A value that was removed but yields nothing to look for cannot be verified gone.
  const unverifiable = removed.filter(
    (v) => v.trim() !== "" && !v.split(/[^\p{L}\p{N}]+/u).some((t) => [...t].length >= 2),
  );
  if (unverifiable.length > 0) {
    console.error(
      `❌ ${name}: ${unverifiable.length} removed value(s) too short to verify absent — refusing.`,
    );
    failures++;
    continue;
  }

  // Word-boundary, not substring: a bare substring test flags "Inc" inside
  // "Including" and would push us into ignoring genuinely identifying words to
  // quiet the false positives. Widening the ignore list to fix a sloppy matcher
  // is how a redaction check ends up unable to fail.
  const survivors = tokens.filter((t) => wholeWord(t).test(out));

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
