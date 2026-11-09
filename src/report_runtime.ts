/**
 * @module
 *
 * Host adapter — the only module that knows which runtime it is running on.
 * Filesystem access, process control, and browser discovery.
 *
 * Deno, Node and Bun all implement the `node:` builtins used here, so they
 * share one implementation rather than getting three. Those builtins are
 * imported **lazily**, because a browser has neither a filesystem nor a way to
 * spawn a process and would fail on a static `import "node:fs"`.
 *
 * ⚠️ **Not usable in a browser.** Every function here throws a descriptive
 * error rather than failing obscurely. What a browser can and cannot do:
 *
 * | | Browser |
 * |---|---|
 * | Bake reports into one printable document | ✅ — use the package's default export, which is pure |
 * | Print that document | ✅ — the browser *is* the engine; `window.print()` |
 * | Read a folder, launch a browser, repack a PDF on disk | ❌ |
 *
 * So the browser path is *bake, then hand the HTML to the page*.
 *
 * @example Locate a browser and render
 * ```ts
 * import * as rt from "@jrmarcum/s3d-reportcompiler/runtime";
 *
 * const chrome = await rt.findChrome();
 * if (!chrome) throw new Error("Install Chrome or Edge, or set CHROME_PATH.");
 *
 * const reports = (await rt.listFiles(rt.joinPath(rt.cwd(), "HTMLFilesToBeCompiled")))
 *   .filter((n) => n.toLowerCase().endsWith(".html"));
 * ```
 */

/** The host this module is running on. */
export type Runtime = "deno" | "bun" | "node" | "browser";

declare const Deno: { version?: { deno?: string } } | undefined;
declare const Bun: { version?: string } | undefined;

/**
 * The detected host, resolved once at module load.
 *
 * ⚠️ Bun is checked before Node because Bun also defines
 * `process.versions.node`; testing for Node first would misreport it.
 */
export const RUNTIME: Runtime = (() => {
  if (typeof Bun !== "undefined") return "bun";
  if (typeof Deno !== "undefined") return "deno";
  if (typeof process !== "undefined" && process.versions?.node) return "node";
  return "browser";
})();

/**
 * True when there is no filesystem or process to reach.
 *
 * Every I/O function below throws a descriptive error in this case rather than
 * failing obscurely on a missing `node:` builtin.
 */
export const isBrowser: boolean = RUNTIME === "browser";

/** Throw a descriptive error if this is a browser, where `what` cannot work. */
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

/** `node:fs/promises`, imported lazily and memoised. Throws in a browser. */
async function fs(): Promise<FsModule> {
  requireHost("Filesystem access");
  fsPromise ??= import("node:fs/promises");
  return await fsPromise;
}

/** `node:path`, imported lazily and memoised. Throws in a browser. */
async function pathMod(): Promise<PathModule> {
  requireHost("Path handling");
  pathPromise ??= import("node:path");
  return await pathPromise;
}

/** Read a UTF-8 text file. */
export async function readTextFile(file: string): Promise<string> {
  return await (await fs()).readFile(file, "utf8");
}

/** Read a file as raw bytes. */
export async function readFile(file: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fs()).readFile(file));
}

/** Write bytes or text to `file`, replacing it if it exists. */
export async function writeFile(file: string, data: Uint8Array | string): Promise<void> {
  await (await fs()).writeFile(file, data);
}

/**
 * Names of the files directly inside `dir` — regular files, and links that lead to one.
 *
 * One level deep — subdirectories are not descended into and not returned, which is what lets an
 * output folder sit safely inside the folder being scanned for reports. A symbolic link to a file
 * IS a file to everyone who opens it: until 2026-11-06 links were left out, so a report that was a
 * link was missing from the PDF and from both sides of its verification, and the build passed.
 */
export async function listFiles(dir: string): Promise<string[]> {
  const f = await fs();
  const entries = await f.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.isFile()) out.push(e.name);
    else if (e.isSymbolicLink()) {
      try {
        if ((await f.stat(`${dir}/${e.name}`)).isFile()) out.push(e.name);
      } catch {
        // a broken link: not a file (listNames still shows it)
      }
    }
  }
  return out;
}

/**
 * Every entry name directly inside `dir`, whatever it is — so a caller can account for each one
 * {@link listFiles} did not return (a folder, a broken link, a device).
 */
export async function listNames(dir: string): Promise<string[]> {
  return await (await fs()).readdir(dir);
}

/**
 * A file's identity on its filesystem (device and file number), or `null` if it does not exist.
 * Two paths with the same identity are the same file — a hard link included, which no path
 * comparison (real path, case, separators) can see.
 */
export async function fileIdentity(file: string): Promise<string | null> {
  try {
    const s = await (await fs()).stat(file, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

/** True if `file` exists and is a regular file. */
export async function fileExists(file: string): Promise<boolean> {
  try {
    return (await (await fs()).stat(file)).isFile();
  } catch {
    return false;
  }
}

/** True if `dir` exists and is a directory. */
export async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await (await fs()).stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Create `dir` and any missing parents. No error if it already exists. */
export async function mkdirp(dir: string): Promise<void> {
  await (await fs()).mkdir(dir, { recursive: true });
}

/**
 * Delete `target`, ignoring any failure.
 *
 * For cleanup paths only, where not deleting something is not a build failure.
 * Never use it where the deletion is the point.
 */
export async function removeQuietly(target: string, recursive = false): Promise<void> {
  try {
    await (await fs()).rm(target, { recursive, force: true });
  } catch {
    // Best effort: a temp directory that will not delete is not a build failure.
  }
}

/** Move or rename a path. */
export async function rename(from: string, to: string): Promise<void> {
  await (await fs()).rename(from, to);
}

/** Create a uniquely-named temporary directory and return its path. */
export async function makeTempDir(prefix: string): Promise<string> {
  const [f, p, os] = [await fs(), await pathMod(), await import("node:os")];
  return await f.mkdtemp(p.join(os.tmpdir(), prefix));
}

/** Resolve symlinks and `..` segments to a canonical path. */
export async function realPath(target: string): Promise<string> {
  return await (await fs()).realpath(target);
}

/** Join path segments with `/`, collapsing repeated separators. */
export function joinPath(...parts: string[]): string {
  // Kept synchronous and separator-agnostic: every runtime here accepts "/" in
  // paths, including Windows, and the alternative is making every call site
  // await a path module for string concatenation.
  return parts.join("/").replace(/\/{2,}/g, "/");
}

/** The final segment of a path, accepting either separator. */
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

/** The path a file:// URL names (a share's too), percent-escapes decoded. */
export async function fromFileUrl(href: string): Promise<string> {
  const url = await import("node:url");
  return url.fileURLToPath(href);
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

/**
 * Command-line arguments, excluding the executable and script.
 *
 * Deno and Bun both populate `process.argv` in the Node layout, so one slice
 * covers all three. Empty in a browser.
 */
export function args(): string[] {
  if (isBrowser) return [];
  return process.argv.slice(2);
}

/** An environment variable, or `undefined` (always `undefined` in a browser). */
export function env(name: string): string | undefined {
  return isBrowser ? undefined : process.env[name];
}

/** Terminate the process with `code`. Throws in a browser, where it has no meaning. */
export function exit(code: number): never {
  if (isBrowser) throw new Error(`exit(${code}) requested in a browser`);
  process.exit(code);
  throw new Error("unreachable");
}

/** Exit status and captured stderr from a spawned process. */
export type RunResult = { code: number; stderr: string };

/**
 * Run a command to completion, capturing stderr. UNBOUNDED: it waits as long as the command (and
 * anything holding its stderr) lives. To launch a browser, use {@link runWithTimeout}.
 */
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

/** How long stderr may stay open after the process exits before {@link runWithTimeout} settles. */
const EXIT_GRACE_MS = 2_000;

/** {@link RunResult}, and whether the process was killed for outliving its time. */
export type TimedRunResult = RunResult & { timedOut: boolean };

/** The longest delay a timer can hold (2^31 - 1 ms, about 24.8 days); longer ones fire at once. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * {@link run}, bounded by wall-clock time: past `timeoutMs`, or when `signal` aborts, the process
 * AND its children are killed (Chrome runs as a tree), and `timedOut` is true for the timeout.
 * Chrome's `--virtual-time-budget` bounds the page, not the process -- a Chrome stuck on a
 * profile, a dialog or a driver never exited, and neither did the build (2026-11-06).
 *
 * After a kill it resolves when the process EXITS, not when its stderr closes: a helper that
 * inherited the pipe could hold it open, and the build waited on it after its own timeout. A
 * process that exits by itself is given two seconds for its stderr to close; then
 * it resolves with the exit status, and on POSIX the rest of its process group is killed. So `cmd`
 * must be the program that does the work: a launcher script that starts the browser and exits at
 * once resolves before the browser has finished.
 *
 * @param timeoutMs 1 to {@link MAX_TIMEOUT_MS}; a longer delay overflowed the timer, which then
 *                  fired after 1 ms and killed Chrome at once (2026-11-06 review)
 */
export async function runWithTimeout(
  cmd: string,
  argv: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TimedRunResult> {
  requireHost("Launching a browser");
  if (!(timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new RangeError(`timeoutMs must be 1 to ${MAX_TIMEOUT_MS}, not ${timeoutMs}`);
  }
  const { spawn } = await import("node:child_process");
  const windows = typeof process !== "undefined" && process.platform === "win32";

  return await new Promise<TimedRunResult>((resolve) => {
    // Its own process group on POSIX, so the group can be killed whole.
    const child = spawn(cmd, argv, { stdio: ["ignore", "ignore", "pipe"], detached: !windows });
    let stderr = "";
    let timedOut = false;
    let killed = false;
    let settled = false;
    /** The exit status once the process itself has exited, before its stderr has closed. */
    let exited: number | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settle = (r: TimedRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", stop);
      // Our end of a pipe a helper still holds: let go of it, or the event loop waits on it.
      child.stderr?.destroy();
      resolve(r);
    };
    /** What is left of the process's own group, killed (POSIX; its group outlives its leader). */
    function reapGroup() {
      if (windows || child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // the group is already gone
      }
    }
    function stop() {
      if (killed) return;
      killed = true;
      try {
        if (windows && child.pid !== undefined) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // fall through to the direct kill
      }
      child.kill("SIGKILL");
    }
    const timer = setTimeout(() => {
      // It exited in time; only a pipe was still open. Not a timeout (the build would have
      // called a finished PDF "not finished").
      if (exited !== null) return settle({ code: exited, stderr, timedOut: false });
      timedOut = true;
      stop();
    }, timeoutMs);
    if (signal?.aborted) stop();
    signal?.addEventListener("abort", stop);

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (e) => settle({ code: -1, stderr: `${stderr}${e}`, timedOut }));
    child.on("exit", (code) => {
      exited = code ?? -1;
      if (killed) return settle({ code: exited, stderr, timedOut });
      // Exited by itself: `close` follows once every holder of stderr lets go. A helper that
      // inherited the pipe can hold it for as long as it lives, and `exit` never fires again --
      // so the wait was unbounded, the timeout's kill could not reach a tree whose root was gone,
      // and the result then said timedOut for a process that exited 0 (2026-11-07 review). The
      // stderr written so far, and the status, after a short grace.
      // What still holds the pipe then is a helper of a browser that has exited: reaped with its
      // process group on POSIX, where the group outlives its leader (review 4: left running).
      // Windows keeps no tree once the root is gone; its helpers end with the browser.
      grace = setTimeout(() => {
        reapGroup();
        settle({ code: exited ?? -1, stderr, timedOut: false });
      }, EXIT_GRACE_MS);
    });
    // On a close as well (review 5): a member that never held stderr -- a launcher's browser that
    // redirects its own -- outlived a prompt close, free to write after the build had moved on.
    child.on("close", (code) => {
      if (!killed) reapGroup();
      settle({ code: code ?? -1, stderr, timedOut });
    });
  });
}

// --------------------------------------------------------------------------
// Browser discovery
// --------------------------------------------------------------------------

/**
 * Path to an installed Chrome or Edge, or `null` if none was found.
 *
 * `CHROME_PATH` is tried first; the rest are the browsers' standard install locations -- the
 * system ones, Chrome's per-user Windows install (`%LOCALAPPDATA%`, what a user without admin
 * rights gets), and the Linux package and snap names (2026-11-07 review: each was "Could not find").
 */
export async function findChrome(): Promise<string | null> {
  const fromEnv = env("CHROME_PATH");
  const localAppData = env("LOCALAPPDATA");
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ...(localAppData ? [`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}
