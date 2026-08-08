// verify-pdf-text.ts
//
// Dump what text a PDF actually contains, page by page. The standalone
// precursor to the verification now built into compiled_reports.ts, kept
// because it is the simplest way to inspect an arbitrary PDF.
//
//   deno run -A cmem/controls/verify-pdf-text.ts [file.pdf]
//
// Defaults to the build output.

import * as pdfjs from "npm:pdfjs-dist@4.6.82/legacy/build/pdf.mjs";

const target = Deno.args[0]
  ? new URL(Deno.args[0], `file://${Deno.cwd().replace(/\\/g, "/")}/`)
  : new URL("../CompiledPDF/combined_report.pdf", import.meta.url);

const doc = await pdfjs.getDocument({
  data: await Deno.readFile(target),
  useSystemFonts: true,
}).promise;

console.log("pages:", doc.numPages);

const headings: string[] = [];
let totalChars = 0;

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();
  const text = content.items.map((i: any) => i.str ?? "").join(" ");
  totalChars += text.length;

  const m = text.match(/MEMBER\s*#\s*(\d+)\s*DESIGN REPORT/i);
  if (m) headings.push(`p${p}: MEMBER #${m[1]}`);

  if (p === 1) console.log("--- page 1 sample ---\n" + text.slice(0, 400) + "\n---");
}

console.log("total extracted chars:", totalChars);
console.log("report headings found:", headings.length);
console.log(headings.join("\n"));
