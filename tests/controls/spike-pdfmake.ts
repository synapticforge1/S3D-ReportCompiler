// Spike: can pdfmake run under Deno, and does it handle the three things a
// SkyCiv report actually needs -- a multi-column table, inline SVG, and a
// base64 PNG?
import PdfPrinter from "npm:pdfmake@0.2.20";

// pdfkit's built-in standard-14 fonts avoid shipping any TTF files.
const fonts = {
  Helvetica: {
    normal: "Helvetica",
    bold: "Helvetica-Bold",
    italics: "Helvetica-Oblique",
    bolditalics: "Helvetica-BoldOblique",
  },
};

const src = await Deno.readTextFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
);

const svg = src.match(/<svg[\s\S]*?<\/svg>/)![0];
const png = src.match(/src="(data:image\/png;base64,[^"]*)"/)![1];

const printer = new PdfPrinter(fonts);

const docDefinition = {
  pageSize: "LETTER",
  pageMargins: [36, 36, 36, 36],
  defaultStyle: { font: "Helvetica", fontSize: 9 },
  content: [
    {
      table: {
        headerRows: 1,
        widths: [80, "*", 70],
        body: [
          [
            { text: "REFERENCES", bold: true },
            { text: "CALCULATIONS", bold: true },
            { text: "RESULTS", bold: true },
          ],
          [
            { text: "Code: AISC 360-16 LRFD", italics: true },
            { text: "MEMBER #1 DESIGN REPORT", fontSize: 14, bold: true },
            "",
          ],
          ["Section", { image: png, width: 180 }, ""],
          ["Diagram", { svg, width: 380 }, ""],
        ],
      },
    },
  ],
};

const pdf = printer.createPdfKitDocument(docDefinition as never);

const chunks: Uint8Array[] = [];
pdf.on("data", (c: Uint8Array) => chunks.push(c));

const done = new Promise<void>((resolve, reject) => {
  pdf.on("end", () => resolve());
  pdf.on("error", reject);
});

pdf.end();
await done;

const total = chunks.reduce((n, c) => n + c.length, 0);
const out = new Uint8Array(total);
let offset = 0;
for (const c of chunks) {
  out.set(c, offset);
  offset += c.length;
}

await Deno.writeFile(Deno.args[0], out);
console.log(`OK: wrote ${Deno.args[0]} (${out.length} bytes)`);
