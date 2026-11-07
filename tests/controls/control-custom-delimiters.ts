// Same idea, but with delimiters that do not collide with LaTeX syntax:
//   display  @@ .. @@      inline  %% .. %%
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
  "utf8",
);
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });

// Every edit checked on its own: one that failed while another applied used to pass as "the
// config was edited", and the control quietly became a different one (2026-11-06 review).
const must = (before: string, after: string, what: string) => {
  if (after === before) throw new Error(`${what} did not apply`);
  return after;
};
let v = must(src, src.replace("['[mathin]', '[mathin]']", "['%%','%%']"), "the inline config edit");
v = must(v, v.replace("['[math]', '[math]']", "['@@','@@']"), "the display config edit");
v = must(
  v,
  v.replace(/\[mathin\]([\s\S]*?)\[mathin\]/g, (_m, b) => `%%${b}%%`),
  "the inline rewrite",
);
v = must(
  v,
  v.replace(/\[math\]([\s\S]*?)\[math\]/g, (_m, b) => `@@${b}@@`),
  "the display rewrite",
);
if (/\[math(?:in)?\]/.test(v)) throw new Error("a [math]/[mathin] delimiter survived");

await writeFile(`${outDir}/d_report.html`, v);
console.log("config declares @@..@@ (display) and %%..%% (inline)");
