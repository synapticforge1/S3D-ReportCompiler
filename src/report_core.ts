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
 * guard and the verification exist, and why every removal is counted in
 * {@link audit}.
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
export const VERSION = "1.1.7";

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
 * Slice a balanced `[...]` array starting at `key:`, ignoring brackets that
 * occur inside string literals.
 */
function sliceArrayLiteral(src: string, key: string): string | null {
  // The key as JavaScript allows it: bare, or quoted either way (a JSON-style config,
  // `"inlineMath": [...]`, used to go unread, and the fallback delimiters stood in for it).
  const at = src.search(new RegExp(`(?<![\\w$])(["']?)${key}\\1\\s*:\\s*\\[`));
  if (at < 0) return null;

  const start = src.indexOf("[", at + key.length);
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

/** Delimiter pairs from one config key, refusing degenerate ones. */
function readPairs(src: string, key: string, display: boolean): Delim[] {
  const arr = sliceArrayLiteral(src, key);
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
  const found = [...readPairs(src, "displayMath", true), ...readPairs(src, "inlineMath", false)];
  // The fallback is for a report with NO config. A config that was read but whose every pair was
  // refused declared its own delimiters, just unusable ones: falling back then applied delimiters
  // it never declared (a bare `$` once turned prose into maths). No delimiters instead -- the
  // guard, which looks for every standard one, refuses whatever maths the report holds.
  const declared =
    sliceArrayLiteral(src, "displayMath") !== null || sliceArrayLiteral(src, "inlineMath") !== null;
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
 * {@link cssWarnings}), and body `<style>` blocks moved into the scoped sheet (`bodySheetsMoved`).
 */
export const bakeRemovals = {
  activeAttributes: 0,
  metaBaseTags: 0,
  blocklessAtRules: 0,
  atRules: 0,
  bodySheetsMoved: 0,
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

/**
 * Scope one selector to a report's wrapper. `html`/`body`/`:root` map onto the
 * wrapper itself, since it stands in for the document once many share a page --
 * the whole leading chain of them (`html body p` is `<wrapper> p`), with any
 * qualifier settled against the source's own tag ({@link settleQualifier}).
 * Returns "" for a selector that can match nothing.
 */
function scopeSelector(selector: string, scope: string, prefix: string, roots?: RootTags): string {
  let s = selector.trim();
  if (!s) return "";

  let qualifier = "";
  let combinator = " ";
  let rooted = false;
  let lastRole: RootRole | null = null;
  for (;;) {
    const m = /^(html|body|:root)(?![\w-])/i.exec(s);
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
  const root = `${scope}${namespaceIds(qualifier, prefix)}`;
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
  /** What a root-less `@scope` means here: the document (`"body"`), or an SVG's own `<svg>`. */
  docRoot = "body",
): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let i = 0;

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
    if (open < 0) break;

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
    // deletes styling, so anything up to the last semicolon is discarded here.
    // Caveat: a selector carrying a semicolon inside an attribute value, as in
    // a[href="x;y"], would be truncated. No such selector exists in these
    // reports, and the alternative -- a full selector parser -- is not worth it.
    const lastSemicolon = prelude.lastIndexOf(";");
    if (lastSemicolon >= 0) {
      audit.strayTokensDropped++;
      prelude = prelude.slice(lastSemicolon + 1).trim();
    }

    if (prelude.startsWith("@")) {
      const name = prelude
        .slice(1)
        .split(/[\s({]/)[0]
        .toLowerCase();
      // We define page geometry ourselves; a report's own @page would fight it.
      if (name === "page") continue;
      if (NESTING_AT_RULES.has(name)) {
        out.push(`${prelude} {\n${scopeRules(block, mapSelector, idsOnly, docRoot)}\n}`);
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
          : [mapSelector(docRoot)];
        if (roots.length === 0) continue; // the root matched nothing in the source
        const limit = pm[2] ? ` to (${splitSelectorList(pm[2]).map(idsOnly).join(", ")})` : "";
        out.push(
          `@scope (${roots.join(", ")})${limit} {\n${scopeRules(block, idsOnly, idsOnly, docRoot)}\n}`,
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
    if (selectors.length > 0) out.push(`${selectors.join(", ")} {${block}}`);
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
  return html.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svg) => {
    // Every block, with any attributes: `<style type="text/css">` is the same
    // stylesheet, and matching only a bare `<style>` used to skip it.
    const blocks = [...svg.matchAll(STYLE_BLOCK)];
    if (blocks.length === 0) return svg;

    let out = svg;
    let allHoisted = true;

    for (const [, attrs, sheet] of blocks) {
      const kind = styleBlockKind(attrs);
      if (kind === "ignored") continue; // not CSS: the browser ignores it too
      if (kind !== "all") {
        // A media-qualified rule is conditional; an attribute is not. Keep it.
        svgStyleWarnings.add(`<style media="${kind}">`);
        allHoisted = false;
        continue;
      }
      allHoisted =
        hoistSvgRules(sheet, (selector, decls) => {
          out = out.replace(new RegExp(`<${selector}\\b`, "gi"), `<${selector} ${decls}`);
        }) && allHoisted;
    }

    return allHoisted ? out.replace(STYLE_BLOCK, "") : out;
  });
}

/** `<style ...>` blocks, capturing the attributes and the sheet. */
const STYLE_BLOCK = new RegExp(STYLE_ELEMENT, "gi");

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

/** A CSS value as an attribute value: no `!important`, quotes and `&` escaped. */
function attrValue(v: string): string {
  return v
    .replace(/\s*!important\s*$/i, "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
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
function hoistSvgRules(sheet: string, apply: (selector: string, attrs: string) => void): boolean {
  let allHoisted = true;
  const src = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    let depth = 0;
    let close = src.length;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) {
        close = k;
        break;
      }
    }
    // A stray ";" before a rule is discarded, as CSS error recovery does.
    const prelude = src
      .slice(i, open)
      .replace(/^[\s\S]*;/, "")
      .trim();
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
      apply(selector, decls.map(([p, v]) => `${p}="${attrValue(v)}"`).join(" "));
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
function removeElementById(html: string, id: string): string {
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
/** The TeX input, named so its label table can be reset per report (`tags.reset`). */
const texInput = new TeX({
  packages: AllPackages,
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
 * {@link seenOpeners}, {@link skippedDelims}, {@link svgStyleWarnings} and {@link cssWarnings} --
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
  texInput.parseOptions.tags.reset(0);
}

/**
 * Typeset one LaTeX expression to CHTML, updating {@link mathStats}.
 *
 * A failure returns an escaped fallback rather than throwing, so one bad
 * expression cannot abort the bake -- the guard catches what survives.
 */
function tex2html(latex: string, display: boolean): string {
  try {
    const html = adaptor.outerHTML(mjDoc.convert(latex.trim(), { display }));
    mathStats.converted++;
    return html;
  } catch (e) {
    if (mathStats.failed === 0) {
      mathStats.firstFailure = `${latex.trim().slice(0, 60)} (${e})`;
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
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
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
 * Where a kept SVG `<style>` block is confined: an attribute put on its own
 * `<svg>`. In HTML a `<style>` inside an inline SVG applies to the WHOLE
 * document, so one report's unhoisted diagram rules reached every report.
 *
 * Inside `:where()`, which adds NO specificity: a rule keeps exactly the weight
 * it had in the source. Prefixed plainly (`svg[data-s3d-scope] text`, 0-1-2), a
 * diagram's bare `text` rule (0-0-1) began to beat the report's own
 * `.rs0 svg text` (0-1-2, earlier in the page) that it used to lose to --
 * measured in Chrome, 2026-11-06.
 */
function confineToSvg(selector: string, prefix: string): string {
  const attr = `[data-s3d-scope="${prefix}"]`;
  // A rule on `svg` itself means that <svg>, and keeps its type selector's weight.
  return /^svg(?![\w-])/i.test(selector)
    ? `svg:where(${attr})${selector.slice(3)}`
    : `:where(svg${attr}) ${selector}`;
}

/**
 * The page's own `<style>` blocks, as opposed to those inside an inline `<svg>`:
 * an `<svg>` is matched whole first, so a `<style>` inside one is never matched
 * on its own. Groups 1 and 2 (attributes, sheet) are set for a page sheet only.
 */
const PAGE_STYLE_OR_SVG = new RegExp(String.raw`<svg\b[\s\S]*?<\/svg>|${STYLE_ELEMENT}`, "gi");

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
  let html = src.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // A fresh label table and equation counter for every report, as it has standing alone: MathJax
  // keeps both across conversions, so report 1's `\label{eq}` failed as "multiply defined" after
  // report 0's, and its `\eqref` could print report 0's number (2026-11-06).
  texInput.parseOptions.tags.reset(0);

  const bodyOpen = startTagRe("body", "i").exec(html);
  if (!bodyOpen) audit.bodyTagMissing++;
  const body0 = bodyOpen ? browserBody(html, bodyOpen) : html;

  // The page's own <style> blocks in the body are not dropped: bakeStyle reads
  // them, as it reads the head's, and scopes them to this report. Left here they
  // applied, unscoped, to every report on the page -- and their #id selectors
  // matched nothing once the ids were renamed. Those inside an <svg> stay; that
  // is portableSvg's job.
  let body = body0.replace(PAGE_STYLE_OR_SVG, (m, _attrs, sheet: string | undefined) => {
    if (sheet === undefined) return m;
    bakeRemovals.bodySheetsMoved++;
    return "";
  });

  // The spinner exists only to be hidden by the JS that we removed. It is the
  // one element deliberately dropped, and the count is reported.
  body = removeElementById(body, "loading");

  // One left-to-right pass over every configured pair, so they cannot
  // interleave. Each pair contributes one capture group, in the same order.
  //
  // FIRST, before any id is touched: raw LaTeX is not markup, and `x<y ... >`
  // or `id = 4` inside an expression once read as a tag or an attribute to the
  // rewrites below. After this the maths is MathJax's own markup -- whose ids
  // (\label, \eqref) are then namespaced like any other, so two reports'
  // equation numbers cannot collide either.
  if (delims.length > 0)
    body = body.replace(buildMathRegex(delims), (...args) => {
      const groups = args.slice(1, 1 + delims.length) as (string | undefined)[];
      const i = groups.findIndex((g) => g !== undefined);
      const inner = groups[i]; // undefined when i < 0: no pair matched
      return inner === undefined
        ? (args[0] as string)
        : tex2html(texFromMarkup(inner), delims[i].display);
    });

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

  // What portableSvg could not hoist stays a <style> block, which in HTML would
  // apply to every report on the page: confine it to this report's own <svg>,
  // with its id selectors renamed like the ids they select ({@link confineToSvg}).
  return portableSvg(body).replace(/<svg\b[\s\S]*?<\/svg>/gi, (svg) => {
    if (!/<style\b/i.test(svg)) return svg;
    return svg.replace(/^<svg\b/i, `<svg data-s3d-scope="${prefix}"`).replace(
      STYLE_BLOCK,
      (_m, attrs: string, sheet: string) =>
        `<style${attrs}>${scopeRules(
          sheet,
          (selector) => {
            const s = namespaceIds(selector.trim(), prefix);
            return s ? confineToSvg(s, prefix) : "";
          },
          (selector) => namespaceIds(selector, prefix),
          "svg",
        )}</style>`,
    );
  });
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
  const headClose = /<\/head\s*>/i.exec(html);
  const before =
    headClose && headClose.index < bodyOpen.index
      ? html.slice(headClose.index + headClose[0].length, bodyOpen.index)
      : "";
  return (before.trim() ? before : "") + inner + (trailing.trim() ? trailing : "");
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
  // <head>'s start tag read quote-aware; its content runs to the first </head>.
  const headOpen = startTagRe("head", "i").exec(src);
  const innerStart = headOpen ? headOpen.index + headOpen[0].length : -1;
  const headClose = headOpen ? /<\/head\s*>/i.exec(src.slice(innerStart)) : null;
  const headInner = headClose ? src.slice(innerStart, innerStart + headClose.index) : "";
  const afterHead = headClose ? innerStart + headClose.index + headClose[0].length : 0;
  // The body as bakeBody sees it: no scripts, no comments.
  const rest = src
    .slice(afterHead)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const blocks: [string, string][] = [
    ...[...headInner.matchAll(STYLE_BLOCK)].map((m) => [m[1], m[2]] as [string, string]),
    ...[...rest.matchAll(PAGE_STYLE_OR_SVG)]
      .filter((m) => m[2] !== undefined)
      .map((m) => [m[1], m[2]] as [string, string]),
  ];

  // Any attributes, as a browser reads them: `<style type="text/css">` is the
  // same sheet (a bare `<style>` match used to drop it silently), a non-CSS
  // type is ignored, and a `media` attribute stays a condition.
  let css = blocks
    .map(([attrs, sheet]) => {
      const kind = styleBlockKind(attrs);
      return kind === "ignored" ? "" : kind === "all" ? sheet : `@media ${kind} {\n${sheet}\n}`;
    })
    .join("\n")
    // At-rules with no block would confuse the brace walker.
    .replace(/@(?:import|charset|namespace)[^;]*;/gi, () => {
      bakeRemovals.blocklessAtRules++;
      return "";
    })
    // Strip comments before counting, or a commented-out rule is audited as
    // though it had been active.
    .replace(/\/\*[\s\S]*?\*\//g, "");

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
  );

  // The gate the removed JavaScript would have opened.
  css = css.replace(/visibility:\s*hidden/gi, () => {
    audit.visibilityNeutralised++;
    return "visibility: visible";
  });

  // height:100% is meaningless in paged media and makes some engines emit a
  // single viewport-tall page.
  css = css.replace(/height:\s*100%/gi, () => {
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
  `form-action 'none'; img-src data:; font-src data: ${new URL(MATHJAX_FONTS).origin}; ` +
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
const ENTITIES: Record<string, string> = {
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
    /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([A-Za-z][A-Za-z0-9]*));/g,
    (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
      if (name !== undefined) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : m;
      const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : String.fromCodePoint(code);
    },
  );
}

/**
 * Lower-cased words of three letters or more.
 *
 * Three is deliberate: PDF extraction breaks short runs on kerning, so shorter
 * tokens would produce false alarms.
 */
export function textWords(text: string): Set<string> {
  return new Set((text.match(/[A-Za-z]{3,}/g) ?? []).map((w) => w.toLowerCase()));
}

/** Distinct numeric literals, integer or decimal. */
export function textNumbers(text: string): Set<string> {
  return new Set(text.match(/\d+\.\d+|\d+/g) ?? []);
}

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
  const texCommands = new Set<string>();
  let expectedImages = 0;

  for (const raw of sources) {
    let html = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<div id="loading"[\s\S]*?<\/div>/i, " ");

    // Only the body is drawn; <title> would otherwise read as missing. The body as a READER sees
    // it: everything after the <body> start tag, including text past </body> or before <body>
    // (the parser moves both in). Cut at </body>, as the bake also cut, a dropped tail was
    // missing from both sides and nothing noticed (2026-11-06). Written apart from the bake's.
    const bodyAt = html.search(/<body(?=[\s/>])/i);
    if (bodyAt >= 0) {
      const headEnd = html.search(/<\/head\s*>/i);
      const before = headEnd >= 0 && headEnd < bodyAt ? html.slice(headEnd, bodyAt) : "";
      const after = html.slice(sourceTagEnd(html, bodyAt)).replace(/<\/(?:body|html)\s*>/gi, " ");
      html = `${before} ${after}`;
    }

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
    const text = decodeEntities(html.replace(SOURCE_TAG, " "));

    for (const c of text.match(/\\([a-zA-Z]{2,})/g) ?? []) {
      texCommands.add(c.slice(1).toLowerCase());
    }
    for (const n of textNumbers(text)) numbers.add(n);
    for (const w of textWords(text)) words.add(w);
  }

  // Command and delimiter names are notation, not content: a reader never sees
  // "dfrac". This costs a little coverage, because some command names are also
  // ordinary words -- "text", "left", "right", "delta" stop being checked as
  // prose. That is the right trade: the alternative is failing a correct build.
  for (const noise of ["mathin", "math"]) texCommands.add(noise);
  for (const c of texCommands) words.delete(c);

  return { words, numbers, expectedImages };
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
  const letters = pdf.text.toLowerCase().replace(/[^a-z]/g, "");
  const digits = pdf.text.replace(/\s+/g, "");

  const missingWords = [...src.words].filter((w) => !letters.includes(w));
  const missingNumbers = [...src.numbers].filter((n) => !digits.includes(n));

  // The two bracket delimiters are named explicitly, but the real protection is
  // the backslash-command pattern: it catches unrendered TeX whatever delimiter
  // was wrapped around it, including one this code has never heard of.
  // The standard TeX delimiters too: `\(a+b=12.5\)` typeset as prose has no backslash COMMAND.
  const leftoverLatex =
    pdf.text.match(/\\[a-zA-Z]{2,}|\[math\]|\[mathin\]|\\\(|\\\)|\\\[|\\\]|\$\$/g) ?? [];
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

  const reports = sources.map((source, i) => {
    const segment = pageTexts
      .slice(starts[i], i + 1 < starts.length ? starts[i + 1] : pageTexts.length)
      .join("\n");
    const own = extractSourceTokens([source]);
    const letters = segment.toLowerCase().replace(/[^a-z]/g, "");
    const digits = segment.replace(/\s+/g, "");
    return {
      report: i,
      missingWords: [...own.words].filter((w) => !letters.includes(w)),
      missingNumbers: [...own.numbers].filter((n) => !digits.includes(n)),
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
 * id references and their targets in one document: `url(#…)` anywhere (style sheets too), and
 * `href` / `xlink:href` "#…" in start tags. Written apart from the bake's own attribute reading
 * (§9 of design-decisions: a check must not share code with what it checks). Attributes are read
 * inside start tags only, one after another, each value whole: prose ("id = 4") is not an
 * attribute, and neither is "id = 4" inside another attribute's value.
 */
function referenceScan(html: string): { refs: number; unresolved: Set<string> } {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
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
    ...named("href", "xlink:href")
      .filter((v) => /^#./.test(v))
      .map((v) => fragment(v.slice(1))),
  ];
  return { refs: targets.length, unresolved: new Set(targets.filter((t) => !ids.has(t))) };
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
  reports.forEach((r, i) => {
    const baked = referenceScan(`${r.style}\n${r.body}`);
    const excused = new Set<string>();
    for (const t of referenceScan(r.source).unresolved) excused.add(t).add(`${r.prefix}${t}`);
    references += baked.refs;
    unresolved += baked.unresolved.size;
    for (const t of baked.unresolved) if (!excused.has(t)) broken.push({ report: i, target: t });
  });
  return { references, unresolved, broken };
}

/** Order report filenames the way a reader expects: member_2 before member_10. */
export function sortReportNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
