/**
 * Reads what `deno publish` would UPLOAD to JSR and refuses anything but this package, intact
 * (bun-migration step 7). CI runs it (.github/workflows/ci.yml); it needs Deno, so a developer
 * machine does not (owner, 2026-10-28: no Deno on this machine).
 *
 *   bun scripts/jsr-upload-check.ts
 *
 * WHY: an exit code cannot judge a publish. Measured 2026-10-26 on Deno 2.9.8 (cmem/bun-migration.md
 * § "Step 1, measured"): `deno publish --config jsr.json` beside a `deno.json` printed "Successfully
 * published" while rewriting every prefix import (`mathjax-full/…`, `pdfjs-dist/…`) to `./…` — a
 * package that cannot load. Only the uploaded tarball shows that.
 *
 * HOW: a fake JSR on 127.0.0.1 (`JSR_URL`), a dummy `--token`, `--no-provenance`; the tarball it
 * receives is unpacked and checked:
 *   1. its files are exactly what jsr.json `publish.include` names;
 *   2. in every .ts file, each import specifier equals the SOURCE's specifier resolved through
 *      jsr.json `imports` (relative and `node:` specifiers unchanged), in order;
 *   3. with the specifiers masked, every file is byte-identical to the source;
 * and there is no deno.json (step 7's end state).
 * Nothing can reach jsr.io: every request goes to the fake, and the token is not a credential.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "jsr.json"), "utf8")) as {
  name: string;
  version: string;
  imports?: Record<string, string>;
  publish: { include: string[] };
};
const imports = manifest.imports ?? {};

let failed = 0;
const ok = (good: boolean, what: string, why = "") => {
  if (!good) failed++;
  console.log(`${good ? "✅" : "❌"} ${what}${good || !why ? "" : ` — ${why}`}`);
};

// The end state of step 7, pinned: a deno.json beside jsr.json is the layout that corrupted the
// upload silently (C1, C2 in cmem/bun-migration.md), whatever it holds.
ok(
  !existsSync(join(root, "deno.json")),
  "no deno.json beside jsr.json",
  "delete it — see cmem/bun-migration.md § Step 1, measured",
);

// ── the fake registry ────────────────────────────────────────────────────────
const body = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const [scope, pkgName] = manifest.name.replace(/^@/, "").split("/");
const task = {
  id: "fake-task",
  status: "success",
  packageScope: scope,
  packageName: pkgName,
  packageVersion: manifest.version,
  error: null,
};
let upload: Buffer | undefined;
const seen: string[] = [];
const server = createServer(async (req, res) => {
  const url = req.url ?? "";
  const data = await body(req);
  seen.push(`${req.method} ${url}`);
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  // The version must look unpublished, or `deno publish` skips the upload AND exits 0 (measured
  // 2026-10-28: it asks GET …/versions/<v>; answered 200, it uploaded nothing and succeeded).
  if (url.endsWith("/meta.json") || url.endsWith("_meta.json")) return json(404, {});
  if (req.method === "GET" && /\/versions\/[^/?]+$/.test(url)) return json(404, {});
  if (req.method === "POST" && /\/versions\/[^/]+(\?|$)/.test(url)) {
    upload = data;
    return json(200, { ...task, status: "pending" });
  }
  if (url.includes("/publish_status/")) return json(200, task);
  if (url.includes(`/scopes/${scope}/packages/${pkgName}`))
    return json(200, { scope, name: pkgName });
  return json(200, {});
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

// ── publish to it ────────────────────────────────────────────────────────────
const publish = await new Promise<{ code: number; out: string }>((resolve) => {
  const p = spawn(
    "deno",
    // Extra arguments pass through to `deno publish` — how its negative controls run
    // `--config jsr.json` beside a deno.json (cmem/testing.md § JSR upload check).
    [
      "publish",
      "--token",
      "not-a-credential",
      "--no-provenance",
      "--allow-dirty",
      ...process.argv.slice(2),
    ],
    { cwd: root, env: { ...process.env, JSR_URL: `http://127.0.0.1:${port}/` } },
  );
  let out = "";
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (out += c));
  p.on("error", (e) => resolve({ code: -1, out: `${out}${e.message}` }));
  p.on("close", (code) => resolve({ code: code ?? -1, out }));
});
server.close();

ok(publish.code === 0, "`deno publish` to the fake JSR exits 0", publish.out.trim().slice(-600));
if (!upload) {
  console.log(`❌ the fake JSR received no tarball. Requests:\n   ${seen.join("\n   ")}`);
  process.exit(1);
}

// ── unpack ───────────────────────────────────────────────────────────────────
const tar = gunzipSync(upload);
const files = new Map<string, string>();
const field = (pos: number, len: number) =>
  tar
    .subarray(pos, pos + len)
    .toString("utf8")
    .replace(/\0.*$/s, "");
for (let pos = 0; pos + 512 <= tar.length;) {
  const name = field(pos, 100);
  if (!name) break;
  const size = parseInt(field(pos + 124, 12).trim() || "0", 8);
  const prefix = field(pos + 345, 155);
  const type = field(pos + 156, 1);
  const path = (prefix ? `${prefix}/${name}` : name).replace(/^\.?\//, "");
  if (type === "" || type === "0")
    files.set(path, tar.subarray(pos + 512, pos + 512 + size).toString("utf8"));
  pos += 512 + Math.ceil(size / 512) * 512;
}

// 1. The file list.
const expected = new Set<string>();
for (const inc of manifest.publish.include) {
  const m = /^([\w./-]*?)\/?\*(\.\w+)$/.exec(inc);
  if (m) {
    for (const f of readdirSync(join(root, m[1])))
      if (f.endsWith(m[2])) expected.add(`${m[1]}/${f}`);
  } else if (/\*/.test(inc))
    throw new Error(`publish.include pattern this check cannot read: ${inc}`);
  else expected.add(inc);
}
const got = new Set(files.keys());
const missing = [...expected].filter((f) => !got.has(f));
const extra = [...got].filter((f) => !expected.has(f));
ok(
  missing.length === 0 && extra.length === 0,
  `the upload holds exactly publish.include (${expected.size} files)`,
  `missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`,
);

// 2 and 3. Every specifier, and everything else.
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
const specifiers = (src: string) => [...src.matchAll(SPEC)].map((m) => m[3]);
const masked = (src: string) => src.replace(SPEC, (_m, a: string, q: string) => `${a}${q}<>${q}`);
const resolveSpec = (s: string): string => {
  if (/^(\.|\/|node:|npm:|jsr:)/.test(s)) return s;
  // The package's own name appears only in the JSDoc @example blocks, which are not rewritten.
  if (s === manifest.name || s.startsWith(`${manifest.name}/`)) return s;
  if (imports[s]) return imports[s];
  const prefix = Object.keys(imports)
    .filter((k) => k.endsWith("/") && s.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? imports[prefix] + s.slice(prefix.length) : `<UNMAPPED ${s}>`;
};
let rewritten = 0;
for (const [path, text] of files) {
  if (!path.endsWith(".ts")) continue;
  const srcPath = join(root, path);
  if (!existsSync(srcPath)) continue; // reported by the file-list check
  const src = readFileSync(srcPath, "utf8");
  const want = specifiers(src).map(resolveSpec);
  const have = specifiers(text);
  const wrong = want
    .map((w, i) => [w, have[i]] as const)
    .filter(([w, h]) => w !== h)
    .map(([w, h]) => `${h ?? "(none)"} ≠ ${w}`);
  if (have.length !== want.length) wrong.push(`${have.length} specifiers, expected ${want.length}`);
  rewritten += want.filter((w, i) => w !== specifiers(src)[i] && !w.startsWith("<UNMAPPED")).length;
  ok(
    wrong.length === 0,
    `${path}: ${want.length} import specifiers as jsr.json resolves them`,
    wrong.slice(0, 4).join("; "),
  );
  ok(masked(text) === masked(src), `${path}: otherwise byte-identical to the source`);
}
for (const [path, text] of files) {
  if (path.endsWith(".ts") || !existsSync(join(root, path))) continue;
  ok(text === readFileSync(join(root, path), "utf8"), `${path}: byte-identical to the source`);
}
// A run that rewrote nothing proves nothing about the import map.
ok(rewritten > 0, `the import map was exercised (${rewritten} bare specifiers rewritten)`);

console.log(
  failed
    ? `\n❌ jsr-upload-check: ${failed} problem(s) — do NOT tag; the upload is not this package`
    : `\n✅ jsr-upload-check: ${manifest.name}@${manifest.version} uploads intact`,
);
process.exit(failed ? 1 : 0);
