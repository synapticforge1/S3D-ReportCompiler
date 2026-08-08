// A single report with its whole body suppressed by display:none -- a rule the
// builder deliberately does not neutralise. Nothing else can supply the missing
// tokens, so the conservation check has to catch this.
const src = await Deno.readTextFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
);
const outDir = Deno.args[0];
await Deno.mkdir(outDir, { recursive: true });

const hidden = src.replace("</style>", "\n#calculations { display: none; }\n</style>");
if (hidden === src) throw new Error("could not inject the hiding rule");

await Deno.writeTextFile(`${outDir}/h_report.html`, hidden);
console.log("single report, #calculations hidden via display:none");
