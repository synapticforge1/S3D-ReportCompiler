// A report whose MathJax setup declares delimiters this script has never seen:
//   display  {{ .. }}   (braces are regex metacharacters -- tests escaping)
//   inline   %% .. %%
// The config is edited FIRST so the body rewrite cannot touch it.
const src = await Deno.readTextFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
);
const outDir = Deno.args[0];
await Deno.mkdir(outDir, { recursive: true });

let v = src
  .replace("['[mathin]', '[mathin]']", "['%%','%%']")
  .replace("['[math]', '[math]']", "['{{','}}']");

if (v === src) throw new Error("config edit did not apply");

// Now the delimiters only remain in the report body.
v = v.replace(/\[mathin\]([\s\S]*?)\[mathin\]/g, (_m, b) => `%%${b}%%`);
v = v.replace(/\[math\]([\s\S]*?)\[math\]/g, (_m, b) => `{{${b}}}`);

await Deno.writeTextFile(`${outDir}/c_report.html`, v);

const n = (re: RegExp) => (v.match(re) ?? []).length;
console.log(`config now declares: {{..}} and %%..%%`);
console.log(`body delimiters: {{ =${n(/\{\{/g)}  %% =${n(/%%/g)}  [math] left=${n(/\[math\]/g)}  [mathin] left=${n(/\[mathin\]/g)}`);
