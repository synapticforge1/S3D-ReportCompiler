// verify-pdf-text.ts
//
// Dump what text a PDF actually contains, page by page. The standalone
// precursor to the verification now built into compiled_reports.ts, kept
// because it is the simplest way to inspect an arbitrary PDF.
//
//   bun tests/controls/verify-pdf-text.ts [file.pdf]
//
// Defaults to the build output.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// A relative argument resolves against the working directory, as before; an
// absolute Windows path now works too (the old `new URL(arg, "file://<cwd>/")`
// read `C:` as a URL scheme).
const target = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL("../CompiledPDF/combined_report.pdf", import.meta.url);

const doc = await pdfjs.getDocument({
  // A fresh Uint8Array, not Node's pooled Buffer.
  data: new Uint8Array(await readFile(target)),
  useSystemFonts: true,
}).promise;

console.log("pages:", doc.numPages);

const headings: string[] = [];
let totalChars = 0;

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();
  const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
  totalChars += text.length;

  const m = text.match(/MEMBER\s*#\s*(\d+)\s*DESIGN REPORT/i);
  if (m) headings.push(`p${p}: MEMBER #${m[1]}`);

  if (p === 1) console.log(`--- page 1 sample ---\n${text.slice(0, 400)}\n---`);
}

console.log("total extracted chars:", totalChars);
console.log("report headings found:", headings.length);
console.log(headings.join("\n"));
