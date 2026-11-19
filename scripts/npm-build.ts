/**
 * Builds the npm copy of the package into dist/ (roadmap task 15; owner, 2026-10-28: "jsr remains
 * the same, npm is on synapticforge1"). JSR stays `@jrmarcum/s3d-reportcompiler`, published from
 * the TypeScript sources; npm gets `@synapticforge1/s3d-reportcompiler`, built here.
 *
 *   bun run npm:build      then   bun run npm:prove   (nothing here publishes)
 *
 * Why a build: Node will not strip types inside node_modules, so an npm package must ship compiled
 * JavaScript; the `.d.ts` files carry the types. JSR does this for its own npm layer; npm does not.
 *
 * The manifest is GENERATED, so the version has one source (jsr.json): name, version, the exports map rewritten to the compiled files, a `bin`
 * (npm can run a CLI through `npx`; JSR cannot), the runtime dependencies exactly as package.json
 * pins them, and the Node floor taken from pdfjs-dist's own `engines`.
 *
 * Uses node: builtins; runs TypeScript's `tsc` from node_modules.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The npm name lives with the registry lookups, so verify-release checks the name this publishes.
import { NPM_NAME } from "./jsr-api.ts";

const REPO_URL = "https://github.com/synapticforge1/S3D-ReportCompiler";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const json = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

/** Every file under `dir`, recursively. */
function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function fail(msg: string): never {
  console.error(`❌ npm:build: ${msg}`);
  process.exit(1);
}

const jsr = json("jsr.json");
const pkg = json("package.json");

// 0. One dependency set, two declarations: npm gets package.json's `dependencies`, JSR resolves
// jsr.json's `imports`. Nothing compared them (2026-11-06 review), so a bump in one would ship the
// two registries different MathJax / pdf.js / pdf-lib under one version. Both directions, exact;
// first, before anything is built.
{
  const imports = Object.values(jsr.imports as Record<string, string>)
    .map((spec) => /^npm:((?:@[^/]+\/)?[^@/]+)@([^/]+)\/?$/.exec(spec))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2]] as const);
  const deps = Object.entries((pkg.dependencies ?? {}) as Record<string, string>);
  const fromJsr = new Map(imports);
  const mismatch = [
    ...deps
      .filter(([n, v]) => fromJsr.get(n) !== v)
      .map(([n, v]) => `${n}: package.json ${v}, jsr.json ${fromJsr.get(n) ?? "none"}`),
    ...imports
      .filter(([n]) => !deps.some(([d]) => d === n))
      .map(([n, v]) => `${n}: jsr.json ${v}, package.json none`),
  ];
  if (mismatch.length > 0) {
    fail(`jsr.json and package.json disagree on a dependency:\n  ${mismatch.join("\n  ")}`);
  }
}

// 1. Compile.
rmSync(dist, { recursive: true, force: true });
const tsc = spawnSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.npm.json"],
  {
    cwd: root,
    encoding: "utf8",
  },
);
if (tsc.status !== 0) fail(`tsc exited ${tsc.status}\n${tsc.stdout}${tsc.stderr}`);

// 2. The CLI runs under Node from npm: its shebang must say so (the source's says Deno).
const mainJs = join(dist, "main.js");
const main = readFileSync(mainJs, "utf8");
writeFileSync(mainJs, `#!/usr/bin/env node\n${main.replace(/^#![^\n]*\n/, "")}`);

// 3. The manifest.
const pdfjsEngines = json("node_modules/pdfjs-dist/package.json").engines?.node;
const floor = /^>=\s*(\d+\.\d+\.\d+)/.exec(String(pdfjsEngines ?? ""))?.[1];
if (!floor)
  fail(`cannot read a Node floor from pdfjs-dist's engines: ${JSON.stringify(pdfjsEngines)}`);

const exportsMap: Record<string, { types: string; default: string }> = {};
for (const [spec, path] of Object.entries(jsr.exports as Record<string, string>)) {
  const js = String(path).replace(/\.ts$/, ".js");
  exportsMap[spec] = { types: js.replace(/\.js$/, ".d.ts"), default: js };
}

const manifest = {
  name: NPM_NAME,
  version: jsr.version,
  description: pkg.description,
  license: jsr.license,
  type: "module",
  exports: exportsMap,
  types: exportsMap["."].types,
  // No "./": npm 12's `npm publish` calls "./main.js" an invalid bin and DROPS it (measured
  // 2026-10-28, dry run), while `npm pack` and an install from the tarball keep it.
  bin: { "s3d-reportcompiler": "main.js" },
  files: [
    "main.js",
    "main.d.ts",
    "src/",
    "fonts/",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
  ],
  dependencies: pkg.dependencies,
  engines: { node: `>=${floor}` },
  repository: { type: "git", url: `git+${REPO_URL}.git` },
  homepage: `${REPO_URL}#readme`,
  bugs: { url: `${REPO_URL}/issues` },
  keywords: ["skyciv", "pdf", "structural", "aisc", "report", "mathjax", "verification"],
  publishConfig: { access: "public", provenance: true },
};
writeFileSync(join(dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// 4. Licence and notices travel with every copy (Apache-2.0 §4 for MathJax and pdf.js).
for (const f of ["README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"]) {
  if (!existsSync(join(root, f))) fail(`${f} is missing`);
  copyFileSync(join(root, f), join(dist, f));
}

// 5. The native renderer's fonts, with their licence (SIL OFL 1.1 requires it to travel with
// them): `fonts/liberation/` beside `src/`, where `readRenderFonts` looks (`../fonts/` from
// `src/report_runtime.js`).
const fontDir = join(root, "fonts", "liberation");
if (!existsSync(join(fontDir, "LICENSE"))) fail("fonts/liberation/LICENSE is missing");
mkdirSync(join(dist, "fonts", "liberation"), { recursive: true });
for (const f of readdirSync(fontDir)) {
  copyFileSync(join(fontDir, f), join(dist, "fonts", "liberation", f));
}

// 6. The build is byte-reproducible across machines: CI publishes only if its build has the digest
// of the one proven locally (scripts/npm-digest.ts; owner, 2026-11-19, H37 (e)). The repo stores
// text as LF (.gitattributes); a checkout made before that rule kept CRLF (LICENSE on the owner's
// machine, 2026-11-19), and a CR shipped here would differ from a fresh clone's build.
for (const f of walkFiles(dist)) {
  if (/\.(?:ttf|woff2?|otf)$/i.test(f)) continue;
  if (readFileSync(f).includes(0x0d)) {
    fail(
      `${f.slice(root.length)} has a CR: a CRLF checkout. Re-check it out (delete it, then \`git checkout -- <file>\`)`,
    );
  }
}

console.log(
  `✅ dist/ built: ${NPM_NAME}@${manifest.version}, ${Object.keys(exportsMap).length} exports, bin s3d-reportcompiler, node >=${floor}`,
);
