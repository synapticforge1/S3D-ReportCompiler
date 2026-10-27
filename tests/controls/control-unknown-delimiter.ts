// A report using a delimiter this script cannot know about: the tex2jax config
// is removed and display math is wrapped in @@..@@. Nothing should match, so
// the LaTeX must survive baking -- which the guard has to catch.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url), "utf8");
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });

let v = src.replace(/\[math\]([\s\S]*?)\[math\]/g, (_m, b) => `@@${b}@@`);
v = v.replace(/<script type="text\/x-mathjax-config">[\s\S]*?<\/script>/i, "");

await writeFile(`${outDir}/x_report.html`, v);
console.log(`config removed: ${!/tex2jax/.test(v)}`);
console.log(`@@ delimiters:  ${(v.match(/@@/g) ?? []).length}`);
