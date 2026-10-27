// A single report with its whole body suppressed by display:none -- a rule the
// builder deliberately does not neutralise. Nothing else can supply the missing
// tokens, so the conservation check has to catch this.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url), "utf8");
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });

const hidden = src.replace("</style>", "\n#calculations { display: none; }\n</style>");
if (hidden === src) throw new Error("could not inject the hiding rule");

await writeFile(`${outDir}/h_report.html`, hidden);
console.log("single report, #calculations hidden via display:none");
