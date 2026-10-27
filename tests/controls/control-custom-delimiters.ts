// Same idea, but with delimiters that do not collide with LaTeX syntax:
//   display  @@ .. @@      inline  %% .. %%
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url), "utf8");
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });

let v = src
  .replace("['[mathin]', '[mathin]']", "['%%','%%']")
  .replace("['[math]', '[math]']", "['@@','@@']");

if (v === src) throw new Error("config edit did not apply");

v = v.replace(/\[mathin\]([\s\S]*?)\[mathin\]/g, (_m, b) => `%%${b}%%`);
v = v.replace(/\[math\]([\s\S]*?)\[math\]/g, (_m, b) => `@@${b}@@`);

await writeFile(`${outDir}/d_report.html`, v);
console.log("config declares @@..@@ (display) and %%..%% (inline)");
