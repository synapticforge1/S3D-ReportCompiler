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

/**
 * Package version. Written by `bun run update-version` from deno.json, which
 * is the single source of truth -- do not edit this by hand.
 */
export const VERSION = "1.0.4";

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

/** Used only when a report carries no readable `tex2jax` config. */
export const FALLBACK_DELIMS: Delim[] = [
  { open: "[mathin]", close: "[mathin]", display: false },
  { open: "[math]", close: "[math]", display: true },
  { open: "$$", close: "$$", display: true },
  { open: "$", close: "$", display: false },
];

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
  return literal.replace(/\\(.)/g, (_m, c) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
  );
}

/**
 * Slice a balanced `[...]` array starting at `key:`, ignoring brackets that
 * occur inside string literals.
 */
function sliceArrayLiteral(src: string, key: string): string | null {
  const at = src.search(new RegExp(`${key}\\s*:\\s*\\[`));
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
  if (found.length === 0) return FALLBACK_DELIMS;

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

/**
 * Prefix id selectors, only where an id can legally appear.
 *
 * ⚠️ Doing this by plain text search would rewrite hex colours -- `#fff` is not
 * an id.
 */
function namespaceIds(selector: string, prefix: string): string {
  return selector.replace(/#([A-Za-z_][\w-]*)/g, (_m, id) => `#${prefix}${id}`);
}

/**
 * Scope one selector to a report's wrapper. `html`/`body`/`:root` map onto the
 * wrapper itself, since it stands in for the document once many share a page.
 */
function scopeSelector(selector: string, scope: string, prefix: string): string {
  const s = namespaceIds(selector.trim(), prefix);
  if (!s) return "";

  const rooted = s.replace(/^(?:html|body|:root)\b\s*/i, "");
  if (rooted !== s) return rooted ? `${scope} ${rooted}` : scope;
  return `${scope} ${s}`;
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
      if (["media", "supports", "layer", "container"].includes(name)) {
        out.push(`${prelude} {\n${scopeCss(block, scope, prefix)}\n}`);
      } else {
        // @font-face, @keyframes: no selectors to scope.
        out.push(`${prelude} {${block}}`);
      }
      continue;
    }

    const selectors = [
      ...new Set(
        prelude
          .split(",")
          .map((s) => scopeSelector(s, scope, prefix))
          .filter(Boolean),
      ),
    ];
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
    const block = svg.match(/<style>([\s\S]*?)<\/style>/i);
    if (!block) return svg;

    let out = svg;
    let allHoisted = true;

    for (const [, selectorList, declarations] of block[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls = declarations
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const i = d.indexOf(":");
          return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as const;
        })
        .filter(([prop, value]) => prop && value);

      if (decls.length === 0) continue;

      for (const selector of selectorList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(selector)) {
          svgStyleWarnings.add(selector);
          allHoisted = false;
          continue;
        }
        // Inserted immediately after the tag name so it precedes any attribute
        // already on the element. In HTML the first occurrence of a duplicated
        // attribute wins, which preserves "stylesheet beats presentation
        // attribute" -- the precedence the rule had before it was hoisted.
        const attrs = decls.map(([p, v]) => `${p}="${v}"`).join(" ");
        out = out.replace(new RegExp(`<${selector}\\b`, "gi"), `<${selector} ${attrs}`);
      }
    }

    return allHoisted ? out.replace(/<style>[\s\S]*?<\/style>/gi, "") : out;
  });
}

/**
 * Remove one element and its subtree by id.
 *
 * Matches the closing tag by depth rather than assuming the element contains no
 * nested tags of the same name.
 */
function removeElementById(html: string, id: string): string {
  const openTag = new RegExp(`<([a-zA-Z][\\w-]*)[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, "i");
  const m = html.match(openTag);
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
const mjDoc = mathjax.document("", {
  InputJax: new TeX({ packages: AllPackages }),
  OutputJax: chtml,
});

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
    return `<code>${escaped}</code>`;
  }
}

/** MathJax's stylesheet, with every glyph the document actually used. */
export function mathStyleSheet(): string {
  return adaptor.textContent(chtml.styleSheet(mjDoc) as never);
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

/**
 * Turn one report's `<body>` into a fragment ready to concatenate with others.
 *
 * Pre-renders every expression to CHTML using the report's own delimiters,
 * strips scripts, removes the loading spinner, namespaces ids with `prefix`,
 * and makes inline SVG portable. Updates {@link mathStats} and {@link audit}.
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

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) audit.bodyTagMissing++;
  let body = bodyMatch ? bodyMatch[1] : html;

  // The spinner exists only to be hidden by the JS that we removed. It is the
  // one element deliberately dropped, and the count is reported.
  body = removeElementById(body, "loading");

  // Namespace every id rather than the two this template happens to use, so
  // many documents can share one page without colliding.
  body = body.replace(/\bid\s*=\s*(["'])([^"']*)\1/gi, (_m, q, id) => `id=${q}${prefix}${id}${q}`);
  body = body.replace(
    /\bhref\s*=\s*(["'])#([^"']*)\1/gi,
    (_m, q, id) => `href=${q}#${prefix}${id}${q}`,
  );

  // One left-to-right pass over every configured pair, so they cannot
  // interleave. Each pair contributes one capture group, in the same order.
  body = body.replace(buildMathRegex(delims), (...args) => {
    const groups = args.slice(1, 1 + delims.length) as (string | undefined)[];
    const i = groups.findIndex((g) => g !== undefined);
    const inner = groups[i]; // undefined when i < 0: no pair matched
    return inner === undefined ? (args[0] as string) : tex2html(inner, delims[i].display);
  });

  return portableSvg(body);
}

/**
 * Extract one report's stylesheets and scope them to that report's wrapper.
 *
 * Also neutralises the `visibility: hidden` reveal gate and relaxes `height:
 * 100%` on wrappers, both counted in {@link audit}.
 *
 * @param scope  wrapper class selector, e.g. `".rs7"`
 * @param prefix id namespace, e.g. `"r7-"`
 */
export function bakeStyle(src: string, scope: string, prefix: string): string {
  // Only <head> styles. The reports carry a third <style> block inside the
  // diagram <svg>, which portableSvg hoists onto presentation attributes --
  // pulling it into the global sheet as well would leak an SVG-scoped rule
  // into document scope.
  const head = src.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? src;

  let css = [...head.matchAll(/<style>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n")
    // At-rules with no block would confuse the brace walker.
    .replace(/@(?:import|charset|namespace)[^;]*;/gi, "")
    // Strip comments before counting, or a commented-out rule is audited as
    // though it had been active.
    .replace(/\/\*[\s\S]*?\*\//g, "");

  audit.atPageDropped += (css.match(/@page\b/gi) ?? []).length;
  css = scopeCss(css, scope, prefix);

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

/** Wrap baked bodies and their scoped stylesheets into one printable document. */
export function assembleDocument(bodies: string[], styles: string[], mathCss: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
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

  for (const opener of seenOpeners) {
    const n = baked.split(opener).length - 1;
    if (n > 0) leftovers.push(`${n} x "${opener}"`);
  }

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

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/** Decode the HTML entities that appear in these reports. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
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

    // Only the body is drawn; <title> would otherwise read as missing.
    html = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;

    // Only embedded images are counted. Deriving the figure count by subtracting
    // the spinner would mean trusting this function's loader-removal regex to
    // match the baker's, and this check is worthless if it can agree with the
    // baker's mistakes. An external image cannot render hermetically anyway,
    // and the bake step warns separately if any survives.
    expectedImages += (html.match(/<img\b[^>]*\bsrc\s*=\s*["']data:/gi) ?? []).length;

    // "<" is a relational operator inside mathematics -- "30.483<\lambda_{rf}".
    // A <[^>]+> stripper would consume from there to the next ">" and swallow
    // real numbers, making this check falsely lenient. Requiring a letter after
    // "<" keeps it to genuine tags.
    const text = decodeEntities(html.replace(/<\/?[a-zA-Z][^>]*>/g, " "));

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
  const leftoverLatex = pdf.text.match(/\\[a-zA-Z]{2,}|\[math\]|\[mathin\]/g) ?? [];
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

/** Order report filenames the way a reader expects: member_2 before member_10. */
export function sortReportNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
