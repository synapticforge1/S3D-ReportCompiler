// Same idea, but with delimiters that do not collide with LaTeX syntax:
//   display  @@ .. @@      inline  %% .. %%
const src = await Deno.readTextFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
);
const outDir = Deno.args[0];
await Deno.mkdir(outDir, { recursive: true });

let v = src
  .replace("['[mathin]', '[mathin]']", "['%%','%%']")
  .replace("['[math]', '[math]']", "['@@','@@']");

if (v === src) throw new Error("config edit did not apply");

v = v.replace(/\[mathin\]([\s\S]*?)\[mathin\]/g, (_m, b) => `%%${b}%%`);
v = v.replace(/\[math\]([\s\S]*?)\[math\]/g, (_m, b) => `@@${b}@@`);

await Deno.writeTextFile(`${outDir}/d_report.html`, v);
console.log("config declares @@..@@ (display) and %%..%% (inline)");
