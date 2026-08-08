// report_runtime.ts
//
// The only file that knows which runtime it is running on.
//
// Deno, Node and Bun all implement the node: builtins used here, so they share
// one implementation rather than getting three. The builtins are imported
// lazily, because a browser has neither a filesystem nor a way to spawn a
// process and would fail on a static import of node:fs.
//
// What a browser can and cannot do:
//   CAN     bake reports into one printable document (report_core.ts is pure)
//   CAN     print that document -- it is already inside a browser engine
//   CANNOT  read a folder, launch a second browser, or repack a PDF on disk
//
// So the browser path is "bake, then hand the HTML to the page", which
// browserBake() below exists to make explicit rather than leaving it implied.

export type Runtime = "deno" | "bun" | "node" | "browser";

declare const Deno: { version?: { deno?: string } } | undefined;
declare const Bun: { version?: string } | undefined;

export const RUNTIME: Runtime = (() => {
  // Bun is checked before Node: it also defines process.versions.node.
  if (typeof Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined") return "deno";
  if (typeof process !== "undefined" && process.versions?.node) return "node";
  return "browser";
})();

export const isBrowser = RUNTIME === "browser";

function requireHost(what: string): void {
  if (isBrowser) {
    throw new Error(
      `${what} is not available in a browser. Bake with report_core.ts and ` +
        `print the result, or run the full pipeline on Deno, Node or Bun.`,
    );
  }
}

// --------------------------------------------------------------------------
// Filesystem
// --------------------------------------------------------------------------

type FsModule = typeof import("node:fs/promises");
type PathModule = typeof import("node:path");

let fsPromise: Promise<FsModule> | null = null;
let pathPromise: Promise<PathModule> | null = null;

async function fs(): Promise<FsModule> {
  requireHost("Filesystem access");
  fsPromise ??= import("node:fs/promises");
  return await fsPromise;
}

async function pathMod(): Promise<PathModule> {
  requireHost("Path handling");
  pathPromise ??= import("node:path");
  return await pathPromise;
}

export async function readTextFile(file: string): Promise<string> {
  return await (await fs()).readFile(file, "utf8");
}

export async function readFile(file: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fs()).readFile(file));
}

export async function writeFile(file: string, data: Uint8Array | string): Promise<void> {
  await (await fs()).writeFile(file, data);
}

export async function listFiles(dir: string): Promise<string[]> {
  const entries = await (await fs()).readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    return (await (await fs()).stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await (await fs()).stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function mkdirp(dir: string): Promise<void> {
  await (await fs()).mkdir(dir, { recursive: true });
}

export async function removeQuietly(target: string, recursive = false): Promise<void> {
  try {
    await (await fs()).rm(target, { recursive, force: true });
  } catch {
    // Best effort: a temp directory that will not delete is not a build failure.
  }
}

export async function rename(from: string, to: string): Promise<void> {
  await (await fs()).rename(from, to);
}

export async function makeTempDir(prefix: string): Promise<string> {
  const [f, p, os] = [await fs(), await pathMod(), await import("node:os")];
  return await f.mkdtemp(p.join(os.tmpdir(), prefix));
}

export async function realPath(target: string): Promise<string> {
  return await (await fs()).realpath(target);
}

export function joinPath(...parts: string[]): string {
  // Kept synchronous and separator-agnostic: every runtime here accepts "/" in
  // paths, including Windows, and the alternative is making every call site
  // await a path module for string concatenation.
  return parts.join("/").replace(/\/{2,}/g, "/");
}

export function baseName(file: string): string {
  return file.replace(/^.*[\\/]/, "");
}

/**
 * Absolute form of a path, resolved against the working directory.
 *
 * Not cosmetic: Chrome's `--print-to-pdf` does not resolve a relative path the
 * way the calling process would, and fails with
 * `Failed to write file <path>: The system cannot find the path specified` --
 * on stderr, while still exiting 0. Every path handed to the browser has to be
 * absolute before it gets there.
 */
export async function resolvePath(target: string): Promise<string> {
  if (isBrowser) return target;
  return (await pathMod()).resolve(target);
}

/** file:// URL for a path, encoded so spaces and unicode survive the trip. */
export async function toFileUrl(file: string): Promise<string> {
  const url = await import("node:url");
  return url.pathToFileURL(await realPath(file)).href;
}

/**
 * Current working directory, for defaulting the input and output folders.
 *
 * Deliberately the working directory rather than the directory this module
 * lives in: the tool has to work when it is installed globally or run from a
 * checkout somewhere else, and in both of those cases the script's own location
 * is a cache path with no reports in it. Run it from a subdirectory and the
 * defaults follow you there -- which fails loudly ("No report .html files found
 * in ..."), not silently.
 *
 * Empty in a browser, where the concept does not exist.
 */
export function cwd(): string {
  return isBrowser ? "" : process.cwd();
}

// --------------------------------------------------------------------------
// Process
// --------------------------------------------------------------------------

export function args(): string[] {
  if (isBrowser) return [];
  // Deno and Bun both populate process.argv in the Node layout, so one slice
  // covers all three.
  return process.argv.slice(2);
}

export function env(name: string): string | undefined {
  return isBrowser ? undefined : process.env[name];
}

export function exit(code: number): never {
  if (isBrowser) throw new Error(`exit(${code}) requested in a browser`);
  process.exit(code);
  throw new Error("unreachable");
}

export type RunResult = { code: number; stderr: string };

/** Run a command to completion, capturing stderr. */
export async function run(cmd: string, argv: string[]): Promise<RunResult> {
  requireHost("Launching a browser");
  const { spawn } = await import("node:child_process");

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (e) => resolve({ code: -1, stderr: `${stderr}${e}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

// --------------------------------------------------------------------------
// Browser discovery
// --------------------------------------------------------------------------

export async function findChrome(): Promise<string | null> {
  const fromEnv = env("CHROME_PATH");
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}
