// The sample's own expressions, with every relational "<" and ">" written as the
// entities &lt; / &gt; -- valid HTML, and what an editor or exporter that escapes
// text produces. A browser's MathJax reads the decoded text, so the report renders
// exactly as before; the bake must do the same. Before 2026-11-05 it handed TeX
// the raw markup, and "&" (TeX's alignment character) failed every one of them.
// No content is added, so the result must match the baseline.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
  "utf8",
);
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });

let encoded = 0;
const encode = (body: string) =>
  body
    // A "<" that does not open a tag (a tag starts with a letter, "/" or "!").
    .replace(/<(?![a-zA-Z/!])/g, () => {
      encoded++;
      return "&lt;";
    })
    .replace(/(^|[^a-zA-Z"'/-])>/g, (_m, pre) => {
      encoded++;
      return `${pre}&gt;`;
    });

const v = src.replace(
  /\[(mathin|math)\]([\s\S]*?)\[\1\]/g,
  (_m, d, body) => `[${d}]${encode(body)}[${d}]`,
);

if (encoded === 0) throw new Error("no relational < or > found inside an expression");
await writeFile(`${outDir}/e_report.html`, v);
console.log(`${encoded} relational operator(s) inside expressions written as entities`);
