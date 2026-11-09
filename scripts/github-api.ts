/**
 * The GitHub REST API calls the release workflow makes, without the GitHub CLI.
 *
 * 🔒 Owner, 2026-11-08 (workspace letter H30): the GitHub CLI is not installed and will not be, in CI too --
 * check the repo instead, and call GitHub's REST API from a Bun step with `GITHUB_TOKEN`. And
 * (H32, via loader-py's C41, 2026-11-09): the release CI makes its own GitHub Release page, by
 * the same recipe in every project -- the tag must exist and peel to the released commit FIRST
 * (`POST /releases` CREATES a missing tag), an existing page is done with no write, then create
 * and read back.
 *
 * Usage (environment: `GITHUB_REPOSITORY`, `GITHUB_TOKEN`; `GITHUB_API_URL` defaults to
 * GitHub's own, and a test points it at a local stand-in):
 *
 *   bun scripts/github-api.ts commit <ref>           the commit a ref names (exit 2: none)
 *   bun scripts/github-api.ts compare <base> <head>  the compare status ("identical", "behind", ...)
 *   bun scripts/github-api.ts ci-run <sha>           "status conclusion url" of ci.yml's push run, or nothing
 *   bun scripts/github-api.ts release <tag> <sha>    the Release page, by the recipe above
 *
 * No dependency: it runs in jobs that install nothing (a write token never sits beside package
 * code, workspace C30).
 *
 * @module
 */

/** What the calls need from their surroundings, so a test can give its own. */
export type Env = {
  repo: string;
  token: string;
  api: string;
  fetch: typeof fetch;
  log: (s: string) => void;
};

/** A GitHub API answer: its status, and its body as JSON (or null). */
async function call(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await env.fetch(`${env.api.replace(/\/$/, "")}/${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "s3d-reportcompiler-release",
      ...(env.token ? { Authorization: `Bearer ${env.token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** A failure with what GitHub answered. */
class ApiError extends Error {}

const field = (json: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
    json,
  );

/** The commit a ref names; null when there is none (404). Anything else is an error, said. */
export async function commitOf(env: Env, ref: string): Promise<string | null> {
  const r = await call(env, "GET", `repos/${env.repo}/commits/${encodeURIComponent(ref)}`);
  if (r.status === 404 || r.status === 422) return null;
  const sha = field(r.json, "sha");
  if (r.status !== 200 || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new ApiError(`GET commits/${ref}: HTTP ${r.status}`);
  }
  return sha;
}

/** How `head` stands to `base`: "identical", "behind", "ahead", "diverged". */
export async function compareStatus(env: Env, base: string, head: string): Promise<string> {
  const r = await call(
    env,
    "GET",
    `repos/${env.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  const status = field(r.json, "status");
  if (r.status !== 200 || typeof status !== "string")
    throw new ApiError(`GET compare ${base}...${head}: HTTP ${r.status}`);
  return status;
}

/** The newest PUSH run of ci.yml on a commit: "status conclusion url", or "" when none yet. */
export async function ciRun(env: Env, sha: string): Promise<string> {
  const r = await call(
    env,
    "GET",
    `repos/${env.repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=1`,
  );
  if (r.status !== 200) throw new ApiError(`GET ci.yml runs for ${sha}: HTTP ${r.status}`);
  const run = (field(r.json, "workflow_runs") as unknown[] | undefined)?.[0];
  if (!run) return "";
  return `${field(run, "status")} ${field(run, "conclusion") ?? "none"} ${field(run, "html_url")}`;
}

/** The commit a tag peels to (an annotated tag followed to its commit); null when there is no tag. */
export async function tagCommit(env: Env, tag: string): Promise<string | null> {
  const r = await call(env, "GET", `repos/${env.repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new ApiError(`GET git/ref/tags/${tag}: HTTP ${r.status}`);
  let type = field(r.json, "object", "type");
  let sha = field(r.json, "object", "sha");
  for (let hops = 0; type === "tag" && hops < 5; hops++) {
    const t = await call(env, "GET", `repos/${env.repo}/git/tags/${sha}`);
    if (t.status !== 200) throw new ApiError(`GET git/tags/${sha}: HTTP ${t.status}`);
    type = field(t.json, "object", "type");
    sha = field(t.json, "object", "sha");
  }
  if (type !== "commit" || typeof sha !== "string")
    throw new ApiError(`tag ${tag} does not peel to a commit`);
  return sha;
}

/**
 * The Release page for `tag`, by the recipe every project follows (H32): the tag exists and peels
 * to `sha` (else refuse: creating the page would create or bless the wrong tag); a page already
 * there is done, with no write; else create it with generated notes and the registry links on
 * top, then read it back and check the tag again.
 */
export async function release(
  env: Env,
  tag: string,
  sha: string,
  version: string,
): Promise<"exists" | "created"> {
  const at = await tagCommit(env, tag);
  if (at === null)
    throw new ApiError(`no tag ${tag} -- refusing: creating its Release would create the tag`);
  if (at !== sha) throw new ApiError(`${tag} peels to ${at}, not the released ${sha} -- refusing`);
  const existing = await call(
    env,
    "GET",
    `repos/${env.repo}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (existing.status === 200) {
    env.log(`the GitHub Release ${tag} already exists -- nothing written`);
    return "exists";
  }
  if (existing.status !== 404)
    throw new ApiError(`GET releases/tags/${tag}: HTTP ${existing.status}`);
  const body =
    `**JSR:** https://jsr.io/@jrmarcum/s3d-reportcompiler@${version} · ` +
    `**npm:** https://www.npmjs.com/package/@synapticforge1/s3d-reportcompiler/v/${version}`;
  const made = await call(env, "POST", `repos/${env.repo}/releases`, {
    tag_name: tag,
    name: tag,
    body,
    generate_release_notes: true,
    draft: false,
    prerelease: false,
  });
  if (made.status !== 201) throw new ApiError(`POST releases (${tag}): HTTP ${made.status}`);
  // Read it back, and the tag again: the page must name this tag, and the tag must not have moved.
  const back = await call(env, "GET", `repos/${env.repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (
    back.status !== 200 ||
    field(back.json, "tag_name") !== tag ||
    field(back.json, "draft") === true
  ) {
    throw new ApiError(`the Release ${tag} does not read back (HTTP ${back.status})`);
  }
  const again = await tagCommit(env, tag);
  if (again !== sha) throw new ApiError(`${tag} moved to ${again} while its Release was made`);
  env.log(`created the GitHub Release ${tag} (${field(back.json, "html_url")})`);
  return "created";
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const env: Env = {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
    api: process.env.GITHUB_API_URL ?? "https://api.github.com",
    fetch,
    log: (s) => console.log(s),
  };
  const usage = () => {
    console.error(
      "usage: bun scripts/github-api.ts commit <ref> | compare <base> <head> | ci-run <sha> | release <tag> <sha>",
    );
    process.exit(64);
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.repo)) {
    console.error("GITHUB_REPOSITORY must be owner/name");
    process.exit(64);
  }
  try {
    if (command === "commit" && args.length === 1) {
      const sha = await commitOf(env, args[0]);
      if (sha === null) process.exit(2);
      console.log(sha);
    } else if (command === "compare" && args.length === 2)
      console.log(await compareStatus(env, args[0], args[1]));
    else if (command === "ci-run" && args.length === 1) console.log(await ciRun(env, args[0]));
    else if (command === "release" && args.length === 2) {
      await release(env, args[0], args[1], args[0].replace(/^v/, ""));
    } else usage();
  } catch (e) {
    console.error(`::error::${(e as Error).message}`);
    process.exit(1);
  }
}
