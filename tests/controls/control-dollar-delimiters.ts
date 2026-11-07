// Build a two-report set where the second uses a different (but equally valid)
// template: display math via $$..$$ instead of [math]..[math], and a renamed
// wrapper id.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const srcFile = new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url);
const outDir = process.argv[2];

await mkdir(outDir, { recursive: true });
const src = await readFile(srcFile, "utf8");

await writeFile(`${outDir}/a_report.html`, src);

// Each edit checked, and the config edited ON PURPOSE: the body rewrite below used to match the
// config's own ['[math]', '[math]'] first and turn it into ['$$', '$$'] by accident -- which is
// what made the two reports' delimiter sets differ (2026-11-06 review). Now: the config drops its
// [math] pair (this template declares $$ and \[..\] only), and only the body is rewritten.
// The pair is the last in displayMath: removed with the comma before it.
const configPair = /,\s*\['\[math\]', '\[math\]'\]/;
const configEdited = src.replace(configPair, "");
if (configEdited === src) throw new Error("the sample's config has no ['[math]', '[math]'] pair");
const bodyAt = configEdited.search(/<body\b/i);
if (bodyAt < 0) throw new Error("the sample has no <body>");
const head = configEdited.slice(0, bodyAt);
const body = configEdited
  .slice(bodyAt)
  .replace(/\[math\]([\s\S]*?)\[math\]/g, (_m, b) => `$$${b}$$`);
if (/\[math\]/.test(body)) throw new Error("a [math] expression survived the rewrite");
if (body === configEdited.slice(bodyAt)) throw new Error("no [math] expression to rewrite");
let variant = head + body;
const renamed = variant
  .replace(/id="report"/g, 'id="calcreport"')
  .replace(/#report\b/g, "#calcreport");
if (renamed === variant) throw new Error("no report id to rename");
variant = renamed;

await writeFile(`${outDir}/b_report.html`, variant);

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
console.log(
  `a_report: [math] delims=${count(src, /\[math\]/g)}  [mathin]=${count(src, /\[mathin\]/g)}`,
);
console.log(
  `b_report: [math] delims=${count(variant, /\[math\]/g)}  $$ delims=${count(variant, /\$\$/g)}`,
);
