// The sample with its stylesheets written the other ways HTML allows:
//   - every head <style> as <style type="text/css"> (the same sheet to a browser);
//   - the diagram's <style> likewise, its font-family quoted ("Arial", sans-serif);
//   - one extra head block, <style media="print">, which must stay conditional.
// Before 2026-11-05 the bake matched only a bare <style>: the head sheets were
// dropped without a warning (the audit counters fell to 0) and a quoted value
// ended the hoisted SVG attribute early. The content is unchanged, so the build
// must PASS with the baseline's audit counts.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
  "utf8",
);
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });

let v = src.replace(/<style>/g, '<style type="text/css">');
const typed = (v.match(/<style type="text\/css">/g) ?? []).length;
if (typed < 3) throw new Error(`expected the sample's 3 <style> blocks, found ${typed}`);

const quoted = v.replace(/font-family:\s*sans-serif;/, 'font-family: "Arial", sans-serif;');
if (quoted === v) throw new Error("no SVG font-family to quote");
v = quoted.replace(
  "</head>",
  '<style media="print">.ctl-print-only { color: black; }</style>\n</head>',
);

await writeFile(`${outDir}/t_report.html`, v);
console.log(
  `${typed} <style type="text/css"> blocks, a quoted SVG font-family, one media="print" block`,
);
