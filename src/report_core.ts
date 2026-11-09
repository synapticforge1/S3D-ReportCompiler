/**
 * @module
 *
 * Every transform that turns SkyCiv structural design reports into one
 * printable, self-contained document — with **no I/O of any kind**. Strings in,
 * strings out.
 *
 * That constraint is what makes this module portable: it runs unchanged on
 * Deno, Node, Bun and in a browser, because it never touches a filesystem, a
 * process or a runtime global. The parts that cannot be portable — reading a
 * folder, launching a browser to print, repacking a PDF — live in `./runtime`.
 *
 * ## What it does
 *
 * - **Bake** — {@link bakeBody} and {@link bakeStyle} pre-render each report's
 *   LaTeX to CHTML using that report's *own* delimiters ({@link parseDelimiters}),
 *   strip its scripts, namespace its ids and scope its stylesheet, so many
 *   reports can share one page without colliding.
 * - **Assemble** — {@link assembleDocument} joins them into one hermetic
 *   document that makes no network requests.
 * - **Guard** — {@link findLeftoverMath} refuses anything with surviving LaTeX.
 *   An unrecognised delimiter raises no error of its own; it simply never
 *   matches, and the maths is typeset as prose. This is the only thing that
 *   catches it.
 * - **Verify** — {@link extractSourceTokens} and {@link compareAgainstPdf} prove
 *   every word, number and graphic in the sources survived into the finished
 *   PDF.
 *
 * ⚠️ These are certified engineering calculations. A dropped value is worse than
 * a broken layout, because a dropped value still looks right — which is why the
 * guard and the verification exist, and why every removal is counted -- in
 * {@link audit} and {@link bakeRemovals} (the latter since 2026-11-06; until
 * then some removals went uncounted).
 *
 * @example Bake two reports into one printable document
 * ```ts
 * import {
 *   assembleDocument,
 *   bakeBody,
 *   bakeStyle,
 *   findLeftoverMath,
 *   mathStyleSheet,
 * } from "@jrmarcum/s3d-reportcompiler";
 *
 * // The raw HTML of each report. How you obtained it is up to the caller —
 * // this module never reads anything itself.
 * declare const sources: string[];
 *
 * // Each report gets its own scope class and id namespace.
 * const styles = sources.map((src, i) => bakeStyle(src, `.rs${i}`, `r${i}-`));
 * const bodies = sources.map((src, i) => bakeBody(src, `r${i}-`));
 *
 * // Never skip this: "0 failed" is not the same as "nothing went wrong".
 * const leftovers = findLeftoverMath(bodies.join(""));
 * if (leftovers.length > 0) throw new Error(`unrendered maths: ${leftovers.join(", ")}`);
 *
 * const html = assembleDocument(bodies, styles, mathStyleSheet());
 * ```
 */

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { CHTML } from "mathjax-full/js/output/chtml.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { entities as MATHJAX_ENTITIES } from "mathjax-full/js/util/Entities.js";
// Side effect: fills MATHJAX_ENTITIES with every extension table (2125 names, measured
// 2026-11-05), synchronously. MathJax otherwise loads them on demand, asynchronously -- which a
// synchronous convert() cannot wait for.
import "mathjax-full/js/util/entities/all.js";

/**
 * Package version. Written by `bun run update-version` from jsr.json, which
 * is the single source of truth -- do not edit this by hand.
 */
export const VERSION = "1.3.0";

/**
 * CDN base the MathJax CHTML web fonts are fetched from, once, before being
 * inlined as data URIs so the baked document needs no network at render time.
 */
export const MATHJAX_FONTS =
  "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/output/chtml/fonts/woff-v2";

// ---------------------------------------------------------------------------
// Delimiter discovery
//
// Which strings mark up an equation is a property of the document, not of this
// code: every report embeds its own MathJax tex2jax configuration. Reading it
// means a template that switches from [math]..[math] to $$..$$ -- both declared
// in the same config -- keeps working instead of silently mangling the page.
// ---------------------------------------------------------------------------

/**
 * One delimiter pair from a report's `tex2jax` config. `display` distinguishes
 * block mathematics from inline.
 */
export type Delim = { open: string; close: string; display: boolean };

/**
 * Used only when a report carries no `tex2jax` config at all: SkyCiv's own markers, and MathJax's
 * own defaults (`$$..$$`, `\[..\]`, `\(..\)`). Not a bare `$`: MathJax does not default to it, and
 * as a fallback it turned prose ("$5 per bolt, total $10") into maths (2026-11-06).
 */
export const FALLBACK_DELIMS: Delim[] = [
  { open: "[mathin]", close: "[mathin]", display: false },
  { open: "[math]", close: "[math]", display: true },
  { open: "$$", close: "$$", display: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
];

/**
 * Every delimiter the guard looks for, whatever a report declared: the fallback's, SkyCiv's, and
 * the standard TeX ones. The guard used to look only for the openers it had been told about, so
 * maths under an undeclared or unread delimiter -- `\(a+b=12.5\)` -- passed as prose. A bare `$` is
 * not here: in prose it is a currency sign; it is checked when a report declares it.
 */
const ALWAYS_GUARDED = ["[mathin]", "[math]", "$$", "\\(", "\\)", "\\[", "\\]"];

/** The marker on an expression that failed to typeset, so the guard sees the failure too. */
const UNRENDERED = "data-s3d-unrendered";

// Bounds a single expression so an unbalanced delimiter cannot consume the rest
// of the document. Longest real body measured in this set: 219 characters.
//
// The cap limits the blast radius but does not eliminate it, and the exposure
// is worst for "$". A literal dollar sign in prose -- a cost in the project
// notes, say -- either pairs with the next one and swallows the text between
// them, or is left stranded and fails the guard. That ambiguity is inherent to
// the delimiter: MathJax reads these documents the same way.
const MAX_MATH_BODY = 2000;

/**
 * Decode a JavaScript string literal the way the browser would.
 *
 * ⚠️ An unrecognised escape simply drops the backslash, so `'\['` evaluates to
 * `"["` -- which is why the degenerate-delimiter check below exists.
 */
function decodeJsString(literal: string): string {
  // Every escape JavaScript has: `$` is "$", not "u0024" (an unread escape made an opener
  // nothing in the body could match, and the maths stayed prose). A line continuation is nothing.
  const simple: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    b: "\b",
    f: "\f",
    v: "\v",
    0: "\0",
  };
  return literal.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g,
    (_m, braced: string | undefined, u4: string | undefined, x2: string | undefined, c: string) => {
      const hex = braced ?? u4 ?? x2;
      if (hex !== undefined) {
        const code = parseInt(hex, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      if (c === "\n" || c === "\r\n" || c === "\r" || c === " " || c === " ") return "";
      return Object.hasOwn(simple, c) ? simple[c] : c;
    },
  );
}

/**
 * Where a config key's value is, and what: an array literal, a variable holding one (resolved),
 * or something only running the script could tell (`unreadable`, naming it). `null` when no
 * script sets the key at all.
 *
 * Until 2026-11-08 a key that did not hold an array literal counted as NOT DECLARED, so
 * `inlineMath: D` (a variable) fell back to the default delimiters: the report's own were never
 * applied, its maths printed as prose, and the guard -- which reads the delimiters read here --
 * said nothing (class B, roadmap task 18 item 1). A variable holding a literal is read; anything
 * else is refused, never guessed.
 */
function configArray(
  scripts: string[],
  key: string,
): { array: string } | { unreadable: string } | null {
  // The key as JavaScript allows it: bare, or quoted either way (a JSON-style config,
  // `"inlineMath": [...]`, used to go unread, and the fallback delimiters stood in for it).
  const keyRe = new RegExp(`(?<![\\w$])(["']?)${key}\\1\\s*:\\s*`);
  for (let s = 0; s < scripts.length; s++) {
    const m = keyRe.exec(scripts[s]);
    if (m === null) continue;
    const valueAt = m.index + m[0].length;
    const value = scripts[s].slice(valueAt);
    if (value.startsWith("[")) {
      const array = sliceArrayAt(scripts[s], valueAt);
      return array === null ? { unreadable: `${key}: ${value.slice(0, 40)}` } : { array };
    }
    const name = /^([A-Za-z_$][\w$]*)\s*(?=[,}\n;]|$)/.exec(value)?.[1];
    if (name === undefined) return { unreadable: `${key}: ${value.slice(0, 40).trim()}` };
    // The variable's last assignment of an array before the key: in this script, then in the
    // scripts that ran before it (`scripts` is latest first).
    const assign = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*=(?!=)\\s*`, "g");
    const lastArray = (text: string) => {
      let found: string | null = null;
      for (const a of text.matchAll(assign)) {
        const at = (a.index ?? 0) + a[0].length;
        found = text[at] === "[" ? sliceArrayAt(text, at) : null;
      }
      return found;
    };
    for (const text of [scripts[s].slice(0, m.index), ...scripts.slice(s + 1)]) {
      const array = lastArray(text);
      if (array !== null) return { array };
      if (assign.test(text)) break; // assigned, but not an array literal
    }
    return { unreadable: `${key}: ${name}` };
  }
  return null;
}

/** The balanced `[...]` starting at `start`, brackets inside string literals ignored. */
function sliceArrayAt(src: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const PAIR_RE = /\[\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*)\3\s*\]/g;

/**
 * Delimiter pairs that were declared but refused as degenerate, as
 * `"open...close"` strings. Report these — silently ignoring a configured
 * delimiter is how expressions end up typeset as prose.
 */
export const skippedDelims: Set<string> = new Set();

/** Delimiter pairs from one config key's array, refusing degenerate ones. */
function readPairs(arr: string | null, display: boolean): Delim[] {
  if (!arr) return [];

  const out: Delim[] = [];
  for (const m of arr.matchAll(PAIR_RE)) {
    const open = decodeJsString(m[2]);
    const close = decodeJsString(m[4]);
    if (!open || !close) continue;

    // SkyCiv's config declares ['\[','\]'], which JavaScript evaluates to a
    // bare "[" and "]". Honouring that would treat every bracketed phrase in
    // the prose as an equation, so single-character bracket delimiters are
    // refused -- loudly, rather than silently doing the wrong thing.
    if (open.length === 1 && "[](){}<>".includes(open)) {
      skippedDelims.add(`${open}...${close}`);
      continue;
    }
    out.push({ open, close, display });
  }
  return out;
}

/**
 * Read a report's own `tex2jax` configuration and return its delimiter pairs,
 * sorted **longest opener first** so `$$` is tried before `$`.
 *
 * Falls back to {@link FALLBACK_DELIMS} when no config can be read.
 * Degenerate single-character bracket delimiters are refused and recorded in
 * {@link skippedDelims}.
 */
export function parseDelimiters(src: string): Delim[] {
  // Read from the scripts a browser RUNS: not from a comment or a <noscript>, where an old,
  // commented-out config ahead of the live one used to win, so the live delimiters were never
  // applied and their maths printed as prose, with the guard (which looks for the standard ones
  // and those configured) silent (2026-11-07 review). Each key from the LAST script that sets it,
  // as a later MathJax config overrides an earlier one.
  const scripts = liveScripts(src).reverse();
  const display = configArray(scripts, "displayMath");
  const inline = configArray(scripts, "inlineMath");
  // A key set to what only running the script could tell: refused, named, never guessed.
  const unreadable = [display, inline].flatMap((c) =>
    c !== null && "unreadable" in c ? [c.unreadable] : [],
  );
  if (unreadable.length > 0) {
    throw new Error(
      `cannot read its maths delimiters: ${unreadable.map((u) => `\`${u}\``).join(", ")} is not ` +
        "an array literal, nor a variable assigned one -- refusing rather than guess which " +
        "delimiters MathJax would apply",
    );
  }
  const arrayOf = (c: typeof display) => (c !== null && "array" in c ? c.array : null);
  const found = [...readPairs(arrayOf(display), true), ...readPairs(arrayOf(inline), false)];
  // The fallback is for a report with NO config. A config that was read but whose every pair was
  // refused declared its own delimiters, just unusable ones: falling back then applied delimiters
  // it never declared (a bare `$` once turned prose into maths). No delimiters instead -- the
  // guard, which looks for every standard one, refuses whatever maths the report holds.
  const declared = display !== null || inline !== null;
  if (found.length === 0) return declared ? [] : FALLBACK_DELIMS;

  // Longest opener first, so $$ is tried before $ and [mathin] before any
  // shorter pair that shares its prefix.
  return found.sort((a, b) => b.open.length - a.open.length);
}

/**
 * Compile delimiter pairs into a single alternating matcher, one capture group
 * per pair. Expression bodies are length-capped so an unbalanced delimiter
 * cannot swallow the rest of the document.
 */
export function buildMathRegex(delims: Delim[]): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const parts = delims.map((d) => {
    // A one-character delimiter that opens and closes an expression can only be
    // paired unambiguously if the body excludes it.
    const body =
      d.open === d.close && d.open.length === 1
        ? `[^${esc(d.open)}]{1,${MAX_MATH_BODY}}?`
        : `[\\s\\S]{1,${MAX_MATH_BODY}}?`;
    return `${esc(d.open)}(${body})${esc(d.close)}`;
  });

  return new RegExp(parts.join("|"), "g");
}

// ---------------------------------------------------------------------------
// Audit
//
// Everything the bake step removes or rewrites is counted, so a build can be
// audited rather than taken on trust.
// ---------------------------------------------------------------------------

/**
 * Running count of everything the bake step removed or rewrote, so a build can
 * be audited rather than taken on trust.
 *
 * Module-level and cumulative across every report baked in one process. Print
 * it: for a document that will be sealed, "nothing was lost" has to be
 * evidenced, not assumed.
 */
export const audit = {
  loadersRemoved: 0,
  bodyTagMissing: 0,
  visibilityNeutralised: 0,
  heightNeutralised: 0,
  atPageDropped: 0,
  strayTokensDropped: 0,
};

/**
 * The rest of what the bake removes or moves, counted like {@link audit} (kept apart so `audit`'s
 * shape -- part of the published API -- does not change). Until 2026-11-06 these went uncounted,
 * though the module promised every removal was: event-handler attributes and `javascript:` URLs
 * (`activeAttributes`), `<meta>` / `<base>` in a body (`metaBaseTags`), `@import` / `@charset` /
 * `@namespace` (`blocklessAtRules`), block at-rules this cannot scope (`atRules`, each named in
 * {@link cssWarnings}), body `<style>` blocks moved into the scoped sheet (`bodySheetsMoved`), and
 * `<noscript>` elements, which a browser with scripting on does not draw (`noscript`).
 */
export const bakeRemovals = {
  activeAttributes: 0,
  metaBaseTags: 0,
  blocklessAtRules: 0,
  atRules: 0,
  bodySheetsMoved: 0,
  noscript: 0,
};

/**
 * A start tag's attributes, read as a browser reads them: an attribute name runs to whitespace,
 * `/`, `>` or `=`; a value is quoted either way -- a `>` inside the quotes does NOT end the tag --
 * or bare; a quote only opens a value right after `=`. Every tag-level step used to read tags as
 * `<[^<>]*>`, ending at the first `>`, quoted or not: `<linearGradient title="ratio > 1" id="g">`
 * kept its id un-renamed, and the handlers, `href`s and `id`s after such a value went unread by
 * every rewrite (2026-11-06; quoted `>` occurs in all 48 client reports).
 */
// Each step can match a given stretch ONE way only -- a single whitespace character, a whole name
// (the lookahead forbids splitting it), a whole bare value -- so a tag that never closes fails in
// linear time instead of trying every split (a nested `(\s+)*` is exponential).
const TAG_ATTRS = String.raw`(?:\s|\/|[^\s/>=]+(?![^\s/>=])(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+(?![^\s>])|(?=[\s>])))?)*`;

/** A start tag named `name` (a regex alternation; default: any), read with {@link TAG_ATTRS}. */
function startTagRe(name = "[a-zA-Z][^\\s/>]*", flags = "gi"): RegExp {
  return new RegExp(`<(${name})(?![^\\s/>])(${TAG_ATTRS})>`, flags);
}

/** `<style …>…</style>`, its attributes read with {@link TAG_ATTRS}: groups 1 attributes, 2 sheet. */
const STYLE_ELEMENT = String.raw`<style(?![^\s/>])(${TAG_ATTRS})>([\s\S]*?)<\/style\s*>`;

/**
 * What a browser does not draw, found where the HTML parser finds it -- one left-to-right pass, so
 * whichever starts first wins (a `<!--` inside a script is script; a `<script>` inside a comment
 * is comment):
 * - a comment: `<!-->` and `<!--->` are complete EMPTY comments, and one also ends at `--!>`; an
 *   unclosed one runs to the end;
 * - a script or noscript element, ending at the first `</script` / `</noscript` followed by
 *   whitespace, `/` or `>` (`</script >` ends it too); unclosed, it runs to the end;
 * - raw-text elements (`style`, `textarea`, `title`, …), whose content is never markup -- matched
 *   only to be KEPT whole, so a `<!--` inside one is not taken for a comment.
 *
 * The lazy `<!--…-->` and `<script…</script>` regexes this replaces ran past `<!-->` and
 * `</script >` to the NEXT terminator, dropping the content between from the bake and the
 * verification alike (2026-11-06 review). `<noscript>` is dropped because the page renders with
 * scripting on (its policy blocks scripts; it does not turn scripting off), so a browser does not
 * show it -- left in, it printed nothing and the verification expected its text.
 */
const UNDRAWN = new RegExp(
  String.raw`<!--(?:-?>|[\s\S]*?(?:--!?>|$))` +
    String.raw`|<(script|noscript)(?![^\s/>])${TAG_ATTRS}>[\s\S]*?(?:<\/\1(?=[\s/>])[^>]*>|$)` +
    String.raw`|<(style|textarea|title|xmp|noembed|noframes)(?![^\s/>])${TAG_ATTRS}>[\s\S]*?(?:<\/\2(?=[\s/>])[^>]*>|$)`,
  "gi",
);

/**
 * The `<script>` elements a browser would run, each whole (start tag to end tag), in document
 * order: found by the same {@link UNDRAWN} pass, so one inside a comment or a `<noscript>` is not
 * one, and a `<!--` inside a script does not hide the rest of the page.
 */
function liveScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(UNDRAWN)) {
    if (m[1]?.toLowerCase() === "script") out.push(m[0]);
  }
  return out;
}

/** `html` without the comments, scripts and `<noscript>` a browser does not draw ({@link UNDRAWN}). */
function stripUndrawn(html: string, count = false): string {
  return html.replace(UNDRAWN, (m, scriptish: string | undefined, raw: string | undefined) => {
    if (raw !== undefined) return m;
    if (count && scriptish?.toLowerCase() === "noscript") bakeRemovals.noscript++;
    return "";
  });
}

// The three below are annotated rather than left to inference: JSR rejects a
// public API whose types it cannot read without running the type checker
// ("slow types"), and these are exported.

/**
 * One entry per distinct delimiter set seen across the reports baked so far.
 * More than one means the inputs disagree about their own maths syntax — worth
 * warning about, though not itself an error.
 */
export const delimSignatures: Set<string> = new Set();

/** Every opening delimiter encountered, for diagnostics. */
export const seenOpeners: Set<string> = new Set();

/**
 * Things the bake declined to do because the report did not look like the template it expects --
 * each kept the content rather than guess (a spinner id on an element that holds text, a hidden
 * rule no script reveals). Print them: each is a place to look.
 */
export const bakeWarnings: Set<string> = new Set();

/** Each page-wide name a report's sheet defined (`@font-face` family, `@keyframes`, …), for {@link bakeStyle}. */
const globalDefinitions = new Map<string, { body: string; prefix: string }>();

/**
 * Selectors from an inline SVG's `<style>` block that could not be hoisted onto
 * presentation attributes, so the block was left in place.
 */
export const svgStyleWarnings: Set<string> = new Set();

// ---------------------------------------------------------------------------
// CSS scoping
//
// Each report keeps its own stylesheet, rewritten so it can only affect its own
// wrapper. That removes two assumptions at once: that every report ships the
// same CSS, and that the only ids worth rewriting are the two this template
// happens to use. html/body selectors map onto the wrapper, since the wrapper
// is what stands in for the document once many of them share one page.
// ---------------------------------------------------------------------------

/** Attributes whose VALUE the bake renames because it is an id (or a list of ids). */
const ID_VALUED_ATTRS = new Set([
  "id",
  "for",
  "headers",
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
]);

/**
 * Prefix the ids a selector names, exactly where the bake renamed them: an `#id` OUTSIDE strings
 * and attribute selectors, and inside an attribute selector only when that attribute holds an id
 * (`[id="x"]`, `[for=x]`, and `[href^="#x"]` -- the bake renames `href="#x"` too). Anything else in
 * brackets or quotes is a value and is left alone: a plain text search renamed the hex colour in
 * `rect[fill="#ffcc00"]`, and the rule never matched again (2026-11-06).
 */
function namespaceIds(selector: string, prefix: string): string {
  let out = "";
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === "\\") {
      out += selector.slice(i, i + 2);
      i += 2;
    } else if (ch === '"' || ch === "'") {
      const end = closeQuote(selector, i);
      out += selector.slice(i, end);
      i = end;
    } else if (ch === "[") {
      const end = closeOf(selector, i);
      const stop = end < 0 ? selector.length : end;
      out += namespaceAttrSelector(selector.slice(i, stop), prefix);
      i = stop;
    } else if (ch === "#" && /^(?:[A-Za-z_-]|\P{ASCII}|\\)/u.test(selector.slice(i + 1))) {
      const m = /^#((?:[\w-]|\P{ASCII}|\\.)+)/u.exec(selector.slice(i));
      const id = m?.[1] ?? "";
      out += `#${prefix}${id}`;
      i += 1 + id.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Index just past the quote that closes the one at `at` (escapes respected). */
function closeQuote(s: string, at: number): number {
  for (let k = at + 1; k < s.length; k++) {
    if (s[k] === "\\") k++;
    else if (s[k] === s[at]) return k + 1;
  }
  return s.length;
}

/** One attribute selector `[name op value flag]`, its value prefixed when the bake renamed it. */
function namespaceAttrSelector(part: string, prefix: string): string {
  const m =
    /^\[(\s*)((?:[\w-]+\|)?[\w:-]+)(\s*)(?:([~|^$*]?=)(\s*)(?:"([^"]*)"|'([^']*)'|([^\s\]]+))([\s\S]*))?\]$/.exec(
      part,
    );
  if (!m?.[4]) return part;
  const [, s1, rawName, s2, op, s3, dq, sq, bare, tail] = m;
  const name = rawName.replace(/^[\w-]*\|/, "").toLowerCase();
  const value = dq ?? sq ?? bare ?? "";
  let next = value;
  if (ID_VALUED_ATTRS.has(name) && value !== "" && op !== "$=" && op !== "*=") {
    next = `${prefix}${value}`;
  } else if (
    (name === "href" || name === "xlink:href") &&
    (op === "=" || op === "^=") &&
    /^#./.test(value)
  ) {
    next = `#${prefix}${value.slice(1)}`;
  }
  if (next === value) return part;
  const q = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
  return `[${s1}${rawName}${s2}${op}${s3}${q}${next}${q}${tail}]`;
}

/** The attributes of a source document's `<html>` or `<body>` tag, by lower-cased name. */
type RootTag = Map<string, string>;

/** A source document's `<html>` and `<body>` tags, for selectors qualified on them. */
type RootTags = { html: RootTag; body: RootTag };

/** Read the `<html>` and `<body>` start tags of a source document. */
function rootTags(src: string): RootTags {
  const read = (name: string): RootTag => attrsOf(startTagRe(name, "i").exec(src)?.[0] ?? "");
  return { html: read("html"), body: read("body") };
}

/**
 * Index just past the bracket or parenthesis that closes the one at `at`, quotes and nesting
 * respected; -1 if it never closes.
 */
function closeOf(s: string, at: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = at; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(") depth++;
    else if ((ch === "]" || ch === ")") && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Where the compound selector starting at `from` ends: the first whitespace or combinator
 * OUTSIDE brackets, parentheses and quotes. A plain character scan stopped at the `~` of
 * `[class~="dark"]`, read it as the sibling combinator, and dropped the rule.
 */
function compoundEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length && !/[\s>+~]/.test(s[i])) {
    if (s[i] === "[" || s[i] === "(") {
      const j = closeOf(s, i);
      if (j < 0) return s.length;
      i = j;
    } else i++;
  }
  return i;
}

/** A qualifier's simple selectors (`.a`, `#b`, `[c=d]`, `:e(f)`), or null if it cannot be read. */
function qualifierParts(q: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  while (i < q.length) {
    let j = i + 1;
    if (q[i] === "[") {
      j = closeOf(q, i);
      if (j < 0) return null;
    } else if (q[i] === "." || q[i] === "#" || q[i] === ":") {
      if (q[j] === ":") j++;
      while (j < q.length && /[\w-]/.test(q[j])) j++;
      if (q[i] === ":" && q[j] === "(") {
        j = closeOf(q, j);
        if (j < 0) return null;
      }
    } else return null;
    parts.push(q.slice(i, j));
    i = j;
  }
  return parts;
}

/**
 * The attributes whose values an HTML document's selectors compare ASCII-case-insensitively
 * (the HTML standard, § "Case-sensitivity of selectors"). `class` and `id` are not among them.
 */
const CASELESS_ATTRS = new Set(
  (
    "accept accept-charset align alink axis bgcolor charset checked clear codetype color " +
    "compact declare defer dir direction disabled enctype face frame hreflang http-equiv lang " +
    "language link media method multiple nohref noresize noshade nowrap readonly rel rev rules " +
    "scope scrolling selected shape target text type valign valuetype vlink"
  ).split(" "),
);

/** Which root a qualifier is written on: `<html>` (or `:root`) or `<body>`. */
type RootRole = "html" | "body";

/** Does An+B (`odd`, `even`, `3`, `2n+1`, `-n+2`) select position `index` (1-based)? */
function nthMatches(formula: string, index: number): boolean | undefined {
  const f = formula.trim().toLowerCase().replace(/\s+/g, "");
  if (f === "odd") return index % 2 === 1;
  if (f === "even") return index % 2 === 0;
  const m = /^([+-]?\d*)n([+-]\d+)?$|^([+-]?\d+)$/.exec(f);
  if (!m) return undefined; // `of S`, or something this does not read
  if (m[3] !== undefined) return index === Number(m[3]);
  const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
  const b = Number(m[2] ?? 0);
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

/**
 * Does a pseudo-class written on `<html>` / `<body>` hold for the SOURCE document, as a browser
 * printing it would decide? The wrapper standing in for the root is a `<div>` among siblings,
 * with none of the root's attributes and none of its position, so leaving a pseudo-class on it
 * judged the wrong element: `body:not(.dark)` on `<body class="dark">` used to apply (2026-11-06).
 * - `:not` / `:is` / `:where` / `:matches`: decided from their arguments, when every one is.
 * - Structural: `<html>` is the only child of the document; `<body>` the 2nd child of `<html>`
 *   (the parser always creates `<head>` first) and the last; neither is `:empty`.
 * - States a printed page never has (`:hover`, `:focus`, `:target`, `:checked`, …) and `:link`:
 *   false.
 * - `:lang()` / `:dir()`: from the `lang` / `dir` attribute, `<body>` inheriting `<html>`'s.
 * - `:has()` and anything unknown: undefined -- left for the wrapper, which holds the same content.
 */
function pseudoHolds(part: string, roots: RootTags, role: RootRole): boolean | undefined {
  if (part.startsWith("::")) return undefined; // a pseudo-element: not a condition
  const m = /^:([\w-]+)(?:\(([\s\S]*)\))?$/.exec(part);
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  const arg = m[2] ?? "";
  const tag = roots[role];
  const any = (verdicts: (boolean | undefined)[]) =>
    verdicts.includes(true) ? true : verdicts.includes(undefined) ? undefined : false;
  const compound = (sel: string): boolean | undefined => {
    const s = sel.trim();
    const typed = /^(html|body|\*)(?![\w-])/i.exec(s);
    if (typed && typed[1] !== "*" && typed[1].toLowerCase() !== role) return false;
    const parts = qualifierParts(typed ? s.slice(typed[0].length) : s);
    if (!parts) return undefined;
    const verdicts = parts.map((p) => holdsFor(p, roots, role));
    return verdicts.includes(false) ? false : verdicts.includes(undefined) ? undefined : true;
  };
  switch (name) {
    case "not": {
      const v = any(splitSelectorList(arg).map(compound));
      return v === undefined ? undefined : !v;
    }
    case "is":
    case "where":
    case "matches":
    case "-webkit-any":
      return any(splitSelectorList(arg).map(compound));
    case "root":
      return role === "html";
    case "first-child":
      return role === "html";
    case "last-child":
    case "last-of-type":
    case "first-of-type":
    case "only-of-type":
      return true;
    case "only-child":
      return role === "html";
    case "nth-child":
      return nthMatches(arg, role === "html" ? 1 : 2);
    case "nth-last-child":
    case "nth-of-type":
    case "nth-last-of-type":
      return nthMatches(arg, 1);
    case "empty":
    case "hover":
    case "active":
    case "focus":
    case "focus-within":
    case "focus-visible":
    case "visited":
    case "link":
    case "any-link":
    case "target":
    case "target-within":
    case "checked":
    case "indeterminate":
    case "placeholder-shown":
    case "autofill":
    case "user-valid":
    case "user-invalid":
    case "popover-open":
    case "fullscreen":
    case "modal":
    case "picture-in-picture":
    case "playing":
    case "paused":
      return false;
    case "lang": {
      const lang = (
        tag.get("lang") ??
        (role === "body" ? roots.html.get("lang") : undefined) ??
        ""
      ).toLowerCase();
      return any(
        splitSelectorList(arg).map((l) => {
          const want = l
            .trim()
            .replace(/^["']|["']$/g, "")
            .toLowerCase();
          return want !== "" && (lang === want || lang.startsWith(`${want}-`));
        }),
      );
    }
    case "dir": {
      const dir = (
        tag.get("dir") ??
        (role === "body" ? roots.html.get("dir") : undefined) ??
        "ltr"
      ).toLowerCase();
      return dir === "auto" ? undefined : dir === arg.trim().toLowerCase();
    }
    default:
      return undefined;
  }
}

/**
 * Does `part` hold for the source's own root tag? true / false for a class, an id, an attribute
 * selector or a pseudo-class it can decide ({@link pseudoHolds}); undefined otherwise.
 */
function holdsFor(part: string, roots: RootTags, role: RootRole): boolean | undefined {
  const tag = roots[role];
  if (part[0] === ".") return (tag.get("class") ?? "").split(/\s+/).includes(part.slice(1));
  if (part[0] === "#") return tag.get("id") === part.slice(1);
  if (part[0] === ":") return pseudoHolds(part, roots, role);
  if (part[0] !== "[") return undefined;
  const m =
    /^\[\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*([iIsS])?\s*)?\]$/.exec(
      part,
    );
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  const have = tag.get(name);
  if (!m[2]) return have !== undefined;
  if (have === undefined) return false;
  // As a browser compares: `i` folds case, `s` keeps it, and otherwise HTML's own list of
  // attributes is ASCII-case-insensitive in selectors. `html[lang=EN]` matches lang="en" in
  // Chrome (measured 2026-11-06), and was dropped here as a rule the source never applied.
  const flag = m[6]?.toLowerCase();
  const fold = flag === "i" || (flag !== "s" && CASELESS_ATTRS.has(name));
  const a = fold ? have.toLowerCase() : have;
  const raw = m[3] ?? m[4] ?? m[5] ?? "";
  const v = fold ? raw.toLowerCase() : raw;
  switch (m[2]) {
    case "=":
      return a === v;
    case "~=":
      return v !== "" && a.split(/\s+/).includes(v);
    case "|=":
      return a === v || a.startsWith(`${v}-`);
    case "^=":
      return v !== "" && a.startsWith(v);
    case "$=":
      return v !== "" && a.endsWith(v);
    default: // "*="
      return v !== "" && a.includes(v);
  }
}

/**
 * Settle a qualifier written on `html`/`body` (the `.dark` of `body.dark`) against the source's
 * own tag, since the wrapper standing in for it carries none of its attributes. Classes, ids and
 * attribute selectors are decided statically: all hold → dropped (the rule applied), any fails →
 * `null` (the rule matched nothing in the source, and must match nothing here). A pseudo-class
 * (`:hover`) is left for the wrapper. With no source tag known -- or a qualifier this cannot
 * read -- it is all left. (`html[lang=en]` used to be left too: the wrapper has no `lang`, so the
 * rule matched nothing.)
 */
function settleQualifier(
  qualifier: string,
  roots: RootTags | undefined,
  role: RootRole,
): string | null {
  if (!roots) return qualifier;
  const parts = qualifierParts(qualifier);
  if (!parts) return qualifier;
  let rest = "";
  for (const p of parts) {
    const holds = holdsFor(p, roots, role);
    if (holds === false) return null;
    if (holds === undefined) rest += p;
  }
  return rest;
}

/** Where the identifier starting at `i` ends (escapes and non-ASCII letters included). */
function identEnd(s: string, i: number): number {
  let k = i;
  while (k < s.length) {
    if (s[k] === "\\") k += 2;
    else if (/[\w-]/.test(s[k]) || s.charCodeAt(k) > 0x7f) k++;
    else break;
  }
  return k;
}

/**
 * A selector's specificity, [ids, classes, types], as CSS Selectors 4 counts it: `:where()` weighs
 * nothing; `:is()`, `:not()`, `:has()` (and `:matches()`, `:-webkit-any()`) weigh their heaviest
 * argument; `:nth-child(… of S)` one class plus S; any other pseudo-class one class; a
 * pseudo-element and a type one type each; `*` nothing. For {@link scopeSelector} and
 * {@link competingRule}, which must keep a rule's weight where the cascade decides.
 */
function specificity(selector: string): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const add = (w: [number, number, number]) => {
    out[0] += w[0];
    out[1] += w[1];
    out[2] += w[2];
  };
  const heaviest = (list: string): [number, number, number] =>
    splitSelectorList(list)
      .map((x) => specificity(x))
      .reduce<[number, number, number]>(
        (best, w) =>
          w[0] > best[0] ||
          (w[0] === best[0] && (w[1] > best[1] || (w[1] === best[1] && w[2] > best[2])))
            ? w
            : best,
        [0, 0, 0],
      );
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === "#") {
      out[0]++;
      i = identEnd(selector, i + 1);
    } else if (ch === ".") {
      out[1]++;
      i = identEnd(selector, i + 1);
    } else if (ch === "[") {
      out[1]++;
      const end = closeOf(selector, i);
      i = end < 0 ? selector.length : end;
    } else if (ch === '"' || ch === "'") {
      i = closeQuote(selector, i);
    } else if (ch === ":") {
      const element = selector[i + 1] === ":";
      const start = i + (element ? 2 : 1);
      const end = identEnd(selector, start);
      const name = selector.slice(start, end).toLowerCase();
      let args: string | null = null;
      i = end;
      if (selector[i] === "(") {
        const close = closeOf(selector, i);
        args = selector.slice(i + 1, close < 0 ? selector.length : close - 1);
        i = close < 0 ? selector.length : close;
      }
      if (element || ["before", "after", "first-line", "first-letter"].includes(name)) out[2]++;
      else if (name === "where") {
        // nothing
      } else if (["is", "not", "has", "matches", "-webkit-any", "-moz-any"].includes(name)) {
        if (args !== null) add(heaviest(args));
      } else if ((name === "nth-child" || name === "nth-last-child") && args !== null) {
        out[1]++;
        const of = /\sof\s([\s\S]*)$/i.exec(args);
        if (of) add(heaviest(of[1]));
      } else out[1]++;
    } else if (/[A-Za-z_\\]/.test(ch) || ch.charCodeAt(0) > 0x7f) {
      const end = identEnd(selector, i);
      // `ns|type`: the namespace prefix is not a type of its own.
      if (selector[end] === "|" && selector[end + 1] !== "=") i = end + 1;
      else {
        out[2]++;
        i = end;
      }
    } else i++;
  }
  return out;
}

/**
 * Selectors that weigh `w` and match every element: what restores the weight of a compound the
 * scoping removed. `:is(#s3d-w, *)` weighs one id (an `:is()` weighs its heaviest argument) and,
 * through `*`, matches anything.
 */
const weightOnly = (w: [number, number, number]): string =>
  ":is(#s3d-w, *)".repeat(Math.max(0, w[0])) +
  ":is(.s3d-w, *)".repeat(Math.max(0, w[1])) +
  ":is(s3d-w, *)".repeat(Math.max(0, w[2]));

/**
 * Scope one selector to a report's wrapper. `html`/`body`/`:root` (and a top-level `:scope`, the
 * same root) map onto the wrapper itself, since it stands in for the document once many share a
 * page -- the whole leading chain of them (`html body p` is `<wrapper> p`), with any qualifier
 * settled against the source's own tag ({@link settleQualifier}). Returns "" for a selector that
 * can match nothing.
 *
 * WEIGHT: every scoped selector gains exactly the wrapper's one class, so rules keep their order of
 * weight. A removed root compound used to take its own weight with it -- `body .x` became `.rs0 .x`,
 * no heavier than a plain `.x` -- and cascade winners flipped: `body .x{display:none}` lost to a
 * later `.x{display:block}`, and the hidden content printed (2026-11-07 review 5). Its weight is now
 * put back by {@link weightOnly}. `weightless` is for a root reached through `:where()` or `*`,
 * which weighed nothing in the source.
 */
function scopeSelector(
  selector: string,
  scope: string,
  prefix: string,
  roots?: RootTags,
  weightless = false,
): string {
  let s = selector.trim();
  if (!s) return "";

  // The page root written another way (2026-11-07 review 4): `:where(body) .x` / `:is(html, body)
  // > .x` are their alternatives, each mapped as below; `* > .x` also matched <body>'s children,
  // which are the wrapper's. Kept as written, each needed a <body> or an element inside the wrapper,
  // so what the rule hid printed.
  const fn = /^:(is|where)\(/i.exec(s);
  if (fn) {
    const close = closeOf(s, fn[0].length - 1);
    const items =
      close < 0 ? [] : splitSelectorList(s.slice(fn[0].length, close - 1)).map((t) => t.trim());
    if (items.length > 0 && items.every((t) => /^(?:html|body|:root|:scope)$/i.test(t))) {
      const after = s.slice(close);
      // `:is()` weighs its argument (a root's own weight); `:where()` weighs nothing.
      const light = weightless || fn[1].toLowerCase() === "where";
      return [...new Set(items.map((t) => scopeSelector(t + after, scope, prefix, roots, light)))]
        .filter(Boolean)
        .join(", ");
    }
  }
  const star = /^\*(?:\|\*)?(\s*>\s*|\s+)(?=\S)/.exec(s);
  if (star) {
    const asBody = scopeSelector(
      `body${star[1]}${s.slice(star[0].length)}`,
      scope,
      prefix,
      roots,
      true,
    );
    const asAny = `${scope} ${namespaceIds(s, prefix)}`;
    return asBody ? `${asAny}, ${asBody}` : asAny;
  }
  if (/[(,]\s*(?:html|body|:root|:scope)(?![\w-])/i.test(s)) {
    bakeWarnings.add(
      `CSS "${selector}" names the page root inside a selector function; it was scoped as written`,
    );
  }

  let qualifier = "";
  let combinator = " ";
  let rooted = false;
  let lastRole: RootRole | null = null;
  const whole = s;
  for (;;) {
    // A top-level `:scope` is the document's root, as `:root` is (review 5: `:scope .hide` was
    // scoped to `.rs0 :scope .hide`, which matched nothing).
    const m = /^(html|body|:root|:scope)(?![\w-])/i.exec(s);
    if (!m) break;
    rooted = true;
    const role: RootRole = m[1].toLowerCase() === "body" ? "body" : "html";
    const end = compoundEnd(s, m[0].length);
    // `:root` is itself a pseudo-class on <html>; its qualifier is what follows it.
    const settled = settleQualifier(s.slice(m[0].length, end), roots, role);
    if (settled === null) return "";
    qualifier += settled;
    const after = /^\s*([>+~]?)\s*/.exec(s.slice(end)) ?? ["", ""];
    s = s.slice(end + after[0].length);
    // A sibling of <html> or <body>: there is none in a parsed document. Kept, it would
    // reach the NEXT report's wrapper.
    if (after[1] === "+" || after[1] === "~") return "";
    combinator = after[1] === ">" ? " > " : " ";
    lastRole = role;
    if (!s) break;
  }
  // `html > X`: <html>'s only children are <head> (never drawn) and <body> (consumed above), so X
  // matches nothing. Mapped onto the wrapper it became `.rs0 > X` -- the report's own top-level
  // elements, which the source rule never touched (`html > p {display:none}` hid them).
  if (lastRole === "html" && combinator === " > " && s) return "";

  const rest = namespaceIds(s, prefix);
  if (!rooted) return `${scope} ${rest}`;
  // The weight the removed root compounds carried, less what their kept qualifier still carries.
  const consumed = specificity(whole.slice(0, whole.length - s.length));
  const kept = specificity(qualifier);
  const filler = weightless
    ? ""
    : weightOnly([consumed[0] - kept[0], consumed[1] - kept[1], consumed[2] - kept[2]]);
  const root = `${scope}${namespaceIds(qualifier, prefix)}${filler}`;
  return rest ? `${root}${combinator}${rest}` : root;
}

/**
 * Split a selector list at its top-level commas only: `p:not(.a, .b)` is one
 * selector, and splitting inside the parentheses made the browser drop the rule.
 */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

/**
 * Rewrite a stylesheet so it can only affect its own report.
 *
 * Every selector is prefixed with `scope`, every id is namespaced with
 * `prefix`, and `html`/`body`/`:root` selectors are mapped onto the wrapper
 * that stands in for the document. Walks top-level rules by brace matching,
 * with awareness of string literals.
 *
 * @param scope  wrapper class selector, e.g. `".rs7"`
 * @param prefix id namespace, e.g. `"r7-"`
 */
export function scopeCss(css: string, scope: string, prefix: string): string {
  return scopeRules(
    css,
    (s) => scopeSelector(s, scope, prefix),
    (s) => namespaceIds(s, prefix),
    (n) => `${prefix}${n}`,
  );
}

/** Block at-rules holding style rules, scoped recursively. */
const NESTING_AT_RULES = new Set(["media", "supports", "layer", "container", "starting-style"]);

/** Block at-rules holding no selector to scope (declarations, keyframe steps): kept as written. */
const DECLARATION_AT_RULES = new Set([
  "font-face",
  "keyframes",
  "-webkit-keyframes",
  "-moz-keyframes",
  "counter-style",
  "property",
  "font-feature-values",
  "font-palette-values",
  "view-transition",
  "position-try",
]);

/**
 * At-rules dropped because this cannot scope them -- each named, never silent. An at-rule passed
 * through unscoped reached every report on the page (`@scope` once did).
 */
export const cssWarnings: Set<string> = new Set();

/**
 * Remove CSS comments as CSS reads them: `/*` inside a quoted string is text (`content: "/*"`),
 * and a comment never closed runs to the end of the sheet. A plain non-greedy `/\*…*\/` replace
 * started a "comment" inside such a string and deleted the rules up to the next real `*\/`
 * (`.hide{display:none}` among them: hidden content printed), and left an unclosed one open to
 * swallow every later report's sheet in the assembled `<style>` (2026-11-07 review).
 */
function stripCssComments(css: string): string {
  if (!css.includes("/*")) return css;
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      let k = i + 1;
      while (k < css.length && css[k] !== ch && css[k] !== "\n") k += css[k] === "\\" ? 2 : 1;
      out += css.slice(i, k + 1);
      i = k + 1;
    } else if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * `@import`, `@charset` and `@namespace` -- the at-rules with no block -- each up to its own `;`,
 * read past quoted strings and never across a brace. Run on a sheet whose comments are already
 * gone: the old `@(…)[^;]*;` ran first and, from `/* @import was here *\/`, ate everything to the
 * next `;` in the sheet, the comment's close included (2026-11-07 review).
 */
const BLOCKLESS_AT_RULE =
  /@(?:import|charset|namespace)\b(?:[^;"'{}]|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')*;/gi;

/**
 * A style rule's body with the ids in its NESTED rules' selectors renamed (CSS nesting:
 * `.report { color: red; #notes { display: none } }`); declarations, and at-rule preludes, as
 * written. A nested selector is relative to its parent, already scoped, so only its ids change.
 * Kept verbatim, `#notes` matched nothing once the element became `r0-notes`, and the notes it hid
 * printed (2026-11-07 review).
 */
function nestedIds(block: string, idsOnly: (selector: string) => string): string {
  if (!block.includes("{")) return block;
  let out = "";
  let from = 0; // start of the text not yet copied
  let boundary = -1; // the last ";", "{" or "}" at this level
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < block.length && block[i] !== ch; i++) if (block[i] === "\\") i++;
    } else if (ch === ";" || ch === "}") {
      boundary = i;
    } else if (ch === "{") {
      let depth = 0;
      let close = block.length;
      for (let k = i; k < block.length; k++) {
        const c = block[k];
        if (c === '"' || c === "'") {
          for (k++; k < block.length && block[k] !== c; k++) if (block[k] === "\\") k++;
        } else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          close = k;
          break;
        }
      }
      const prelude = block.slice(boundary + 1, i);
      const lead = /^\s*/.exec(prelude)?.[0] ?? "";
      const mapped = prelude.trim().startsWith("@")
        ? prelude
        : `${lead}${splitSelectorList(prelude.trim())
            .map((s) => idsOnly(s.trim()))
            .join(", ")} `;
      out += block.slice(from, boundary + 1) + mapped;
      out += `{${nestedIds(block.slice(i + 1, close), idsOnly)}}`;
      i = close;
      from = close + 1;
      boundary = close;
    }
  }
  return out + block.slice(from);
}

/**
 * The walk behind {@link scopeCss}, with the per-selector rewrite supplied: each selector of each
 * rule goes through `mapSelector` ("" drops it), at any depth of the {@link NESTING_AT_RULES}.
 * `@scope`'s root selectors go through `mapSelector` too (none: the document, so the wrapper), and
 * its inner rules, relative to that root, through `idsOnly`. `@page` is dropped (we set the page);
 * the {@link DECLARATION_AT_RULES} are kept; any other block at-rule is dropped and named in
 * {@link cssWarnings}.
 */
function scopeRules(
  css: string,
  mapSelector: (selector: string) => string,
  idsOnly: (selector: string) => string,
  layerName: (name: string) => string,
): string {
  const src = stripCssComments(css);
  const out: string[] = [];
  let i = 0;

  // Cascade layers are named page-wide, and ordered by where a name first appears. So each
  // report's names are its own (`r0-a`), and the statement form `@layer a, b;` -- no block, and
  // dropped as a stray token, which flipped the order -- is kept, renamed. Unrenamed, one report's
  // `@layer show, hide;` ordered the next report's layers, and content it hid printed (2026-11-07
  // review 4).
  const layers = (names: string) =>
    names
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map(layerName)
      .join(", ");
  /** The statements before a rule (or after the last): `@layer` ones kept, anything else dropped. */
  const statements = (text: string, counted: boolean) => {
    let stray = false;
    for (const part of text.split(";")) {
      const m = /^\s*@layer\s+([^{}]+?)\s*$/i.exec(part);
      if (m) out.push(`@layer ${layers(m[1])};`);
      else if (counted || part.trim()) stray = true;
    }
    if (stray && counted) audit.strayTokensDropped++;
  };

  const skipQuoted = (s: string, at: number): number => {
    const q = s[at];
    for (let k = at + 1; k < s.length; k++) {
      if (s[k] === "\\") k++;
      else if (s[k] === q) return k;
    }
    return s.length;
  };

  while (i < src.length) {
    let open = -1;
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (ch === "'" || ch === '"') j = skipQuoted(src, j);
      else if (ch === "{") {
        open = j;
        break;
      }
    }
    if (open < 0) {
      statements(src.slice(i), false);
      break;
    }

    let depth = 0;
    let close = src.length;
    for (let k = open; k < src.length; k++) {
      const ch = src[k];
      if (ch === "'" || ch === '"') k = skipQuoted(src, k);
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        close = k;
        break;
      }
    }

    let prelude = src.slice(i, open).trim();
    const block = src.slice(open + 1, close);
    i = close + 1;

    // A stray ";" between rules is legal -- CSS error recovery discards it.
    // Left in place it would be glued onto the following selector, and a
    // browser drops a rule whose selector it cannot parse. That silently
    // deletes styling, so anything up to the last semicolon is discarded here
    // ({@link statements} keeps an `@layer` statement among it).
    // Caveat: a selector carrying a semicolon inside an attribute value, as in
    // a[href="x;y"], would be truncated. No such selector exists in these
    // reports, and the alternative -- a full selector parser -- is not worth it.
    const lastSemicolon = prelude.lastIndexOf(";");
    if (lastSemicolon >= 0) {
      statements(prelude.slice(0, lastSemicolon), true);
      prelude = prelude.slice(lastSemicolon + 1).trim();
    }

    if (prelude.startsWith("@")) {
      const name = prelude
        .slice(1)
        .split(/[\s({]/)[0]
        .toLowerCase();
      // We define page geometry ourselves; a report's own @page would fight it.
      if (name === "page") continue;
      if (name === "layer") {
        const named = prelude.slice("@layer".length).trim();
        const head = named ? `@layer ${layers(named)}` : "@layer";
        out.push(`${head} {\n${scopeRules(block, mapSelector, idsOnly, layerName)}\n}`);
      } else if (NESTING_AT_RULES.has(name)) {
        out.push(`${prelude} {\n${scopeRules(block, mapSelector, idsOnly, layerName)}\n}`);
      } else if (name === "scope") {
        // `@scope (A) to (B)`: A is the root -- mapped like any selector (no prelude: the
        // document, i.e. the wrapper); B and the inner rules are relative to it, so only their
        // ids are renamed.
        const pm = /^@scope\s*(?:\(([\s\S]*?)\))?\s*(?:to\s*\(([\s\S]*)\))?\s*$/i.exec(prelude);
        if (!pm) {
          cssWarnings.add(prelude);
          bakeRemovals.atRules++;
          continue;
        }
        const roots = pm[1]
          ? splitSelectorList(pm[1]).map(mapSelector).filter(Boolean)
          : [mapSelector("body")]; // the document: the wrapper
        if (roots.length === 0) continue; // the root matched nothing in the source
        const limit = pm[2] ? ` to (${splitSelectorList(pm[2]).map(idsOnly).join(", ")})` : "";
        out.push(
          `@scope (${roots.join(", ")})${limit} {\n${scopeRules(block, idsOnly, idsOnly, layerName)}\n}`,
        );
      } else if (DECLARATION_AT_RULES.has(name)) {
        out.push(`${prelude} {${block}}`);
      } else {
        cssWarnings.add(prelude);
        bakeRemovals.atRules++;
      }
      continue;
    }

    const selectors = [...new Set(splitSelectorList(prelude).map(mapSelector).filter(Boolean))];
    if (selectors.length > 0) out.push(`${selectors.join(", ")} {${nestedIds(block, idsOnly)}}`);
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Portability transforms
// ---------------------------------------------------------------------------

// CSS inside <svg> is the least portable construct in these files, so its rules
// are hoisted onto presentation attributes. The rules are parsed rather than
// assumed: hard-coding `font-family="sans-serif"` would silently apply the
// wrong value the moment a diagram styled its text differently.
//
// Only bare element selectors can be hoisted this way. Anything else (classes,
// ids, descendant selectors) is left as a <style> block and reported, since
// dropping it would change the drawing.
//
// ORDERING: this runs after the maths has been converted, and it rewrites every
// <text> element it finds. That is safe only because the maths is encoded as
// CHTML, which emits no SVG. Switching the output back to SVG would put
// MathJax's own <text> elements in its path -- convert first, or scope this to
// the diagrams, if that ever changes.
/**
 * Hoist an inline SVG's internal `<style>` rules onto presentation attributes,
 * so the drawing survives being merged into a document with other stylesheets.
 *
 * ⚠️ Ordering matters: this must run **after** the maths has been converted.
 * It rewrites every `<text>` element it finds, which is safe only because CHTML
 * emits no SVG. Switching the maths output back to SVG would put MathJax's own
 * `<text>` elements in its path.
 */
export function portableSvg(html: string): string {
  return mapOuterSvgs(html, (svg) => {
    const plan = hoistPlan(svg);
    if (plan === null) return svg; // no sheet
    if (!plan.ok) return svg; // kept as written (bakeBody moves such a sheet to the report's)
    let out = svg;
    for (const [selector, decls] of plan.rules) {
      out = out.replace(new RegExp(`<${selector}\\b`, "gi"), `<${selector} ${decls}`);
    }
    return out.replace(STYLE_BLOCK, "");
  });
}

/** An `<svg>` start tag (quote-aware, {@link TAG_ATTRS}; group 1 set) or end tag (`</svg >` too). */
const SVG_TAG = new RegExp(String.raw`<(svg)(?![^\s/>])${TAG_ATTRS}>|<\/svg\s*>`, "gi");

/**
 * `<svg … />` closes itself: SVG is foreign content, where the HTML parser honours the slash --
 * unless it ends an unquoted value (`<svg a=b/>` is the value "b/").
 */
const selfClosing = (tag: string): boolean => /\/\s*>$/.test(tag) && !/=[^\s"'>]*\/\s*>$/.test(tag);

/**
 * Each OUTERMOST `<svg>` element of `html`, start tag to end tag, nested ones inside it. Matched by
 * depth: the lazy `<svg…</svg>` regex this replaces ended an outer diagram at its inner `</svg>`
 * and missed `</svg >`, so one diagram's sheet was hoisted onto the next (2026-11-07 review). An
 * unclosed `<svg>` runs to the end, as the parser keeps it open.
 */
function outerSvgs(html: string): { start: number; end: number; closed: boolean }[] {
  const out: { start: number; end: number; closed: boolean }[] = [];
  let depth = 0;
  let start = 0;
  for (const m of html.matchAll(SVG_TAG)) {
    const at = m.index ?? 0;
    if (m[1] !== undefined) {
      if (selfClosing(m[0])) {
        if (depth === 0) out.push({ start: at, end: at + m[0].length, closed: true });
        continue;
      }
      if (depth++ === 0) start = at;
    } else if (depth > 0 && --depth === 0) {
      out.push({ start, end: at + m[0].length, closed: true });
    }
  }
  if (depth > 0) out.push({ start, end: html.length, closed: false });
  return out;
}

/** `html` with each outermost `<svg>` element ({@link outerSvgs}) replaced by `fn` of it. */
function mapOuterSvgs(html: string, fn: (svg: string) => string): string {
  let out = "";
  let at = 0;
  for (const { start, end } of outerSvgs(html)) {
    out += html.slice(at, start) + fn(html.slice(start, end));
    at = end;
  }
  return out + html.slice(at);
}

/**
 * What hoisting one SVG's sheets would write: `null` when it has no CSS sheet, else `ok` (every
 * rule hoistable, warnings recorded for those that are not) and the (element, attributes) pairs.
 * A declaration marked `!important` is not hoistable: an attribute carries no importance, so the
 * rule began to lose to rules it beat in the source (2026-11-07 review).
 */
function hoistPlan(svg: string): { ok: boolean; rules: [string, string, string[]][] } | null {
  // Every block, with any attributes: `<style type="text/css">` is the same
  // stylesheet, and matching only a bare `<style>` used to skip it.
  const blocks = [...svg.matchAll(STYLE_BLOCK)];
  if (blocks.length === 0) return null;
  const rules: [string, string, string[]][] = [];
  let ok = true;
  for (const [, attrs, sheet] of blocks) {
    const kind = styleBlockKind(attrs);
    if (kind === "ignored") continue; // not CSS: the browser ignores it too
    if (kind !== "all") {
      // A media-qualified rule is conditional; an attribute is not.
      svgStyleWarnings.add(`<style media="${kind}">`);
      ok = false;
      continue;
    }
    ok =
      hoistSvgRules(svgSheetText(sheet), (selector, decls, props) =>
        rules.push([selector, decls, props]),
      ) && ok;
  }
  return { ok, rules };
}

/**
 * The SVG sheets of one report that must MOVE to the report's own scoped sheet rather than be
 * hoisted, keyed by the `<svg>` element's text in `stripUndrawn(src)`. {@link bakeBody} removes
 * them from their `<svg>`; {@link bakeStyle} adds them to the report's sheet, in document order.
 *
 * In HTML an inline SVG's `<style>` applies to the whole page, so the report's whole wrapper is
 * its meaning here -- as for a body sheet (#34). Hoisting onto the diagram's own elements says the
 * same only when nothing else could tell the difference, so it is kept for exactly that case (the
 * SkyCiv template's one diagram) and refused when:
 * - a rule cannot be an attribute at all ({@link hoistPlan}: a condition, a class or descendant
 *   selector, a CSS-only property, `!important`);
 * - an element the rule names occurs elsewhere in the report -- in another diagram, or in the
 *   page -- where the sheet applied in the source and an attribute on this diagram does not;
 * - a rule elsewhere in the report sets the same property on that element with no more weight
 *   than the hoisted rule's (`*`, the bare element, `svg *`): the sheet beat it in the source, but
 *   a presentation attribute loses to every author rule.
 *
 * The confinement this replaces (`:where(svg[data-s3d-scope])`) kept such a sheet to its own
 * `<svg>`, so diagram 1's `.lbl{display:none}` no longer hid diagram 2's labels (2026-11-07).
 */
function svgSheetsToMove(src: string): Set<string> {
  // Keyed by the diagram's text with inert content blanked ({@link blankInert}), as both callers read it.
  const page = blankInert(stripUndrawn(src));
  const svgs = outerSvgs(page);
  const outside = (i: number) => `${page.slice(0, svgs[i].start)} ${page.slice(svgs[i].end)}`;
  // The report's own sheets outside every <svg>, comments gone: the rules a hoist competes with.
  let pageOnly = "";
  let at = 0;
  for (const { start, end } of svgs) {
    pageOnly += page.slice(at, start);
    at = end;
  }
  pageOnly += page.slice(at);
  const pageCss = [...pageOnly.matchAll(STYLE_BLOCK)]
    .filter((m) => styleBlockKind(m[1]) !== "ignored")
    .map((m) => stripCssComments(m[2]))
    .join("\n");

  // An unclosed <svg> runs to the end of whatever text it is found in, so bakeBody (the body) and
  // bakeStyle (the page) would key it differently: its sheet was then neither moved nor hoisted, or
  // both (2026-11-07 review 4). Refused while it holds a sheet; without one nothing depends on it.
  const last = svgs.at(-1);
  if (last && !last.closed && hoistPlan(page.slice(last.start)) !== null) {
    throw new Error("a diagram's <svg> is never closed, and holds a <style> the bake must place");
  }

  const plans = svgs.map(({ start, end }) => hoistPlan(page.slice(start, end)));
  const move = new Set<number>();
  /** The CSS of a moved diagram's sheets, as it applies once moved: to the whole report. */
  const sheetCss = (i: number) =>
    [...page.slice(svgs[i].start, svgs[i].end).matchAll(STYLE_BLOCK)]
      .filter((m) => styleBlockKind(m[1]) !== "ignored")
      .map((m) => stripCssComments(svgSheetText(m[2])))
      .join("\n");
  plans.forEach((plan, i) => {
    if (plan === null) return;
    if (!plan.ok) {
      move.add(i);
      return;
    }
    // Inside <foreignObject> the elements are HTML, where a presentation attribute does nothing:
    // hoisted, `span{display:none}` stopped hiding its span (2026-11-07 review 5).
    if (/<foreignObject(?![^\s/>])/i.test(page.slice(svgs[i].start, svgs[i].end))) {
      svgStyleWarnings.add("a diagram holding <foreignObject>");
      move.add(i);
      return;
    }
    const rest = outside(i);
    for (const [element] of plan.rules) {
      if (startTagRe(element, "i").test(rest)) {
        svgStyleWarnings.add(`${element} (also outside its diagram)`);
        move.add(i);
        return;
      }
    }
  });
  // A moved sheet is a rival too: diagram B's moved `text{display:inline}` beat diagram A's
  // hoisted `display="none"` attribute, where in the source A's later rule won (2026-11-07 review
  // 4). Each move can make another, so repeated until none does.
  for (let changed = true; changed;) {
    changed = false;
    plans.forEach((plan, i) => {
      if (plan === null || move.has(i)) return;
      const rivals = [pageCss, ...[...move].filter((j) => j !== i).map(sheetCss)].join("\n");
      for (const [element, , props] of plan.rules) {
        const rival = competingRule(rivals, element, props);
        if (rival !== null) {
          svgStyleWarnings.add(`${element} (competes with "${rival}")`);
          move.add(i);
          changed = true;
          return;
        }
      }
    });
  }
  return new Set([...move].map((i) => page.slice(svgs[i].start, svgs[i].end)));
}

/**
 * A rule of `css` that could match `element` and sets one of `props` with no more weight than a
 * bare type selector -- by {@link specificity}: no id, no class, at most one type -- or null. Such a rule lost to the diagram's sheet in the source and would beat
 * the same declaration as a presentation attribute.
 */
function competingRule(css: string, element: string, props: string[]): string | null {
  const wanted = new Set(props.map((p) => p.toLowerCase()));
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const declared = m[2]
      .split(";")
      .map((d) => d.slice(0, d.indexOf(":")).trim().toLowerCase())
      .filter((p) => wanted.has(p));
    if (declared.length === 0) continue;
    for (const selector of splitSelectorList(m[1].replace(/^[\s\S]*;/, ""))) {
      const s = selector.trim();
      if (!s || s.startsWith("@")) continue;
      // Weighed as the cascade weighs it ({@link specificity}): more than one type is heavier.
      // Any `:` used to count as heavier, so `:is(text)` / `:not(rect)` -- one type's weight --
      // were skipped, and a hoisted `display:none` lost to them (2026-11-07 review 5).
      const [ids, classes, types] = specificity(s);
      if (ids > 0 || classes > 0 || types > 1) continue;
      // The subject's own type, read at the top level: another element's name cannot match. One
      // written inside a function (`:is(text)`, `:not(rect)`) is taken as a rival -- moving a
      // sheet that could have been hoisted is the safe side.
      let from = 0;
      for (let k = 0, depth = 0; k < s.length; k++) {
        if (s[k] === "(" || s[k] === "[") depth++;
        else if (s[k] === ")" || s[k] === "]") depth--;
        else if (depth === 0 && /[\s>+~]/.test(s[k])) from = k + 1;
      }
      const type = /^(?:(?:[\w-]+|\*)\|)?([A-Za-z][\w-]*)/.exec(s.slice(from))?.[1]?.toLowerCase();
      if (type === undefined || type === element.toLowerCase()) return s;
    }
  }
  return null;
}

/** `<style ...>` blocks, capturing the attributes and the sheet. */
const STYLE_BLOCK = new RegExp(STYLE_ELEMENT, "gi");

/** An element whose content is never markup a browser applies: a template's, or raw text. */
const INERT_ELEMENT = new RegExp(
  String.raw`(<(template|textarea|title|xmp|noembed|noframes)(?![^\s/>])${TAG_ATTRS}>)([\s\S]*?)(<\/\2\s*>)`,
  "gi",
);

/**
 * `html` with the content of every inert element ({@link INERT_ELEMENT}) blanked to spaces, the
 * same length, so offsets still hold. A `<style>` inside `<template>`, `<textarea>` or `<title>`
 * is no sheet -- it is inert, or text -- yet the bake applied it: a template's `p{display:none}`
 * hid the report's values, and a textarea's lost its text (2026-11-07 review 5).
 */
function blankInert(html: string): string {
  return html.replace(
    INERT_ELEMENT,
    (_m, open: string, _name: string, inner: string, close: string) =>
      `${open}${" ".repeat(inner.length)}${close}`,
  );
}

/** `text` with each match of `re` (global) OUTSIDE inert elements replaced by `fn`. */
function outsideInert(text: string, re: RegExp, fn: () => string): string {
  let out = "";
  let at = 0;
  for (const m of blankInert(text).matchAll(re)) {
    const i = m.index ?? 0;
    out += text.slice(at, i) + fn();
    at = i + m[0].length;
  }
  return out + text.slice(at);
}

/**
 * The CSS an `<svg>`'s `<style>` holds, read as the parser reads it there. Inside an `<svg>` a
 * `<style>` is foreign content, not raw text: `<![CDATA[ … ]]>` is a text wrapper, `<!-- … -->` a
 * real comment, and `&gt;` a character. Taken as an HTML sheet's text, a CDATA-wrapped
 * `.lbl{display:none}` became the invalid rule `<![CDATA[ .lbl`, which the browser dropped, so the
 * hidden label printed; a `<!-- text{display:none} -->` came alive and hid one the source shows
 * (2026-11-07 review 4: since 54eb5b2 moves such sheets out of their `<svg>`). Refused, not guessed,
 * where the sheet holds an element or an unclosed CDATA section (it swallows the page's rest).
 */
function svgSheetText(sheet: string): string {
  // The bake's own decoding, not the verifier's decodeEntities (design-decisions §9; review 5): the
  // whole HTML table, case-sensitively (MathJax's, as for TeX), numeric references, and the legacy
  // names a parser reads without ";" (`&gt` in a selector). An unknown name stays as written.
  const decode = (s: string) =>
    s.replace(
      /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([A-Za-z][A-Za-z0-9]*);|(amp|lt|gt|quot|nbsp)(?![A-Za-z0-9;]))/g,
      (m, hex?: string, dec?: string, name?: string, legacy?: string) => {
        if (legacy !== undefined) return MATHJAX_ENTITIES[legacy] ?? m;
        if (name !== undefined)
          return Object.hasOwn(MATHJAX_ENTITIES, name) ? MATHJAX_ENTITIES[name] : m;
        const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
        return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? "�"
          : String.fromCodePoint(code);
      },
    );
  let out = "";
  let at = 0;
  for (const m of sheet.matchAll(
    /<!\[CDATA\[([\s\S]*?)(\]\]>|$)|<!--(?:-?>|[\s\S]*?(?:--!?>|$))|<[a-zA-Z/!?]/g,
  )) {
    const i = m.index ?? 0;
    out += decode(sheet.slice(at, i));
    at = i + m[0].length;
    if (m[0].startsWith("<![CDATA[")) {
      if (m[2] !== "]]>")
        throw new Error("a diagram's <style> opens a CDATA section it never closes");
      out += m[1];
    } else if (!m[0].startsWith("<!--")) {
      throw new Error(
        "a diagram's <style> holds markup, which is not a stylesheet the bake can read",
      );
    }
  }
  out += decode(sheet.slice(at));
  if (/<\/style/i.test(out)) throw new Error("a diagram's <style> writes </style> in its sheet");
  return out;
}

/**
 * What a `<style>` block's attributes make of it, as a browser reads them:
 * `"ignored"` for a non-CSS `type`, the `media` query when one narrows it, or
 * `"all"`.
 */
function styleBlockKind(attrs: string): string {
  // Attributes read in order ({@link attrsOf}): data-type= and data-media= are
  // other attributes, and so is a `type=` written inside another one's value.
  const a = attrsOf(`<style${attrs}>`);
  const type = a.get("type")?.trim();
  if (type !== undefined && type !== "" && type.toLowerCase() !== "text/css") return "ignored";
  const media = a.get("media")?.trim();
  return media === undefined || media === "" || media.toLowerCase() === "all" ? "all" : media;
}

/** A CSS value as an attribute value: quotes and `&` escaped (`!important` is never hoisted). */
function attrValue(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * CSS properties that SVG also accepts as presentation attributes (SVG 1.1's
 * list, plus SVG 2's `paint-order` and `vector-effect`). A property outside it
 * -- `font`, the shorthand, say -- written as an attribute is simply ignored, so
 * a rule using one is not hoisted. `transform` is deliberately absent: its
 * attribute syntax differs from the CSS property's.
 */
const SVG_PRESENTATION = new Set(
  (
    "alignment-baseline baseline-shift clip clip-path clip-rule color color-interpolation " +
    "color-interpolation-filters color-profile color-rendering cursor direction display " +
    "dominant-baseline enable-background fill fill-opacity fill-rule filter flood-color " +
    "flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant " +
    "font-weight glyph-orientation-horizontal glyph-orientation-vertical image-rendering kerning " +
    "letter-spacing lighting-color marker-end marker-mid marker-start mask opacity overflow " +
    "paint-order pointer-events shape-rendering stop-color stop-opacity stroke stroke-dasharray " +
    "stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity " +
    "stroke-width text-anchor text-decoration text-rendering unicode-bidi vector-effect " +
    "visibility word-spacing writing-mode"
  ).split(" "),
);

/**
 * Hand each hoistable rule of an SVG sheet to `apply` as (selector, attributes).
 * Returns false when anything could not be hoisted (recorded as a warning): an
 * at-rule (`@media` is a condition an attribute cannot carry, `@font-face` has
 * no element), a selector that is not a bare element name, or a property with no
 * presentation attribute. Rules are read at the TOP LEVEL only: a rule nested in
 * `@media screen` used to be hoisted as though it applied unconditionally.
 */
function hoistSvgRules(
  sheet: string,
  apply: (selector: string, attrs: string, props: string[]) => void,
): boolean {
  let allHoisted = true;
  const src = stripCssComments(sheet);
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) {
      // A statement after the last rule (`@layer a, b;`) orders the page's layers: not an attribute.
      if (src.slice(i).includes("@")) {
        svgStyleWarnings.add(src.slice(i).trim());
        allHoisted = false;
      }
      break;
    }
    let depth = 0;
    let close = src.length;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) {
        close = k;
        break;
      }
    }
    // A stray ";" before a rule is discarded, as CSS error recovery does -- but not a statement
    // at-rule: `@layer a, b;` sets the order of the page's layers, which no attribute can carry.
    const head = src.slice(i, open);
    const dropped = head.slice(0, head.lastIndexOf(";") + 1);
    if (dropped.includes("@")) {
      svgStyleWarnings.add(dropped.trim());
      allHoisted = false;
    }
    const prelude = head.replace(/^[\s\S]*;/, "").trim();
    const declarations = src.slice(open + 1, close);
    i = close + 1;

    if (prelude.startsWith("@") || declarations.includes("{")) {
      svgStyleWarnings.add(prelude);
      allHoisted = false;
      continue;
    }

    const decls = declarations
      .split(";")
      .map((d) => d.trim())
      .map((d) => {
        const at = d.indexOf(":");
        // No colon is not a declaration; the browser drops it too.
        return at < 0
          ? (["", ""] as const)
          : ([d.slice(0, at).trim(), d.slice(at + 1).trim()] as const);
      })
      .filter(([prop, value]) => prop && value);

    if (decls.length === 0) continue;
    const foreign = decls.map(([p]) => p).filter((p) => !SVG_PRESENTATION.has(p.toLowerCase()));
    // An attribute carries no importance: hoisted, `fill: red !important` lost to an inline
    // style= and to every author rule it beat in the source (2026-11-07 review).
    const important = decls.filter(([, v]) => /!\s*important\s*$/i.test(v)).map(([p]) => p);
    if (important.length > 0) {
      svgStyleWarnings.add(`${prelude.trim()} { ${important.join("; ")} !important }`);
      allHoisted = false;
      continue;
    }

    for (const selector of splitSelectorList(prelude)
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(selector)) {
        svgStyleWarnings.add(selector);
        allHoisted = false;
        continue;
      }
      if (foreign.length > 0) {
        svgStyleWarnings.add(`${selector} { ${foreign.join("; ")} }`);
        allHoisted = false;
        continue;
      }
      // Inserted immediately after the tag name so it precedes any attribute
      // already on the element. In HTML the first occurrence of a duplicated
      // attribute wins, which preserves "stylesheet beats presentation
      // attribute" -- the precedence the rule had before it was hoisted.
      // Escaped: `font-family: "Arial"` would otherwise end the attribute early.
      apply(
        selector,
        decls.map(([p, v]) => `${p}="${attrValue(v)}"`).join(" "),
        decls.map(([p]) => p),
      );
    }
  }
  return allHoisted;
}

/**
 * Remove one element and its subtree by id.
 *
 * Matches the closing tag by depth rather than assuming the element contains no
 * nested tags of the same name.
 */
function removeElementById(html: string, id: string, onlyIfTextless = false): string {
  // The attribute named id, read in order -- not data-id=, and not "id=" inside
  // another attribute's value (whose element is not the one asked for).
  const m = [...html.matchAll(startTagRe())].find((t) => attrsOf(t[0]).get("id") === id);
  if (!m || m.index === undefined) return html;

  const tag = m[1];
  const scan = new RegExp(`<(/?)${tag}\\b`, "gi");
  scan.lastIndex = m.index + m[0].length;

  let depth = 1;
  for (let hit = scan.exec(html); hit !== null; hit = scan.exec(html)) {
    depth += hit[1] ? -1 : 1;
    if (depth === 0) {
      const end = html.indexOf(">", hit.index);
      if (end < 0) return html;
      if (onlyIfTextless) {
        const inner = html.slice(m.index + m[0].length, hit.index);
        const text = inner.replace(startTagRe(), " ").replace(/<\/[^>]*>/g, " ");
        // A drawing is content as text is: an inline <svg>, or an image embedded as data. Only an
        // outside image (the real spinner's .gif, which the document's policy never loads) is not.
        const drawing = [
          ...inner.matchAll(startTagRe("svg|img|image|input|object|embed|video|source")),
        ].some(
          (t) =>
            t[1].toLowerCase() === "svg" ||
            [...attrsOf(t[0])].some(
              ([n, v]) =>
                /^(?:src|href|xlink:href|data|poster|srcset)$/.test(n) && /^\s*data:/i.test(v),
            ),
        );
        if (drawing) {
          bakeWarnings.add(
            `the element with id="${id}" holds a drawing, so it was kept, not removed as the spinner`,
          );
          return html;
        }
        if (/[^\s]/.test(text.replace(/&nbsp;|&#160;|&#xa0;/gi, " "))) {
          bakeWarnings.add(
            `the element with id="${id}" holds text, so it was kept, not removed as the spinner`,
          );
          return html;
        }
      }
      audit.loadersRemoved++;
      return html.slice(0, m.index) + html.slice(end + 1);
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const chtml = new CHTML({ fontURL: MATHJAX_FONTS });
/**
 * The TeX packages, less the two that turn an error into typeset text. `noundefined` typesets an
 * unknown command as its own name in red ("\phiM" for a mistyped `\phi M`) and returns normally,
 * so `formatError` below never ran: counted as converted, the guard silent, the red name sealed
 * into the PDF (2026-11-07 review; it caught every undefined command, the commonest TeX error).
 * `noerrors` typesets the source of a failed expression in place of the error. Without them both,
 * an unknown command is "Undefined control sequence", thrown and counted as failed.
 */
const TEX_PACKAGES = AllPackages.filter((p: string) => p !== "noundefined" && p !== "noerrors");
/** The TeX input, named so its per-report state can be reset ({@link resetTexDefinitions}). */
const texInput = new TeX({
  packages: TEX_PACKAGES,
  // ⚠️ MathJax limitation (re-check on every MathJax update; roadmap task 8): by default a TeX
  // error does NOT throw -- MathJax typesets an inline red error box ("Misplaced &",
  // "Undefined control sequence") and convert() returns normally, so the bake counted it as
  // converted and the box went into the sealed PDF. Thrown, it reaches tex2html's catch, is
  // counted as failed, and the build refuses. (Measured 2026-11-05: 0 error boxes in the 13
  // samples and the 48-report client set, so this changes no current output.)
  formatError: (_jax: unknown, err: Error) => {
    throw err;
  },
});
const mjDoc = mathjax.document("", { InputJax: texInput, OutputJax: chtml });

/**
 * The maps MathJax adds a report's definitions to: `newcommand`'s (its `NEW_*` names), and
 * mathtools' `\DeclarePairedDelimiter` map -- missed, report 0's `\DeclarePairedDelimiter\phi{(}{)}`
 * printed report 1's `\phi M_n` as `(M)_n`, 0 failed (2026-11-07 review 4).
 */
const TEX_DEFINITION_MAPS = [
  "new-Command",
  "new-Environment",
  "new-Delimiter",
  "mathtools-paired-delims",
];

/** mathtools' settings as configured, before any report's `\mathtoolsset` changed them. */
const MATHTOOLS_DEFAULTS: Record<string, unknown> = (() => {
  const set = (texInput.parseOptions.options as { mathtools?: Record<string, unknown> }).mathtools;
  if (set === undefined) throw new Error("MathJax keeps no mathtools settings to reset");
  return { ...set };
})();

/**
 * `\unicode`'s font and size cache is private to MathJax's module and never reset: a later
 * `\unicode{x41}` takes the font an earlier `\unicode[…]{x41}` gave it. Within a report that is the
 * page's own behaviour; across reports it is state no standalone page has (2026-11-07 review 4).
 * So once a report has used `\unicode[…]`, a LATER report's `\unicode` is refused -- counted as
 * failed -- rather than drawn in another report's font.
 */
const unicodeCache = { setByEarlierReport: false, setByThisReport: false };

/**
 * Give the next report the TeX state it has standing alone: no label or equation number, and no
 * definition from an earlier report. MathJax keeps every `\def`, `\newcommand`, `\renewcommand`,
 * `\let`, `\DeclareMathOperator`, `\newenvironment`, `\definecolor` and `\newtagform` for the life
 * of the TeX input, so report 0's `\renewcommand{\phi}{0.9}` printed report 1's `\phi M_n = 12.5`
 * as `0.9 M_n = 12.5` -- converted, 0 failed, PASS: an added "0.9" is invisible to a check that
 * proves presence (2026-11-07 review). Within one report they hold, as on the page.
 *
 * A map or field that is not where MathJax 3.2.2 keeps it THROWS rather than being skipped: a reset
 * that silently stopped resetting after an upgrade is the same leak with no sign (roadmap task 8).
 */
function resetTexDefinitions(): void {
  const options = texInput.parseOptions;
  options.tags.reset(0);
  for (const name of TEX_DEFINITION_MAPS) {
    const map = (options.handlers.retrieve(name) as { map?: unknown } | null)?.map;
    if (!(map instanceof Map)) throw new Error(`MathJax keeps no "${name}" map to reset`);
    map.clear();
  }
  const color = (options.packageData.get("color") as { model?: { userColors?: unknown } })?.model;
  if (!(color?.userColors instanceof Map))
    throw new Error("MathJax keeps no colour table to reset");
  color.userColors.clear();
  const tags = options.tags as unknown as { mtFormats?: unknown; mtCurrent?: unknown };
  if (!(tags.mtFormats instanceof Map)) throw new Error("MathJax keeps no tag-form table to reset");
  tags.mtFormats.clear();
  tags.mtCurrent = null;
  // `\mathtoolsset{…}` writes these for good (`centercolon` changed the next report's layout).
  const mathtools = (options.options as { mathtools?: Record<string, unknown> }).mathtools;
  if (mathtools === undefined) throw new Error("MathJax keeps no mathtools settings to reset");
  for (const key of Object.keys(mathtools)) {
    if (!Object.hasOwn(MATHTOOLS_DEFAULTS, key)) delete mathtools[key];
  }
  Object.assign(mathtools, MATHTOOLS_DEFAULTS);
  // Not resettable ({@link unicodeCache}): remembered, so a later report's `\unicode` is refused.
  if (unicodeCache.setByThisReport) unicodeCache.setByEarlierReport = true;
  unicodeCache.setByThisReport = false;
}

/**
 * Running totals for maths conversion, cumulative across every report baked in
 * one process.
 *
 * ⚠️ `failed: 0` does **not** mean every expression was rendered. An
 * unrecognised delimiter never reaches the converter at all, so it cannot fail
 * — it is simply typeset as prose. {@link findLeftoverMath} is what catches
 * that; this counter cannot.
 */
export const mathStats = { converted: 0, failed: 0, firstFailure: "" };

/**
 * Start a new batch: zero every running counter and empty every diagnostic set --
 * {@link mathStats}, {@link audit}, {@link bakeRemovals}, {@link delimSignatures},
 * {@link seenOpeners}, {@link skippedDelims}, {@link svgStyleWarnings}, {@link cssWarnings} and
 * {@link bakeWarnings} --
 * and clear MathJax's equation labels and numbering (each report also gets a fresh table).
 *
 * They are module-level and cumulative, which suits the CLI (one build per process) and nothing
 * else: a page or a server that bakes a second batch inherited the first one's failures and
 * delimiters -- one bad expression earlier and every later batch was refused, a `$` declared by
 * an earlier report made a cost in a later report's prose read as stranded maths (measured
 * 2026-11-06). Call this before each batch.
 *
 * MathJax's own stylesheet ({@link mathStyleSheet}) is not reset: it keeps every glyph used since
 * the module loaded, a superset that renders the same.
 */
export function resetBakeState(): void {
  mathStats.converted = 0;
  mathStats.failed = 0;
  mathStats.firstFailure = "";
  for (const key of Object.keys(audit) as (keyof typeof audit)[]) audit[key] = 0;
  for (const key of Object.keys(bakeRemovals) as (keyof typeof bakeRemovals)[]) {
    bakeRemovals[key] = 0;
  }
  delimSignatures.clear();
  seenOpeners.clear();
  skippedDelims.clear();
  svgStyleWarnings.clear();
  cssWarnings.clear();
  bakeWarnings.clear();
  globalDefinitions.clear();
  resetTexDefinitions();
}

/**
 * Typeset one LaTeX expression to CHTML, updating {@link mathStats}.
 *
 * A failure returns an escaped fallback rather than throwing, so one bad
 * expression cannot abort the bake -- the guard catches what survives.
 */
function tex2html(latex: string, display: boolean): string {
  try {
    if (/\\unicode(?![a-zA-Z])/.test(latex)) {
      if (unicodeCache.setByEarlierReport) {
        throw new Error(
          "\\unicode after an earlier report's \\unicode[…]: MathJax would draw it in that report's font",
        );
      }
      // Any `\unicode` not followed by its `{…}` argument: `\unicode[…]`, and `\unicode` handed on
      // to an alias (`\let\U\unicode`, `\def\U{\unicode}`), whose `\U[Courier]{x41}` set the
      // cache unseen (2026-11-07 review 5).
      if (/\\unicode(?![a-zA-Z])(?!\s*\{)/.test(latex)) unicodeCache.setByThisReport = true;
    }
    const html = adaptor.outerHTML(mjDoc.convert(latex.trim(), { display }));
    mathStats.converted++;
    return html;
  } catch (e) {
    if (mathStats.failed === 0) {
      // MathJax throws its own TexError, not an Error: interpolated whole it read "[object Object]".
      const why =
        typeof e === "object" &&
        e !== null &&
        typeof (e as { message?: unknown }).message === "string"
          ? (e as { message: string }).message
          : String(e);
      mathStats.firstFailure = `${latex.trim().slice(0, 60)} (${why})`;
    }
    mathStats.failed++;
    // Leave the source visible rather than silently dropping a calculation.
    // It must be escaped: expressions routinely contain "<" (e.g. \lambda < 200),
    // which would otherwise be injected into the document as markup.
    const escaped = latex.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Marked, so findLeftoverMath sees the failure even when the source holds no TeX command it
    // would recognise (`x^^2`, `a & b`): it used to see nothing, and a caller who checked only the
    // guard shipped the raw source.
    return `<code ${UNRENDERED}>${escaped}</code>`;
  }
}

/** MathJax's stylesheet, with every glyph the document actually used. */
export function mathStyleSheet(): string {
  return adaptor.textContent(chtml.styleSheet(mjDoc) as never);
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

const TEX_ENTITIES: Record<string, string> = {
  // U+00A0, as the DOM has it -- not a space. Measured 2026-11-05 (MathJax 3.2.2):
  // identical in maths mode, but \text{A&nbsp;&nbsp;B} keeps both and two ASCII
  // spaces collapse to one, so a space would change a sealed calculation's text.
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * The text a browser's MathJax reads from an expression: it scans the DOM's
 * decoded text, so `\lambda &lt; 200` in the markup is `\lambda < 200` to TeX.
 * Passing the raw markup instead hands TeX an `&` -- its alignment character --
 * and the expression fails or prints "lt;". One pass, so `&amp;lt;` decodes
 * once, to the literal text `&lt;`. Deliberately separate from decodeEntities:
 * the bake and the verification share no logic.
 */
function texFromMarkup(s: string): string {
  // The only tags a text run can hold (inTextRuns): MathJax reads <br> as a newline and <wbr> as
  // nothing. Passed through, TeX typeset "<br>" as the relation "<", b, r, ">".
  const text = s.replace(/<\/?br(?![^\s/>])[^>]*>/gi, "\n").replace(/<wbr(?![^\s/>])[^>]*>/gi, "");
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    // Every named entity, not six: an exporter that escapes text writes `&ge;`, `&times;`,
    // `&deg;`, and an undecoded one hands TeX a bare "&". MathJax's own table (the one its
    // browser build reads), case-SENSITIVELY -- `&Delta;` and `&delta;` are different
    // characters, and lower-casing the name used to turn one into the other. A name in no
    // table is left as written, so TeX rejects it and the bake refuses the build, loudly.
    if (e[0] !== "#") {
      return Object.hasOwn(TEX_ENTITIES, e)
        ? TEX_ENTITIES[e]
        : Object.hasOwn(MATHJAX_ENTITIES, e)
          ? MATHJAX_ENTITIES[e]
          : m;
    }
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/**
 * `url(#id)` in every quoting a document carries: bare, `'`/`"`, and the
 * entity forms a browser writes when it serializes an inline style
 * (`style="clip-path: url(&quot;#c&quot;)"`) -- the form a report saved from a
 * browser has. Group 1 is the quote, group 2 the id.
 */
// The opening and closing quote are matched separately, not by backreference:
// `&#34;` and `&quot;` are the same character, and a serializer may mix them
// (`url(&#34;#g&quot;)`), which a backreference refused -- the id was renamed,
// the reference was not. Both quotes are kept exactly as written.
const QUOTE = `(?:"|'|&quot;|&#34;|&#39;|&apos;)`;
const URL_REF = new RegExp(String.raw`url\(\s*(${QUOTE}?)#([^"')\s&]+)(${QUOTE}?)\s*\)`, "gi");

/** Prefix the id in every `url(#id)`; with `only`, just the ids it holds. */
function namespaceUrlRefs(text: string, prefix: string, only?: Set<string>): string {
  return text.replace(URL_REF, (m, open: string, id: string, close: string) =>
    only && !only.has(id) ? m : `url(${open}#${prefix}${id}${close})`,
  );
}

// One attribute of a start tag: its name, then optionally `=` and a value quoted
// either way or bare. Matched IN ORDER from just after the tag name, each value
// consumed whole -- so `alt="Member id = 4"` is one attribute, alt, and the "id"
// in its text is never read as an attribute. (A pattern that looked for "id="
// anywhere in the tag did read it: it renamed the alt text and added "4" to the
// ids that steer every reference rewrite. Its predecessor, `\bid=`, also matched
// `data-id=`, whose name this reads whole.)
const TAG_ATTR = /([^\s"'<>/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * Rewrite a start tag's attribute values: `fn` gets each (lower-cased name,
 * value) and returns the new value. An unchanged value leaves the attribute as
 * written; a changed one keeps its name, spacing and quoting.
 */
function mapAttrs(tag: string, fn: (name: string, value: string) => string): string {
  const head = /^<[^\s/>]+/.exec(tag)?.[0] ?? "";
  return (
    head +
    tag
      .slice(head.length)
      .replace(
        TAG_ATTR,
        (all, name: string, eq?: string, dq?: string, sq?: string, bare?: string) => {
          if (eq === undefined) return all;
          const value = dq ?? sq ?? bare ?? "";
          const next = fn(name.toLowerCase(), value);
          if (next === value) return all;
          const q = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
          return `${name}${eq}${q}${next}${q}`;
        },
      )
  );
}

/**
 * A start tag without its event-handler attributes (`on…=`), and with any `javascript:` URL in
 * `href` / `xlink:href` / `src` / `action` / `formaction` replaced by `#`. Attributes are read in
 * order, values whole ({@link TAG_ATTR}), so text inside another attribute is never touched.
 */
function stripActiveAttrs(tag: string): string {
  const head = /^<[^\s/>]+/.exec(tag)?.[0] ?? "";
  const rest = tag
    .slice(head.length)
    .replace(
      TAG_ATTR,
      (all, name: string, eq?: string, dq?: string, sq?: string, bare?: string) => {
        const n = name.toLowerCase();
        if (/^on/.test(n)) {
          bakeRemovals.activeAttributes++;
          return "";
        }
        if (eq === undefined) return all;
        const value = dq ?? sq ?? bare ?? "";
        // A browser ignores tabs and newlines inside a URL, and whitespace around it.
        if (URL_ATTRS.has(n) && /^javascript:/i.test(value.replace(/[\t\n\r]/g, "").trim())) {
          bakeRemovals.activeAttributes++;
          return `${name}${eq}"#"`;
        }
        return all;
      },
    );
  return head + rest;
}

/** Attributes whose value is a URL a browser may navigate to or load. */
const URL_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction", "data"]);

/** A start tag's attributes by lower-cased name; the first of a duplicate wins, as HTML parses. */
function attrsOf(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  mapAttrs(tag, (name, value) => {
    if (!out.has(name)) out.set(name, value);
    return value;
  });
  return out;
}

/** Attributes holding one id or a space-separated list of them. */
const ID_LIST_ATTRS = new Set([
  "for",
  "headers",
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
]);

/**
 * Turn one report's `<body>` into a fragment ready to concatenate with others.
 *
 * Pre-renders every expression to CHTML using the report's own delimiters,
 * strips scripts, removes the loading spinner, namespaces ids with `prefix`,
 * and makes inline SVG portable. Updates {@link mathStats} and {@link audit}.
 *
 * The body's own `<style>` blocks (outside any `<svg>`) are left out of the
 * fragment: {@link bakeStyle} carries them, scoped. Use the two together.
 *
 * @param prefix id namespace, e.g. `"r7-"`
 */
export function bakeBody(src: string, prefix: string): string {
  // Read the delimiters before the scripts are stripped -- the tex2jax config
  // lives in one of them.
  const delims = parseDelimiters(src);
  delimSignatures.add(delims.map((d) => `${d.open}..${d.close}`).join(" "));
  for (const d of delims) seenOpeners.add(d.open);

  // Scripts come out next, so the config block -- which contains the delimiter
  // strings as literals -- is never itself read as an expression.
  const html = stripUndrawn(src, true);

  // A fresh label table and equation counter for every report, as it has standing alone: MathJax
  // keeps both across conversions, so report 1's `\label{eq}` failed as "multiply defined" after
  // report 0's, and its `\eqref` could print report 0's number (2026-11-06). Its definitions too:
  // report 0's `\renewcommand{\phi}{0.9}` changed report 1's values (2026-11-07).
  resetTexDefinitions();

  const bodyOpen = startTagRe("body", "i").exec(html);
  if (!bodyOpen) audit.bodyTagMissing++;
  const body0 = bodyOpen ? browserBody(html, bodyOpen) : html;

  // The page's own <style> blocks in the body are not dropped: bakeStyle reads
  // them, as it reads the head's, and scopes them to this report. Left here they
  // applied, unscoped, to every report on the page -- and their #id selectors
  // matched nothing once the ids were renamed. A diagram's sheet stays for portableSvg to hoist
  // only where that says the same; otherwise it moves too ({@link svgSheetsToMove}).
  const moving = svgSheetsToMove(src);
  const moved = () => {
    bakeRemovals.bodySheetsMoved++;
    return "";
  };
  let body = "";
  {
    // Never a <style> inside an inert element: one inside a <textarea> is its TEXT, which was cut.
    const move = (text: string) => outsideInert(text, STYLE_BLOCK, moved);
    let at = 0;
    for (const { start, end } of outerSvgs(body0)) {
      const svg = body0.slice(start, end);
      body += move(body0.slice(at, start));
      body += moving.has(blankInert(svg)) ? move(svg) : svg;
      at = end;
    }
    body += move(body0.slice(at));
  }

  // The spinner exists only to be hidden by the JS that we removed. It is the
  // one element deliberately dropped, and the count is reported -- and only while it draws no
  // text: an element that merely shares the id ("loading" is a plausible section name in a
  // structural report) used to go with its whole subtree, and the verification cut it too.
  body = removeElementById(body, "loading", true);

  // One left-to-right pass over every configured pair, so they cannot
  // interleave. Each pair contributes one capture group, in the same order.
  //
  // FIRST, before any id is touched: raw LaTeX is not markup, and `x<y ... >`
  // or `id = 4` inside an expression once read as a tag or an attribute to the
  // rewrites below. After this the maths is MathJax's own markup -- whose ids
  // (\label, \eqref) are then namespaced like any other, so two reports'
  // equation numbers cannot collide either.
  //
  // Within one TEXT RUN only, as MathJax in a browser pairs them: never across an element boundary
  // (only <br> and <wbr> join a run), never inside a tag's attributes, never inside pre / code /
  // textarea / style / annotation. Over the whole body, two stray delimiters typeset the table cells
  // between them -- tags and values -- as one "expression", and maths in a title="" attribute
  // broke its tag open into the page; both passed (2026-11-06 review). A pair a browser would not
  // see now stays as written, and the guard refuses it.
  if (delims.length > 0) {
    const re = buildMathRegex(delims);
    body = inTextRuns(body, (run) =>
      run.replace(re, (...args) => {
        const groups = args.slice(1, 1 + delims.length) as (string | undefined)[];
        const i = groups.findIndex((g) => g !== undefined);
        const inner = groups[i]; // undefined when i < 0: no pair matched
        return inner === undefined
          ? (args[0] as string)
          : tex2html(texFromMarkup(inner), delims[i].display);
      }),
    );
  }

  // Namespace every id rather than the two this template happens to use, so
  // many documents can share one page without colliding. Attributes are read
  // INSIDE TAGS only: unquoted values are matched (HTML allows them), and run
  // over the whole text that would also rewrite prose -- "Member id = 4" in a
  // report's own words.
  const ids = new Set<string>();
  inTags(body, (tag) =>
    mapAttrs(tag, (name, value) => {
      if (name === "id") ids.add(value);
      return value;
    }),
  );

  // The baked document is meant to run no code: <script> blocks are gone above, and so are inline
  // event-handler attributes (on…=) and javascript: URLs here. A report is user-supplied HTML, and
  // the render must not execute anything it carries (the CLI also prints with scripting off).
  body = inTags(body, stripActiveAttrs);
  // <meta http-equiv> (a refresh navigates away; no policy stops it) and <base> (it re-roots every
  // relative address) have no place in a report's body; neither draws anything.
  body = body.replace(startTagRe("meta|base"), () => {
    bakeRemovals.metaBaseTags++;
    return "";
  });

  // Every reference to a renamed id has to follow it, or its target vanishes
  // without an error -- and verification counts text and image paints, not
  // gradients, clip paths or arrowheads. main.ts's reference check catches what
  // this misses.
  body = inTags(body, (tag) =>
    mapAttrs(tag, (name, value) => {
      if (name === "id") return `${prefix}${value}`;
      if (name === "href" || name === "xlink:href") {
        return /^#./.test(value) ? `#${prefix}${value.slice(1)}` : value;
      }
      if (ID_LIST_ATTRS.has(name)) {
        return value
          .split(/(\s+)/)
          .map((t) => (ids.has(t) ? `${prefix}${t}` : t))
          .join("");
      }
      return value;
    }),
  );
  // SVG paint servers, clips, masks, filters and markers: url(#id), in
  // presentation attributes, inline styles and the SVG's own <style> block --
  // which is not a tag, so this one runs over the text. Only ids this report
  // defines, so a url(#...) in prose is left alone.
  body = namespaceUrlRefs(body, prefix, ids);

  // Every diagram sheet left is one svgSheetsToMove judged hoistable, so none may survive: one
  // that did would apply, unscoped, to every report on the page. Refused, not left (§ practices 2).
  const out = portableSvg(body);
  for (const { start, end } of outerSvgs(out)) {
    const left = [...out.slice(start, end).matchAll(STYLE_BLOCK)].filter(
      (m) => styleBlockKind(m[1]) !== "ignored",
    );
    if (left.length > 0) {
      throw new Error("internal: a diagram's <style> was neither hoisted nor moved to the report");
    }
  }
  return out;
}

/**
 * A document's body as a browser builds it, from the `<body>` start tag found in `html`: what lies
 * between it and the LAST `</body>`, plus any text a report put between `</head>` and `<body>` or
 * after `</body>` / `</html>` -- the parser moves both into the body, so a reader sees them. Taking
 * only `<body>…</body>` dropped such text from the bake AND the verification, which shared the
 * cut, so nothing noticed (2026-11-06). Whitespace alone there is not content and is not added,
 * so an ordinary document bakes exactly as before.
 */
function browserBody(html: string, bodyOpen: RegExpExecArray): string {
  const after = html.slice(bodyOpen.index + bodyOpen[0].length);
  const closes = [...after.matchAll(/<\/body\s*>/gi)];
  const last = closes.at(-1);
  const inner = last?.index === undefined ? after : after.slice(0, last.index);
  const trailing =
    last?.index === undefined ? "" : after.slice(last.index).replace(/<\/(?:body|html)\s*>/gi, "");
  const leak = drawnBeforeBody(html, bodyOpen.index);
  const before =
    leak < 0 ? "" : html.slice(leak, bodyOpen.index).replace(/<\/?head(?![^\s/>])[^>]*>/gi, "");
  return before + inner + (trailing.trim() ? trailing : "");
}

/**
 * Where, before the `<body>` tag at `bodyAt`, the parser starts the body: the first thing that is
 * not whitespace, the doctype, the `<html>` / `<head>` tags or an element a head may hold. Anything
 * else -- a `<div>` or bare text inside `<head>`, or between `</head>` and `<body>` -- opens the
 * body there, so it is drawn, and so is all that follows it. -1 when nothing does. Only text after
 * `</head>` was taken before, so a `<div>` in the head was missing from the bake AND the
 * verification, and passed (2026-11-07 review 4).
 */
function drawnBeforeBody(html: string, bodyAt: number): number {
  const headOnly = new RegExp(
    String.raw`[ \t\n\f\r]+|<!doctype[^>]*>` +
      String.raw`|<\/?(?:html|head|meta|link|base|basefont|bgsound)(?![^\s/>])${TAG_ATTRS}>` +
      String.raw`|<(style|title|template)(?![^\s/>])${TAG_ATTRS}>[\s\S]*?<\/\1\s*>`,
    "iy",
  );
  let at = 0;
  while (at < bodyAt) {
    headOnly.lastIndex = at;
    const m = headOnly.exec(html);
    if (!m || m.index + m[0].length > bodyAt) return at;
    at += m[0].length;
  }
  return -1;
}

/**
 * The selectors a report's own script makes visible -- the gate the bake opens in its place:
 * `jQuery(sel)` / `$(sel)` with `.css('visibility', 'visible')` or `.css({visibility: 'visible'})`,
 * and `getElementById(id)` / `querySelector(sel)` with `.style.visibility = 'visible'`. Whitespace
 * in each selector collapsed, so it compares with a sheet's.
 */
function revealedSelectors(src: string): Set<string> {
  // Only scripts that run: a commented-out `$('.draft').css('visibility','visible')` opened the
  // gate on a rule nothing reveals, and the hidden DRAFT printed (2026-11-07 review).
  const scripts = liveScripts(src).join("\n");
  const out = new Set<string>();
  const add = (s: string) => out.add(s.replace(/\s+/g, " ").trim());
  // The selector is group 2 in the first, group 3 in the second.
  const jquery =
    /(?:jQuery|\$)\(\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*\)\s*\.css\(\s*(?:(["'])visibility\3\s*,\s*(["'])visible\4|\{[^}]*?visibility["']?\s*:\s*(["'])visible\5)/g;
  const dom =
    /(getElementById|querySelector)\(\s*(["'])((?:(?!\2)[^\\]|\\.)*)\2\s*\)\s*\.style\.visibility\s*=\s*(["'])visible\4/g;
  for (const m of scripts.matchAll(jquery)) add(m[2]);
  for (const m of scripts.matchAll(dom)) add(m[1] === "getElementById" ? `#${m[3]}` : m[3]);
  return out;
}

/** Elements whose content MathJax does not search for maths (its `skipHtmlTags`, plus `title`). */
const NO_MATH_ELEMENTS = new Set([
  "script",
  "noscript",
  "style",
  "textarea",
  "pre",
  "code",
  "annotation",
  "annotation-xml",
  "title",
]);

/**
 * Apply `fn` to every TEXT RUN of `html` -- text, with the `<br>` / `<wbr>` tags inside it, between
 * any other two tags -- outside the {@link NO_MATH_ELEMENTS}. Tags themselves are never passed to
 * `fn`, so nothing it does can reach an attribute value.
 */
function inTextRuns(html: string, fn: (run: string) => string): string {
  const tag = new RegExp(`${startTagRe().source}|<\\/([a-zA-Z][^\\s/>]*)\\s*>`, "gi");
  let out = "";
  let run = "";
  let at = 0;
  /** The open no-maths element and its nesting depth, while inside one. */
  let skip: { name: string; depth: number } | null = null;
  const flush = () => {
    out += skip ? run : fn(run);
    run = "";
  };
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    run += html.slice(at, m.index);
    at = m.index + m[0].length;
    const startName = m[1]?.toLowerCase();
    const endName = m[3]?.toLowerCase();
    if (!skip && (startName === "br" || startName === "wbr" || endName === "br")) {
      run += m[0];
      continue;
    }
    flush();
    out += m[0];
    const name = startName ?? endName ?? "";
    if (skip) {
      if (name === skip.name) {
        skip.depth += startName ? 1 : -1;
        if (skip.depth === 0) skip = null;
      }
    } else if (startName && NO_MATH_ELEMENTS.has(startName) && !/\/\s*>$/.test(m[0])) {
      skip = { name: startName, depth: 1 };
    }
  }
  run += html.slice(at);
  flush();
  return out;
}

/** Apply `fn` to every start tag (`<name …>`), leaving text, comments and end tags alone. */
function inTags(html: string, fn: (tag: string) => string): string {
  return html.replace(startTagRe(), (tag: string) => fn(tag));
}

/**
 * Extract one report's stylesheets and scope them to that report's wrapper.
 * Reads every `<style>` in `<head>` and those in the body outside an `<svg>`
 * (which {@link bakeBody} leaves out of its fragment).
 *
 * Also neutralises the `visibility: hidden` reveal gate and relaxes `height:
 * 100%` on wrappers, both counted in {@link audit}.
 *
 * @param scope  wrapper class selector, e.g. `".rs7"`
 * @param prefix id namespace, e.g. `"r7-"`
 */
export function bakeStyle(src: string, scope: string, prefix: string): string {
  // The page's own sheets: every one in <head>, and those in the body that sit
  // outside an <svg> (bakeBody removes those from the body; together they are
  // the report's whole stylesheet). NOT the <style> inside the diagram <svg>,
  // which portableSvg hoists onto presentation attributes -- pulling it in here
  // as well would leak an SVG-scoped rule into document scope. `<head\b`, so a
  // <header> is not read as the head.
  // <head>'s start tag read quote-aware; its content runs to the first </head>. The whole page as
  // a browser draws it: a commented-out <style> in the head is no sheet either.
  // Inert content blanked ({@link blankInert}): a <style> inside <template> or <textarea> is none.
  const page = blankInert(stripUndrawn(src));
  const headOpen = startTagRe("head", "i").exec(page);
  const innerStart = headOpen ? headOpen.index + headOpen[0].length : -1;
  const headClose = headOpen ? /<\/head\s*>/i.exec(page.slice(innerStart)) : null;
  const headInner = headClose ? page.slice(innerStart, innerStart + headClose.index) : "";
  const afterHead = headClose
    ? innerStart + headClose.index + headClose[0].length
    : headOpen
      ? headOpen.index
      : 0;
  // What precedes <head> too (`<html><style>…</style><head>`, or straight after the doctype): the
  // parser puts such a sheet in the head, and it applies. It was read by neither half of the bake,
  // and nothing warned (2026-11-07 review 5).
  const beforeHead = headOpen ? page.slice(0, headOpen.index) : "";
  // The head and the rest, in document order: sheets outside every <svg>, and the sheets of a
  // diagram whose rules cannot be hoisted ({@link svgSheetsToMove}), which apply to the whole page
  // in HTML. A diagram in the head is drawn ({@link drawnBeforeBody}) and read the same way.
  const rest = `${beforeHead}\n${headInner}\n${page.slice(afterHead)}`;
  const moving = svgSheetsToMove(src);
  // A diagram's sheet as SVG parses it ({@link svgSheetText}); the page's as HTML raw text.
  const restSheets: [string, boolean][] = [];
  {
    let at = 0;
    for (const { start, end } of outerSvgs(rest)) {
      restSheets.push([rest.slice(at, start), false]);
      const svg = rest.slice(start, end);
      if (moving.has(svg)) restSheets.push([svg, true]);
      at = end;
    }
    restSheets.push([rest.slice(at), false]);
  }
  const blocks: [string, string][] = [
    ...restSheets.flatMap(([part, inSvg]) =>
      [...part.matchAll(STYLE_BLOCK)].map(
        (m) =>
          [m[1], inSvg && styleBlockKind(m[1]) !== "ignored" ? svgSheetText(m[2]) : m[2]] as [
            string,
            string,
          ],
      ),
    ),
  ];

  // Any attributes, as a browser reads them: `<style type="text/css">` is the
  // same sheet (a bare `<style>` match used to drop it silently), a non-CSS
  // type is ignored, and a `media` attribute stays a condition.
  // Comments go first, per sheet (an unclosed one ends its own <style>, not the next one), before
  // anything is counted: a commented-out rule is not audited as though active, and a comment that
  // MENTIONS an at-rule is not one.
  let css = blocks
    .map(([attrs, sheet]) => {
      const kind = styleBlockKind(attrs);
      const own = stripCssComments(sheet);
      return kind === "ignored" ? "" : kind === "all" ? own : `@media ${kind} {\n${own}\n}`;
    })
    .join("\n")
    // At-rules with no block would confuse the brace walker.
    .replace(BLOCKLESS_AT_RULE, () => {
      bakeRemovals.blocklessAtRules++;
      return "";
    })
    // `<!--` and `-->` in a sheet are CSS's CDO / CDC tokens, which CSS ignores (old pages wrap
    // their rules in them). Inside a <style> they are text now, not a comment, so the brace walker
    // would read "<!--" as part of the first selector.
    .replace(/<!--|-->/g, "");

  // The gate the removed JavaScript would have opened -- ONLY that: `visibility: hidden` in a rule
  // whose selector the report's own script reveals (`jQuery('#report').css('visibility',
  // 'visible')`). It used to be lifted from every rule, so anything a template deliberately hid
  // printed in the sealed PDF, and the presence-only verification could not notice (2026-11-06
  // review). A hidden rule no script reveals stays hidden.
  const revealed = revealedSelectors(src);
  css = css.replace(/([^{}]*)\{([^{}]*)\}/g, (rule, prelude: string, decls: string) => {
    if (!/(?<![\w-])visibility\s*:\s*hidden/i.test(decls)) return rule;
    // The selector only: statements before it (`@layer a, b;`) are not part of it -- read in, the
    // gate never matched, and a gated report stayed hidden whole (2026-11-07 review 5; reachable
    // since review 4 kept those statements).
    const lead = prelude.slice(0, prelude.lastIndexOf(";") + 1);
    const selector = prelude.slice(lead.length);
    const parts = selector
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (parts.length === 0 || !parts.every((p) => revealed.has(p))) {
      bakeWarnings.add(`CSS "${selector.trim()}" hides content no script reveals; it stays hidden`);
      return rule;
    }
    // An `!important` hide: the script's inline `style.visibility = 'visible'` cannot beat it, so
    // in the source the page stayed hidden. Opened, it printed (review 5).
    if (/(?<![\w-])visibility\s*:\s*hidden\s*!\s*important/i.test(decls)) {
      bakeWarnings.add(
        `CSS "${selector.trim()}" hides content with !important, which its script cannot reveal; it stays hidden`,
      );
      return rule;
    }
    return `${lead}${selector}{${decls.replace(/(?<![\w-])visibility\s*:\s*hidden/gi, () => {
      audit.visibilityNeutralised++;
      return "visibility: visible";
    })}}`;
  });

  audit.atPageDropped += (css.match(/@page\b/gi) ?? []).length;
  // scopeCss namespaces ids in selectors; a declaration's url(#id) names an id
  // too. Every id in the report is renamed, so every such reference follows.
  css = namespaceUrlRefs(css, prefix);
  // `body.dark p` is settled against this report's own <body> tag: the wrapper
  // standing in for it carries none of its classes.
  const roots = rootTags(src);
  css = scopeRules(
    css,
    (s) => scopeSelector(s, scope, prefix, roots),
    (s) => namespaceIds(s, prefix),
    (n) => `${prefix}${n}`,
  );

  // The names these at-rules define are page-wide, not scoped: a later report's `@font-face` for a
  // family an earlier one also defines draws BOTH reports' text in it. Renaming them means
  // rewriting every use, so a clash is named instead (2026-11-07 review 4).
  for (const m of css.matchAll(
    /@((?:-[a-z]+-)?keyframes|font-face|counter-style|property|font-palette-values|position-try)\b([^{;]*)\{((?:[^{}]|\{[^{}]*\})*)\}/gi,
  )) {
    const kind = m[1].toLowerCase();
    const name =
      kind === "font-face"
        ? (/font-family\s*:\s*([^;]+)/i.exec(m[3])?.[1] ?? "").replace(/["'\s]/g, "").toLowerCase()
        : m[2].trim();
    const key = `@${kind} ${name}`;
    const body = m[3].replace(/\s+/g, "");
    const seen = globalDefinitions.get(key);
    if (seen === undefined) globalDefinitions.set(key, { body, prefix });
    else if (seen.prefix !== prefix && seen.body !== body) {
      bakeWarnings.add(`two reports define ${key} differently; the page applies one to both`);
    }
  }

  // height:100% is meaningless in paged media and makes some engines emit a
  // single viewport-tall page. The property `height` only: `line-height` / `max-height: 100%`
  // became the invalid "auto", which a browser drops.
  css = css.replace(/(?<![\w-])height:\s*100%/gi, () => {
    audit.heightNeutralised++;
    return "height: auto";
  });

  return css;
}

/**
 * The assembled document's Content-Security-Policy. It needs no script and nothing from another
 * host -- it is built from user-supplied reports, so whatever one carries must neither run nor
 * load while it renders: no script of any kind (blocks, inline handlers, `javascript:` URLs), no
 * plugin, no frame, no fetch; images and fonts from embedded data only; styles inline. The one
 * exception is MathJax's font origin, which the browser path loads its fonts from (the CLI
 * inlines them, so its document loads nothing at all). `base-uri` / `form-action` close what
 * `default-src` does not cover.
 */
const DOCUMENT_CSP =
  "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; " +
  // MathJax's font FOLDER, not the whole jsDelivr host (which serves any npm or GitHub content):
  // a source ending in "/" matches that path and below only (2026-11-06 review).
  `form-action 'none'; img-src data:; font-src data: ${MATHJAX_FONTS}/; ` +
  "style-src 'unsafe-inline'";

/**
 * Wrap baked bodies and their scoped stylesheets into one printable document.
 *
 * The document forbids scripting and outside loads itself ({@link DOCUMENT_CSP}): it needs
 * neither, and it is built from user-supplied reports, whatever the bake missed.
 */
export function assembleDocument(bodies: string[], styles: string[], mathCss: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>Combined Design Report</title>
<style>
@page { size: Letter; margin: 0.5in; }

/* Legacy spellings first: older engines only implement those. */
.report-sheet { page-break-after: always; break-after: page; }
.report-sheet:last-child { page-break-after: auto; break-after: auto; }

/* Applies to the small nested tables. On the outer table -- which is the whole
   report -- it is unsatisfiable and the engine ignores it. The reports' own
   stylesheet also declares .unbreakable, but no element carries that class, so
   it is not repeated here. */
table { page-break-inside: avoid; break-inside: avoid; }

/* Sections are free to run across a page break -- the rules that bound them are
   cosmetic, and keeping whole rows together wasted roughly a third of the page
   count on trailing whitespace. What must never be sliced in half is a graphic
   or an equation, so the constraint is applied to those alone.
   mjx-container is the wrapper MathJax puts around every typeset expression. */
img, svg, mjx-container { page-break-inside: avoid; break-inside: avoid; }

html, body { height: auto; margin: 0; padding: 0; }
img, svg { max-width: 100%; }

${styles.join("\n")}
${mathCss}
</style>
</head>
<body>
${bodies.map((b, i) => `<div class="report-sheet rs${i}">${b}</div>`).join("\n")}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Guard: nothing that looks like unrendered maths may reach the PDF.
//
// A delimiter this code does not understand produces no error -- it simply
// never matches, and the LaTeX is typeset as prose. That is the failure mode
// most likely to survive review, so it is checked for explicitly. Only report
// bodies should be passed here: MathJax's own stylesheet contains CSS escapes
// that read as TeX commands.
// ---------------------------------------------------------------------------

/**
 * **The guard.** Surviving delimiters and TeX commands in a baked document.
 *
 * An empty array is the only acceptable result before rendering. This is the
 * only thing that catches an unrecognised delimiter, which raises no error of
 * its own — it simply never matches, and the LaTeX is typeset as prose while
 * {@link mathStats} still reports `0 failed`.
 *
 * ⚠️ Pass report **bodies** only, never MathJax's own stylesheet: it contains
 * CSS escapes that read as TeX commands.
 */
export function findLeftoverMath(baked: string): string[] {
  const leftovers: string[] = [];

  for (const opener of new Set([...seenOpeners, ...ALWAYS_GUARDED])) {
    const n = baked.split(opener).length - 1;
    if (n > 0) leftovers.push(`${n} x "${opener}"`);
  }

  const unrendered = baked.split(UNRENDERED).length - 1;
  if (unrendered > 0) leftovers.push(`${unrendered} expression(s) that failed to typeset`);

  const texCommands = baked.match(/\\[a-zA-Z]{2,}/g);
  if (texCommands) {
    const sample = [...new Set(texCommands)].slice(0, 6).join(", ");
    leftovers.push(`${texCommands.length} TeX command(s): ${sample}`);
  }

  return leftovers;
}

// ---------------------------------------------------------------------------
// Verification: the source half
//
// Deliberately re-derives what a reader should see from the original HTML,
// using none of the transforms above. A check that shares logic with the thing
// it checks can agree with its mistakes.
// ---------------------------------------------------------------------------

// The verification's own table, written apart from the bake's (which reads MathJax's): the
// markup entities, and the symbols an engineering report's prose uses. Case-sensitive, as HTML
// is (&Delta; is not &delta;). A name in no table is left as written -- its letters are then
// expected in the PDF and missed, which fails loudly rather than passing.
const GREEK =
  "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - Sigma Tau Upsilon Phi Chi Psi Omega";
/**
 * HTML's Latin-1 entity names, in code-point order from U+00A0 -- the accented letters a report's
 * text can hold (`&eacute;` was read as the word "eacute", a false FAIL; 2026-11-08, class B).
 * The verification's own list (design-decisions §9), not the bake's.
 */
const LATIN1_NAMES = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn " +
  "sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave " +
  "Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml " +
  "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN " +
  "szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave " +
  "iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute " +
  "ucirc uuml yacute thorn yuml"
).split(" ");

/** The names a browser still decodes with no ";" -- HTML's legacy set: Latin-1, and these. */
const LEGACY_ENTITIES = new Set([
  ...LATIN1_NAMES,
  ..."amp lt gt quot AMP LT GT QUOT COPY REG".split(" "),
]);

const ENTITIES: Record<string, string> = {
  ...Object.fromEntries(LATIN1_NAMES.map((n, i) => [n, String.fromCodePoint(0xa0 + i)])),
  AMP: "&",
  LT: "<",
  GT: ">",
  QUOT: '"',
  COPY: "©",
  REG: "®",
  shy: "",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwj: "",
  zwnj: "",
  lrm: "",
  rlm: "",
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  deg: "°",
  times: "×",
  divide: "÷",
  plusmn: "±",
  minus: "−",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  infin: "∞",
  radic: "√",
  sum: "∑",
  micro: "µ",
  middot: "·",
  sdot: "⋅",
  bull: "•",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  prime: "′",
  Prime: "″",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sect: "§",
  para: "¶",
  copy: "©",
  reg: "®",
  trade: "™",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  ...Object.fromEntries(
    GREEK.split(" ").flatMap((name, i) =>
      name === "-"
        ? [["sigmaf", "ς"]]
        : [
            [name, String.fromCodePoint(0x391 + i)],
            [name.toLowerCase(), String.fromCodePoint(0x3b1 + i)],
          ],
    ),
  ),
};

/**
 * Decode the HTML entities in report text, as a browser does: named ones from
 * this module's own table, decimal and hex character references, in ONE pass
 * (so `&amp;#60;` is the text `&#60;`, not `<`). A reference no character can
 * have -- zero, a surrogate, past U+10FFFF -- is U+FFFD, as a browser reads it;
 * it used to throw a RangeError and stop the verification.
 */
export function decodeEntities(s: string): string {
  return s.replace(
    /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([A-Za-z][A-Za-z0-9]*);|([A-Za-z][A-Za-z0-9]*))/g,
    (
      m,
      hex: string | undefined,
      dec: string | undefined,
      name: string | undefined,
      bare: string | undefined,
    ) => {
      // As a browser reads them (2026-11-08, class B): a numeric reference needs no ";", and a
      // LEGACY name with none is still decoded -- its longest legacy prefix, the rest kept
      // (`&timesx` is "×x"). Read as text, `&times` and `&#53` were words and numbers no PDF
      // holds, a false FAIL.
      if (bare !== undefined) {
        for (let n = bare.length; n > 1; n--) {
          const head = bare.slice(0, n);
          if (LEGACY_ENTITIES.has(head) && Object.hasOwn(ENTITIES, head)) {
            return ENTITIES[head] + bare.slice(n);
          }
        }
        return m;
      }
      if (name !== undefined) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : m;
      const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : String.fromCodePoint(code);
    },
  );
}

/**
 * Text normalised for comparison, the same way on both sides: the minus sign and the dashes a
 * value is written with read as "-", and the Latin ligatures a PDF text layer can hold (`ﬁ`) as
 * their letters. Nothing else changes -- `²` stays `²` (NFKC would make `mm²` and `mm2` alike).
 */
function normalizeText(text: string): string {
  return (
    text
      .replace(/[−‐‑‒–﹣－]/g, "-")
      // The multiplication dot: a report writes `·` (U+00B7) in its maths, MathJax prints `⋅`.
      .replace(/·/g, "⋅")
      .replace(/[ﬀ-ﬆ]/g, (c) => c.normalize("NFKC"))
      // Characters that draw nothing: a zero-width space or joiner inside `12​.5` split it.
      .replace(/[​-‍⁠﻿]/g, "")
  );
}

/**
 * Lower-cased words of two letters or more, in any script, plus every non-ASCII symbol on its own
 * (`λ`, `≤`, `²`, `°`, `×`): what a reader sees that a value depends on. Words of three ASCII
 * letters were all that was checked, so `OK` → `NG`, `kN` → `mm`, `λ` → `φ` and `mm²` → `mm³`
 * passed unseen (2026-11-08, class B). Two letters is safe now that the PDF text is read with its
 * gaps ({@link compareAgainstPdf}); one letter is a variable name.
 */
export function textWords(text: string): Set<string> {
  return new Set(wordTokens(text));
}

/** Every word and symbol of {@link textWords}, one entry per OCCURRENCE. */
function wordTokens(text: string): string[] {
  const t = normalizeText(text);
  // Words lower-cased, but not a short one: three letters or fewer is where the units are, and
  // case is their meaning (`MN` is not `mN`, `MPa` not `mPa`; class B, iteration 2). A symbol
  // (below) keeps its case too.
  const words = (t.match(/\p{L}{2,}/gu) ?? []).map((w) =>
    [...w].length <= 3 ? w : w.toLowerCase(),
  );
  // A symbol: anything but an ASCII character, a decimal digit, a space or an invisible format
  // character -- so `²` (category No, not a digit) is one, and so is every non-ASCII LETTER on its
  // own: a single `λ` is no two-letter word, but λ → φ changes the quantity.
  // And the ASCII operators a value's meaning turns on, each counted (task 18 item 2): a `<` → `>`,
  // a `+` → `-`, an empty cell's `-` → `+` changes a check, and none was a token. Every `-` counts,
  // hyphens too, on both sides alike (maths minus signs read as `-`, normalizeText).
  const symbols = t.match(/[^\p{Nd}\s\p{Cf}\p{ASCII}]|[<>=+%-]/gu) ?? [];
  return [...words, ...symbols];
}

/**
 * The number tokens of a text, each WHOLE: its sign (a "-" with nothing alphanumeric before it),
 * thousands separators (`1,000`), decimal part, a leading-point decimal (`.5`) and exponent
 * (`1.5e-3`). Split at signs and separators, `-12.5` → `12.5`, `1,000` → `1.000` and `1.5e-3` →
 * `1.5e3` all passed (2026-11-08, class B).
 */
export function textNumbers(text: string): Set<string> {
  return new Set(numberTokens(text));
}

/** Every number token of {@link textNumbers}, one entry per OCCURRENCE. */
function numberTokens(text: string): string[] {
  return normalizeText(text).match(NUMBER_TOKEN) ?? [];
}

/**
 * One number token ({@link textNumbers}). A comma is a thousands separator only inside a whole
 * integer of groups (`1,250`, `12,300.5`); anywhere else it separates (`max(12.5,300.2)`, `(1,2)`).
 * The first version read every "digit," as the start of a group and dropped both arguments of the
 * samples' own `\max(96.982,50.675)` (class B, iteration 2).
 */
const NUMBER_TOKEN =
  /(?:(?<![\p{L}\p{N}\])}.,])-)?(?<![\d.])(?:(?:\d{1,3}(?:,\d{3})+(?!\d)|\d{4,}|\d{1,3}(?!,\d{3}(?!\d)))(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?!\d|\.\d|[eE][-+]?\d)/gu;

/** A "-" read as a sign ({@link NUMBER_TOKEN}): nothing alphanumeric or closing before it. */
const SIGN = String.raw`(?<![\p{L}\p{N}\])}.,])-`;

/**
 * Where `token` (a {@link textNumbers} token) stands WHOLE in `text`: no digit, point or separator
 * joined to either side of it, so `0.9` is not found in `0.95`, `125` not in `1250`, `250` not in
 * `1,250`, `12` not in `12,300`. An unsigned token is not found right after a SIGN (`12.5` is not
 * `-12.5`), though it may follow a binary minus (`5-3`). A signed token may print its minus apart
 * from its digits: MathJax spaces `M_{u} -0.537` as a binary minus, "- 0.537".
 */
function hasNumber(text: string, token: string): boolean {
  return countNumber(text, token) > 0;
}

/** How many times `token` stands whole in `text` ({@link hasNumber}'s rules). */
function countNumber(text: string, token: string): number {
  const signed = token.startsWith("-");
  const digits = (signed ? token.slice(1) : token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let before = signed ? String.raw`-\s?` : `(?<!${SIGN})`;
  before = `(?<![\\d.])${before}`;
  // The tail of a thousands number: three digits after an integer group and a comma.
  if (!signed && /^\d{3}(?!\d)/.test(token))
    before = String.raw`(?<!(?<![\d.])\d{1,3}(?:,\d{3})*,)` + before;
  // The head of one: an integer of one to three digits followed by ",ddd".
  const after = /^-?\d{1,3}$/.test(token) ? String.raw`(?!,\d{3}(?!\d))` : "";
  const re = new RegExp(`${before}${digits}${after}(?!\\d|\\.\\d|[eE][-+]?\\d)`, "gu");
  return (text.match(re) ?? []).length;
}

/**
 * How many times `word` (a {@link textWords} token) stands in `text`: a word with no letter joined
 * to it (`kip` is not found in `kips`), a symbol anywhere. One SPACE may stand between two of its
 * letters -- maths draws a multi-letter subscript glyph by glyph (`λ_{rf}` prints "r f") -- but not a
 * line break: `k` at a line's end and `N` on the next passed as "kN" (class B, re-check 2).
 */
function countWord(
  text: string,
  word: string,
  exact: string,
  /**
   * In capitals ({@link countWord} below): `null` never (counting a SOURCE, which a stylesheet has
   * not set yet); otherwise how many of the capitals the source's own capital token already
   * claims -- a heading written `OF` is that token's, not `of` set upper-case (re-check 2:
   * counted twice, they made a surplus that hid one lost `of`).
   */
  claimed: number | null = 0,
): number {
  // A symbol in the text as printed, case and all: `Δ` is not `δ`.
  if ([...word].length === 1 || !/\p{L}/u.test(word)) return exact.split(word).length - 1;
  // What may not touch the word: a letter -- but for a word not in Greek, not a Greek one. Maths
  // prints a symbol against its operand (`\phi P_{c}` as "ϕPc"), so "Pc" stands there whole.
  const letter = /\p{Script=Greek}/u.test(word) ? "\\p{L}" : "(?!\\p{Script=Greek})\\p{L}";
  const pattern = (w: string) =>
    new RegExp(
      `(?<!${letter})${[...w].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[ ]?")}(?!${letter})`,
      "gu",
    );
  if ([...word].length > 3) return (text.match(pattern(word)) ?? []).length;
  // A short word kept its case ({@link textWords}): counted as written. In capitals only where a
  // stylesheet could have set it so -- a source word with no capital of its own, on a PDF line with
  // no lower-case letter (a heading). Accepted in capitals anywhere, `mN` passed as `MN`, a factor
  // of 10⁹, and `mm` as `MM` (re-check 2).
  let n = (exact.match(pattern(word)) ?? []).length;
  const upper = word.toUpperCase();
  if (claimed !== null && word === word.toLowerCase() && upper !== word) {
    let capitals = 0;
    for (const m of exact.matchAll(pattern(upper))) {
      const from = exact.lastIndexOf("\n", m.index) + 1;
      const to = exact.indexOf("\n", m.index);
      if (!/\p{Ll}/u.test(exact.slice(from, to < 0 ? exact.length : to))) capitals++;
    }
    n += Math.max(0, capitals - claimed);
  }
  return n;
}

/**
 * Each number with its neighbours, counted: the unit, word, operator or `%` right after it
 * (`12 m`, `30.483 <`, `85 %`) and the operator right before it (`+ 3`, `< 0.2`), at most one space
 * between. A number checked alone let `12 m` → `12 N`, `30.483 <` → `>`, `12.5+3` → `12.5-3` and
 * `85%` → `85` through: the number was still there (task 18 item 2). A sign counts as the operator
 * before its digits, so `-0.537` and MathJax's spaced "- 0.537" are one pair. ONE scan for the
 * source and the PDF (the lesson of #89). `runs`: a line break ends a run, and no pair crosses it
 * -- the SOURCE, cut into runs of text (see {@link sourceTally}); without it all whitespace is a
 * space -- the PDF, where a run may wrap onto the next line ("360-16" / "LRFD").
 */
function neighbourTally(text: string, runs = false): Map<string, number> {
  const t = normalizeText(text).replace(runs ? /[^\S\n]+/g : /\s+/g, " ");
  const out = new Map<string, number>();
  const add = (key: string) => out.set(key, (out.get(key) ?? 0) + 1);
  const OP = "<>=+\\-≤≥≠×⋅/";
  for (const m of t.matchAll(NUMBER_TOKEN)) {
    const at = m.index ?? 0;
    const signed = m[0].startsWith("-");
    const digits = signed ? m[0].slice(1) : m[0];
    // After it: a run of letters -- a Greek symbol stands alone, as maths prints it touching its
    // neighbour (`2\phi P_c` is "2ϕPc"; its neighbour is ϕ) -- or an operator, or `%`.
    const after = new RegExp(
      `^ ?(\\p{Script=Greek}|(?:(?!\\p{Script=Greek})\\p{L})+|[${OP}%])`,
      "u",
    ).exec(t.slice(at + m[0].length));
    if (after) add(`${digits} ${after[1]}`);
    const before = signed
      ? ["-"]
      : new RegExp(`([${OP}]) ?$`, "u").exec(t.slice(Math.max(0, at - 2), at));
    if (before) add(`${before[before.length - 1]} ${digits}`);
  }
  return out;
}

/** Whether `word` stands in `text` at least once ({@link countWord}). */
function hasWord(text: string, word: string, exact: string): boolean {
  return countWord(text, word, exact) > 0;
}

/**
 * The glyph each TeX command the reports' maths uses prints as, so the verification expects it:
 * `\lambda` → λ. Read from the RAW source by the verification's own table (design-decisions §9),
 * as MathJax 3's CHTML writes it (measured on the samples: `\phi` is U+03D5, `\varphi` U+03C6).
 */
const TEX_GLYPHS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  times: "×",
  cdot: "⋅",
  pm: "±",
  infty: "∞",
  sqrt: "√",
  rightarrow: "→",
  to: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  sum: "∑",
  prod: "∏",
  int: "∫",
  partial: "∂",
  // `^\circ` is how a TeX report writes a degree; MathJax prints the ring operator.
  circ: "∘",
};

/**
 * The commands that print their own NAME, upright (`\max(a,b)` shows "max"): blanked with the
 * other commands, a renamed `\min` passed (class B, iteration 2).
 */
const TEX_OPERATOR_NAMES = new Set([
  "arccos",
  "arcsin",
  "arctan",
  "arg",
  "cos",
  "cosh",
  "cot",
  "coth",
  "csc",
  "deg",
  "det",
  "dim",
  "exp",
  "gcd",
  "hom",
  "inf",
  "ker",
  "lg",
  "lim",
  "liminf",
  "limsup",
  "ln",
  "log",
  "max",
  "min",
  "Pr",
  "sec",
  "sin",
  "sinh",
  "sup",
  "tan",
  "tanh",
]);

/** Everything the source reports contain that the finished PDF must still have. */
export type SourceTokens = {
  words: Set<string>;
  numbers: Set<string>;
  expectedImages: number;
};

/**
 * A tag in a SOURCE report, for the verification: `<` and a letter (or `/` and a letter), then
 * anything, quoted runs taken whole, up to the `>` that ends it. Written apart from the bake's
 * reading (design-decisions §9).
 */
const SOURCE_TAG = /<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|[^"'>])*>/g;

/** A table cell's tag: the cells of one row are one run of text ({@link neighbourTally}). */
const CELL_TAG = /^<\/?t[dh](?=[\s/>])/i;

/**
 * The source's text as a reader sees the maths: delimiters gone, a command's NAME gone where it is
 * a command, a glyph command's glyph and an operator's name left (`\lambda` → λ, `\max` → max).
 */
function printedProse(text: string, runs = false): string {
  // With `runs`, display maths and TeX's `\\` end a run of text ({@link neighbourTally}).
  const end = runs ? "\n" : " ";
  return text
    .replace(/\[math\]/gi, end)
    .replace(/\[mathin\]/gi, " ")
    .replace(/\\\\|\\([a-zA-Z]+)/g, (_m, name?: string) =>
      name === undefined
        ? end
        : Object.hasOwn(TEX_GLYPHS, name)
          ? ` ${TEX_GLYPHS[name]} `
          : TEX_OPERATOR_NAMES.has(name)
            ? ` ${name} `
            : " ",
    );
}

/** Each sub- or superscript as its own token, as it prints: `F_yS` is F, y and S; `M_{nz}` M and nz. */
function isolateScripts(prose: string): string {
  return prose.replace(/[_^]\{([^{}]*)\}/g, " $1 ").replace(/[_^]([^\s{\\])/g, " $1 ");
}

/** A phrasing element's tag, drawn in line with its neighbours ({@link extractSourceTokens}). */
const INLINE_TAG =
  /^<\/?(?:a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strike|strong|time|tt|u|var|wbr)(?=[\s/>])/i;

/** Index just past the `>` that ends the tag starting at `at`, quoted runs skipped. */
function sourceTagEnd(html: string, at: number): number {
  let quote = "";
  for (let i = at + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i + 1;
  }
  return html.length;
}

/**
 * TeX arguments that are SETTINGS, not text: what a reader never sees on the page, so they are not
 * expected in the PDF. Each spec lists the arguments dropped, in order: `[` an optional `[…]`, `{`
 * a required group (or one token), `*` an optional star. Arguments after these -- the text a
 * command colours, raises or boxes -- are left, so they are still checked.
 *
 * Found by the first real SkyCiv zip (2026-11-06): `\color{blue}{\text{ NONCOMPACT}}` in two of 75
 * reports, and "blue" reported missing from a correct PDF. The whole class is here -- colours,
 * spacing (whose numbers never print), invisible content, labels, environment names and column
 * specs, and MathJax's own extensions -- not only `\color`. Written for the verification alone
 * (design-decisions §9); applied to all text, which can only make it expect less.
 */
const NONPRINTING_TEX: Record<string, string> = {
  color: "[{",
  textcolor: "[{",
  colorbox: "[{",
  fcolorbox: "[{{",
  pagecolor: "[{",
  definecolor: "{{{",
  hspace: "*{",
  vspace: "*{",
  mspace: "{",
  rule: "[{{",
  raisebox: "{[[",
  phantom: "{",
  hphantom: "{",
  vphantom: "{",
  label: "{",
  // A reference prints the NUMBER of what it names, never its key: `\eqref{eq:stress}` expected
  // "stress" in the PDF, a false failure (2026-11-07 review).
  ref: "{",
  eqref: "{",
  // A definition's name, argument count and default print nothing. Its BODY is what prints wherever
  // the macro is used, so it is expected: dropped, `\newcommand{\Mn}{512.3}` left 512.3 unchecked at
  // every use (2026-11-07 review 4). Its `#1` parameters are not text ({@link TEX_DEFINITIONS}). A
  // macro defined and never used then fails loudly, the safe direction.
  newcommand: "*{[[",
  renewcommand: "*{[[",
  providecommand: "*{[[",
  newenvironment: "*{[[",
  renewenvironment: "*{[[",
  def: "{",
  gdef: "{",
  let: "{{",
  DeclareMathOperator: "*{",
  // mathtools and the tag forms: names, delimiters, options (2026-11-07 review 4).
  DeclarePairedDelimiter: "{{{",
  DeclarePairedDelimiterX: "{[{{",
  mathtoolsset: "{",
  newtagform: "{[",
  usetagform: "{",
  Newextarrow: "{{{",
  require: "{",
  style: "{",
  class: "{",
  cssId: "{",
  // `\unicode[height,depth][font]{x41}`: both options are settings.
  unicode: "[[{",
  href: "{",
  enclose: "{[",
  bbox: "[",
  begin: "{",
  end: "{",
};
/** Commands followed by a bare dimension (`\kern3pt`, `\raise 2pt`), which never prints. */
const TEX_DIMENSION_COMMANDS =
  /\\(?:kern|mkern|hskip|mskip|vskip|raise|lower|moveleft|moveright)\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|mm|cm|in|em|ex|mu|px|pc|bp|dd|cc|sp)/g;
/** Environments whose first group after `\begin{…}` is a column or count spec. */
const TEX_SPEC_ENVIRONMENTS = new Set(["array", "subarray", "tabular", "alignat", "alignedat"]);
/** Environments that take up to two `[…]` options and no spec (`\begin{multlined}[t][10cm]`). */
const TEX_OPTION_ENVIRONMENTS = new Set(["multlined", "aligned", "gathered"]);
/**
 * The definitions whose body is kept as text, and how many groups after the command it can span:
 * their `#1` parameters are blanked within it, as the arguments stand there in print.
 */
const TEX_DEFINITIONS =
  /\\(?:(?:re)?newcommand|providecommand|(?:re)?newenvironment|g?def|DeclareMathOperator|DeclarePairedDelimiterX)(?![a-zA-Z])/g;

/**
 * `text` with each definition's `#1` parameters blanked ({@link TEX_DEFINITIONS}) -- the same
 * length, so nothing else moves. Through the end of the definition's last group, counted EXACTLY:
 * the name is a group only when braced (`\newcommand{\x}{…}` two, `\newcommand\x{…}` one; `\def`
 * one; an environment three; `\DeclarePairedDelimiterX` three or four). And never past the group
 * that encloses the definition, nor 2,000 characters: with a token name the old count overshot by
 * one group, and with no group after it blanked every `#7` to the end of the report -- US bar
 * sizes ("#4 bars") went unchecked (2026-11-08, class B).
 */
function blankTexParameters(text: string): string {
  let out = text;
  for (const m of text.matchAll(TEX_DEFINITIONS)) {
    let k = (m.index ?? 0) + m[0].length;
    const braced = /^\s*\{/.test(text.slice(k));
    const named = braced ? 1 : 0;
    const want = /def$/.test(m[0])
      ? 1
      : /environment$/.test(m[0])
        ? 3
        : /X$/.test(m[0])
          ? 3 + named
          : 1 + named;
    let groups = 0;
    let depth = 0;
    const limit = Math.min(text.length, k + 2000);
    for (; k < limit && groups < want; k++) {
      if (text[k] === "\\") k++;
      else if (text[k] === "{") depth++;
      else if (text[k] === "}") {
        if (depth === 0) break; // the enclosing group ends: the definition went no further
        if (--depth === 0) groups++;
      }
    }
    const from = m.index ?? 0;
    out =
      out.slice(0, from) +
      out.slice(from, k).replace(/#+[1-9]/g, (p) => " ".repeat(p.length)) +
      out.slice(k);
  }
  return out;
}

/** `text` with every non-printing TeX argument removed (see {@link NONPRINTING_TEX}). */
function dropNonPrintingTex(source: string): string {
  const text = blankTexParameters(source);
  // A group from `at` (a "{" or "["), braces nested; returns the index past its close -- or -1 if
  // it never closes, and then nothing is dropped: running to the end dropped the rest of the
  // report from the expected tokens (2026-11-06 review).
  const group = (at: number, open: string, close: string): number => {
    let depth = 0;
    for (let i = at; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) return i + 1;
    }
    return -1;
  };
  const skipSpace = (i: number) => {
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  };
  let out = "";
  let i = 0;
  // `\\[4pt]` is a line break's extra space; only a dimension in the brackets is one. A `\\` not
  // followed by one is matched too, and skipped: it is a line break, so `\\color` is a break and
  // the TEXT "color", which prints (2026-11-06 review: it was read as \color).
  const command =
    /\\([a-zA-Z]+)|\\\\(\s*\[\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|mm|cm|in|em|ex|mu|px|pc|bp|dd|cc|sp)\s*\])?/g;
  for (let m = command.exec(text); m; m = command.exec(text)) {
    const name = m[1];
    let at = command.lastIndex;
    if (name === undefined) {
      if (m[2] === undefined) continue; // a bare `\\`
      out += `${text.slice(i, m.index)} `;
      i = at;
      continue;
    }
    const spec = Object.hasOwn(NONPRINTING_TEX, name) ? NONPRINTING_TEX[name] : undefined;
    if (spec === undefined) continue;
    let environment = "";
    let unclosed = false;
    for (const kind of spec) {
      const j = skipSpace(at);
      if (kind === "*") {
        if (text[j] === "*") at = j + 1;
      } else if (kind === "[") {
        if (text[j] === "[") at = group(j, "[", "]");
      } else if (text[j] === "{") {
        const end = group(j, "{", "}");
        if (end > 0 && name === "begin") environment = text.slice(j + 1, end - 1).trim();
        at = end;
      } else if (j < text.length) {
        at = text[j] === "\\" ? (/^\\[a-zA-Z]+/.exec(text.slice(j))?.[0].length ?? 2) + j : j + 1;
      }
      if (at < 0) {
        unclosed = true;
        break;
      }
    }
    if (!unclosed && TEX_SPEC_ENVIRONMENTS.has(environment.replace(/\*$/, ""))) {
      // `\begin{array}[t]{lcr}`: the optional vertical position comes BEFORE the column spec, and
      // with it unskipped "lcr" was expected in the PDF, a false failure (2026-11-07 review).
      let j = skipSpace(at);
      if (text[j] === "[") {
        at = group(j, "[", "]");
        j = at < 0 ? j : skipSpace(at);
      }
      if (at >= 0 && text[j] === "{") at = group(j, "{", "}");
      if (at < 0) unclosed = true;
    } else if (!unclosed && TEX_OPTION_ENVIRONMENTS.has(environment.replace(/\*$/, ""))) {
      // `\begin{multlined}[t][10cm]`: a position and a width, which never print.
      for (let n = 0; n < 2 && at >= 0; n++) {
        const j = skipSpace(at);
        if (text[j] !== "[") break;
        at = group(j, "[", "]");
      }
      if (at < 0) unclosed = true;
    }
    if (unclosed) continue;
    out += `${text.slice(i, m.index)} `;
    i = command.lastIndex = at;
  }
  return (out + text.slice(i)).replace(TEX_DIMENSION_COMMANDS, " ");
}

/**
 * The source as a reader sees it, for the verification: comments, scripts, `<noscript>` and style
 * sheets removed where an HTML parser ends them. A character scan, written apart from the bake's
 * reading (design-decisions §9). A comment opened by `<!--` ends at `-->` or `--!>`, or at once
 * when it is `<!-->` / `<!--->`; a script, noscript or style element ends at its end tag's name
 * followed by whitespace, `/` or `>`; anything unclosed runs to the end. The lazy regexes this
 * replaces read `<!-->` and `</script >` as never ending, and cut the text after them.
 */
function readerVisible(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    out += html.slice(i, lt);
    if (lower.startsWith("<!--", lt)) {
      let end: number;
      if (lower.startsWith(">", lt + 4)) end = lt + 5;
      else if (lower.startsWith("->", lt + 4)) end = lt + 6;
      else {
        const a = lower.indexOf("-->", lt + 4);
        const b = lower.indexOf("--!>", lt + 4);
        const close = [a < 0 ? Infinity : a + 3, b < 0 ? Infinity : b + 4];
        end = Math.min(...close);
        if (end === Infinity) end = html.length;
      }
      out += " ";
      i = end;
      continue;
    }
    // A <template>'s content is inert too: never drawn, so never expected (2026-11-08, class B:
    // it was a false FAIL).
    const element = /^<(script|noscript|style|template)(?=[\s/>])/.exec(lower.slice(lt, lt + 12));
    if (element) {
      const name = element[1];
      let at = sourceTagEnd(html, lt);
      for (;;) {
        const close = lower.indexOf(`</${name}`, at);
        if (close < 0) {
          at = html.length;
          break;
        }
        const after = lower[close + 2 + name.length];
        if (after === undefined || /[\s/>]/.test(after)) {
          const gt = lower.indexOf(">", close);
          at = gt < 0 ? html.length : gt + 1;
          break;
        }
        at = close + 2 + name.length;
      }
      out += " ";
      i = at;
      continue;
    }
    out += "<";
    i = lt + 1;
  }
  return out + html.slice(i);
}

/**
 * `html` without the loading spinner -- the first element whose `id` attribute is `loading` --
 * but only while it holds no text: an element that merely shares the id is content, and is
 * expected in the PDF. Written apart from the bake's removal (design-decisions §9).
 */
function withoutSpinner(html: string): string {
  for (const m of html.matchAll(SOURCE_TAG)) {
    if (m[0][1] === "/" || m.index === undefined) continue;
    // The attributes one after another, each value whole: `title="see id=loading"` is a title.
    const id = [
      ...m[0]
        .replace(/^<[^\s/>]+/, "")
        .matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g),
    ].find((a) => a[1].toLowerCase() === "id");
    if ((id?.[2] ?? id?.[3] ?? id?.[4]) !== "loading") continue;
    const name = /^<([^\s/>]+)/.exec(m[0])?.[1].toLowerCase() ?? "";
    const open = m.index + m[0].length;
    let depth = 1;
    const scan = new RegExp(`<(/?)${name.replace(/[^\w-]/g, "")}(?=[\\s/>])`, "gi");
    scan.lastIndex = open;
    for (let t = scan.exec(html); t; t = scan.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth > 0) continue;
      const content = html.slice(open, t.index);
      // A drawing is content too: an inline <svg>, or an image embedded as data (an outside one
      // never draws, so the real spinner's .gif is not one). The bake decides the same, apart.
      if (
        /<svg[\s/>]|<(?:img|image|input|object|embed|video|source)\b[^>]*?(?:src|href|data|poster|srcset)\s*=\s*["']?\s*data:/i.test(
          content,
        )
      ) {
        return html;
      }
      const inner = content.replace(SOURCE_TAG, " ");
      if (decodeEntities(inner).replace(/ /g, " ").trim() !== "") return html;
      return `${html.slice(0, m.index)} ${html.slice(sourceTagEnd(html, t.index))}`;
    }
    return html;
  }
  return html;
}

/**
 * What a reader sees of `html` before its `<body>` tag at `bodyAt` (comments, scripts and sheets
 * already blanked by {@link readerVisible}): everything from the first token a `<head>` cannot hold,
 * or "" when there is none. Tokens are read one at a time, quote-aware; written apart from the
 * bake's own reading (design-decisions §9).
 */
function bodyStartBefore(html: string, bodyAt: number): string {
  const head = html.slice(0, bodyAt);
  let i = 0;
  while (i < head.length) {
    const ch = head[i];
    if (" \t\n\f\r".includes(ch)) {
      i++;
      continue;
    }
    if (ch !== "<") return head.slice(i);
    if (/^<!doctype/i.test(head.slice(i, i + 9))) {
      i = head.indexOf(">", i) + 1 || head.length;
      continue;
    }
    const name = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(head.slice(i))?.[1]?.toLowerCase();
    if (name === undefined) return head.slice(i);
    const end = sourceTagEnd(head, i);
    if (["html", "head", "meta", "link", "base", "basefont", "bgsound"].includes(name)) {
      i = end;
    } else if ((name === "title" || name === "template") && head[i + 1] !== "/") {
      const close = head.toLowerCase().indexOf(`</${name}`, end);
      if (close < 0) return "";
      i = sourceTagEnd(head, close);
    } else {
      return head.slice(i);
    }
  }
  return "";
}

/**
 * Derive the expected content from the **raw source reports**, independently of
 * anything the bake step did.
 *
 * Deliberately shares no code with the transforms: a build and its own
 * self-assessment failing the same way is exactly what the verification exists
 * to rule out.
 */
export function extractSourceTokens(sources: string[]): SourceTokens {
  const words = new Set<string>();
  const numbers = new Set<string>();
  let expectedImages = 0;
  for (const raw of sources) {
    const one = sourceTally(raw);
    for (const w of one.words.keys()) words.add(w);
    for (const n of one.numbers.keys()) numbers.add(n);
    expectedImages += one.expectedImages;
  }
  return { words, numbers, expectedImages };
}

/**
 * The maths delimiter pairs a source declares, read by the VERIFICATION's own code -- not the
 * bake's `parseDelimiters` (design-decisions §9: a reader they shared could lose the same
 * delimiter on both sides, and every check would agree). Over-inclusive on purpose: every
 * `<script>` of any type, live or not, so a pair is looked for whenever any config names it; a
 * variable holding the array is followed. Single-character brackets are left out, as MathJax
 * reads SkyCiv's `['\[','\]']` as "[" and "]" (roadmap task 18 item 1).
 */
function declaredDelimiters(raw: string): [string, string][] {
  const scripts = [
    ...raw.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi),
  ]
    .map((m) => m[1])
    .join("\n;\n");
  /** The `[...]` at `at`, quotes respected. */
  const bracket = (at: number) => {
    let depth = 0;
    let quote = "";
    for (let i = at; i < scripts.length; i++) {
      const c = scripts[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) return scripts.slice(at, i + 1);
    }
    return "";
  };
  const jsString = (s: string) =>
    s.replace(
      /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g,
      (_m, u?: string, x?: string, c?: string) =>
        u || x ? String.fromCharCode(parseInt((u ?? x) as string, 16)) : (c ?? ""),
    );
  const pairs: [string, string][] = [];
  for (const key of scripts.matchAll(/(?<![\w$])["']?(?:inline|display)Math["']?\s*:\s*/g)) {
    const at = (key.index ?? 0) + key[0].length;
    let array = scripts[at] === "[" ? bracket(at) : "";
    const name = /^[A-Za-z_$][\w$]*/.exec(scripts.slice(at))?.[0];
    if (!array && name) {
      const assigned = [
        ...scripts.matchAll(
          new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*=(?!=)\\s*\\[`, "g"),
        ),
      ];
      for (const a of assigned) array += bracket((a.index ?? 0) + a[0].length - 1);
    }
    for (const p of array.matchAll(
      /\[\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(['"])((?:\\.|(?!\3).)*)\3\s*\]/g,
    )) {
      const open = jsString(p[2]);
      const close = jsString(p[4]);
      if (open && close && !(open.length === 1 && "[](){}<>".includes(open)))
        pairs.push([open, close]);
    }
  }
  return pairs;
}

/**
 * One report's expected content ({@link extractSourceTokens}), each word and number with the
 * number of times a reader sees it: present once was all that was checked, so a value printed
 * twice could lose an occurrence, a line or a `PASS` → `FAIL` unseen (class B, re-check 2).
 */
function sourceTally(raw: string): {
  words: Map<string, number>;
  numbers: Map<string, number>;
  /** Each number with its neighbours ({@link neighbourTally}). */
  pairs: Map<string, number>;
  expectedImages: number;
} {
  const words = new Map<string, number>();
  const numbers = new Map<string, number>();
  let pairs = new Map<string, number>();
  let expectedImages = 0;
  {
    let html = withoutSpinner(readerVisible(raw));

    // Only the body is drawn; <title> would otherwise read as missing. The body as a READER sees
    // it: everything after the <body> start tag, including text past </body> or before <body>
    // (the parser moves both in). Cut at </body>, as the bake also cut, a dropped tail was
    // missing from both sides and nothing noticed (2026-11-06). Written apart from the bake's.
    const bodyAt = html.search(/<body(?=[\s/>])/i);
    if (bodyAt >= 0) {
      // Before <body>: from the first thing a head cannot hold -- a <div> or text inside <head>
      // opens the body there (2026-11-07 review 4). A <title> past that point is still not drawn.
      const before = bodyStartBefore(html, bodyAt).replace(
        /<title(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>[\s\S]*?<\/title\s*>/gi,
        " ",
      );
      const after = html.slice(sourceTagEnd(html, bodyAt)).replace(/<\/(?:body|html)\s*>/gi, " ");
      html = `${before} ${after}`;
    }

    // An SVG's <title> (a tooltip) and <desc> are never drawn: not expected (class B). Outside an
    // <svg>, `desc` is no element of HTML's and its text IS drawn, so only inside one.
    html = html.replace(/<svg(?=[\s/>])[\s\S]*?<\/svg\s*>/gi, (svg) =>
      svg.replace(/<(title|desc)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>[\s\S]*?<\/\1\s*>/gi, " "),
    );

    // Only embedded images are counted. Deriving the figure count by subtracting
    // the spinner would mean trusting this function's loader-removal regex to
    // match the baker's, and this check is worthless if it can agree with the
    // baker's mistakes. An external image cannot render hermetically anyway,
    // and the bake step warns separately if any survives. Tags read quote-aware: a ">" inside
    // an earlier attribute's value hid the src from `[^>]*`.
    expectedImages += (html.match(SOURCE_TAG) ?? []).filter((t) =>
      /^<img\b[\s\S]*?\ssrc\s*=\s*["']data:/i.test(t),
    ).length;

    // "<" is a relational operator inside mathematics -- "30.483<\lambda_{rf}".
    // A <[^>]+> stripper would consume from there to the next ">" and swallow
    // real numbers, making this check falsely lenient. Requiring a letter after
    // "<" keeps it to genuine tags; quotes are respected, so a ">" inside an attribute value
    // does not leave the rest of the tag behind as text.
    // A phrasing tag joins what is on either side, as a browser draws it: `<b>0</b>.95` is the
    // number 0.95, `<b>Ax</b>ial` the word "Axial"; replaced by a space, each split into tokens
    // the PDF does not hold (class B, iteration 2). Every other tag -- a cell, a line break, a
    // `<sub>`/`<sup>`, which prints apart -- still separates.
    const text = dropNonPrintingTex(
      decodeEntities(html.replace(SOURCE_TAG, (tag) => (INLINE_TAG.test(tag) ? "" : " "))),
    );

    // Command and delimiter names are notation, not content: a reader never sees "dfrac". They
    // are blanked WHERE THEY ARE COMMANDS -- `\\` first, so `\\color` is a line break and the word
    // "color" -- and a command that prints a glyph leaves that glyph to expect (`\lambda` → λ).
    // Deleted from the whole report's words, one `$$\max(a)$$` stopped a "Max Moment" heading
    // being checked, and `\lambda` → φ passed (2026-11-08, class B).
    // The report's own maths delimiters print nothing either: `%%x%%` shows no "%" (read by this
    // side's own reader, {@link declaredDelimiters}).
    const delimiters = [...new Set(declaredDelimiters(raw).flat())].sort(
      (a, b) => b.length - a.length,
    );
    const unDelimited = (s: string) => delimiters.reduce((t, d) => t.split(d).join(" "), s);
    const prose = printedProse(unDelimited(text));
    // Numbers from the text as written: a sign needs nothing before it but a space or an operator,
    // so `M_{p}-0.7` keeps its BINARY minus (the `}` before it).
    // Each token counted with the SAME matcher the PDF is counted with: by tokens, `t_{w}` was no
    // "tw", but its printed "t w" matched one in the PDF, so the PDF always held a surplus and one
    // occurrence could go unseen (`of`, `tw`, `Pr`, `ry` on member_0).
    const numberText = normalizeText(prose);
    for (const n of new Set(numberTokens(prose))) {
      numbers.set(n, Math.max(1, countNumber(numberText, n)));
    }
    // Words with each sub- or superscript as its own token, as it is printed: `F_yS` is F, y and S
    // (not the "word" yS), `M_{nz}` is M and nz.
    const scripts = isolateScripts(prose);
    const exact = normalizeText(scripts);
    const lower = exact.toLowerCase();
    for (const w of new Set(wordTokens(scripts))) {
      words.set(w, Math.max(1, countWord(lower, w, exact, null)));
    }
    // Neighbours within one RUN of text -- an element's own text, one maths expression -- as they
    // stay together on the page, wrapped or not. Across elements the page's reading order is the
    // layout's, not the source's: a verdict box laid out apart made "1.0 STATUS" a pair the page
    // never prints in that order. So every tag but a phrasing one, display maths and `\\` end a
    // run; the HTML's own line breaks are spaces; TeX's grouping braces draw nothing.
    // The cells of one table row are one run, as a row prints left to right: a unit in a cell of
    // its own pairs with the number in the cell before it (`<td>12</td><td>m</td>` is "12 m"); a
    // row's end still ends the run (task 18 item 2, its last gap).
    const runs = dropNonPrintingTex(
      decodeEntities(
        html
          .replace(/\s+/g, " ")
          .replace(SOURCE_TAG, (tag) =>
            INLINE_TAG.test(tag) ? "" : CELL_TAG.test(tag) ? " " : "\n",
          ),
      ),
    );
    pairs = neighbourTally(
      isolateScripts(printedProse(unDelimited(runs), true)).replace(/[{}]/g, " "),
      true,
    );
  }

  return { words, numbers, pairs, expectedImages };
}

/**
 * What was actually found in the finished PDF, read back from disk.
 *
 * `imagePaints` counts paint operations, not images: a figure straddling a page
 * break is painted on **both** pages, so a count above the expected number
 * means something was sliced.
 */
export type PdfObservations = {
  text: string;
  pages: number;
  imagePaints: number;
  diagramTitlePages: number[];
  diagramAxisPages: number[];
  headingPages: number[];
  blankPages: number[];
};

/**
 * Outcome of comparing sources against the PDF. A non-empty `failures` means
 * the PDF does not faithfully reproduce its sources and must not be issued.
 */
export type VerificationResult = {
  missingWords: string[];
  missingNumbers: string[];
  leftoverLatex: string[];
  splitDiagrams: number[];
  failures: string[];
};

/** Compare what the sources contain against what the PDF actually shows. */
export function compareAgainstPdf(
  src: SourceTokens,
  pdf: PdfObservations,
  reportCount: number,
): VerificationResult {
  // PDF text arrives as positioned fragments, so "REFERENCES CALCULATIONS" can
  // extract as one run and a single word can arrive in pieces. Comparing token
  // sets would report both as missing. Reducing each side to a normalised
  // stream and searching by substring survives concatenation and fragmentation
  // alike; it can only under-report absence, which is the safe direction.
  // Tokens WHOLE, in the text as read with its gaps (the caller reads each item's position and
  // puts a space where items stand apart): searched as substrings of a stream with every space
  // and non-letter removed, `0.9` was found in `0.95`, `125` in `1250`, and two table cells "12"
  // and "5" read as "125" -- a value check that under-reports absence is the LENIENT direction,
  // not the safe one (2026-11-08, class B: 30% of the samples' numbers would have passed deleted).
  // A wrap within one element ({@link SOFT_BREAK}) joined where a source token stands across it.
  const text = normalizeText(resolveSoftBreaks(pdf.text, src.numbers, src.words));
  const lower = text.toLowerCase();

  const missingWords = [...src.words].filter((w) => !hasWord(lower, w, text));
  const missingNumbers = [...src.numbers].filter((n) => !hasNumber(text, n));

  // The two bracket delimiters are named explicitly, but the real protection is
  // the backslash-command pattern: it catches unrendered TeX whatever delimiter
  // was wrapped around it, including one this code has never heard of.
  // The standard TeX delimiters too: `\(a+b=12.5\)` typeset as prose has no backslash COMMAND.
  // And TeX's own sub- and superscript marks, which printed maths never shows (`F_y`, `k_{2}`,
  // `10^{-3}`): maths left as prose behind a delimiter the BAKE could not read (`inlineMath: D`, a
  // variable) carries no command and no delimiter this knows -- and the bake-side guard reads the
  // delimiters the bake read, so it missed it too (2026-11-08, class B; design-decisions §9).
  // Only the BRACED marks: a bare `x_1` or `m^2` is also how prose writes one, and failed a
  // correct report (iteration 2); maths left with bare marks only still has every character
  // checked as a word or a number.
  const leftoverLatex =
    pdf.text.match(
      /\\[a-zA-Z]{2,}|\[math\]|\[mathin\]|\\\(|\\\)|\\\[|\\\]|\$\$|[\p{L}\p{N})\]}][_^]\{/gu,
    ) ?? [];
  const splitDiagrams = pdf.diagramTitlePages.filter((p) => !pdf.diagramAxisPages.includes(p));

  const failures: string[] = [];
  if (missingWords.length || missingNumbers.length) failures.push("content missing from the PDF");
  if (leftoverLatex.length) failures.push("unrendered LaTeX in the PDF");
  if (pdf.imagePaints > src.expectedImages) failures.push("an image was split across a page break");
  if (pdf.imagePaints < src.expectedImages) {
    failures.push("fewer images drawn than the sources contain");
  }
  if (splitDiagrams.length) failures.push(`diagram split on page(s) ${splitDiagrams.join(", ")}`);
  if (pdf.headingPages.length !== reportCount) {
    failures.push("report count does not match the source");
  }
  if (pdf.blankPages.length) {
    failures.push(`blank page(s): ${pdf.blankPages.slice(0, 10).join(", ")}`);
  }

  return {
    missingWords,
    missingNumbers,
    leftoverLatex: [...leftoverLatex],
    splitDiagrams,
    failures,
  };
}

/**
 * A line break that may fall inside a token (U+2028 LINE SEPARATOR): the CLI writes it into a
 * page's text at a wrap within one element between two letters or digits, where Chrome's PDF
 * cannot say whether the wrap split a token (`word-break: break-all` printed 77.531234 as "77.5"
 * / "312" / "34") or fell at a space -- it writes no space at a line's end either way (task 18
 * item 3).
 */
const SOFT_BREAK = String.fromCharCode(0x2028);

/**
 * Each soft break decided by the source: joined where one of the source's own numbers or words
 * stands WHOLE across it ("77.5⏎312⏎34" where the source has 77.531234), a line break everywhere
 * else ("LC3⏎77.5" stays two). Decided one break at a time -- read all one way, the wrap after
 * "LC3" made "377.531234".
 */
function resolveSoftBreaks(
  text: string,
  numbers: Iterable<string>,
  words: Iterable<string>,
): string {
  if (!text.includes(SOFT_BREAK)) return text;
  const join = new Set<number>();
  const soft = "\\u2028?";
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const spanning = (re: RegExp) => {
    for (const m of text.matchAll(re)) {
      for (let k = m.index; k < m.index + m[0].length; k++) if (text[k] === SOFT_BREAK) join.add(k);
    }
  };
  for (const n of numbers) {
    spanning(new RegExp(`(?<![\\d.])${[...n].map(esc).join(soft)}(?!\\d|\\.\\d)`, "gu"));
  }
  for (const w of words) {
    if ([...w].length < 2 || !/^\p{L}+$/u.test(w)) continue;
    spanning(
      new RegExp(`(?<!\\p{L})${[...w].map(esc).join(soft)}(?!\\p{L})`, w.length > 3 ? "giu" : "gu"),
    );
  }
  return text.replace(new RegExp(SOFT_BREAK, "g"), (_c, at: number) => (join.has(at) ? "" : "\n"));
}

/** One report's own conservation: what its source holds that its own part of the PDF lacks. */
export type ReportConservation = {
  /** Position of the report in the build, 0-based — the order the sources were given in. */
  report: number;
  missingWords: string[];
  missingNumbers: string[];
};

/** Outcome of {@link compareEachReport}. `checked` is false when the PDF could not be segmented. */
export type PerReportResult = {
  checked: boolean;
  /** Why the check did not run, when `checked` is false. */
  reason: string;
  reports: ReportConservation[];
};

/**
 * Per-report conservation: each report's words and numbers must appear in ITS OWN part of the PDF.
 *
 * {@link compareAgainstPdf} checks a set union across all reports, so a value lost from one report
 * but present in another passes it (two identical members, one with a hidden row). This closes that
 * gap. The PDF is cut into whole PAGES at the report headings — the SkyCiv template prints
 * `MEMBER # n DESIGN REPORT` once per report — and report i owns the pages from the one carrying its
 * heading up to (not including) the one carrying the next. Whole pages, not the heading's position:
 * each report prints its tab strip and code line BEFORE its heading, and every report starts on a
 * new page (`.report-sheet { break-after: page }` in {@link assembleDocument}). Were a report ever to
 * start mid-page, the earlier report's tail would land in the next segment and the earlier report
 * would FAIL — the loud direction, never a silent pass. Segments are matched to `sources` in order,
 * which is the order the build assembled them in.
 *
 * Same comparison as the set-wide check (a normalised stream searched by substring), so it can only
 * under-report absence. If the number of heading pages differs from the number of sources the PDF
 * cannot be segmented: `checked` is false and `reason` says why — that is a failure for the caller,
 * never a pass.
 *
 * @param sources the raw source reports, in build order
 * @param pageTexts the extracted text of each PDF page, in page order
 * @example
 * ```ts
 * import { compareEachReport } from "@jrmarcum/s3d-reportcompiler";
 * const r = compareEachReport(["<body>MEMBER # 1 DESIGN REPORT 2.5</body>"], ["MEMBER # 1 DESIGN REPORT 2.5"]);
 * console.log(r.checked, r.reports[0].missingNumbers); // true []
 * ```
 */
export function compareEachReport(sources: string[], pageTexts: string[]): PerReportResult {
  const heading = /MEMBER\s*#?\s*\d+\s*DESIGN\s*REPORT/gi;
  const headingCount = pageTexts.reduce((n, t) => n + (t.match(heading) ?? []).length, 0);
  const starts = pageTexts.flatMap((t, p) =>
    /MEMBER\s*#?\s*\d+\s*DESIGN\s*REPORT/i.test(t) ? [p] : [],
  );
  // Two headings on one page would make two reports share it: not segmentable by page.
  if (starts.length !== sources.length || headingCount !== sources.length) {
    return {
      checked: false,
      reason: `found ${headingCount} report heading(s) on ${starts.length} page(s) for ${sources.length} source(s)`,
      reports: [],
    };
  }

  // Each segment is its OWN source's: the heading its pages print must be the one its source
  // carries, member number and all. Paired by position only, two reports exchanged in assembly
  // were each compared with the other's source, and passed when the template's shared text and
  // the member number elsewhere on the page supplied the tokens (task 18 item 7).
  const headingOf = (text: string) =>
    (text.match(/MEMBER\s*#?\s*\d+\s*DESIGN\s*REPORT/i)?.[0] ?? "")
      .replace(/\s+/g, "")
      .toUpperCase();
  for (let i = 0; i < sources.length; i++) {
    const own = headingOf(decodeEntities(readerVisible(sources[i]).replace(SOURCE_TAG, " ")));
    const printed = headingOf(pageTexts[starts[i]]);
    if (own !== printed) {
      return {
        checked: false,
        reason:
          `report ${i + 1}'s pages are headed "${printed}" but its source is "${own || "(no heading)"}" ` +
          "-- reports exchanged or out of order",
        reports: [],
      };
    }
  }

  const reports = sources.map((source, i) => {
    // The first report owns every page before its heading too: a report's own content printed
    // before the heading (a note at the top of its body, pushed onto a page of its own) belonged
    // to no segment, and -- searched as a substring -- passed only because "ref" was inside
    // "REFERENCES" (2026-11-08, class B).
    const segment = pageTexts
      .slice(i === 0 ? 0 : starts[i], i + 1 < starts.length ? starts[i + 1] : pageTexts.length)
      .join("\n");
    const own = sourceTally(source);
    // A wrap within one element ({@link SOFT_BREAK}) joined where this report's own token stands
    // whole across it, a line break everywhere else.
    const page = resolveSoftBreaks(segment, own.numbers.keys(), own.words.keys());
    const text = normalizeText(page);
    const lower = text.toLowerCase();
    // Each as many times as the source shows it: a token found fewer times is named with its
    // counts, "30.483 (2 of 3)"; one not found at all, by itself.
    const short = (want: Map<string, number>, count: (t: string) => number) =>
      [...want].flatMap(([t, n]) => {
        const found = count(t);
        return found >= n ? [] : [found === 0 ? t : `${t} (${found} of ${n})`];
      });
    const neighbours = neighbourTally(page);
    // Maths left as prose prints its delimiters: a declared pair around text in this report's own
    // pages means the bake never read it. The LaTeX check looks for the standard delimiters only;
    // a report's own -- `@@`, a bare `$` -- were looked for only as the BAKE read them, so a config
    // it could not read hid both sides at once (task 18 item 1). Named "... printed as prose".
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const printed = declaredDelimiters(source).flatMap(([open, close]) =>
      new RegExp(`${esc(open)}[^\\n]{0,200}?\\S[^\\n]{0,200}?${esc(close)}`).test(page)
        ? [`${open}..${close} printed as prose`]
        : [],
    );
    return {
      report: i,
      missingWords: [
        ...new Set(printed),
        ...short(own.words, (w) => countWord(lower, w, text, own.words.get(w.toUpperCase()) ?? 0)),
      ],
      missingNumbers: [
        ...short(own.numbers, (n) => countNumber(text, n)),
        // A number with the wrong neighbour is a changed value: "12 m" where the PDF has "12 N".
        ...short(own.pairs, (p) => neighbours.get(p) ?? 0),
      ],
    };
  });
  return { checked: true, reason: "", reports };
}

/** One report as {@link findBrokenReferences} reads it: its source, and what the bake made of it. */
export type BakedReport = {
  /** The raw source report. */
  source: string;
  /** Its baked, scoped stylesheet ({@link bakeStyle}). */
  style: string;
  /** Its baked body fragment ({@link bakeBody}). */
  body: string;
  /** The id namespace it was baked with, e.g. `"r7-"`. */
  prefix: string;
};

/** Outcome of {@link findBrokenReferences}. An empty `broken` is the only acceptable result. */
export type ReferenceCheck = {
  /** id references in the baked reports: `url(#…)` and `href` / `xlink:href` `"#…"`. */
  references: number;
  /** Distinct targets left unresolved in the bake, per report, summed (broken or not). */
  unresolved: number;
  /** References the BAKE broke: the report's position in the list, and the target it names. */
  broken: { report: number; target: string }[];
};

/**
 * The reference guard's own reading of what a page draws: comments, scripts and `<noscript>`
 * removed, left to right as the HTML parser meets them. `<!-->` and `<!--->` are whole (empty)
 * comments and `--!>` ends one; `</script >` ends a script; an unclosed one runs to the end; and
 * the content of a raw-text element (`style`, `textarea`, `title`, …) is kept as text, so a `<!--`
 * in a sheet hides nothing. The lazy `<!--…-->` it replaces ran from `<!-->` to the next `-->`,
 * hiding the source's own ids, so a reference the bake broke read as already unresolved in the
 * source and was excused (2026-11-07 review). Deliberately not the bake's reader (§9).
 */
function drawnText(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      if (html.startsWith("<!-->", lt)) i = lt + 5;
      else if (html.startsWith("<!--->", lt)) i = lt + 6;
      else {
        const a = html.indexOf("-->", lt + 4);
        const b = html.indexOf("--!>", lt + 4);
        const end = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        i = end < 0 ? html.length : end + (end === b ? 4 : 3);
      }
      continue;
    }
    const name = /^<([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])/
      .exec(html.slice(lt, lt + 40))?.[1]
      ?.toLowerCase();
    const dropped = name === "script" || name === "noscript";
    const raw = ["style", "textarea", "title", "xmp", "noembed", "noframes"].includes(name ?? "");
    if (!dropped && !raw) {
      out += "<";
      i = lt + 1;
      continue;
    }
    const close = new RegExp(`</${name}(?=[\\s/>])[^>]*>`, "g");
    close.lastIndex = lt + 1;
    const end = close.exec(lower);
    const stop = end ? end.index + end[0].length : html.length;
    if (raw) out += html.slice(lt, stop);
    i = stop;
  }
  return out + html.slice(i);
}

/**
 * id references and their targets in one document: `url(#…)` anywhere (style sheets too), and
 * `href` / `xlink:href` "#…" in start tags. Written apart from the bake's own attribute reading
 * (§9 of design-decisions: a check must not share code with what it checks). Attributes are read
 * inside start tags only, one after another, each value whole: prose ("id = 4") is not an
 * attribute, and neither is "id = 4" inside another attribute's value.
 */
function referenceScan(html: string): {
  refs: number;
  unresolved: Set<string>;
  ids: Set<string>;
  resolved: Set<string>;
} {
  const text = drawnText(html);
  const attrs = (tag: string): [string, string][] =>
    [
      ...tag
        .replace(/^<[^\s/>]+/, "")
        .matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g),
    ]
      .filter((m) => m[2] !== undefined || m[3] !== undefined || m[4] !== undefined)
      .map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? ""]);
  // Start tags read with their quoted values whole: a ">" inside one ended `<[^<>]*>` early, and
  // the id or href after it went unseen -- a broken reference read as "0 references".
  const all = (text.match(/<[a-zA-Z](?:"[^"]*"|'[^']*'|[^"'<>])*>/g) ?? []).flatMap(attrs);
  const named = (...names: string[]) => all.filter(([n]) => names.includes(n)).map(([, v]) => v);
  const ids = new Set(named("id"));
  // A fragment is percent-decoded before it is matched, as a browser does: MathJax's \eqref
  // writes href="#mjx-eqn%3At1" for id="mjx-eqn:t1", which read as broken.
  const fragment = (t: string) => {
    try {
      return decodeURIComponent(t);
    } catch {
      return t;
    }
  };
  const targets = [
    // url(#x) bare, quoted, or entity-quoted as a browser serializes a style -- in a style sheet
    // as well as an attribute, so over the whole text.
    ...[...text.matchAll(/url\(\s*(?:"|'|&quot;|&#34;|&#39;|&apos;)?#([^"')\s&]+)/gi)].map((m) =>
      fragment(m[1]),
    ),
    // Trimmed first, as a browser parses a URL: `href=" #g"` is a reference to g (class B).
    ...named("href", "xlink:href")
      .map((v) => v.trim())
      .filter((v) => /^#./.test(v))
      .map((v) => fragment(v.slice(1))),
  ];
  return {
    refs: targets.length,
    unresolved: new Set(targets.filter((t) => !ids.has(t))),
    ids,
    resolved: new Set(targets.filter((t) => ids.has(t))),
  };
}

/**
 * **The reference guard.** Every id is renamed per report, so every reference to one has to
 * follow it; one that stops resolving fails without an error -- a gradient, clip path or
 * arrowhead just disappears -- and the PDF verification counts text and image paints, not paint
 * servers. So: a reference that resolved in its own source must still resolve in its bake.
 *
 * Compared as SETS, per report: every target a report's bake (its sheet and its body) leaves
 * unresolved must be one its own source already left unresolved, as written or under its prefix
 * -- a link broken in the source stays broken, and is not the bake's doing. A count let one broken
 * reference hide behind a dangling one the bake happened to remove; one set shared by all reports
 * let report 0's dangling `#grad` excuse report 1's broken `#grad`.
 *
 * Moved here from the CLI (2026-11-06) so the browser path and library callers run it too.
 *
 * @example
 * ```ts
 * import { bakeBody, bakeStyle, findBrokenReferences } from "@jrmarcum/s3d-reportcompiler";
 * declare const sources: string[];
 * const check = findBrokenReferences(sources.map((source, i) => ({
 *   source, prefix: `r${i}-`,
 *   style: bakeStyle(source, `.rs${i}`, `r${i}-`), body: bakeBody(source, `r${i}-`),
 * })));
 * if (check.broken.length > 0) throw new Error("the bake broke an id reference");
 * ```
 */
export function findBrokenReferences(reports: BakedReport[]): ReferenceCheck {
  let references = 0;
  let unresolved = 0;
  const broken: { report: number; target: string }[] = [];
  // The ids every earlier report's bake defines: in the ONE combined document an id two reports
  // share resolves to the first, so a later report's reference to it reaches the wrong element --
  // resolved within its own report, and passed (2026-11-08, class B).
  const earlier = new Set<string>();
  reports.forEach((r, i) => {
    const baked = referenceScan(`${r.style}\n${r.body}`);
    const excused = new Set<string>();
    for (const t of referenceScan(r.source).unresolved) excused.add(t).add(`${r.prefix}${t}`);
    references += baked.refs;
    unresolved += baked.unresolved.size;
    for (const t of baked.unresolved) if (!excused.has(t)) broken.push({ report: i, target: t });
    for (const t of baked.resolved) if (earlier.has(t)) broken.push({ report: i, target: t });
    for (const id of baked.ids) earlier.add(id);
  });
  return { references, unresolved, broken };
}

/** Order report filenames the way a reader expects: member_2 before member_10. */
export function sortReportNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// The SkyCiv zip (roadmap task 16, owner 2026-11-06)
//
// SkyCiv exports a set of reports as ONE zip, which the browser saves to the user's downloads. The
// zip is read in memory (nothing is unpacked, so nothing stray can join the set), and after a
// passed verification the PDF is added back to it. Pure: bytes in, bytes out; inflating uses the
// platform's `DecompressionStream`, which Bun, Node, Deno and browsers all have.
//
// The reader REFUSES rather than guesses. Every shape it does not handle -- zip64, encryption, a
// method other than stored/deflate, folders, data outside the entries, headers that disagree, a bad
// CRC -- stops with the entry named, because a report read wrongly is a report missing from a
// certified package (the folder build refuses an unreadable `.html` for the same reason).
// ---------------------------------------------------------------------------

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
/** A report is ~60 KB; anything claiming more than this unpacked is not one. */
const ZIP_MAX_ENTRY = 256 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO-HDLC), as a zip records it. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One entry as the central directory records it, checked against its local header. */
type ZipRecord = {
  name: string;
  /** The central-directory header, verbatim (46 bytes + name + extra + comment). */
  central: Uint8Array;
  /** The local header's extra field, verbatim. */
  localExtra: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  size: number;
  /** The entry's compressed bytes (a view into the archive). */
  data: Uint8Array;
  /** The entry's comment (central directory), as text: {@link ZIP_OWN_MARK} marks this tool's PDF. */
  comment: string;
};

/** A zip, parsed and checked. Every refusal names the entry. */
function parseZip(zip: Uint8Array): { records: ZipRecord[]; comment: Uint8Array } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);
  const fail = (msg: string): never => {
    throw new Error(`not a zip this tool can read: ${msg}`);
  };
  if (zip.length < 22) fail("too short to be a zip");

  // The end record: the LAST signature whose comment runs exactly to the end of the file, so a
  // signature inside the comment cannot be taken for it.
  let end = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 22 - 0xffff); p--) {
    if (u32(p) === ZIP_END && p + 22 + u16(p + 20) === zip.length) {
      end = p;
      break;
    }
  }
  if (end < 0) fail("no end-of-archive record (damaged, or not a zip)");
  if (end >= 20 && u32(end - 20) === ZIP64_LOCATOR) fail("a zip64 archive");
  const total = u16(end + 10);
  const cdSize = u32(end + 12);
  const cdOffset = u32(end + 16);
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== total) {
    fail("a multi-part (split or spanned) archive");
  }
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail("a zip64 archive");
  if (cdOffset + cdSize !== end) {
    fail("the central directory is not where the end record puts it (damaged, or self-extracting)");
  }

  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const records: ZipRecord[] = [];
  const spans: [number, number, string][] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > end || u32(p) !== ZIP_CENTRAL) fail(`central directory entry ${i + 1} is damaged`);
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const csize = u32(p + 20);
    const size = u32(p + 24);
    const [n, e, c] = [u16(p + 28), u16(p + 30), u16(p + 32)];
    const local = u32(p + 42);
    if (p + 46 + n + e + c > end) fail(`central directory entry ${i + 1} is damaged`);
    const rawName = zip.subarray(p + 46, p + 46 + n);
    let name = "";
    try {
      // Bit 11 says UTF-8. Without it the name is in an old code page, which is read only when it
      // is plain ASCII (identical in every code page): a guess at the rest could misname a report.
      if (!(flags & 0x800) && rawName.some((b) => b >= 0x80)) throw new Error();
      name = utf8.decode(rawName);
    } catch {
      fail(`entry ${i + 1}'s name is not in UTF-8 (re-create the zip with a current tool)`);
    }
    const what = `"${name}"`;
    // A second name, which 7-Zip and Info-ZIP show instead of the first (the Info-ZIP Unicode Path
    // extra field, 0x7075): two readers would name the entry differently. Refused, in either header.
    const hasUnicodePath = (extra: Uint8Array) => {
      const v = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
      for (let k = 0; k + 4 <= extra.length; k += 4 + v.getUint16(k + 2, true)) {
        if (v.getUint16(k, true) === 0x7075) return true;
      }
      return false;
    };
    if (hasUnicodePath(zip.subarray(p + 46 + n, p + 46 + n + e))) {
      fail(`${what} carries a second, different name (a Unicode Path field)`);
    }
    if (u16(p + 34) !== 0) fail(`${what} is on another disk of a split archive`);
    if (flags & 0x2041) fail(`${what} is encrypted`);
    if (method !== 0 && method !== 8) fail(`${what} uses compression method ${method}`);
    if (csize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      fail(`${what} needs zip64`);
    }
    if (method === 0 && csize !== size) fail(`${what}: stored, but its two sizes differ`);
    if (size > ZIP_MAX_ENTRY) fail(`${what} claims ${size} bytes unpacked`);

    if (local + 30 > cdOffset || u32(local) !== ZIP_LOCAL) fail(`${what}: no local header`);
    const [ln, le] = [u16(local + 26), u16(local + 28)];
    const lflags = u16(local + 6);
    const start = local + 30 + ln + le;
    if (start + csize > cdOffset) fail(`${what} runs past the end of the entries`);
    const localName = zip.subarray(local + 30, local + 30 + ln);
    if (localName.length !== rawName.length || localName.some((b, k) => b !== rawName[k])) {
      fail(`${what}: its two headers name different files`);
    }
    if (u16(local + 8) !== method || (lflags & 0x2041) !== (flags & 0x2041)) {
      fail(`${what}: its two headers disagree`);
    }
    // Bit 3: sizes and CRC follow the data, so the local copies may be zero; otherwise they must
    // match the central directory's, or two readers could see two different files.
    if (
      !(lflags & 8) &&
      (u32(local + 14) !== crc || u32(local + 18) !== csize || u32(local + 22) !== size)
    ) {
      fail(`${what}: its two headers record different sizes or checksums`);
    }
    // Bit 3: a data descriptor follows -- 12 bytes, or 16 with its optional signature -- and it
    // must agree with the central directory too.
    let next = start + csize;
    if (lflags & 8) {
      const sig = next + 16 <= cdOffset && u32(next) === 0x08074b50 ? 4 : 0;
      if (next + sig + 12 > cdOffset) fail(`${what}: its data descriptor is missing`);
      if (
        u32(next + sig) !== crc ||
        u32(next + sig + 4) !== csize ||
        u32(next + sig + 8) !== size
      ) {
        fail(`${what}: its data descriptor disagrees with the central directory`);
      }
      next += sig + 12;
    }
    if (hasUnicodePath(zip.subarray(local + 30 + ln, start))) {
      fail(`${what} carries a second, different name (a Unicode Path field)`);
    }
    spans.push([local, next, what]);
    records.push({
      name,
      central: zip.subarray(p, p + 46 + n + e + c),
      localExtra: zip.subarray(local + 30 + ln, start),
      flags,
      method,
      crc,
      size,
      data: zip.subarray(start, start + csize),
      comment: new TextDecoder().decode(zip.subarray(p + 46 + n + e, p + 46 + n + e + c)),
    });
    p += 46 + n + e + c;
  }
  if (p !== end) fail("the central directory holds more than its entries");
  // Every byte before the central directory belongs to exactly one entry. Entries that share bytes
  // are one file under two names; bytes no entry claims are a file the directory does not list
  // (another reader, scanning local headers, would see it) -- or a self-extracting stub. Neither is
  // a SkyCiv export.
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  for (const [from, to, what] of spans) {
    if (from < covered) fail(`${what} overlaps the entry before it`);
    if (from > covered) fail(`${from - covered} byte(s) before ${what} belong to no entry`);
    covered = to;
  }
  if (covered !== cdOffset)
    fail(`${cdOffset - covered} byte(s) after the last entry belong to no entry`);
  return { records, comment: zip.subarray(end + 22) };
}

/** An entry's bytes, inflated and checked against its recorded size and CRC. */
async function zipEntryBytes(r: ZipRecord): Promise<Uint8Array> {
  const bad = (why: string): never => {
    throw new Error(`not a zip this tool can read: "${r.name}" ${why}`);
  };
  let out: Uint8Array;
  if (r.method === 0) {
    out = r.data;
  } else {
    const reader = new Blob([r.data as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        // Stopped at the recorded size, not after: a damaged or hostile entry cannot unpack to
        // more memory than it declared.
        if (length > r.size) {
          await reader.cancel();
          bad("unpacks to more than its recorded size");
        }
        chunks.push(value);
      }
    } catch (e) {
      if ((e as Error).message.startsWith("not a zip")) throw e;
      bad(`is damaged (${(e as Error).message})`);
    }
    out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
  }
  if (out.length !== r.size) bad(`unpacks to ${out.length} bytes, not the ${r.size} recorded`);
  if (crc32(out) !== r.crc) bad("fails its CRC check (damaged)");
  return out;
}

/**
 * The entry comment that marks the PDF this tool added to a zip. It is how a later run finds its
 * own PDF -- by mark, not by name, so a zip renamed after its PDF was added can still be rebuilt
 * (it was refused: "pack.pdf is not a report"), and a user's own file that merely has the name is
 * never taken for it and replaced (2026-11-06 review).
 */
const ZIP_OWN_MARK = "added by s3d-reportcompiler (verified)";

/** The entry this tool added: a PDF carrying {@link ZIP_OWN_MARK}. An `.html` with it is a report. */
const isOwnEntry = (r: ZipRecord): boolean =>
  r.comment === ZIP_OWN_MARK && r.name.toLowerCase().endsWith(".pdf");

/** The reports in a zip, and what else it held. */
export type ZipReports = {
  /** Every `.html` entry, in the zip's order, decoded as UTF-8 exactly as the folder build reads a file. */
  reports: { name: string; html: string }[];
  /** The name of the PDF an earlier run added (found by its mark), which a new one replaces; or null. */
  own: string | null;
};

/**
 * Read the reports from a SkyCiv zip: every `.html` entry, unpacked in memory and checked against
 * its CRC. Throws -- naming every problem -- on anything else in it: a folder, a nested path, a file
 * that is not `.html` (except the PDF this tool added, found by its mark), two names that differ
 * only in case, an unmarked `ownName` (a file of the user's that a build would replace), and every
 * archive shape the reader does not handle (zip64, encryption, a method other than stored or
 * deflate, damage).
 *
 * @param zip     the archive's bytes
 * @param ownName the name this build's PDF will take in the zip (compared without case)
 *
 * @example
 * ```ts
 * import { readZipReports } from "@jrmarcum/s3d-reportcompiler";
 * declare const zip: Uint8Array;
 * const { reports } = await readZipReports(zip, "pack.pdf");
 * ```
 */
export async function readZipReports(zip: Uint8Array, ownName: string): Promise<ZipReports> {
  const { records } = parseZip(zip);
  const problems: string[] = [];
  const seen = new Map<string, string>();
  let own: string | null = null;
  const html: ZipRecord[] = [];
  for (const r of records) {
    const key = r.name.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) problems.push(`"${r.name}" and "${other}" are the same name`);
    seen.set(key, r.name);
    if (r.name.endsWith("/")) problems.push(`"${r.name}" is a folder`);
    else if (/[/\\]/.test(r.name)) problems.push(`"${r.name}" is inside a folder`);
    // Only a PDF is this tool's: an `.html` carrying the mark is a report, and was dropped.
    else if (isOwnEntry(r)) own = r.name;
    else if (key === ownName.toLowerCase()) {
      problems.push(
        `"${r.name}" is not a report, and not a PDF this tool added -- a build would replace it`,
      );
    } else if (key.endsWith(".html")) html.push(r);
    else problems.push(`"${r.name}" is not a report (.html)`);
  }
  if (problems.length > 0) {
    throw new Error(
      `the zip holds more than a flat set of reports:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  const reports: ZipReports["reports"] = [];
  const unreadable: string[] = [];
  for (const r of html) {
    try {
      reports.push({ name: r.name, html: decodeReport(await zipEntryBytes(r), r.name) });
    } catch (e) {
      unreadable.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (unreadable.length > 0) throw new Error(unreadable.join("\n"));
  return { reports, own };
}

/**
 * One report's bytes as text, decoded as UTF-8 -- and refused, naming `name`, where that would not
 * be the text a browser shows: bytes that are not UTF-8, a UTF-16 byte-order mark, or a declared
 * charset other than UTF-8 (`<meta charset>` or `http-equiv` Content-Type, in the first 1024 bytes
 * as a browser looks) unless every byte is ASCII, which every such charset reads alike.
 *
 * Decoded leniently, a bad byte became U+FFFD on BOTH sides of the verification -- the bake and the
 * check read the same string -- and U+FFFD is neither a word nor a number, so `10 mm²` from a
 * Windows-1252 report printed `10 mm�` with PASS (2026-11-07 review). A leading UTF-8 byte-order
 * mark is kept as U+FEFF, as `readFile(…, "utf8")` keeps it.
 *
 * @example
 * ```ts
 * import { decodeReport } from "@jrmarcum/s3d-reportcompiler";
 * declare const bytes: Uint8Array;
 * const html = decodeReport(bytes, "member_1_report.html");
 * ```
 */
export function decodeReport(bytes: Uint8Array, name: string): string {
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) {
    throw new Error(`${name}: is UTF-16 (a byte-order mark); reports are read as UTF-8`);
  }
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(
      `${name}: is not valid UTF-8 -- its characters would print as "�"; save it as UTF-8`,
    );
  }
  if (!utf8Bom) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    const declared =
      /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([^\s"'/;>]+)/i.exec(head)?.[1]?.toLowerCase() ?? "";
    const ascii = !bytes.some((b) => b > 0x7f);
    if (declared && declared !== "utf-8" && declared !== "utf8" && !ascii) {
      throw new Error(
        `${name}: declares charset "${declared}", but is read as UTF-8 -- re-save it as UTF-8`,
      );
    }
  }
  return text;
}

/**
 * The zip with `file` added under `name`, marked as this tool's, replacing the PDF an earlier run
 * added (found by its mark, whatever its name). Every other entry's compressed data, name, CRC,
 * sizes and central-directory record are kept -- the data is never re-encoded -- in the original
 * order, as is the archive comment; each local header is rewritten (sizes in place of a data
 * descriptor) and its offset updated. The new file is appended, stored (a PDF is already
 * compressed). Throws if an unmarked entry already has `name`. Check the result with
 * {@link checkZipUpdate} before it replaces anything.
 *
 * @param date the new entry's timestamp (local time, as zips record it)
 */
export function zipWithFile(
  zip: Uint8Array,
  name: string,
  file: Uint8Array,
  date: Date,
): Uint8Array {
  const { records, comment } = parseZip(zip);
  const kept = records.filter((r) => !isOwnEntry(r));
  if (kept.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`the zip already holds "${name}", which this tool did not add`);
  }
  const nameBytes = new TextEncoder().encode(name);
  const markBytes = new TextEncoder().encode(ZIP_OWN_MARK);
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number) => {
    const b = new Uint8Array(size);
    return { b, v: new DataView(b.buffer) };
  };
  for (const r of kept) {
    const c = new DataView(r.central.buffer, r.central.byteOffset, r.central.byteLength);
    const flags = r.flags & ~8; // the sizes go in the local header; no data descriptor follows
    const { b, v } = header(30);
    v.setUint32(0, ZIP_LOCAL, true);
    v.setUint16(4, c.getUint16(6, true), true); // version needed
    v.setUint16(6, flags, true);
    v.setUint16(8, r.method, true);
    v.setUint32(10, c.getUint32(12, true), true); // time and date
    v.setUint32(14, r.crc, true);
    v.setUint32(18, r.data.length, true);
    v.setUint32(22, r.size, true);
    v.setUint16(26, c.getUint16(28, true), true);
    v.setUint16(28, r.localExtra.length, true);
    locals.push(b, r.central.subarray(46, 46 + c.getUint16(28, true)), r.localExtra, r.data);
    const central = r.central.slice();
    const cv = new DataView(central.buffer);
    cv.setUint16(8, flags, true);
    cv.setUint32(42, offset, true);
    centrals.push(central);
    offset += 30 + c.getUint16(28, true) + r.localExtra.length + r.data.length;
  }
  const utf8Flag = nameBytes.some((b) => b >= 0x80) ? 0x800 : 0;
  const crc = crc32(file);
  {
    const { b, v } = header(30);
    v.setUint32(0, ZIP_LOCAL, true);
    v.setUint16(4, 10, true);
    v.setUint16(6, utf8Flag, true);
    v.setUint16(8, 0, true);
    v.setUint16(10, dosTime, true);
    v.setUint16(12, dosDate, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, file.length, true);
    v.setUint32(22, file.length, true);
    v.setUint16(26, nameBytes.length, true);
    locals.push(b, nameBytes, file);
    const { b: cb, v: cv } = header(46);
    cv.setUint32(0, ZIP_CENTRAL, true);
    cv.setUint16(4, 20, true); // made by: MS-DOS, 2.0
    cv.setUint16(6, 10, true);
    cv.setUint16(8, utf8Flag, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.length, true);
    cv.setUint32(24, file.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(32, markBytes.length, true); // the entry comment: this tool's mark
    cv.setUint32(42, offset, true);
    centrals.push(cb, nameBytes, markBytes);
    offset += 30 + nameBytes.length + file.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  if (offset + cdSize + 22 + comment.length >= 0xffffffff || kept.length + 1 >= 0xffff) {
    throw new Error("the zip would need zip64 (over 4 GB or 65,535 entries)");
  }
  const { b: endRecord, v: ev } = header(22);
  ev.setUint32(0, ZIP_END, true);
  ev.setUint16(8, kept.length + 1, true);
  ev.setUint16(10, kept.length + 1, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  const parts = [...locals, ...centrals, endRecord, comment];
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of parts) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

/**
 * Prove that `updated` is `original` with `file` added under `name`, and nothing else changed:
 * the same entries in the same order with the same names, methods, CRCs, sizes and compressed
 * bytes; the same comment; the same reports when unpacked; and one more entry, `name`, whose
 * stored bytes ARE `file`. Returns the failures; an empty list is a pass.
 *
 * Written apart from {@link zipWithFile}, reading both archives back from their bytes, so a writer
 * bug cannot vouch for itself (design-decisions §9).
 */
export async function checkZipUpdate(
  original: Uint8Array,
  updated: Uint8Array,
  name: string,
  file: Uint8Array,
): Promise<string[]> {
  const failures: string[] = [];
  let before: ReturnType<typeof parseZip>;
  let after: ReturnType<typeof parseZip>;
  try {
    before = parseZip(original);
    after = parseZip(updated);
  } catch (e) {
    return [(e as Error).message];
  }
  const kept = before.records.filter((r) => !isOwnEntry(r));
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  if (after.records.length !== kept.length + 1) {
    failures.push(`${after.records.length} entries, expected ${kept.length + 1}`);
  }
  kept.forEach((r, i) => {
    const u = after.records[i];
    if (
      !u ||
      u.name !== r.name ||
      u.method !== r.method ||
      u.crc !== r.crc ||
      u.size !== r.size ||
      u.comment !== r.comment ||
      !same(u.data, r.data)
    ) {
      failures.push(`"${r.name}" is not carried over unchanged`);
    }
  });
  const added = after.records[after.records.length - 1];
  if (
    !added ||
    added.name !== name ||
    added.method !== 0 ||
    added.comment !== ZIP_OWN_MARK ||
    !same(added.data, file)
  ) {
    failures.push(`"${name}" is not the file that was added`);
  } else if (added.crc !== crc32(file)) {
    failures.push(`"${name}" records the wrong CRC`);
  }
  if (!same(after.comment, before.comment)) failures.push("the archive comment changed");
  try {
    const [a, b] = [await readZipReports(original, name), await readZipReports(updated, name)];
    if (
      a.reports.length !== b.reports.length ||
      a.reports.some((r, i) => r.name !== b.reports[i].name || r.html !== b.reports[i].html)
    ) {
      failures.push("the reports read back differently");
    }
    if (b.own !== name) failures.push(`"${name}" is not found by its mark`);
  } catch (e) {
    failures.push((e as Error).message);
  }
  return failures;
}
