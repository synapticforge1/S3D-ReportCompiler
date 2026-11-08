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
// The whole HTML entity table, loaded synchronously (MathJax's, already a dependency).
import "mathjax-full/js/util/entities/all.js";
import { translate } from "mathjax-full/js/util/Entities.js";

/**
 * Text as a reader sees it: every named and numeric entity decoded. Used on BOTH sides of the
 * residue check -- the removed value and the written file. The check used to blank entities in the
 * value and search the raw file, so a name written as `&#26472;&#20255;` left nothing to look for,
 * and `M&uuml;ller` in the <title> did not match "Müller" from the field: both passed with ✓
 * (2026-11-07 review).
 */
const asText = (html: string) =>
  translate(html)
    // A legacy entity with no ";" (`M&uumlller`): a browser still decodes the longest name it
    // knows. Decoding more than a browser would can only find more, the safe direction for a
    // residue check (2026-11-07 review 4: `&auml` without ";" passed with ✓).
    .replace(/&([A-Za-z][A-Za-z0-9]*)(?!;)/g, (m, name: string) => {
      for (let n = name.length; n > 1; n--) {
        const decoded = translate(`&${name.slice(0, n)};`);
        if (decoded !== `&${name.slice(0, n)};`) return decoded + name.slice(n);
      }
      return m;
    })
    // One form for both sides: "Müller" typed decomposed (u + U+0308) did not match "Müller", and
    // a full-width "Ｍüller" is the same name to a reader.
    .normalize("NFKC");

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

/**
 * Every `Label:  [mathin]\text{  }[mathin]value<br>` row of the block: [label, value]. A label is
 * any text up to its colon -- digits and punctuation included (`Job No.:`, `Client #:`): it used to
 * be `[A-Z][A-Za-z ]`, so a filled row with such a label was never seen, and passed (2026-11-06,
 * review 2).
 */
const LABEL = String.raw`[^<>:\n]{1,60}`;
const SPACER = String.raw`\[[a-z]+\]\\text\{[^}]*\}\[[a-z]+\]`;
const FIELD_ROW = new RegExp(String.raw`(${LABEL}):\s*${SPACER}([\s\S]*?)<br\b`, "g");

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
 * Matches `Label:` plus the inline-maths spacer, then the WHOLE value: up to the `<br>` that
 * starts the next field ROW (a label in the template's own layout -- `Label:` and the spacer) or
 * to the end of the block (`</td>`, `</p>`, …). It used to stop at the first `<br>`, so notes
 * split by `<br>` (client / job number / scope) were scrubbed to their first line and the rest
 * passed the residue check unseen -- it only looks for what was removed (2026-11-06 review).
 * The next row is recognised by the spacer, so a line inside the value that merely LOOKS like a
 * label ("Ref: 4471") does not end it early.
 */
// The REAL row only (2026-11-06, review 2): the label as written (case kept), at the start of a
// row (after a tag or a line break), and WITH the template's spacer. It used to match the first
// "designer:" anywhere, any case, spacer optional -- so a "Designer: per contract" line above the
// block was rewritten and the real name stayed, unseen by a residue check that looks only for
// what it removed. The caller also requires exactly one such row.
function fieldPattern(label: string, flags = ""): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextRow = String.raw`<br\s*/?>(?=\s*${LABEL}:\s*${SPACER})`;
  const blockEnd = String.raw`<\/(?:td|th|p|div|li|tr|table)\s*>`;
  return new RegExp(
    `((?:^|(?<=[>\\n]))[ \\t]*${escaped}:\\s*${SPACER})([\\s\\S]*?)(${nextRow}|${blockEnd})`,
    flags,
  );
}

/**
 * The "Project details" block: from its heading to the end of the cell or block holding it (the
 * template: `<h3>Project details</h3>Date: …<br>…Project Units: …<br></td>`). null if absent.
 */
function projectDetailsBlock(html: string): string | null {
  const head = /<h[1-6][^>]*>\s*Project details\s*<\/h[1-6]\s*>/i.exec(html);
  if (!head) return null;
  const from = head.index + head[0].length;
  const end = /<\/(?:td|th|div|table|section)\s*>/i.exec(html.slice(from));
  return html.slice(from, end ? from + end.index : html.length);
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
  let refused = false;

  for (const { label, value } of REPLACEMENTS) {
    const pattern = fieldPattern(label);
    const match = out.match(pattern);
    const rows = (out.match(fieldPattern(label, "g")) ?? []).length;

    if (!match || rows !== 1) {
      // Not "nothing to do" — the field this script exists to remove is missing (or there are
      // two, and which is real cannot be told), so the template changed or the pattern is wrong.
      // The WHOLE FILE is refused: a `continue` here once went on to the next field and wrote the
      // file with this one unscrubbed, under "Nothing partial was shipped" (2026-11-06, review 2).
      console.error(
        rows > 1
          ? `❌ ${name}: ${rows} "${label}:" rows — refusing: which one is the real field?`
          : `❌ ${name}: no "${label}:" field found — refusing to sanitize blind`,
      );
      refused = true;
      break;
    }

    // The value's TEXT, for the residue check: a multi-line value carries its <br> tags, and "br"
    // checked as a word refused every such file -- <br> is everywhere. Entities DECODED, not
    // blanked: blanked, a name written as references left no word to look for.
    removed.push(asText(match[2].replace(/<[^>]*>/g, " ")));
    out = out.replace(pattern, `$1${value}$3`);
  }
  if (refused) {
    failures++;
    continue;
  }

  // Every "Label:" left in the Project-details block, whatever its markup -- `<b>Company</b>:`, a
  // row without the spacer -- must be one the strict pattern read: a filled row in another shape was
  // never looked at, and its value was copied into tests/ with ✓ (2026-11-07 review; the #45
  // class, per field). Read on the SCRUBBED block, so a line inside a removed value ("Ref: 4471"
  // in the notes) is gone already; any other label the strict pattern did not read is refused.
  const block = projectDetailsBlock(out);
  if (block === null) {
    console.error(`❌ ${name}: no "Project details" block found — refusing to sanitize blind.`);
    failures++;
    continue;
  }
  // ROW by row, not label by label (2026-11-07 review 4): a second `<b>Client</b>:` row passed
  // because "client" was a label already read, and so did a Client whose first line was blank
  // (the rest on the lines after it, which carry no colon), and any line without one. Now every
  // non-empty row must be one field row, each label once: a scrubbed field holding its
  // placeholder, a kept field, or any other field EMPTY.
  const placeholder = new Map(REPLACEMENTS.map((r) => [r.label.toLowerCase(), r.value]));
  const labelsSeen = new Set<string>();
  let strange = 0;
  for (const raw of block.split(/<br\s*\/?>/i)) {
    const row = asText(raw.replace(/<[^>]*>/g, "")).trim();
    if (row === "") continue;
    const m = new RegExp(String.raw`^([^:\n]{1,60}):\s*(?:${SPACER})?\s*([\s\S]*)$`).exec(row);
    const label = m?.[1].trim().toLowerCase() ?? "";
    const value = m?.[2].trim() ?? "";
    const ok =
      m !== null &&
      !labelsSeen.has(label) &&
      (placeholder.has(label)
        ? value === placeholder.get(label)
        : KEPT_FIELDS.has(label) || (seen.has(label) && value === ""));
    labelsSeen.add(label);
    if (!ok) strange++;
  }
  if (strange > 0) {
    console.error(
      `❌ ${name}: ${strange} row(s) of the project-details block are not in the template's ` +
        `layout, so their values cannot be checked — refusing.`,
    );
    failures++;
    continue;
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
  // Searched in the written file as TEXT (entities decoded): `M&uuml;ller` is Müller to a reader.
  const outText = asText(out);
  const survivors = tokens.filter((t) => wholeWord(t).test(outText));

  // Counted, never printed: the survivors and the removed values ARE the client's data, and printing
  // them put a project name and a designer in the terminal and every session transcript
  // (known-issues: "count such fields with a script that prints only filled/empty").
  if (survivors.length > 0) {
    console.error(`❌ ${name}: ${survivors.length} removed term(s) still present elsewhere.`);
    console.error("   The field was rewritten but the value appears elsewhere in the document.");
    failures++;
    continue;
  }

  const summary = `${removed.length} field value(s)`;
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
