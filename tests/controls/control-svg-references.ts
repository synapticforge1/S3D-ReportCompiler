// The sample's diagram, given a gradient, a clip path and an arrowhead marker,
// each used through url(#id) -- in a presentation attribute, an inline style and
// a quoted form. The bake renames every id (r0-...), so every reference has to
// follow; before 2026-11-05 only href="#..." did, and the three silently pointed
// at nothing. Verification counts text and image paints, not paint servers, so
// the build PASSED either way: the test reads the baked HTML.
// A url(#...) naming no id in the report stays untouched.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const src = await readFile(
  new URL("../HTMLFilesToBeCompiled/member_0_report.html", import.meta.url),
  "utf8",
);
const outDir = process.argv[2];
await mkdir(outDir, { recursive: true });

const defs =
  '<defs><linearGradient id="ctl-grad"><stop offset="0" stop-color="#000"/></linearGradient>' +
  '<clipPath id="ctl-clip"><rect width="10" height="10"/></clipPath>' +
  '<marker id="ctl-arrow" markerWidth="4" markerHeight="4"><path d="M0,0 L4,2 L0,4 z"/></marker></defs>' +
  '<rect width="1" height="1" fill="url(#ctl-grad)" clip-path="url(#ctl-clip)"/>' +
  `<line x1="0" y1="0" x2="1" y2="1" style="stroke: url('#ctl-grad'); marker-end: url(#ctl-arrow)"/>` +
  '<rect width="1" height="1" fill="url(#ctl-undefined)"/>' +
  // How a browser serializes an inline-style reference when it saves a page.
  '<rect width="1" height="1" style="clip-path: url(&quot;#ctl-clip&quot;)"/>' +
  // A data attribute that happens to hold an id's name is data, not an id.
  '<g data-id="ctl-grad"></g>' +
  // Unquoted, as HTML allows: the id and the reference to it.
  "<g id=ctl-bare><rect width=1 height=1 /></g><use href=#ctl-bare />";

let v = src.replace(/<svg\b[^>]*>/i, (open) => `${open}${defs}`);
if (v === src) throw new Error("no <svg> to add the references to");

// A reference that is ALREADY dangling in the source, inside the loading spinner the bake
// removes. It sets the trap the reference guard's set comparison exists for: a COUNT of
// unresolved targets (bake vs sources) would let one reference the bake breaks hide behind
// this one, which the bake deletes. With the bake correct it changes nothing.
const trapped = v.replace(
  '<div id="loading">',
  '<div id="loading"><span style="fill: url(#ctl-in-loader)"></span>',
);
if (trapped === v) throw new Error("no loading spinner to plant the dangling reference in");
v = trapped;

await writeFile(`${outDir}/s_report.html`, v);
console.log("diagram references a gradient, a clip path and a marker through url(#id)");
