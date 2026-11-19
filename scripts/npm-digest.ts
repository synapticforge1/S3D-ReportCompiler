/**
 * The npm package's digest: one sha256 over every file `bun run npm:build` writes into `dist/`, each
 * named by its path (sorted, `/` separators) and its own sha256. The release proves the package on
 * this machine; `bun run bump` records this digest in `npm-dist.sha256`; CI's npm-build rebuilds the
 * package and publishes it only if its digest is the recorded one, so what ships is the proven bytes
 * without CI running a test (owner, 2026-11-19, letter H37 (e): "Digest match").
 *
 *   bun scripts/npm-digest.ts            print the digest of dist/
 *   bun scripts/npm-digest.ts --check    exit 1 unless dist/ matches npm-dist.sha256
 *   bun scripts/npm-digest.ts --write    write dist/'s digest to npm-dist.sha256
 *   bun scripts/npm-digest.ts --list     print each file's sha256 (to find what differs)
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
/** The recorded digest, committed by `bun run bump`. */
export const DIGEST_FILE = join(root, "npm-dist.sha256");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Each file of `dir` as `[path relative to dir with "/", its sha256]`, sorted by path. */
export function fileHashes(dir: string): [string, string][] {
  return walk(dir)
    .map((p): [string, string] => [
      relative(dir, p).replaceAll("\\", "/"),
      createHash("sha256").update(readFileSync(p)).digest("hex"),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The digest of `dir`: sha256 over its `path  sha256` lines. */
export function digestOf(dir: string): string {
  const lines = fileHashes(dir).map(([p, h]) => `${p}  ${h}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

if (import.meta.main) {
  if (!existsSync(join(dist, "package.json"))) {
    console.error("❌ npm-digest: dist/ is not built — run `bun run npm:build` first");
    process.exit(1);
  }
  const mode = process.argv[2];
  const digest = digestOf(dist);
  if (mode === undefined) {
    console.log(digest);
  } else if (mode === "--list") {
    for (const [p, h] of fileHashes(dist)) console.log(`${h}  ${p}`);
  } else if (mode === "--write") {
    writeFileSync(DIGEST_FILE, `${digest}\n`);
    console.log(`npm-dist.sha256 ← ${digest}`);
  } else if (mode === "--check") {
    if (!existsSync(DIGEST_FILE)) {
      console.error("❌ npm-digest: no npm-dist.sha256 — `bun run bump` records it");
      process.exit(1);
    }
    const recorded = readFileSync(DIGEST_FILE, "utf8").trim();
    if (recorded !== digest) {
      console.error(
        `❌ npm-digest: dist/ is ${digest}, the proven package was ${recorded} — refusing`,
      );
      process.exit(1);
    }
    console.log(`✅ npm-digest: dist/ is the proven package (${digest})`);
  } else {
    console.error(`npm-digest: unknown argument ${mode}`);
    process.exit(2);
  }
}
