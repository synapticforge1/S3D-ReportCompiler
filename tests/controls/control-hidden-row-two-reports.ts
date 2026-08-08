// A report whose content is hidden by a rule the builder does not neutralise.
// The bake step will succeed; only the conservation check can catch this.
const src = await Deno.readTextFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
);
const outDir = Deno.args[0];
await Deno.mkdir(outDir, { recursive: true });

// Two reports: one intact, one with a section suppressed.
await Deno.writeTextFile(`${outDir}/a_report.html`, src);

const hidden = src.replace(
  "</style>",
  "\n#calculations table tr:nth-child(5) { display: none; }\n</style>",
);
if (hidden === src) throw new Error("could not inject the hiding rule");

await Deno.writeTextFile(`${outDir}/b_report.html`, hidden);
console.log("b_report hides one table row via display:none");
