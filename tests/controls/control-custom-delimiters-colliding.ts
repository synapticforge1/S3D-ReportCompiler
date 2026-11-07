// A report whose MathJax setup declares delimiters this script has never seen:
//   display  {{ .. }}   (braces are regex metacharacters -- tests escaping)
//   inline   %% .. %%
// The config is edited FIRST so the body rewrite cannot touch it.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
  "utf8",
);
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });

// Every edit checked on its own (2026-11-06 review): one failing while the other applied used to
// pass as "the config was edited".
const must = (before: string, after: string, what: string) => {
  if (after === before) throw new Error(`${what} did not apply`);
  return after;
};
let v = must(src, src.replace("['[mathin]', '[mathin]']", "['%%','%%']"), "the inline config edit");
v = must(v, v.replace("['[math]', '[math]']", "['{{','}}']"), "the display config edit");

// Now the delimiters only remain in the report body.
v = must(
  v,
  v.replace(/\[mathin\]([\s\S]*?)\[mathin\]/g, (_m, b) => `%%${b}%%`),
  "the inline rewrite",
);
v = must(
  v,
  v.replace(/\[math\]([\s\S]*?)\[math\]/g, (_m, b) => `{{${b}}}`),
  "the display rewrite",
);
if (/\[math(?:in)?\]/.test(v)) throw new Error("a [math]/[mathin] delimiter survived");

await writeFile(`${outDir}/c_report.html`, v);

const n = (re: RegExp) => (v.match(re) ?? []).length;
console.log(`config now declares: {{..}} and %%..%%`);
console.log(
  `body delimiters: {{ =${n(/\{\{/g)}  %% =${n(/%%/g)}  [math] left=${n(/\[math\]/g)}  [mathin] left=${n(/\[mathin\]/g)}`,
);
