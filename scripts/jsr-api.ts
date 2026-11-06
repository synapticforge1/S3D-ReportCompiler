/**
 * The one JSR version lookup, shared by `publish.ts` (is this version already published?) and
 * `verify-release.ts` (is it attested?). Two copies had already drifted -- one called any 2xx
 * "published", the other parsed the record -- so the URL, the timeout, the test hooks and the
 * three-way answer live here, once (2026-11-05). The npm lookup lives beside it (2026-11-06): one
 * tag releases both, and `verify-release --npm` checks both.
 *
 * Test hooks: `S3D_JSR_API` and `S3D_NPM_API` (base URLs), `S3D_JSR_TIMEOUT_MS`, `S3D_JSR_RETRY_MS`
 * (both registries). They exist so tests/build.test.ts can stand fakes on 127.0.0.1. Fenced, because the release guard
 * reads this: the base URL is honoured ONLY for a loopback host (anything else is refused), every
 * run that uses it says so on stderr, and `publish.ts` never tags while it is set.
 */

/** A version's JSR record, as far as these scripts read it. */
export type VersionInfo = { rekorLogId?: string | null; yanked?: boolean };

/** One look at JSR: the record, a definite "not there" (404), or why it could not tell. */
export type Look = { info: VersionInfo } | { missing: true } | { error: string };

/** The npm name (owner, 2026-10-28; the JSR name is unchanged). One copy: npm-build reads it here. */
export const NPM_NAME = "@synapticforge1/s3d-reportcompiler";

/** A version's npm record, as far as these scripts read it: does npm hold a provenance statement? */
export type NpmInfo = { provenance: boolean };

/** One look at npm, three answers like {@link Look}. */
export type NpmLook = { info: NpmInfo } | { missing: true } | { error: string };

const REAL_API = "https://api.jsr.io";
const REAL_NPM = "https://registry.npmjs.org";

/** A positive integer from the environment, else `fallback` (a typo must not become 0 or NaN). */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not a positive number of milliseconds`);
  }
  return n;
}

/** A base URL, after the fence: `real`, or the loopback test server `hookName` names. */
function fencedBase(hookName: string, real: string, registry: string): string {
  const hook = process.env[hookName];
  if (hook === undefined || hook === "") return real;
  let host: string;
  try {
    host = new URL(hook).hostname;
  } catch {
    throw new Error(`${hookName}=${JSON.stringify(hook)} is not a URL`);
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error(
      `${hookName}=${hook} is not a loopback address. It is a TEST hook; unset it to ask ${registry}.`,
    );
  }
  return hook.replace(/\/+$/, "");
}

const apiBase = () => fencedBase("S3D_JSR_API", REAL_API, "JSR");
const npmBase = () => fencedBase("S3D_NPM_API", REAL_NPM, "npm");

/** True while the test hook redirects the lookup (callers that would tag must refuse). */
export const usingTestApi = (): boolean => apiBase() !== REAL_API;

export const JSR_TIMEOUT_MS = envMs("S3D_JSR_TIMEOUT_MS", 20_000);
export const JSR_RETRY_MS = envMs("S3D_JSR_RETRY_MS", 15_000);

/** `@scope/name` + version → the JSR API URL for that version. */
export function versionUrl(packageName: string, version: string): string {
  const [scope, name] = packageName.replace(/^@/, "").split("/");
  return `${apiBase()}/scopes/${scope}/packages/${name}/versions/${version}`;
}

/**
 * Look the version up once, bounded by the timeout. Only a 404 means "not published"; a 5xx, a
 * 429, a timeout or a network failure is "could not tell" -- callers decide what that means,
 * never by treating it as "not published".
 */
export async function lookupVersion(packageName: string, version: string): Promise<Look> {
  const url = versionUrl(packageName, version);
  if (usingTestApi()) console.error(`  ⚠️ S3D_JSR_API is set: asking ${url}, NOT JSR (test hook)`);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(JSR_TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return { missing: true };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    // A 200 that is not a version record is "could not tell", not "published".
    const body: unknown = await res.json().catch(() => null);
    if (body === null || typeof body !== "object") return { error: "HTTP 200 without a record" };
    return { info: body as VersionInfo };
  } catch (e) {
    return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

/**
 * Look a version up on npm once, the same three ways as {@link lookupVersion}. Provenance is what
 * npm records for a trusted (OIDC) publish: `dist.attestations.provenance` on the version (present
 * on 1.1.4–1.1.7, absent on 1.1.0, published by hand; read 2026-11-06).
 */
export async function lookupNpmVersion(packageName: string, version: string): Promise<NpmLook> {
  const url = `${npmBase()}/${packageName.replace("/", "%2f")}/${version}`;
  if (npmBase() !== REAL_NPM)
    console.error(`  ⚠️ S3D_NPM_API is set: asking ${url}, NOT npm (test hook)`);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(JSR_TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return { missing: true };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { error: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as {
      version?: string;
      dist?: { attestations?: { provenance?: unknown } };
    } | null;
    if (body === null || typeof body !== "object" || body.version !== version) {
      return { error: "HTTP 200 without this version's record" };
    }
    return { info: { provenance: Boolean(body.dist?.attestations?.provenance) } };
  } catch (e) {
    return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
