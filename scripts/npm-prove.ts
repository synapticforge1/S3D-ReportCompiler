/**
 * Proves the npm TARBALL, not the tree (roadmap task 15) — the gate an npm publish must pass.
 *
 *   bun run npm:build && bun run npm:prove
 *
 *  1. pack dist/; no TypeScript source ships, and every path the manifest names is in the tarball;
 *     `npm publish --dry-run` takes the manifest without "auto-correcting" it;
 *  2. install the tarball into a scratch project OUTSIDE the repo, as a user would;
 *  3. on the manifest's Node floor, every current Node LTS line (Node's own schedule), Bun, and Deno
 *     with `--deno` (CI passes it; a developer machine has no Deno, owner 2026-10-28):
 *     import `.` and `./runtime`, and run the INSTALLED CLI on the sample reports — it must PASS and
 *     bake the same document, byte for byte, as the source does;
 *  4. `npm exec s3d-reportcompiler -- --version` prints the version;
 *  5. the shipped .d.ts type-check for a consumer;
 *  6. the export list equals JSR's own npm build of this package (an independent reference).
 *
 * A Node version fnm lacks FAILS with the `fnm install` that fixes it; nothing is skipped.
 * `--install-node` installs every needed version first (CI).
 * Needs the network (the tarball's dependencies come from npmjs.org) and Chrome (the CLI renders).
 * Uses node: builtins; npm is run as `node <npm-cli.js>` beside a fnm Node (fnm cannot spawn the
 * Windows `npm.cmd` shim).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const samples = join(root, "tests", "HTMLFilesToBeCompiled");
if (!existsSync(join(dist, "package.json"))) {
  console.error("❌ npm:prove: dist/ is not built — run `bun run npm:build` first");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dist, "package.json"), "utf8"));
const NAME: string = manifest.name;
const NPM_NODE = "24";
const withDeno = process.argv.includes("--deno");
const installNode = process.argv.includes("--install-node");

let failed = 0;
const ok = (good: boolean, what: string, why = "") => {
  if (!good) failed++;
  console.log(`${good ? "✅" : "❌"} ${what}${good || !why ? "" : ` — ${why}`}`);
  return good;
};
const run = (cmd: string, args: string[], cwd: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 << 20 });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
};
const fnmNode = (version: string, args: string[], cwd: string) =>
  run("fnm", ["exec", `--using=${version}`, "--", "node", ...args], cwd);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);

const work = mkdtempSync(join(tmpdir(), "s3d-npm-prove-"));
try {
  const floor = /^>=(\d+\.\d+\.\d+)$/.exec(String(manifest.engines?.node ?? ""))?.[1];
  if (!floor)
    throw new Error(`engines.node must be ">=X.Y.Z": ${JSON.stringify(manifest.engines)}`);
  const schedule = (await (
    await fetch("https://raw.githubusercontent.com/nodejs/Release/main/schedule.json")
  ).json()) as Record<string, { lts?: string; end: string }>;
  const now = Date.now();
  const lines = Object.entries(schedule)
    .filter(
      ([, v]) => v.lts && Date.parse(v.end) >= now && Date.parse(v.lts) <= now + 30 * 86_400_000,
    )
    .map(([k]) => k.slice(1));
  if (installNode) {
    for (const v of new Set([NPM_NODE, floor, ...lines])) {
      const r = run("fnm", ["install", v], work);
      if (r.code !== 0) throw new Error(`fnm install ${v} failed:\n${r.out}`);
    }
  }

  // npm itself: the npm-cli.js beside the chosen Node (Windows layout), or under lib/ (POSIX).
  writeFileSync(join(work, "where.mjs"), "console.log(process.execPath);\n");
  const nodeExe = fnmNode(NPM_NODE, [join(work, "where.mjs")], work).out.trim();
  const npmCli = [
    join(dirname(nodeExe), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(nodeExe), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((p) => existsSync(p));
  if (!npmCli) throw new Error(`npm-cli.js not found beside Node ${NPM_NODE} (${nodeExe})`);
  const npm = (args: string[], cwd: string) => fnmNode(NPM_NODE, [npmCli, ...args], cwd);

  // 1. Pack and inspect.
  const pack = npm(["pack", "--json", "--pack-destination", work], dist);
  if (pack.code !== 0) throw new Error(`npm pack failed:\n${pack.out}`);
  const parsed = JSON.parse(pack.out.slice(pack.out.search(/[[{]/)));
  const info = Array.isArray(parsed) ? parsed[0] : (parsed[NAME] ?? Object.values(parsed)[0]); // npm 10 array, npm 11+ object
  const files: string[] = info.files.map((f: { path: string }) => f.path.replace(/^\.\//, ""));
  const tarball = join(work, info.filename);
  console.log(
    `packed ${info.filename}: ${files.length} files, ${(info.size / 1024).toFixed(0)} KiB`,
  );
  ok(
    files.every((f) => !/\.ts$/.test(f) || /\.d\.ts$/.test(f)),
    "no TypeScript source in the tarball",
    files.filter((f) => /(?<!\.d)\.ts$/.test(f)).join(", "),
  );
  const named = [
    manifest.types,
    ...Object.values(
      manifest.exports as Record<string, { types: string; default: string }>,
    ).flatMap((e) => [e.types, e.default]),
    ...Object.values(manifest.bin as Record<string, string>),
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "README.md",
  ].map((p) => String(p).replace(/^\.\//, ""));
  const absent = named.filter((p) => !files.includes(p));
  ok(absent.length === 0, "every path the manifest names is in the tarball", absent.join(", "));
  const firstLine = readFileSync(
    join(dist, String(manifest.bin["s3d-reportcompiler"])),
    "utf8",
  ).split("\n")[0];
  ok(firstLine === "#!/usr/bin/env node", "the bin runs under Node", firstLine);

  // `npm publish` validates the manifest more strictly than `npm pack` and SILENTLY repairs what it
  // dislikes — it dropped a "./main.js" bin (2026-10-28). A dry run (no registry write) shows it.
  // It runs on a COPY under a throwaway prerelease version: between releases the tree's version is
  // already on npm, and a dry run of it fails "cannot publish over the previously published
  // versions" — on every commit after a release (measured 2026-10-28, after 1.1.4).
  const dryDir = join(work, "dry-run");
  cpSync(dist, dryDir, { recursive: true });
  writeFileSync(
    join(dryDir, "package.json"),
    `${JSON.stringify({ ...manifest, version: `${manifest.version}-prove.0` }, null, 2)}\n`,
  );
  const dry = npm(["publish", "--dry-run", "--access", "public", "--tag", "prove"], dryDir);
  const corrected = dry.out
    .split("\n")
    .filter((l) => /auto-corrected|errors corrected|was invalid and removed/.test(l));
  ok(
    dry.code === 0 && corrected.length === 0,
    "`npm publish --dry-run` accepts the manifest unchanged",
    dry.code === 0 ? corrected.join(" | ") : dry.out.trim().split("\n").slice(-3).join(" | "),
  );

  // 2. Install as a user would.
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "npm-prove-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  const inst = npm(["install", "--no-audit", "--no-fund", tarball], consumer);
  if (
    !ok(
      inst.code === 0,
      `npm install of the tarball (npm on Node ${NPM_NODE})`,
      inst.out.trim().split("\n").slice(-5).join(" | "),
    )
  ) {
    throw new Error("cannot continue without an installed package");
  }

  // The reference: the SOURCE build's baked document.
  const ref = join(work, "ref", "c.pdf");
  const refRun = run("bun", [join(root, "main.ts"), samples, ref], root);
  if (refRun.code !== 0) throw new Error(`the source build failed:\n${refRun.out.slice(-800)}`);
  const refHash = sha(ref.replace(/\.pdf$/, ".html"));

  // 3. Every runtime: the library imports, and the INSTALLED CLI bakes the same document.
  writeFileSync(
    join(consumer, "probe.mjs"),
    [
      `import * as core from ${JSON.stringify(NAME)};`,
      `import * as rt from ${JSON.stringify(`${NAME}/runtime`)};`,
      `console.log(JSON.stringify({ version: core.VERSION, core: Object.keys(core).length, runtime: Object.keys(rt).length, compareEachReport: typeof core.compareEachReport }));`,
      "",
    ].join("\n"),
  );
  const runtimes: Array<[string, (args: string[]) => ReturnType<typeof run>]> = [
    [`node ${floor} (engines floor)`, (a) => fnmNode(floor, a, consumer)],
    ...lines.map((l): [string, (args: string[]) => ReturnType<typeof run>] => [
      `node ${l}`,
      (a) => fnmNode(l, a, consumer),
    ]),
    ["bun", (a) => run("bun", a, consumer)],
    ...(withDeno
      ? [
          ["deno", (a) => run("deno", ["run", "-A", ...a], consumer)] as [
            string,
            (args: string[]) => ReturnType<typeof run>,
          ],
        ]
      : []),
  ];
  if (!withDeno) console.log("·  deno: runs in CI (.github/workflows/ci.yml), not on this machine");
  const cli = join(consumer, "node_modules", ...NAME.split("/"), "main.js");
  const probes = new Set<string>();
  for (const [label, exec] of runtimes) {
    const p = exec(["probe.mjs"]);
    const probe = p.out.trim().split("\n").pop() ?? "";
    let parsedProbe: { version?: string; compareEachReport?: string } = {};
    try {
      parsedProbe = JSON.parse(probe);
    } catch {
      /* reported below */
    }
    ok(
      p.code === 0 &&
        parsedProbe.version === manifest.version &&
        parsedProbe.compareEachReport === "function",
      `${label}: imports \`.\` and \`./runtime\``,
      /version not found|Can't find|ERR_|Error/.test(p.out)
        ? (p.out
            .trim()
            .split("\n")
            .filter((l) => /fnm install|ERR_|Error/.test(l))[0] ?? p.out.slice(-200))
        : probe,
    );
    probes.add(probe);
    const out = join(work, "cli", label.replace(/\W+/g, "-"), "c.pdf");
    const c = exec([cli, samples, out]);
    const html = out.replace(/\.pdf$/, ".html");
    const hash = existsSync(html) ? sha(html) : "none";
    ok(
      c.code === 0 && /PASS: every source word and number present/.test(c.out) && hash === refHash,
      `${label}: the installed CLI PASSES and bakes the source's document (${hash})`,
      c.code === 0
        ? `html ${hash} vs source ${refHash}`
        : c.out.trim().split("\n").slice(-3).join(" | "),
    );
  }
  ok(probes.size === 1, "every runtime sees the same exports", [...probes].join(" vs "));

  // 4. npm exec, as `npx` would. Its STDOUT only: npm 12 writes "npm notice run …" to stderr.
  const ex = npm(["exec", "--no", "--", "s3d-reportcompiler", "--version"], consumer);
  ok(
    ex.code === 0 && ex.stdout.trim() === manifest.version,
    "`npm exec s3d-reportcompiler -- --version`",
    `exit ${ex.code}, stdout ${JSON.stringify(ex.stdout.trim())}`,
  );

  // 5. The shipped types, for a consumer.
  writeFileSync(
    join(consumer, "typed.ts"),
    [
      `import { compareEachReport, VERSION, type PerReportResult } from ${JSON.stringify(NAME)};`,
      `import { isBrowser } from ${JSON.stringify(`${NAME}/runtime`)};`,
      "const r: PerReportResult = compareEachReport([], []);",
      "const v: string = VERSION;",
      "const b: boolean = isBrowser;",
      "export { b, r, v };",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext", target: "es2022", noEmit: true, types: [], skipLibCheck: false, lib: ["es2022", "dom"] }, files: ["typed.ts"] }, null, 2)}\n`,
  );
  const tc = run(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    consumer,
  );
  ok(
    tc.code === 0,
    "the shipped .d.ts type-check for a consumer",
    tc.out.trim().split("\n").slice(0, 4).join(" | "),
  );

  // 6. The export list vs JSR's own npm build of this package.
  const jsrMeta = (await (
    await fetch("https://npm.jsr.io/@jsr/jrmarcum__s3d-reportcompiler")
  ).json()) as {
    "dist-tags": { latest: string };
    versions: Record<string, { dist: { tarball: string } }>;
  };
  const jsrVersion = jsrMeta["dist-tags"].latest;
  const tgz = new Uint8Array(
    await (await fetch(jsrMeta.versions[jsrVersion].dist.tarball)).arrayBuffer(),
  );
  const tar = gunzipSync(tgz);
  let jsrExports: string[] = [];
  for (let pos = 0; pos + 512 <= tar.length;) {
    const name = tar
      .subarray(pos, pos + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(
      tar
        .subarray(pos + 124, pos + 136)
        .toString("utf8")
        .replace(/\0.*$/s, "")
        .trim() || "0",
      8,
    );
    if (name === "package/package.json") {
      jsrExports = Object.keys(
        JSON.parse(tar.subarray(pos + 512, pos + 512 + size).toString("utf8")).exports ?? {},
      ).sort();
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  const ours = Object.keys(manifest.exports).sort();
  ok(
    jsrExports.length > 0 && jsrExports.join() === ours.join(),
    `the export list equals JSR's npm build (@jsr/jrmarcum__s3d-reportcompiler@${jsrVersion})`,
    `JSR [${jsrExports.join(" ")}] vs ours [${ours.join(" ")}]`,
  );
} catch (e) {
  ok(false, "npm:prove could not finish", (e as Error).message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(
  failed
    ? `\n❌ npm:prove: ${failed} problem(s) — do not publish`
    : `\n✅ npm:prove: ${NAME}@${manifest.version} — the tarball is what users get, and it works`,
);
process.exit(failed ? 1 : 0);
