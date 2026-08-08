// Build a two-report set where the second uses a different (but equally valid)
// template: display math via $$..$$ instead of [math]..[math], and a renamed
// wrapper id.
const srcFile = new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url);
const outDir = Deno.args[0];

await Deno.mkdir(outDir, { recursive: true });
const src = await Deno.readTextFile(srcFile);

await Deno.writeTextFile(`${outDir}/a_report.html`, src);

let variant = src.replace(/\[math\]([\s\S]*?)\[math\]/g, (_m, body) => `$$${body}$$`);
variant = variant
  .replace(/id="report"/g, 'id="calcreport"')
  .replace(/#report\b/g, "#calcreport");

await Deno.writeTextFile(`${outDir}/b_report.html`, variant);

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
console.log(`a_report: [math] delims=${count(src, /\[math\]/g)}  [mathin]=${count(src, /\[mathin\]/g)}`);
console.log(`b_report: [math] delims=${count(variant, /\[math\]/g)}  $$ delims=${count(variant, /\$\$/g)}`);
