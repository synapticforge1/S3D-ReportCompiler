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
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The npm name (owner, 2026-10-28). The JSR name is unchanged. */
export const NPM_NAME = "@synapticforge1/s3d-reportcompiler";
const REPO_URL = "https://github.com/synapticforge1/S3D-ReportCompiler";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const json = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

function fail(msg: string): never {
  console.error(`❌ npm:build: ${msg}`);
  process.exit(1);
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
const jsr = json("jsr.json");
const pkg = json("package.json");
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
  files: ["main.js", "main.d.ts", "src/", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"],
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

console.log(
  `✅ dist/ built: ${NPM_NAME}@${manifest.version}, ${Object.keys(exportsMap).length} exports, bin s3d-reportcompiler, node >=${floor}`,
);
