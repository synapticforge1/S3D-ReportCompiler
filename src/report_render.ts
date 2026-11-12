/**
 * A native renderer: the baked document to a PDF, with no browser (roadmap task 19: a scoped trial
 * from 2026-11-11, owner: "lets test a scoped trial and see if we can move this forward faster";
 * the CLI's renderer for every report it can draw since 2026-11-12, target 1, design-decisions §10).
 *
 * It takes the same kind of document Chrome is given ({@link assembleDocument}'s output, or one
 * report's alone from `assembleReports`) and lays it out
 * itself: its own HTML parser and its own cascade -- NOT the verifier's (`report_style.ts`,
 * `report_svg.ts`; design-decisions §9: a reader shared by both sides would make the verification's
 * style check a tautology) -- block, inline and table layout on Letter pages with 0.5 in margins,
 * and the PDF written directly (content streams of its own; pdf-lib for the document around them).
 *
 * The subset is SkyCiv's model-report template first (the 36ft report: text, tables, images).
 * Anything outside it is REFUSED by name, never approximated: a refusal is returned, and the CLI
 * sends that report to Chrome (or, under `S3D_RENDERER=native`, stops). What the subset draws
 * differently from Chrome on purpose, and why, is said where it is done (fonts: the Liberation
 * faces the package ships, embedded and subset -- metric-compatible with Arial, Courier New and
 * Times New Roman).
 *
 * Pure: no I/O.
 *
 * @module
 */

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, type PDFFont, type PDFRef } from "pdf-lib";
import { decodeEntities } from "./report_core.ts";

// ---------------------------------------------------------------------------
// Page geometry (CSS px; 96 px to the inch, 72 pt)
// ---------------------------------------------------------------------------

/** Letter, 0.5 in margins: what {@link assembleDocument}'s `@page` asks for. */
const PAGE_W_PT = 612;
const PAGE_H_PT = 792;
const MARGIN_PT = 36;
const PT = 0.75; // points per CSS px
/** The content box, in CSS px. */
const CONTENT_W = (PAGE_W_PT - 2 * MARGIN_PT) / PT; // 720
const CONTENT_H = (PAGE_H_PT - 2 * MARGIN_PT) / PT; // 960

/** What the renderer could not do, each named once. A non-empty list means no PDF may be trusted. */
class Refusals {
  readonly list = new Set<string>();
  add(what: string): void {
    this.list.add(what);
  }
}

// ---------------------------------------------------------------------------
// HTML: an element tree by HTML's nesting rules (its own reader)
// ---------------------------------------------------------------------------

type Elem = {
  tag: string;
  attrs: Map<string, string> | null;
  classes: string[];
  id: string;
  parent: Elem | null;
  kids: (Elem | string)[];
  /** 1-based position among the element children of its parent, and from the end. */
  nth: number;
  nthLast: number;
  depth: number;
  style?: Style;
};

const VOID_TAGS = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
/** Elements whose content is text the parser does not read as markup, and that draw nothing. */
const RAW_TAGS = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "template"]);
const CLOSES_P = new Set(
  (
    "address article aside blockquote center details dialog dir div dl fieldset figcaption " +
    "figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section " +
    "summary table ul"
  ).split(" "),
);

function makeElem(tag: string, parent: Elem | null, attrs: Map<string, string> | null): Elem {
  const cls = attrs?.get("class");
  return {
    tag,
    attrs,
    classes: cls ? cls.split(/\s+/).filter(Boolean) : [],
    id: attrs?.get("id") ?? "",
    parent,
    kids: [],
    nth: 0,
    nthLast: 0,
    depth: parent ? parent.depth + 1 : 0,
  };
}

/** The document's element tree; `<html>` is the root. */
function parseDocument(html: string, refuse: Refusals): Elem {
  const root = makeElem("html", null, null);
  let head: Elem | null = null;
  let body: Elem | null = null;
  const stack: Elem[] = [root];
  const top = () => stack[stack.length - 1];
  const within = (names: string[], stopAt: string[]) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (names.includes(stack[k].tag)) return k;
      if (stopAt.includes(stack[k].tag)) return -1;
    }
    return -1;
  };
  const closeTo = (names: string[], stopAt: string[]) => {
    const k = within(names, stopAt);
    if (k > 0) stack.length = k;
  };
  const append = (e: Elem) => {
    e.parent = top();
    e.depth = e.parent.depth + 1;
    e.parent.kids.push(e);
  };
  const re =
    /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>|[^<]+|</g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tok = m[0];
    if (m[2] === undefined) {
      if (tok.startsWith("<!") || tok.startsWith("<?")) continue;
      const parentTag = top().tag;
      if (/^(table|tbody|thead|tfoot|tr)$/.test(parentTag)) {
        if (tok.trim() !== "")
          refuse.add(`text directly inside <${parentTag}> (moved out by HTML)`);
        continue;
      }
      if (parentTag === "html" || parentTag === "head") {
        if (tok.trim() === "") continue;
        if (!body) {
          body = makeElem("body", root, null);
          append(body);
          stack.length = 1;
          stack.push(body);
        }
      }
      const text = decodeEntities(tok);
      const kids = top().kids;
      if (typeof kids[kids.length - 1] === "string") kids[kids.length - 1] += text;
      else kids.push(text);
      continue;
    }
    const name = m[2].toLowerCase();
    if (m[1]) {
      // An end tag.
      if (name === "html" || name === "body" || name === "head") {
        if (name === "head") closeTo(["head"], []);
        continue;
      }
      if (name === "br") {
        append(makeElem("br", top(), null));
        continue;
      }
      if (name === "p" && within(["p"], ["table", "td", "th", "button"]) < 0) {
        append(makeElem("p", top(), null)); // `</p>` with none open makes an empty one
        continue;
      }
      const tableScope = /^(td|th|tr|tbody|thead|tfoot|caption|table)$/.test(name);
      closeTo([name], tableScope ? ["html"] : ["table", "td", "th", "caption", "html"]);
      if (tableScope && name === "table" && top().tag !== "html") {
        // nothing more: the stack was cut at the table
      }
      continue;
    }
    // A start tag.
    const attrs = new Map<string, string>();
    for (const a of m[3].matchAll(/([^\s=/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const k = a[1].toLowerCase();
      if (!attrs.has(k)) attrs.set(k, decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
    }
    if (name === "html") {
      if (root.attrs === null) root.attrs = new Map();
      for (const [k, v] of attrs) if (!root.attrs.has(k)) root.attrs.set(k, v);
      continue;
    }
    if (name === "head") {
      if (!head) {
        head = makeElem("head", root, attrs);
        append(head);
        stack.length = 1;
        stack.push(head);
      }
      continue;
    }
    if (name === "body") {
      if (!body) {
        body = makeElem("body", root, attrs);
        stack.length = 1;
        append(body);
        stack.push(body);
      }
      continue;
    }
    const inHead = top().tag === "head";
    if (inHead && !/^(meta|title|style|link|base|script|noscript|template)$/.test(name)) {
      stack.length = 1;
      body = makeElem("body", root, null);
      append(body);
      stack.push(body);
    }
    if (CLOSES_P.has(name)) closeTo(["p"], ["table", "td", "th", "button", "html"]);
    if (name === "li") closeTo(["li"], ["ul", "ol", "table", "td", "th"]);
    if (name === "dt" || name === "dd") closeTo(["dt", "dd"], ["dl", "table", "td", "th"]);
    if (name === "td" || name === "th") closeTo(["td", "th"], ["tr", "table"]);
    if (name === "tr") closeTo(["tr", "td", "th"], ["table", "tbody", "thead", "tfoot"]);
    if (name === "tbody" || name === "thead" || name === "tfoot")
      closeTo(["tbody", "thead", "tfoot"], ["table"]);
    if (name === "tr" && top().tag === "table") {
      const tbody = makeElem("tbody", top(), null);
      append(tbody);
      stack.push(tbody);
    }
    if ((name === "td" || name === "th") && /^(table|tbody|thead|tfoot)$/.test(top().tag)) {
      if (top().tag === "table") {
        const tbody = makeElem("tbody", top(), null);
        append(tbody);
        stack.push(tbody);
      }
      const tr = makeElem("tr", top(), null);
      append(tr);
      stack.push(tr);
    }
    if (name === "svg" || name === "math") refuse.add(`<${name}> (a drawing or MathML)`);
    const el = makeElem(name, top(), attrs.size > 0 ? attrs : null);
    append(el);
    if (VOID_TAGS.has(name)) continue;
    if (RAW_TAGS.has(name) || name === "svg" || name === "math") {
      // Its content up to its end tag (an svg's or math's nesting balanced), kept as text.
      const close = new RegExp(`<(/?)${name}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>`, "gi");
      close.lastIndex = re.lastIndex;
      let depth = 1;
      let end = html.length;
      for (let c = close.exec(html); c; c = close.exec(html)) {
        if (name === "svg" || name === "math") depth += c[1] ? -1 : c[0].endsWith("/>") ? 0 : 1;
        else if (c[1]) depth = 0;
        if (depth === 0) {
          el.kids.push(html.slice(re.lastIndex, c.index));
          end = c.index + c[0].length;
          break;
        }
      }
      re.lastIndex = end;
      continue;
    }
    stack.push(el);
  }
  // Positions among siblings, for :nth-child and friends.
  const number = (e: Elem) => {
    const els = e.kids.filter((k): k is Elem => typeof k !== "string");
    els.forEach((k, i) => {
      k.nth = i + 1;
      k.nthLast = els.length - i;
    });
    for (const k of els) number(k);
  };
  root.nth = root.nthLast = 1;
  number(root);
  return root;
}

// ---------------------------------------------------------------------------
// CSS: rules, selectors, the cascade (its own reader)
// ---------------------------------------------------------------------------

type Decl = { prop: string; value: string; important: boolean };

type Compound = {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; op: string; value: string }[];
  pseudos: Pseudo[];
};
type Pseudo =
  | { kind: "nth"; last: boolean; a: number; b: number }
  | { kind: "is"; list: Selector[] }
  | { kind: "not"; list: Selector[] }
  | { kind: "root" }
  | { kind: "never" };
/**
 * Compounds from right to left; `combs[i]` joins compound i to compound i + 1 (leftward).
 * `element` names a pseudo-element (`before`): the rule styles that, not the element it matches.
 */
type Selector = { parts: Compound[]; combs: string[]; spec: number; element: string | null };

/** Pseudo-elements that draw nothing in print: their rules are left out, matched or not. */
const SILENT_ELEMENTS =
  /^(selection|placeholder|backdrop|-webkit-scrollbar.*|-webkit-full-page-media|-webkit-input-placeholder|-webkit-search-.*|-webkit-inner-spin-button|-webkit-outer-spin-button|-moz-.*|-ms-.*)$/;
type Rule = { sel: Selector; decls: Decl[]; order: number; origin: 0 | 1 };

/** The pseudo-classes a printed page never matches: no pointer, no focus, nothing visited. */
const NEVER =
  /^(hover|active|focus|focus-within|focus-visible|visited|target|checked|disabled|enabled|indeterminate|placeholder-shown|invalid|valid|required|optional|read-only|read-write|default|autofill|future|past|playing|paused)$/;

function parseSelectorList(text: string, refuse: Refusals): Selector[] | null {
  const parts = splitTop(text, ",");
  const out: Selector[] = [];
  for (const p of parts) {
    const s = parseSelector(p.trim(), refuse);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** Split at `sep` outside parentheses, brackets and strings. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out;
}

function parseSelector(text: string, refuse: Refusals): Selector | null {
  const compounds: Compound[] = [];
  const combs: string[] = [];
  let i = 0;
  const ident = () => {
    const m = /^-?(?:[a-zA-Z_ -￿]|\\.)(?:[\w -￿-]|\\.)*/.exec(text.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0].replace(/\\(.)/g, "$1");
  };
  let spec = 0;
  let element: string | null = null;
  while (i < text.length) {
    if (element !== null) return null; // a pseudo-element ends a selector
    const c: Compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
    let any = false;
    if (text[i] === "*") {
      i++;
      any = true;
    } else {
      const t = ident();
      if (t) {
        c.tag = t.toLowerCase();
        spec += 1;
        any = true;
      }
    }
    for (;;) {
      const ch = text[i];
      if (ch === "#") {
        i++;
        c.id = ident();
        if (c.id === null) return null;
        spec += 10000;
      } else if (ch === ".") {
        i++;
        const k = ident();
        if (k === null) return null;
        c.classes.push(k);
        spec += 100;
      } else if (ch === "[") {
        const end = text.indexOf("]", i);
        if (end < 0) return null;
        const body = text.slice(i + 1, end).trim();
        i = end + 1;
        const m = /^([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(i)?)?$/.exec(
          body,
        );
        if (!m) return null;
        if (m[6]) {
          refuse.add(`a case-insensitive attribute selector [${body}]`);
          return null;
        }
        c.attrs.push({
          name: m[1].toLowerCase(),
          op: m[2] ?? "",
          value: m[3] ?? m[4] ?? m[5] ?? "",
        });
        spec += 100;
      } else if (ch === ":") {
        if (text[i + 1] === ":") {
          // A pseudo-element: kept, refused only where its rule matches an element (styleOf).
          const name = text.slice(i + 2).match(/^[\w-]+/)?.[0] ?? "";
          if (name === "") return null;
          element = name.toLowerCase();
          i += 2 + name.length;
          if (text[i] === "(") {
            const close = text.indexOf(")", i);
            if (close < 0) return null;
            i = close + 1;
          }
          spec += 1;
          any = true;
          break;
        }
        i++;
        const name = (ident() ?? "").toLowerCase();
        // CSS 2's one-colon spellings of the four first pseudo-elements.
        if (/^(before|after|first-line|first-letter)$/.test(name)) {
          element = name;
          spec += 1;
          any = true;
          break;
        }
        let arg: string | null = null;
        if (text[i] === "(") {
          let depth = 0;
          const from = i + 1;
          for (; i < text.length; i++) {
            if (text[i] === "(") depth++;
            else if (text[i] === ")" && --depth === 0) break;
          }
          arg = text.slice(from, i);
          i++;
        }
        if (name === "first-child") c.pseudos.push({ kind: "nth", last: false, a: 0, b: 1 });
        else if (name === "last-child") c.pseudos.push({ kind: "nth", last: true, a: 0, b: 1 });
        else if (name === "only-child") {
          c.pseudos.push({ kind: "nth", last: false, a: 0, b: 1 });
          c.pseudos.push({ kind: "nth", last: true, a: 0, b: 1 });
        } else if ((name === "nth-child" || name === "nth-last-child") && arg !== null) {
          const ab = nthArgs(arg);
          if (!ab) return null;
          c.pseudos.push({ kind: "nth", last: name === "nth-last-child", a: ab[0], b: ab[1] });
        } else if (
          (name === "is" ||
            name === "where" ||
            name === "not" ||
            name === "matches" ||
            name === "-webkit-any") &&
          arg !== null
        ) {
          const list = parseSelectorList(arg, refuse);
          if (list === null) return null;
          c.pseudos.push({ kind: name === "not" ? "not" : "is", list });
          if (name !== "where") spec += Math.max(0, ...list.map((s) => s.spec));
          spec -= 0;
          continue;
        } else if (name === "root") c.pseudos.push({ kind: "root" });
        else if (NEVER.test(name)) c.pseudos.push({ kind: "never" });
        else if (name === "link" || name === "any-link")
          c.attrs.push({ name: "href", op: "", value: "" });
        else {
          refuse.add(`the pseudo-class :${name}${arg === null ? "" : `(${arg})`}`);
          return null;
        }
        spec += 100;
      } else break;
      any = true;
    }
    if (!any) return null;
    compounds.push(c);
    const ws = /^\s*/.exec(text.slice(i))?.[0].length ?? 0;
    i += ws;
    if (i >= text.length) break;
    const comb = text[i];
    if (comb === ">" || comb === "+" || comb === "~") {
      combs.push(comb);
      i++;
      i += /^\s*/.exec(text.slice(i))?.[0].length ?? 0;
    } else if (ws > 0) combs.push(" ");
    else return null;
  }
  if (compounds.length === 0) return null;
  return { parts: compounds.reverse(), combs: combs.reverse(), spec, element };
}

function nthArgs(arg: string): [number, number] | null {
  const s = arg.replace(/\s+/g, "").toLowerCase();
  if (s === "odd") return [2, 1];
  if (s === "even") return [2, 0];
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (m) {
    const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
    return [a, m[2] ? Number(m[2]) : 0];
  }
  if (/^[+-]?\d+$/.test(s)) return [0, Number(s)];
  return null;
}

function matchCompound(c: Compound, e: Elem): boolean {
  if (c.tag !== null && c.tag !== e.tag) return false;
  if (c.id !== null && c.id !== e.id) return false;
  for (const k of c.classes) if (!e.classes.includes(k)) return false;
  for (const a of c.attrs) {
    const v = e.attrs?.get(a.name);
    if (v === undefined) return false;
    switch (a.op) {
      case "":
        break;
      case "=":
        if (v !== a.value) return false;
        break;
      case "~=":
        if (!v.split(/\s+/).includes(a.value)) return false;
        break;
      case "|=":
        if (v !== a.value && !v.startsWith(`${a.value}-`)) return false;
        break;
      case "^=":
        if (a.value === "" || !v.startsWith(a.value)) return false;
        break;
      case "$=":
        if (a.value === "" || !v.endsWith(a.value)) return false;
        break;
      case "*=":
        if (a.value === "" || !v.includes(a.value)) return false;
        break;
    }
  }
  for (const p of c.pseudos) {
    if (p.kind === "never") return false;
    if (p.kind === "root") {
      if (e.parent !== null) return false;
    } else if (p.kind === "nth") {
      const n = p.last ? e.nthLast : e.nth;
      if (n === 0) return false;
      if (p.a === 0) {
        if (n !== p.b) return false;
      } else if ((n - p.b) / p.a < 0 || (n - p.b) % p.a !== 0) return false;
    } else if (p.kind === "is") {
      if (!p.list.some((s) => matches(s, e))) return false;
    } else if (p.list.some((s) => matches(s, e))) return false;
  }
  return true;
}

function matches(s: Selector, e: Elem): boolean {
  if (!matchCompound(s.parts[0], e)) return false;
  return matchFrom(s, 1, e);
}

/** Whether compounds `k`… match leftward from `e` (which matched compound k - 1). */
function matchFrom(s: Selector, k: number, e: Elem): boolean {
  if (k >= s.parts.length) return true;
  const comb = s.combs[k - 1];
  const c = s.parts[k];
  if (comb === ">") {
    const p = e.parent;
    return p !== null && matchCompound(c, p) && matchFrom(s, k + 1, p);
  }
  if (comb === " ") {
    for (let p = e.parent; p; p = p.parent)
      if (matchCompound(c, p) && matchFrom(s, k + 1, p)) return true;
    return false;
  }
  const sibs = e.parent?.kids.filter((x): x is Elem => typeof x !== "string") ?? [];
  const at = sibs.indexOf(e);
  if (comb === "+")
    return at > 0 && matchCompound(c, sibs[at - 1]) && matchFrom(s, k + 1, sibs[at - 1]);
  for (let j = at - 1; j >= 0; j--)
    if (matchCompound(c, sibs[j]) && matchFrom(s, k + 1, sibs[j])) return true;
  return false;
}

/** Every rule of a style sheet: `@media` for print (or all) read into, other at-rules left out. */
function parseSheet(css: string, origin: 0 | 1, refuse: Refusals, rules: Rule[]): void {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const block = (from: number): number => {
    // the index just past the `}` matching the `{` at `from`
    let depth = 0;
    let quote = "";
    for (let k = from; k < text.length; k++) {
      const c = text[k];
      if (quote) {
        if (c === "\\") k++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return k + 1;
    }
    return text.length;
  };
  while (i < text.length) {
    const open = text.indexOf("{", i);
    const semi = text.indexOf(";", i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    if (prelude.startsWith("@")) {
      if (semi >= 0 && semi < open) {
        // `@import` / `@charset` / `@namespace`
        if (/^@import/i.test(text.slice(i).trim())) refuse.add("an @import in a style sheet");
        i = semi + 1;
        continue;
      }
      const end = block(open);
      const m = /^@media\s+([^{]*)$/i.exec(prelude);
      if (m) {
        const applies = mediaForPrint(m[1]);
        if (applies === null) refuse.add(`a conditional @media rule (@media ${m[1].trim()})`);
        else if (applies) parseSheet(text.slice(open + 1, end - 1), origin, refuse, rules);
      } else if (!/^@(page|font-face|keyframes|-webkit-keyframes|supports)\b/i.test(prelude)) {
        refuse.add(`the at-rule ${prelude.split(/\s/)[0]}`);
      } else if (/^@supports/i.test(prelude)) refuse.add("an @supports rule");
      i = end;
      continue;
    }
    const end = block(open);
    const decls = parseDecls(text.slice(open + 1, end - 1));
    i = end;
    if (prelude === "" || decls.length === 0) continue;
    for (const p of splitTop(prelude, ",")) {
      const sel = parseSelector(p.trim(), refuse);
      if (sel === null) {
        refuse.add(`the selector ${p.trim()}`);
        continue;
      }
      rules.push({ sel, decls, order: rules.length, origin });
    }
  }
}

/**
 * Whether a media query list applies when printing: true, false, or null when it has a condition
 * this renderer does not evaluate (`(min-width: …)`, `print and (orientation: …)`). Such a rule was
 * dropped as "not print", so a sheet hiding a draft under `@media (min-width:1px)` printed the
 * draft (T1-3 review). A query naming another medium (`screen and (…)`) never applies.
 */
function mediaForPrint(query: string): boolean | null {
  let unknown = false;
  for (const q of splitTop(query, ",")) {
    const t = q.trim().toLowerCase();
    if (/^not\b/.test(t)) {
      if (/\(/.test(t)) unknown = true;
      else if (!/\bprint\b/.test(t)) return true;
      continue;
    }
    const medium = /^(?:only\s+)?([a-z-]+)\b/.exec(t)?.[1];
    if (medium !== undefined && medium !== "print" && medium !== "all") continue;
    if (/\(/.test(t)) unknown = true;
    else return true;
  }
  return unknown ? null : false;
}

function parseDecls(text: string): Decl[] {
  const out: Decl[] = [];
  for (const d of splitTop(text, ";")) {
    const c = d.indexOf(":");
    if (c < 0) continue;
    const prop = d.slice(0, c).trim().toLowerCase();
    let value = d.slice(c + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    if (prop && value) out.push({ prop, value, important });
  }
  return out;
}

/** The browser's own sheet, for what the reports use (Chrome's `html.css`, abridged). */
const UA_CSS = `
html, address, blockquote, body, dd, div, dl, dt, fieldset, form, h1, h2, h3, h4, h5, h6,
p, center, hr, pre, header, footer, section, article, aside, nav, main, figure, figcaption,
details, summary, legend, ul, ol, menu, dir { display: block }
li { display: list-item }
head, script, style, title, meta, link, base, template, noscript, datalist, param, area { display: none }
table { display: table; border-spacing: 2px; border-collapse: separate }
thead { display: table-header-group }
tbody { display: table-row-group }
tfoot { display: table-footer-group }
tr { display: table-row }
td, th { display: table-cell; padding: 1px }
th { font-weight: bold; text-align: center }
caption { display: table-caption; text-align: center }
col { display: table-column }
colgroup { display: table-column-group }
body { margin: 8px }
p { margin-top: 1em; margin-bottom: 1em }
h1 { font-size: 2em; margin-top: 0.67em; margin-bottom: 0.67em; font-weight: bold }
h2 { font-size: 1.5em; margin-top: 0.83em; margin-bottom: 0.83em; font-weight: bold }
h3 { font-size: 1.17em; margin-top: 1em; margin-bottom: 1em; font-weight: bold }
h4 { margin-top: 1.33em; margin-bottom: 1.33em; font-weight: bold }
h5 { font-size: 0.83em; margin-top: 1.67em; margin-bottom: 1.67em; font-weight: bold }
h6 { font-size: 0.67em; margin-top: 2.33em; margin-bottom: 2.33em; font-weight: bold }
hr { color: gray; border-style: inset; border-width: 1px; margin: 0.5em auto }
b, strong { font-weight: bolder }
i, em, cite, var, dfn, address { font-style: italic }
a[href] { color: #0000ee; text-decoration: underline }
sup { vertical-align: super; font-size: smaller }
sub { vertical-align: sub; font-size: smaller }
small { font-size: smaller }
big { font-size: larger }
u, ins { text-decoration: underline }
s, strike, del { text-decoration: line-through }
center { text-align: center }
pre, xmp, listing, plaintext { font-family: monospace; white-space: pre; margin-top: 1em; margin-bottom: 1em }
code, kbd, samp, tt { font-family: monospace }
`;

// ---------------------------------------------------------------------------
// Computed style
// ---------------------------------------------------------------------------

type RGBA = [number, number, number, number];
type Len = { v: number; u: "px" | "%" } | "auto";
type Edge = { w: number; style: string; color: RGBA };
type FontKey = "sans" | "serif" | "mono";

type Style = {
  display: string;
  color: RGBA;
  background: RGBA | null;
  font: FontKey;
  fontSize: number;
  bold: boolean;
  weight: number;
  italic: boolean;
  /** Line height in px, or a factor of the font size ("normal" is the font's own). */
  lineHeight: { px: number } | { factor: number } | "normal";
  textAlign: "left" | "right" | "center";
  whiteSpace: "normal" | "pre" | "nowrap";
  visible: boolean;
  margin: [Len, Len, Len, Len];
  padding: [Len, Len, Len, Len];
  border: [Edge, Edge, Edge, Edge];
  width: Len;
  height: Len;
  maxWidth: Len | "none";
  maxHeight: Len | "none";
  minWidth: Len;
  breakBefore: "auto" | "page";
  breakAfter: "auto" | "page";
  avoidInside: boolean;
  verticalAlign: "baseline" | "super" | "sub" | "middle" | "top" | "bottom";
  /** Inside a superscript or subscript, at any depth. */
  inScript: boolean;
  /** Lines drawn through or under this element's text, propagated from its ancestors. */
  decorations: { line: "underline" | "line-through" | "overline"; color: RGBA }[];
  collapse: boolean;
  spacing: number;
  /** `print-color-adjust: exact`: backgrounds print (inherited). */
  exact: boolean;
  id: number;
};

const TRANSPARENT: RGBA = [0, 0, 0, 0];
const NO_EDGE: Edge = { w: 0, style: "none", color: TRANSPARENT };

const NAMED: Record<string, RGBA> = {
  black: [0, 0, 0, 1],
  white: [255, 255, 255, 1],
  red: [255, 0, 0, 1],
  green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1],
  gray: [128, 128, 128, 1],
  grey: [128, 128, 128, 1],
  silver: [192, 192, 192, 1],
  maroon: [128, 0, 0, 1],
  navy: [0, 0, 128, 1],
  yellow: [255, 255, 0, 1],
  orange: [255, 165, 0, 1],
  purple: [128, 0, 128, 1],
  lime: [0, 255, 0, 1],
  aqua: [0, 255, 255, 1],
  teal: [0, 128, 128, 1],
  olive: [128, 128, 0, 1],
  fuchsia: [255, 0, 255, 1],
  lightgray: [211, 211, 211, 1],
  lightgrey: [211, 211, 211, 1],
  darkgray: [169, 169, 169, 1],
  darkgrey: [169, 169, 169, 1],
  transparent: [0, 0, 0, 0],
};

function parseColour(v: string, current: RGBA): RGBA | null {
  const t = v.trim().toLowerCase();
  if (t === "currentcolor") return current;
  if (NAMED[t]) return NAMED[t];
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const c = [...h].map((x) => Number.parseInt(x + x, 16));
      return [c[0], c[1], c[2], h.length === 4 ? c[3] / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const c = [0, 2, 4, 6].map((k) => Number.parseInt(h.slice(k, k + 2), 16));
      return [c[0], c[1], c[2], h.length === 8 ? c[3] / 255 : 1];
    }
    return null;
  }
  m =
    /^rgba?\(\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(
      t,
    );
  if (m) {
    const ch = (n: string, pct: string) => Math.min(255, pct ? (Number(n) * 255) / 100 : Number(n));
    const a = m[7] === undefined ? 1 : m[8] ? Number(m[7]) / 100 : Number(m[7]);
    return [ch(m[1], m[2]), ch(m[3], m[4]), ch(m[5], m[6]), Math.min(1, a)];
  }
  return null;
}

/** A length in px or %, from its CSS text (`em` against `em`, `rem` against 16). */
function parseLen(v: string, em: number): Len | null {
  const t = v.trim().toLowerCase();
  if (t === "auto") return "auto";
  if (t === "0") return { v: 0, u: "px" };
  const m = /^(-?[\d.]+)(px|em|rem|%|pt|pc|in|cm|mm|ex|ch)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "px":
      return { v: n, u: "px" };
    case "%":
      return { v: n, u: "%" };
    case "em":
      return { v: n * em, u: "px" };
    case "rem":
      return { v: n * 16, u: "px" };
    case "pt":
      return { v: (n * 96) / 72, u: "px" };
    case "pc":
      return { v: n * 16, u: "px" };
    case "in":
      return { v: n * 96, u: "px" };
    case "cm":
      return { v: (n * 96) / 2.54, u: "px" };
    case "mm":
      return { v: (n * 96) / 25.4, u: "px" };
    default:
      return null; // ex, ch: font-dependent, not read
  }
}

/** Resolved against a containing block's width. */
function px(l: Len, base: number): number {
  if (l === "auto") return 0;
  return l.u === "%" ? (l.v * base) / 100 : l.v;
}

const BORDER_WIDTHS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
const BORDER_STYLES = new Set([
  "none",
  "hidden",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);
const FONT_SIZES: Record<string, number> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
  "xxx-large": 48,
};

/** Properties read but not drawn (print colour aside, they change nothing on paper here). */
/**
 * The properties that inherit: `inherit` on any other takes its parent's value, which this
 * renderer does not do (it took the initial value: `background: inherit` drew nothing) -- refused.
 */
const INHERITED = new Set([
  "color",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-variant",
  "line-height",
  "text-align",
  "white-space",
  "visibility",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-transform",
  "border-collapse",
  "border-spacing",
  "empty-cells",
  "caption-side",
  "list-style",
  "list-style-type",
  "quotes",
  "cursor",
  "direction",
  "orphans",
  "widows",
  "print-color-adjust",
  "-webkit-print-color-adjust",
  "word-wrap",
  "overflow-wrap",
  "word-break",
]);

/**
 * The elements this renderer draws, or knows draw nothing (`head`'s). Any other is refused by
 * name: an unknown element was laid out as plain inline text, so a closed `<details>`, a
 * `<select>`'s every option, a `<canvas>`'s fallback printed, and an `<input>`'s value was lost --
 * each a PASS (T1-3 review).
 */
const DRAWN_ELEMENTS = new Set([
  "html",
  "head",
  "body",
  "title",
  "meta",
  "link",
  "style",
  "script",
  "base",
  "noscript",
  "template",
  "div",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "br",
  "center",
  "blockquote",
  "address",
  "header",
  "footer",
  "section",
  "article",
  "aside",
  "nav",
  "main",
  "figure",
  "figcaption",
  "span",
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "small",
  "big",
  "sup",
  "sub",
  "code",
  "kbd",
  "samp",
  "tt",
  "cite",
  "var",
  "dfn",
  "abbr",
  "acronym",
  "font",
  "label",
  "time",
  "data",
  "img",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "col",
  "colgroup",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "pre",
]);

/**
 * The attributes this renderer reads, or that draw nothing. Any other is refused by name: `hidden`
 * printed what Chrome hides (a superseded "1.42 FAILS", T1-3 review), `dir` was ignored.
 * Presentational ones (`align=`, `bgcolor=`, `width=` ...) are {@link presentational}'s.
 */
const READ_ATTRIBUTES =
  /^(class|id|style|src|alt|href|title|name|target|rel|lang|xml:lang|xmlns(:\w+)?|charset|content|http-equiv|type|integrity|crossorigin|referrerpolicy|loading|decoding|role|tabindex|translate|spellcheck|draggable|data-[\w.-]*|aria-[\w-]*|width|height|align|valign|bgcolor|border|cellpadding|cellspacing|color|face|size|nowrap|background|colspan|rowspan|span|summary|scope|headers|abbr|start|value)$/;

const HARMLESS = new Set([
  "cursor",
  "outline",
  "outline-color",
  "outline-style",
  "outline-width",
  "user-select",
  "-webkit-user-select",
  "pointer-events",
  "transition",
  "animation",
  "resize",
  "box-shadow", // refused below when it would draw
  "zoom",
  "list-style",
  "list-style-type",
  "speak",
  "-webkit-font-smoothing",
  "-moz-osx-font-smoothing",
  "text-rendering",
  "font-variant-ligatures",
  "font-feature-settings",
  "overflow",
  "overflow-x",
  "overflow-y",
  "word-wrap",
  "overflow-wrap",
  "word-break",
  "content",
  "quotes",
  "table-layout",
  "empty-cells",
  "caption-side",
  "orphans",
  "widows",
  "box-sizing",
  "page",
  "size",
]);

class Cascade {
  private readonly byKey = new Map<string, Rule[]>();
  private readonly cache = new Map<string, Style>();
  private nextId = 1;
  private readonly refuse: Refusals;
  constructor(rules: Rule[], refuse: Refusals) {
    this.refuse = refuse;
    for (const r of rules) {
      const c = r.sel.parts[0];
      const key =
        c.id !== null ? `#${c.id}` : c.classes.length ? `.${c.classes[0]}` : (c.tag ?? "*");
      let list = this.byKey.get(key);
      if (!list) {
        list = [];
        this.byKey.set(key, list);
      }
      list.push(r);
    }
  }

  /** The style of `e`, its parent's already computed. */
  styleOf(e: Elem, parent: Style | null): Style {
    if (!DRAWN_ELEMENTS.has(e.tag)) this.refuse.add(`the element <${e.tag}>`);
    for (const k of e.attrs?.keys() ?? []) {
      if (!READ_ATTRIBUTES.test(k)) this.refuse.add(`the ${k} attribute on <${e.tag}>`);
    }
    const cands: Rule[] = [];
    const add = (k: string) => {
      const l = this.byKey.get(k);
      if (l) for (const r of l) cands.push(r);
    };
    add("*");
    add(e.tag);
    if (e.id) add(`#${e.id}`);
    for (const c of e.classes) add(`.${c}`);
    const hit: Rule[] = [];
    const seen = new Set<Rule>();
    for (const r of cands) {
      if (seen.has(r)) continue;
      seen.add(r);
      if (!matches(r.sel, e)) continue;
      const pe = r.sel.element;
      if (pe === null) hit.push(r);
      else if (!SILENT_ELEMENTS.test(pe))
        this.refuse.add(`the pseudo-element ::${pe} on <${e.tag}>`);
    }
    const inline = e.attrs?.get("style") ?? "";
    const hints = presentational(e, this.refuse);
    const key = `${parent?.id ?? 0}|${e.tag}|${hit.map((r) => r.order).join(",")}|${inline}|${hints}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const style = this.compute(parent, hit, inline, hints, e.tag);
    this.cache.set(key, style);
    return style;
  }

  private compute(
    parent: Style | null,
    hit: Rule[],
    inline: string,
    hints: string,
    tag: string,
  ): Style {
    // Declarations in cascade order: UA, author, author inline; then the important ones.
    type D = Decl & { rank: number };
    const ds: D[] = [];
    for (const r of hit) {
      for (const d of r.decls) {
        const level = d.important ? (r.origin === 0 ? 5 : 3) : r.origin === 0 ? 0 : 1;
        ds.push({ ...d, rank: level * 1e12 + r.sel.spec * 1e5 + r.order });
      }
    }
    for (const d of parseDecls(hints)) ds.push({ ...d, rank: 0.5e12 });
    for (const d of parseDecls(inline)) ds.push({ ...d, rank: (d.important ? 4 : 2) * 1e12 });
    ds.sort((a, b) => a.rank - b.rank);
    const v = new Map<string, string>();
    for (const d of ds) for (const [p, x] of expand(d.prop, d.value, this.refuse)) v.set(p, x);

    const inh = parent;
    const get = (p: string): string | undefined => {
      const x = v.get(p);
      return x === "inherit" || x === "unset" || x === "initial" ? undefined : x;
    };
    const inheritOf = (p: string) => v.get(p) === "inherit";
    for (const [p, x] of v) {
      if (!KNOWN.has(p) && !HARMLESS.has(p)) this.refuse.add(`the CSS property ${p}`);
      if (p === "box-shadow" && x !== "none") this.refuse.add("box-shadow");
      if ((p === "letter-spacing" || p === "word-spacing") && x !== "normal" && x !== "0")
        this.refuse.add(p);
      if (p === "text-indent" && !/^0(px|em|%)?$/.test(x)) this.refuse.add("text-indent");
      if (p === "text-transform" && x !== "none") this.refuse.add("text-transform");
      if (p === "float" && x !== "none") this.refuse.add(`float: ${x}`);
      if (p === "position" && x !== "static" && x !== "relative") this.refuse.add(`position: ${x}`);
      if (p === "transform" && x !== "none") this.refuse.add("transform");
      if (p === "background-image" && x !== "none") this.refuse.add("a background image");
      if (p === "opacity" && Number(x) !== 1) this.refuse.add("opacity");
      if (p === "visibility" && x === "collapse") this.refuse.add("visibility: collapse");
      if (
        (p === "top" || p === "left" || p === "right" || p === "bottom") &&
        x !== "auto" &&
        v.get("position") === "relative" &&
        !/^0(px|%)?$/.test(x)
      )
        this.refuse.add("a relative offset");
      if (p === "clip-path" || p === "mask" || p === "filter") if (x !== "none") this.refuse.add(p);
      // T1-3 review: each of these was read as something else, or not read, and drew otherwise
      // than Chrome with no refusal.
      if (/^(initial|revert|revert-layer)$/.test(x)) this.refuse.add(`the keyword ${x} (${p})`);
      if (x === "inherit" && !INHERITED.has(p)) this.refuse.add(`inherit on ${p}`);
      if (/^margin/.test(p) && /(^|\s)-\s*(\d*\.)?\d*[1-9]/.test(x))
        this.refuse.add("a negative margin");
      if (p === "min-width" && !/^(0(\.0+)?(px|em|%)?|auto)$/.test(x))
        this.refuse.add(`min-width: ${x}`);
      if (p === "max-width" && x !== "none" && tag !== "img")
        this.refuse.add(`max-width on <${tag}>`);
      if (
        p === "box-sizing" &&
        x === "border-box" &&
        ["width", "height", "min-width", "max-width", "max-height"].some(
          (q) => v.has(q) && !/^(auto|none)$/.test(v.get(q) as string),
        )
      )
        this.refuse.add("box-sizing: border-box with a set width or height");
    }

    // Font size first: em lengths below are of this size.
    const pSize = inh?.fontSize ?? 16;
    let fontSize = pSize;
    const fs = get("font-size");
    if (fs !== undefined && !inheritOf("font-size")) {
      if (FONT_SIZES[fs] !== undefined) fontSize = FONT_SIZES[fs];
      else if (fs === "smaller") fontSize = pSize / 1.2;
      else if (fs === "larger") fontSize = pSize * 1.2;
      else {
        const l = parseLen(fs, pSize);
        if (l === null || l === "auto") this.refuse.add(`font-size: ${fs}`);
        else fontSize = l.u === "%" ? (l.v * pSize) / 100 : l.v;
      }
    }
    const em = fontSize;
    const len = (p: string, fallback: Len): Len => {
      const x = get(p);
      if (x === undefined) return fallback;
      const l = parseLen(x, em);
      if (l === null) {
        this.refuse.add(`${p}: ${x}`);
        return fallback;
      }
      return l;
    };
    const color = (() => {
      const x = get("color");
      if (x === undefined) return inh?.color ?? ([0, 0, 0, 1] as RGBA);
      const c = parseColour(x, inh?.color ?? [0, 0, 0, 1]);
      if (!c) this.refuse.add(`color: ${x}`);
      return c ?? inh?.color ?? ([0, 0, 0, 1] as RGBA);
    })();
    const edge = (side: string): Edge => {
      const style = get(`border-${side}-style`) ?? "none";
      if (!BORDER_STYLES.has(style)) this.refuse.add(`border-style: ${style}`);
      if (style === "none" || style === "hidden") return NO_EDGE;
      if (!/^(solid|inset|outset)$/.test(style)) this.refuse.add(`a ${style} border`);
      const wv = get(`border-${side}-width`) ?? "medium";
      const wl =
        BORDER_WIDTHS[wv] ??
        (() => {
          const l = parseLen(wv, em);
          if (l === null || l === "auto" || l.u === "%") {
            this.refuse.add(`border-width: ${wv}`);
            return 0;
          }
          return l.v;
        })();
      const cv = get(`border-${side}-color`) ?? "currentcolor";
      const c = parseColour(cv, color);
      if (!c) this.refuse.add(`border-color: ${cv}`);
      // Chrome rounds a border down to whole device pixels, at least one.
      const w = wl > 0 && wl < 1 ? 1 : Math.floor(wl);
      return { w, style, color: c ?? color };
    };
    const display = get("display") ?? "inline";
    const fam = get("font-family");
    const weightV = get("font-weight");
    const pWeight = inh?.weight ?? 400;
    let weight = pWeight;
    if (weightV !== undefined && !inheritOf("font-weight")) {
      if (weightV === "bold") weight = 700;
      else if (weightV === "normal") weight = 400;
      else if (weightV === "bolder") weight = pWeight < 350 ? 400 : pWeight < 550 ? 700 : 900;
      else if (weightV === "lighter") weight = pWeight < 550 ? 100 : pWeight < 750 ? 400 : 700;
      else if (/^\d+$/.test(weightV)) weight = Number(weightV);
      else this.refuse.add(`font-weight: ${weightV}`);
    }
    const styleV = get("font-style");
    const italic =
      styleV === undefined || inheritOf("font-style")
        ? (inh?.italic ?? false)
        : styleV !== "normal";
    const lhV = get("line-height");
    let lineHeight: Style["lineHeight"] = inh?.lineHeight ?? "normal";
    if (lhV !== undefined && !inheritOf("line-height")) {
      if (lhV === "normal") lineHeight = "normal";
      else if (/^[\d.]+$/.test(lhV)) lineHeight = { factor: Number(lhV) };
      else {
        const l = parseLen(lhV, em);
        if (l === null || l === "auto") this.refuse.add(`line-height: ${lhV}`);
        else lineHeight = { px: l.u === "%" ? (l.v * em) / 100 : l.v };
      }
    }
    const taV = get("text-align");
    let textAlign = inh?.textAlign ?? "left";
    if (taV !== undefined && !inheritOf("text-align")) {
      if (taV === "left" || taV === "start" || taV === "-webkit-left") textAlign = "left";
      else if (taV === "right" || taV === "end" || taV === "-webkit-right") textAlign = "right";
      else if (taV === "center" || taV === "-webkit-center") textAlign = "center";
      else this.refuse.add(`text-align: ${taV}`);
    }
    const wsV = get("white-space");
    let whiteSpace = inh?.whiteSpace ?? "normal";
    if (wsV !== undefined && !inheritOf("white-space")) {
      // `pre` is refused: runs of spaces were collapsed, so pre-aligned columns lost their places
      // (T1-3 review: "[1  000]" printed "[1 000]").
      if (wsV === "normal" || wsV === "nowrap") whiteSpace = wsV;
      else this.refuse.add(`white-space: ${wsV}`);
    }
    const visV = get("visibility");
    const visible =
      visV === undefined || inheritOf("visibility") ? (inh?.visible ?? true) : visV !== "hidden";
    let background: RGBA | null = null;
    const bgV = get("background-color");
    if (bgV !== undefined) {
      const c = parseColour(bgV, color);
      if (!c) this.refuse.add(`background-color: ${bgV}`);
      else if (c[3] > 0) background = c;
    }
    const vaV = get("vertical-align") ?? "baseline";
    if (!/^(baseline|super|sub|middle|top|bottom)$/.test(vaV))
      this.refuse.add(`vertical-align: ${vaV}`);
    // A superscript inside a superscript (or a subscript) shifts by its own style only, so 10²³
    // drew the 3 BELOW the 2 (T1-3 review): refused, however deep the nesting.
    const script = vaV === "super" || vaV === "sub";
    if (script && inh?.inScript) this.refuse.add("a superscript or subscript inside another");
    const decorations = [...(inh?.decorations ?? [])];
    const tdV = get("text-decoration-line") ?? get("text-decoration");
    if (tdV !== undefined && tdV !== "none") {
      for (const w of tdV.split(/\s+/)) {
        if (w === "underline" || w === "line-through" || w === "overline")
          decorations.push({ line: w, color });
        else if (!/^(solid|none)$/.test(w) && !parseColour(w, color))
          this.refuse.add(`text-decoration: ${tdV}`);
      }
    }
    const brk = (p: string): "auto" | "page" => {
      const x = get(p);
      return x === "always" || x === "page" || x === "left" || x === "right" ? "page" : "auto";
    };
    const avoidV = get("page-break-inside") ?? get("break-inside");
    const exactV = get("-webkit-print-color-adjust") ?? get("print-color-adjust");
    const exact =
      exactV === undefined || inheritOf("print-color-adjust")
        ? (inh?.exact ?? false)
        : exactV === "exact";
    const spacingV = get("border-spacing");
    let spacing = inh?.spacing ?? 0;
    if (spacingV !== undefined) {
      const l = parseLen(spacingV.split(/\s+/)[0], em);
      if (l === null || l === "auto" || l.u === "%" || spacingV.trim().split(/\s+/).length > 1)
        this.refuse.add(`border-spacing: ${spacingV}`);
      else spacing = l.v;
    }
    const collapseV = get("border-collapse");
    const collapse = collapseV === undefined ? (inh?.collapse ?? false) : collapseV === "collapse";
    const mw = get("max-width");
    const mh = get("max-height");
    return {
      display,
      color,
      background,
      font:
        fam === undefined || inheritOf("font-family")
          ? (inh?.font ?? "serif")
          : fontKey(fam, this.refuse),
      fontSize,
      weight,
      bold: weight >= 600,
      italic,
      lineHeight,
      textAlign,
      whiteSpace,
      visible,
      margin: (["top", "right", "bottom", "left"] as const).map((s) =>
        len(`margin-${s}`, { v: 0, u: "px" }),
      ) as Style["margin"],
      padding: (["top", "right", "bottom", "left"] as const).map((s) =>
        len(`padding-${s}`, { v: 0, u: "px" }),
      ) as Style["padding"],
      border: [edge("top"), edge("right"), edge("bottom"), edge("left")],
      width: len("width", "auto"),
      height: len("height", "auto"),
      maxWidth: mw === undefined || mw === "none" ? "none" : len("max-width", "auto"),
      maxHeight: mh === undefined || mh === "none" ? "none" : len("max-height", "auto"),
      minWidth: len("min-width", { v: 0, u: "px" }),
      breakBefore: brk("page-break-before") === "page" ? "page" : brk("break-before"),
      breakAfter: brk("page-break-after") === "page" ? "page" : brk("break-after"),
      avoidInside: avoidV === "avoid" || avoidV === "avoid-page",
      verticalAlign: vaV as Style["verticalAlign"],
      inScript: script || (inh?.inScript ?? false),
      decorations,
      collapse,
      spacing,
      exact,
      id: this.nextId++,
    };
  }
}

/** Every property this renderer reads. */
const KNOWN = new Set([
  "display",
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "text-align",
  "white-space",
  "visibility",
  "vertical-align",
  "text-decoration",
  "text-decoration-line",
  "page-break-before",
  "page-break-after",
  "page-break-inside",
  "break-before",
  "break-after",
  "break-inside",
  "-webkit-print-color-adjust",
  "print-color-adjust",
  "border-spacing",
  "border-collapse",
  "width",
  "height",
  "max-width",
  "max-height",
  "min-width",
  "float",
  "position",
  "top",
  "left",
  "right",
  "bottom",
  "opacity",
  "transform",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-transform",
  "clip-path",
  "mask",
  "filter",
  ...["top", "right", "bottom", "left"].flatMap((s) => [
    `margin-${s}`,
    `padding-${s}`,
    `border-${s}-width`,
    `border-${s}-style`,
    `border-${s}-color`,
  ]),
]);

/** A shorthand as its longhands; anything else as itself. */
function expand(prop: string, value: string, refuse: Refusals): [string, string][] {
  const sides = ["top", "right", "bottom", "left"];
  const four = (v: string) => {
    const p = splitTop(v.trim().replace(/\s+/g, " "), " ");
    const [a, b = a, c = a, d = b] = p;
    return [a, b, c, d];
  };
  const global = /^(inherit|initial|unset)$/.test(value.trim());
  switch (prop) {
    case "margin":
    case "padding": {
      const v = global ? [value, value, value, value] : four(value);
      return sides.map((s, k) => [`${prop}-${s}`, v[k]]);
    }
    case "border-width":
    case "border-style":
    case "border-color": {
      const kind = prop.slice(7);
      const v = global ? [value, value, value, value] : four(value);
      return sides.map((s, k) => [`border-${s}-${kind}`, v[k]]);
    }
    case "border":
    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left": {
      const which = prop === "border" ? sides : [prop.slice(7)];
      let w = "medium";
      let st = "none";
      let c = "currentcolor";
      for (const t of splitTop(value.trim().replace(/\s+/g, " "), " ")) {
        if (BORDER_STYLES.has(t)) st = t;
        else if (BORDER_WIDTHS[t] !== undefined || /^[\d.]/.test(t)) w = t;
        else c = t;
      }
      return which.flatMap((s): [string, string][] => [
        [`border-${s}-width`, w],
        [`border-${s}-style`, st],
        [`border-${s}-color`, c],
      ]);
    }
    case "background": {
      if (/url\(|gradient\(/i.test(value)) {
        refuse.add("a background image");
        return [];
      }
      const t = value.trim();
      if (t === "none") return [["background-color", "transparent"]];
      return [["background-color", t]];
    }
    case "font":
      refuse.add("the font shorthand");
      return [];
    case "text-decoration":
      return [["text-decoration", value]];
    default:
      return [[prop, value]];
  }
}

/** Presentational attributes, as CSS (only the ones read; the rest refused). */
function presentational(e: Elem, refuse: Refusals): string {
  if (!e.attrs) return "";
  let out = "";
  for (const [k, v] of e.attrs) {
    if (k === "width" || k === "height") {
      if (e.tag === "img") {
        const n = /^\s*(\d+(?:\.\d+)?)(%?)\s*$/.exec(v);
        if (n) out += `${k}: ${n[1]}${n[2] || "px"};`;
        // `width="100px"` is not a number: it was ignored, the image drawn at its own size (T1-3).
        else refuse.add(`the ${k}="${v}" attribute on <img>`);
      } else refuse.add(`the ${k}= attribute on <${e.tag}>`);
    } else if (
      /^(align|valign|bgcolor|border|cellpadding|cellspacing|color|face|size|nowrap|background|colspan|rowspan|span)$/.test(
        k,
      )
    ) {
      if ((k === "colspan" || k === "rowspan") && v.trim() === "1") continue;
      refuse.add(`the ${k}= attribute on <${e.tag}>`);
    }
  }
  return out;
}

/** Font families installed with Windows or macOS, which Chrome would use where named. */
const INSTALLED_FAMILIES =
  /^(verdana|tahoma|calibri|cambria|cambria math|candara|consolas|constantia|corbel|segoe ui|segoe ui symbol|segoe ui emoji|georgia|trebuchet ms|comic sans ms|impact|palatino linotype|book antiqua|palatino|lucida console|lucida sans unicode|lucida grande|lucida sans|garamond|century gothic|franklin gothic medium|gill sans|optima|futura|menlo|monaco|sf pro text|sf pro display|-apple-system|system-ui|blinkmacsystemfont|symbol|wingdings|webdings|ms gothic|ms mincho|ms sans serif|ms serif|microsoft sans serif|arial narrow|arial black|courier std)$/;

function fontKey(families: string, refuse: Refusals): FontKey {
  for (const f of splitTop(families, ",")) {
    const n = f
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase();
    if (/^(arial|helvetica|helvetica neue|sans-serif|liberation sans|arimo)$/.test(n))
      return "sans";
    if (/^(courier new|courier|monospace|liberation mono|cousine)$/.test(n)) return "mono";
    // A family Chrome finds on an ordinary Windows or Mac host: passed over, the text took
    // another face's metrics -- and Symbol's Greek drew as Latin (T1-3 review). Refused.
    if (INSTALLED_FAMILIES.test(n)) {
      refuse.add(`the font family "${n}" (installed on common systems; no face here matches it)`);
      return "serif";
    }
    if (/^(times new roman|times|serif|liberation serif|tinos)$/.test(n)) return "serif";
    // A family not on this host (Lato, Helvetica Neue on Windows): the next one, as Chrome does.
  }
  refuse.add(`no font this renderer has in "${families}"`);
  return "serif";
}

// ---------------------------------------------------------------------------
// Fonts: Liberation, embedded, with the vertical metrics of the faces Chrome uses
// ---------------------------------------------------------------------------

/**
 * The fonts {@link renderDocument} draws in, by family: regular, bold, italic, bold italic, each a
 * TrueType file's bytes. The package ships Liberation 2.1.5 (SIL OFL 1.1, `fonts/liberation/`),
 * read and checked by the runtime's `readRenderFonts`: metric-compatible with the Arial, Courier
 * New and Times New Roman Chrome draws a SkyCiv report in on Windows -- every glyph the same
 * advance -- and EMBEDDED (subset to the glyphs printed), so every viewer shows the faces the
 * layout measured (owner, 2026-11-11: "we should embed the fonts into the file that are required
 * for fidelity. and into the project for full compatibility on the usage and incorporation").
 */
export type RenderFonts = {
  sans: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  mono: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  serif: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
};

/**
 * The vertical metrics (ascent, descent, line gap: `normal` line height) of Arial, Courier New and
 * Times New Roman -- which Liberation Sans, Mono and Serif share, by design.
 */
const METRICS: Record<FontKey, { ascent: number; descent: number; gap: number }> = {
  sans: { ascent: 0.905, descent: 0.212, gap: 0.033 },
  mono: { ascent: 0.833, descent: 0.3, gap: 0 },
  serif: { ascent: 0.891, descent: 0.216, gap: 0.042 },
};

/** What pdf-lib keeps of the font it embeds: fontkit's font, which knows its glyphs. */
type Glyphs = { hasGlyphForCodePoint(cp: number): boolean };

class Face {
  private readonly widths = new Map<string, number>();
  private readonly codes = new Map<string, string>();
  readonly font: PDFFont;
  /** The font's resource name on a page. */
  readonly name: string;
  private readonly refuse: Refusals;
  private readonly glyphs: Glyphs;
  constructor(font: PDFFont, name: string, refuse: Refusals) {
    this.font = font;
    this.name = name;
    this.refuse = refuse;
    this.glyphs = (font as unknown as { embedder: { font: Glyphs } }).embedder.font;
  }
  /** The advance of one character at size 1. A character the font has no glyph for is refused. */
  private advance(ch: string): number {
    let w = this.widths.get(ch);
    if (w === undefined) {
      const cp = ch.codePointAt(0) ?? 0;
      // A character that draws nothing in Chrome (a soft hyphen, a zero-width space or joiner, a
      // direction mark): fontkit draws the SPACE glyph for it, so "Comb&#173;ination" printed
      // "Comb ination" (T1-3 review). Refused rather than guessed at a line's end.
      if (isInvisible(cp)) {
        this.refuse.add(
          `the invisible character U+${cp.toString(16).toUpperCase().padStart(4, "0")}`,
        );
      }
      // fontkit would draw a missing glyph as .notdef (a box) and say nothing.
      else if (!this.glyphs.hasGlyphForCodePoint(cp)) {
        this.refuse.add(
          `the character U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${ch}): no glyph in ${this.font.name}`,
        );
      }
      this.codes.set(ch, this.font.encodeText(ch).toString().slice(1, -1));
      w = this.font.widthOfTextAtSize(ch, 1);
      this.widths.set(ch, w);
    }
    return w;
  }
  width(text: string, size: number): number {
    let w = 0;
    for (const ch of text) w += this.advance(ch);
    return w * size;
  }
  hex(text: string): string {
    let out = "";
    for (const ch of text) {
      this.advance(ch);
      out += this.codes.get(ch);
    }
    return out;
  }
}

class Fonts {
  private readonly faces = new Map<string, Face>();
  static async load(pdf: PDFDocument, files: RenderFonts, refuse: Refusals): Promise<Fonts> {
    pdf.registerFontkit(fontkit);
    const f = new Fonts();
    let n = 0;
    for (const key of ["sans", "mono", "serif"] as FontKey[]) {
      for (let k = 0; k < 4; k++) {
        // Subset: only the glyphs printed are embedded. Not features: no ligature or kerning
        // pass, so each character is its own glyph at its own advance, as the layout measured.
        const font = await pdf.embedFont(files[key][k], { subset: true });
        f.faces.set(`${key}${k}`, new Face(font, `F${++n}`, refuse));
      }
    }
    return f;
  }
  face(s: Style): Face {
    return this.faces.get(`${s.font}${(s.bold ? 1 : 0) + (s.italic ? 2 : 0)}`) as Face;
  }
}

// ---------------------------------------------------------------------------
// Drawing: page sinks (PDF operators by layer) and recorders (replayed later)
// ---------------------------------------------------------------------------

type Img = { ref: PDFRef; w: number; h: number };

/** Layers: backgrounds by element depth, then table borders, then text and images. */
const BORDER_LAYER = 100_000;
const FG_LAYER = 200_000;

interface Sink {
  rect(layer: number, x: number, y: number, w: number, h: number, c: RGBA): void;
  text(x: number, baseline: number, face: Face, size: number, c: RGBA, s: string): void;
  image(x: number, y: number, w: number, h: number, img: Img): void;
}

type Cmd =
  | { k: 0; layer: number; x: number; y: number; w: number; h: number; c: RGBA }
  | { k: 1; x: number; y: number; face: Face; size: number; c: RGBA; s: string }
  | { k: 2; x: number; y: number; w: number; h: number; img: Img };

class Recorder implements Sink {
  readonly cmds: Cmd[] = [];
  rect(layer: number, x: number, y: number, w: number, h: number, c: RGBA): void {
    this.cmds.push({ k: 0, layer, x, y, w, h, c });
  }
  text(x: number, y: number, face: Face, size: number, c: RGBA, s: string): void {
    this.cmds.push({ k: 1, x, y, face, size, c, s });
  }
  image(x: number, y: number, w: number, h: number, img: Img): void {
    this.cmds.push({ k: 2, x, y, w, h, img });
  }
  replay(to: Sink, dx: number, dy: number): void {
    for (const c of this.cmds) {
      if (c.k === 0) to.rect(c.layer, c.x + dx, c.y + dy, c.w, c.h, c.c);
      else if (c.k === 1) to.text(c.x + dx, c.y + dy, c.face, c.size, c.c, c.s);
      else to.image(c.x + dx, c.y + dy, c.w, c.h, c.img);
    }
  }
}

const NULL_SINK: Sink = { rect() {}, text() {}, image() {} };

/** A coordinate or size in points, to 0.01 pt (3.5 µm: below any printer's dot). */
const num = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

/** A drawing operation on a page, in points from the page's lower left. */
type PageOp =
  | { k: 0; x: number; y: number; w: number; h: number; c: RGBA }
  | { k: 1; x: number; y: number; face: Face; size: number; c: RGBA; s: string; w: number }
  | { k: 2; x: number; y: number; w: number; h: number; img: Img };

/**
 * One page's drawing, kept by layer (the painting order) and written compactly (owner,
 * 2026-11-11: the package's size "is not an issue, as long as the resulting pdf is minimized"):
 * one text object at a time, the font, the fill and its alpha set only when they change, the
 * pieces of a line that follow on from each other in one style joined into one string -- with no
 * kerning, each glyph advances exactly as the layout measured, so joining moves nothing --
 * rectangles filled with no save and restore around them, coordinates to 0.01 pt.
 */
class PageSink implements Sink {
  private readonly layers = new Map<number, PageOp[]>();
  readonly fonts = new Set<Face>();
  readonly images = new Set<Img>();
  readonly alphas = new Set<number>();
  /** Points per CSS px on this page: 0.75, times the document's shrink-to-fit. */
  private readonly pt: number;
  constructor(pt: number) {
    this.pt = pt;
  }
  private push(layer: number, op: PageOp) {
    let l = this.layers.get(layer);
    if (!l) {
      l = [];
      this.layers.set(layer, l);
    }
    l.push(op);
  }
  rect(layer: number, x: number, y: number, w: number, h: number, c: RGBA): void {
    if (w <= 0 || h <= 0 || c[3] <= 0) return;
    const X = MARGIN_PT + x * this.pt;
    const Y = PAGE_H_PT - MARGIN_PT - (y + h) * this.pt;
    this.push(layer, { k: 0, x: X, y: Y, w: w * this.pt, h: h * this.pt, c });
  }
  text(x: number, baseline: number, face: Face, size: number, c: RGBA, s: string): void {
    if (s === "" || c[3] <= 0) return;
    this.fonts.add(face);
    const X = MARGIN_PT + x * this.pt;
    const Y = PAGE_H_PT - MARGIN_PT - baseline * this.pt;
    const pts = size * this.pt;
    this.push(FG_LAYER, { k: 1, x: X, y: Y, face, size: pts, c, s, w: face.width(s, pts) });
  }
  image(x: number, y: number, w: number, h: number, img: Img): void {
    this.images.add(img);
    const X = MARGIN_PT + x * this.pt;
    const Y = PAGE_H_PT - MARGIN_PT - (y + h) * this.pt;
    this.push(FG_LAYER, { k: 2, x: X, y: Y, w: w * this.pt, h: h * this.pt, img });
  }
  content(): string {
    const out: string[] = [];
    let inText = false;
    let fill = "0 0 0 rg"; // the PDF's initial fill: black
    let alpha = 1;
    let font: Face | null = null;
    let fontSize = -1;
    /** A line's text, held while its next piece may follow on in the same style. */
    let run: { op: Extract<PageOp, { k: 1 }>; hex: string; end: number } | null = null;
    const setFill = (c: RGBA) => {
      const f = `${num(c[0] / 255)} ${num(c[1] / 255)} ${num(c[2] / 255)} rg`;
      if (f !== fill) {
        out.push(f);
        fill = f;
      }
      const a = c[3] >= 1 ? 1 : Math.round(c[3] * 1000) / 1000;
      if (a !== alpha) {
        this.alphas.add(a);
        out.push(`/GS${Math.round(a * 1000)} gs`);
        alpha = a;
      }
    };
    const flush = () => {
      if (!run) return;
      out.push(`1 0 0 1 ${num(run.op.x)} ${num(run.op.y)} Tm <${run.hex}> Tj`);
      run = null;
    };
    const endText = () => {
      flush();
      if (inText) out.push("ET");
      inText = false;
    };
    for (const layer of [...this.layers.keys()].sort((a, b) => a - b)) {
      for (const op of this.layers.get(layer) as PageOp[]) {
        if (op.k === 1) {
          const r = run as { op: Extract<PageOp, { k: 1 }>; hex: string; end: number } | null;
          if (
            r &&
            r.op.face === op.face &&
            r.op.size === op.size &&
            r.op.c.every((v, i) => v === op.c[i]) &&
            Math.abs(r.op.y - op.y) < 0.005 &&
            Math.abs(r.end - op.x) < 0.01
          ) {
            r.hex += op.face.hex(op.s);
            r.end += op.w;
            continue;
          }
          flush();
          if (!inText) {
            out.push("BT");
            inText = true;
          }
          if (op.face !== font || op.size !== fontSize) {
            out.push(`/${op.face.name} ${num(op.size)} Tf`);
            font = op.face;
            fontSize = op.size;
          }
          setFill(op.c);
          run = { op, hex: op.face.hex(op.s), end: op.x + op.w };
        } else if (op.k === 0) {
          endText();
          setFill(op.c);
          out.push(`${num(op.x)} ${num(op.y)} ${num(op.w)} ${num(op.h)} re f`);
        } else {
          endText();
          out.push(
            `q ${num(op.w)} 0 0 ${num(op.h)} ${num(op.x)} ${num(op.y)} cm /Im${op.img.ref.objectNumber} Do Q`,
          );
        }
      }
    }
    endText();
    return out.join("\n");
  }
}

// ---------------------------------------------------------------------------
// The flow: where the next piece goes, page by page
// ---------------------------------------------------------------------------

class TooTall extends Error {}

type Placed = { page: number; y: number };

class Flow {
  page = 0;
  y = 0;
  private pending: number[] = [];
  /** Something is on this page (margins after an UNFORCED break are truncated before it). */
  placed = false;
  /**
   * Something on this page that is not kept with what follows it (a heading, its rule): moving a
   * block on to the next page gains nothing on a page that holds only its own heading -- it would
   * leave the heading alone there (owner, 2026-11-11, choosing how breaks behave: "I agree with B").
   */
  hasContent = false;
  /** What is placed now is kept with what follows it. */
  keeping = false;
  /** The page was begun by a forced break (or is the first): margins at its top are kept. */
  forced = true;
  /** A forced break waits for the next piece. */
  breakNext = false;
  /** Blocks open, their first placement once known. */
  readonly open: { start: Placed | null }[] = [];
  readonly height: number;
  readonly sinkFor: (page: number) => Sink;
  private readonly limit: number;
  constructor(height: number, sinkFor: (page: number) => Sink, limit = Number.POSITIVE_INFINITY) {
    this.height = height;
    this.sinkFor = sinkFor;
    this.limit = limit;
  }
  margin(m: number): void {
    this.pending.push(m);
  }
  collapsed(): number {
    let pos = 0;
    let neg = 0;
    for (const m of this.pending) {
      if (m > pos) pos = m;
      if (m < neg) neg = m;
    }
    return pos + neg;
  }
  /** Drop the margins waiting (a cell's or a page's top edge). */
  clearMargins(): void {
    this.pending = [];
  }
  /**
   * A forced break was asked of a flow with no pages to break between (a table cell's, an inline
   * box's): it is not taken, and the box refuses it. Taken, it started a "page" the cell's
   * recorder never saw, and the next block printed OVER the one before (T1-3 review: "Mx 12.5"
   * and "My 99.1" at one point, verification PASS).
   */
  breakInBox = false;
  /** Something was placed past a page's foot ({@link place}). */
  pastFoot = false;
  forceBreak(): void {
    if (!Number.isFinite(this.height)) {
      if (this.placed) this.breakInBox = true;
      return;
    }
    if (this.placed) this.breakNext = true;
  }
  newPage(forced: boolean): void {
    this.page++;
    this.y = 0;
    this.placed = false;
    this.hasContent = false;
    this.forced = forced;
    this.breakNext = false;
  }
  /** Room left on this page below the margins waiting. */
  room(): number {
    return this.height - this.y - (this.placed || this.forced ? this.collapsed() : 0);
  }
  /** An unbreakable piece `h` tall: where it goes. */
  place(h: number): Placed {
    if (this.breakNext) this.newPage(true);
    let m = this.collapsed();
    this.pending = [];
    if (!this.placed && !this.forced) m = 0;
    if (this.placed && this.y + m + h > this.height) {
      this.newPage(false);
      m = 0;
    }
    const at = { page: this.page, y: this.y + m };
    this.y = at.y + h;
    if (this.y > this.limit) throw new TooTall();
    // Past the page's foot even on a page of its own (a margin kept at a forced break's top, a
    // box taller than the page): drawn off the paper. The final pass refuses it (T1-3 review).
    if (this.y > this.height + 0.01) this.pastFoot = true;
    this.placed = true;
    if (!this.keeping) this.hasContent = true;
    for (let k = this.open.length - 1; k >= 0 && this.open[k].start === null; k--) {
      this.open[k].start = at;
    }
    return at;
  }
  here(): Placed {
    return { page: this.page, y: this.y };
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Grid = { rows: Elem[]; cells: Elem[][]; cols: number; min: number[]; max: number[] };

/** One piece of an inline formatting context. */
type Piece =
  | { kind: "text"; text: string; style: Style; boxes: Elem[] }
  | {
      kind: "atomic";
      w: number;
      above: number;
      below: number;
      style: Style;
      draw: (s: Sink, x: number, baseline: number) => void;
    }
  | { kind: "br"; style: Style };

class Layout {
  readonly cascade: Cascade;
  readonly fonts: Fonts;
  readonly images: Map<string, Img>;
  readonly refuse: Refusals;
  /** The page's content box, in CSS px, at the width this pass lays out at. */
  readonly pageW: number;
  readonly pageH: number;
  /** The final pass: content past the page is refused (the first pass only measures it). */
  readonly final: boolean;
  /** The furthest right any box or line reaches. */
  reach = 0;
  constructor(
    cascade: Cascade,
    fonts: Fonts,
    images: Map<string, Img>,
    refuse: Refusals,
    page: { w: number; h: number; final: boolean },
  ) {
    this.cascade = cascade;
    this.fonts = fonts;
    this.images = images;
    this.refuse = refuse;
    this.pageW = page.w;
    this.pageH = page.h;
    this.final = page.final;
  }

  /**
   * A box or line ends at `right`. Past the content box it prints into the page's margin, as
   * Chrome prints it (a `max-width: 100%` image's own border, 2 px); past the PAPER it would be
   * lost, and is refused in the final pass.
   */
  reaches(right: number, what: () => string): void {
    if (right > this.reach) this.reach = right;
    const paper = this.pageW + (MARGIN_PT / PT) * (this.pageW / CONTENT_W);
    if (this.final && right > paper) this.refuse.add(`${what()} past the paper's edge`);
  }

  styled(e: Elem): Style {
    if (!e.style) e.style = this.cascade.styleOf(e, e.parent ? this.styled(e.parent) : null);
    return e.style;
  }

  lineHeightOf(s: Style): number {
    if (s.lineHeight === "normal") {
      const m = METRICS[s.font];
      return (m.ascent + m.descent + m.gap) * s.fontSize;
    }
    return "px" in s.lineHeight ? s.lineHeight.px : s.lineHeight.factor * s.fontSize;
  }

  /** Above and below the baseline that an inline box of style `s` asks of its line. */
  extent(s: Style, parentSize: number): [number, number] {
    const m = METRICS[s.font];
    const lh = this.lineHeightOf(s);
    const content = (m.ascent + m.descent) * s.fontSize;
    let above = m.ascent * s.fontSize + (lh - content) / 2;
    let below = lh - above;
    const shift = this.shift(s, parentSize);
    above += shift;
    below -= shift;
    return [above, below];
  }

  shift(s: Style, parentSize: number): number {
    if (s.verticalAlign === "super") return parentSize / 3;
    if (s.verticalAlign === "sub") return -parentSize / 5;
    if (s.verticalAlign !== "baseline")
      this.refuse.add(`vertical-align: ${s.verticalAlign} in a line`);
    return 0;
  }

  /** Whether `e` is laid out as a block-level box in its parent's flow. */
  isBlock(e: Elem): boolean {
    const d = this.styled(e).display;
    return d === "block" || d === "table" || d === "list-item" || d === "flow-root";
  }

  // --- block flow --------------------------------------------------------------

  /** The children of `e` in a block formatting context, at `x`, `width` wide. */
  blockChildren(e: Elem, x: number, width: number, flow: Flow, sink: (p: number) => Sink): void {
    let run: (Elem | string)[] = [];
    // A box that avoids breaks inside it keeps its leading text with what follows it: if it must
    // break, not straight after its opening line -- its title (SkyCiv's `<span class="subheading">`
    // before its table was left alone on a page; owner, 2026-11-11: "I agree with B").
    let lead = this.styled(e).avoidInside;
    const flush = () => {
      if (run.length) {
        const was = flow.keeping;
        if (lead) flow.keeping = true;
        this.inline(e, run, x, width, flow);
        flow.keeping = was;
      }
      run = [];
    };
    const kids = e.kids;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (typeof k === "string") {
        run.push(k);
        continue;
      }
      const s = this.styled(k);
      if (s.display === "none") continue;
      if (this.isBlock(k) && /^h[1-6]$/.test(k.tag)) {
        // A heading, and the rules right after it, kept with what follows (owner, 2026-11-11:
        // "I agree with B" -- Chrome strands a heading at a page's foot, or alone on a page).
        flush();
        lead = false;
        const rules: number[] = [];
        let next = i + 1;
        for (; next < kids.length; next++) {
          const n = kids[next];
          if (typeof n === "string") {
            if (n.trim() === "") continue;
            break;
          }
          if (this.styled(n).display === "none") continue;
          if (n.tag === "hr") rules.push(next);
          else break;
        }
        this.keepWithNext(
          k,
          rules.map((r) => kids[r] as Elem),
          kids[next],
          e,
          width,
          flow,
        );
        const was = flow.keeping;
        flow.keeping = true;
        this.block(k, x, width, flow, sink);
        for (const r of rules) this.block(kids[r] as Elem, x, width, flow, sink);
        flow.keeping = was;
        i = rules.length ? rules[rules.length - 1] : i;
      } else if (this.isBlock(k)) {
        flush();
        lead = false;
        this.block(k, x, width, flow, sink);
      } else if (/^table-/.test(s.display)) {
        this.refuse.add(`a <${k.tag}> outside a table`);
      } else run.push(k);
    }
    flush();
  }

  /**
   * Before a heading: start the next page unless the heading, its rules and the start of what
   * follows share this one. The start is the whole of a following box that avoids breaks inside it
   * (it would move on alone otherwise), else up to four of its lines. Not on a page that holds only
   * kept content, and not before a heading that starts a page of its own anyway.
   */
  keepWithNext(
    heading: Elem,
    rules: Elem[],
    next: Elem | string | undefined,
    parent: Elem,
    width: number,
    flow: Flow,
  ): void {
    if (!flow.hasContent || this.styled(heading).breakBefore === "page") return;
    const room = flow.room();
    let need = 0;
    for (const b of [heading, ...rules]) {
      const h = this.measure(b, width, room);
      if (h === null) return; // taller than the room: nothing to keep together
      need += h + px(this.styled(b).margin[2], width);
    }
    const lines = 4 * this.lineHeightOf(this.styled(parent));
    let start = 0;
    if (next !== undefined && typeof next !== "string" && this.isBlock(next)) {
      const ns = this.styled(next);
      const h = this.measure(next, width, Math.max(0, room - need));
      start =
        h === null
          ? ns.avoidInside
            ? Number.POSITIVE_INFINITY
            : lines
          : ns.avoidInside
            ? h
            : Math.min(h, lines);
      start += px(ns.margin[0], width);
    } else if (next !== undefined) start = lines;
    if (need + start > room) flow.newPage(false);
  }

  /** A block-level box: margins, borders, padding, its content, its breaks. */
  block(e: Elem, x: number, cbWidth: number, flow: Flow, sink: (p: number) => Sink): void {
    const s = this.styled(e);
    if (s.display === "list-item") this.refuse.add("a list item (its marker is not drawn)");
    if (e.tag === "img") {
      this.blockImage(e, x, cbWidth, flow);
      return;
    }
    if (s.breakBefore === "page") flow.forceBreak();
    const [mt, mr, mb, ml] = s.margin;
    const pad = s.padding.map((p) => px(p, cbWidth));
    const bw = s.border.map((b) => b.w);
    let width: number;
    let left = px(ml, cbWidth);
    const right = px(mr, cbWidth);
    if (s.display === "table") {
      flow.margin(px(mt, cbWidth));
      this.table(e, x, cbWidth, flow, sink);
      flow.margin(px(mb, cbWidth));
      if (s.breakAfter === "page") flow.forceBreak();
      return;
    }
    if (s.width === "auto") {
      width = cbWidth - left - right - pad[1] - pad[3] - bw[1] - bw[3];
    } else {
      width = px(s.width, cbWidth);
      if (s.maxWidth !== "none") width = Math.min(width, px(s.maxWidth, cbWidth));
      const used = width + pad[1] + pad[3] + bw[1] + bw[3];
      if (ml === "auto" && mr === "auto") left = (cbWidth - used) / 2;
      else if (ml === "auto") left = cbWidth - used - right;
    }
    flow.margin(px(mt, cbWidth));
    // `break-inside: avoid`, as Blink applies it: a box that does not fit in the room left goes on
    // to the next page, even one taller than a page (a break inside it is then allowed). Not off
    // a page that holds only its own heading ({@link Flow.hasContent}).
    if (s.avoidInside && flow.hasContent) {
      const room = flow.room();
      const h = this.measure(e, cbWidth, room);
      if (h === null || h > room) flow.newPage(false);
    }
    const boxX = x + left;
    this.reaches(boxX + width + pad[1] + pad[3] + bw[1] + bw[3], () => `a <${e.tag}> box`);
    const top = pad[0] + bw[0];
    const entry = { start: null as Placed | null };
    flow.open.push(entry);
    if (top > 0) flow.place(top);
    const contentX = boxX + bw[3] + pad[3];
    this.blockChildren(e, contentX, width, flow, sink);
    const bottom = pad[2] + bw[2];
    if (bottom > 0) flow.place(bottom);
    flow.open.pop();
    const end = flow.here();
    const start = entry.start ?? end;
    if (s.height !== "auto") {
      const want = px(s.height, cbWidth) + top + bottom;
      if (start.page === end.page && end.y - start.y < want) flow.place(want - (end.y - start.y));
      else if (start.page !== end.page) this.refuse.add("a set height on a box across pages");
    }
    const fin = flow.here();
    this.decorate(e, s, boxX, width + pad[1] + pad[3] + bw[1] + bw[3], start, fin, flow, sink);
    flow.margin(px(mb, cbWidth));
    if (s.breakAfter === "page") flow.forceBreak();
  }

  /** A box's background and borders on each page it spans (its fragments sliced at the breaks). */
  decorate(
    e: Elem,
    s: Style,
    x: number,
    w: number,
    start: Placed,
    end: Placed,
    flow: Flow,
    sink: (p: number) => Sink,
  ): void {
    const bg = s.background && s.exact ? s.background : null;
    if (!bg && s.border.every((b) => b.w === 0)) return;
    for (let p = start.page; p <= end.page; p++) {
      const y0 = p === start.page ? start.y : 0;
      const y1 = p === end.page ? end.y : flow.height;
      if (y1 <= y0) continue;
      const out = sink(p);
      if (bg) out.rect(e.depth, x, y0, w, y1 - y0, bg);
      const [t, r, b, l] = s.border;
      if (p === start.page && t.w) out.rect(e.depth, x, y0, w, t.w, edgeColour(t, true));
      if (p === end.page && b.w) out.rect(e.depth, x, y1 - b.w, w, b.w, edgeColour(b, false));
      if (l.w) out.rect(e.depth, x, y0, l.w, y1 - y0, edgeColour(l, true));
      if (r.w) out.rect(e.depth, x + w - r.w, y0, r.w, y1 - y0, edgeColour(r, false));
    }
  }

  /** The height `e` takes, laid out alone, or null past `limit` (a page, unless said). */
  measure(e: Elem, cbWidth: number, limit = this.pageH): number | null {
    const flow = new Flow(Number.POSITIVE_INFINITY, () => NULL_SINK, limit);
    const s = this.styled(e);
    try {
      // The box from its border edge: no breaks before or after it, its own margins not counted.
      e.style = { ...s, breakBefore: "auto", breakAfter: "auto", avoidInside: false };
      try {
        if (s.display === "table") this.table(e, 0, cbWidth, flow, () => NULL_SINK);
        else this.block(e, 0, cbWidth, flow, () => NULL_SINK);
      } finally {
        e.style = s;
      }
      return flow.y;
    } catch (err) {
      if (err instanceof TooTall) return null;
      throw err;
    }
  }

  // --- replaced: images ------------------------------------------------------------

  imageOf(e: Elem): Img | null {
    const src = e.attrs?.get("src") ?? "";
    const img = this.images.get(src);
    if (!img) {
      this.refuse.add(`an image that is not embedded (${src.slice(0, 40)})`);
      return null;
    }
    return img;
  }

  /** An image's used size: its CSS width and height, its own ratio, its max sizes. */
  imageSize(e: Elem, cbWidth: number, img: Img): [number, number] {
    const s = this.styled(e);
    const ratio = img.h / img.w;
    let w = s.width === "auto" ? null : px(s.width, cbWidth);
    let h = s.height === "auto" || s.height.u === "%" ? null : px(s.height, 0);
    if (w === null && h === null) {
      w = img.w;
      h = img.h;
    } else if (w === null) w = (h as number) / ratio;
    else if (h === null) h = w * ratio;
    let W = w as number;
    let H = h as number;
    const maxW = s.maxWidth === "none" ? Number.POSITIVE_INFINITY : px(s.maxWidth, cbWidth);
    const maxH =
      s.maxHeight === "none" || (s.maxHeight !== "auto" && s.maxHeight.u === "%")
        ? Number.POSITIVE_INFINITY
        : px(s.maxHeight, 0);
    const bothAuto = s.width === "auto" && s.height === "auto";
    if (W > maxW) {
      if (bothAuto || s.height === "auto") H = (H * maxW) / W;
      W = maxW;
    }
    if (H > maxH) {
      if (bothAuto || s.width === "auto") W = (W * maxH) / H;
      H = maxH;
    }
    // 🔒 Owner, 2026-11-10: an image taller than a page is SCALED to fit one, its pixels the source's.
    const room = this.pageH - this.boxV(s, cbWidth);
    if (H > room) {
      W = (W * room) / H;
      H = room;
    }
    return [W, H];
  }

  boxH(s: Style, cb: number): number {
    return px(s.padding[1], cb) + px(s.padding[3], cb) + s.border[1].w + s.border[3].w;
  }
  boxV(s: Style, cb: number): number {
    return px(s.padding[0], cb) + px(s.padding[2], cb) + s.border[0].w + s.border[2].w;
  }

  drawImageBox(
    e: Elem,
    out: Sink,
    x: number,
    y: number,
    w: number,
    h: number,
    cb: number,
    img: Img,
  ): void {
    const s = this.styled(e);
    const [t, r, b, l] = s.border;
    const pl = px(s.padding[3], cb);
    const pt = px(s.padding[0], cb);
    const W = w + this.boxH(s, cb);
    const H = h + this.boxV(s, cb);
    if (s.background && s.exact) out.rect(e.depth, x, y, W, H, s.background);
    if (t.w) out.rect(e.depth, x, y, W, t.w, t.color);
    if (b.w) out.rect(e.depth, x, y + H - b.w, W, b.w, b.color);
    if (l.w) out.rect(e.depth, x, y, l.w, H, l.color);
    if (r.w) out.rect(e.depth, x + W - r.w, y, r.w, H, r.color);
    if (s.visible) out.image(x + l.w + pl, y + t.w + pt, w, h, img);
  }

  blockImage(e: Elem, x: number, cbWidth: number, flow: Flow): void {
    const s = this.styled(e);
    const img = this.imageOf(e);
    if (!img) return;
    if (s.breakBefore === "page") flow.forceBreak();
    const [w, h] = this.imageSize(e, cbWidth, img);
    const boxW = w + this.boxH(s, cbWidth);
    let left = px(s.margin[3], cbWidth);
    if (s.margin[1] === "auto" && s.margin[3] === "auto") left = (cbWidth - boxW) / 2;
    this.reaches(x + left + boxW, () => "an image");
    flow.margin(px(s.margin[0], cbWidth));
    const at = flow.place(h + this.boxV(s, cbWidth));
    this.drawImageBox(e, flow.sinkFor(at.page), x + left, at.y, w, h, cbWidth, img);
    flow.margin(px(s.margin[2], cbWidth));
    if (s.breakAfter === "page") flow.forceBreak();
  }

  // --- inline formatting -----------------------------------------------------------

  /** The pieces of an inline run, its whitespace collapsed as `white-space: normal` does. */
  pieces(owner: Elem, run: (Elem | string)[], cbWidth: number): Piece[] {
    const out: Piece[] = [];
    const walk = (nodes: (Elem | string)[], parent: Elem, boxes: Elem[]) => {
      const ps = this.styled(parent);
      for (const n of nodes) {
        if (typeof n === "string") {
          if (!ps.visible) {
            this.refuse.add("hidden text (visibility: hidden)");
            continue;
          }
          const text = ps.whiteSpace === "pre" ? n : n.replace(/[ \t\n\r\f]+/g, " ");
          if (ps.whiteSpace === "pre" && /\n/.test(text))
            this.refuse.add("preformatted line breaks");
          out.push({ kind: "text", text, style: ps, boxes });
          continue;
        }
        const s = this.styled(n);
        if (s.display === "none") continue;
        if (n.tag === "br") {
          out.push({ kind: "br", style: ps });
          continue;
        }
        if (n.tag === "img") {
          const img = this.imageOf(n);
          if (!img) continue;
          const [w, h] = this.imageSize(n, cbWidth, img);
          const ml = px(s.margin[3], cbWidth);
          const mr = px(s.margin[1], cbWidth);
          const mt = px(s.margin[0], cbWidth);
          const mb = px(s.margin[2], cbWidth);
          const H = h + this.boxV(s, cbWidth);
          out.push({
            kind: "atomic",
            w: ml + w + this.boxH(s, cbWidth) + mr,
            above: mt + H + mb,
            below: 0,
            style: s,
            draw: (sink, x, baseline) =>
              this.drawImageBox(n, sink, x + ml, baseline - mb - H, w, h, cbWidth, img),
          });
          continue;
        }
        if (s.display === "inline-block") {
          out.push(this.inlineBlock(n, cbWidth));
          continue;
        }
        if (s.display !== "inline") {
          this.refuse.add(`display: ${s.display} inside a line (<${n.tag}>)`);
          continue;
        }
        if (
          s.border.some((b) => b.w > 0) ||
          s.padding.some((p) => px(p, cbWidth) !== 0) ||
          s.margin.some((m) => m !== "auto" && px(m, cbWidth) !== 0)
        )
          this.refuse.add(`an inline box with borders, padding or margins (<${n.tag}>)`);
        walk(n.kids, n, s.background && s.exact ? [...boxes, n] : boxes);
      }
    };
    walk(run, owner, []);
    return out;
  }

  /** An inline-block: laid out alone, then placed in its line like an image. */
  /** How many inline boxes the layout is inside now. */
  private inlineBoxDepth = 0;

  inlineBlock(e: Elem, cbWidth: number): Piece {
    // One inside another lost the outer box's baseline, sitting ~4 pt high (T1-3 review).
    if (this.inlineBoxDepth > 0) this.refuse.add(`an inline box inside another (<${e.tag}>)`);
    const s = this.styled(e);
    const pad = s.padding.map((p) => px(p, cbWidth));
    const bw = s.border.map((b) => b.w);
    const ml = px(s.margin[3], cbWidth);
    const mr = px(s.margin[1], cbWidth);
    const mt = px(s.margin[0], cbWidth);
    const mb = px(s.margin[2], cbWidth);
    let width: number;
    if (s.width !== "auto") width = px(s.width, cbWidth);
    else {
      // shrink to fit
      const [min, max] = this.intrinsic(e.kids, e, cbWidth);
      const avail = cbWidth - ml - mr - pad[1] - pad[3] - bw[1] - bw[3];
      width = Math.min(Math.max(min, avail), max);
    }
    const rec = new Recorder();
    const flow = new Flow(Number.POSITIVE_INFINITY, () => rec);
    const lastBaseline = { y: -1 };
    this.baselineProbe = lastBaseline;
    const top = pad[0] + bw[0];
    if (top > 0) flow.place(top);
    // Its own formatting context: its children's margins stay inside it.
    this.inlineBoxDepth++;
    try {
      this.blockChildren(e, bw[3] + pad[3], width, flow, () => rec);
    } finally {
      this.inlineBoxDepth--;
    }
    this.baselineProbe = null;
    if (flow.breakInBox) this.refuse.add(`a forced page break inside an inline box (<${e.tag}>)`);
    flow.y += flow.collapsed();
    flow.clearMargins();
    const bottom = pad[2] + bw[2];
    if (bottom > 0) flow.place(bottom);
    const H = flow.y;
    const W = width + pad[1] + pad[3] + bw[1] + bw[3];
    const base = lastBaseline.y < 0 ? H + mb : lastBaseline.y;
    const above = mt + base;
    const below = lastBaseline.y < 0 ? 0 : H - base + mb;
    return {
      kind: "atomic",
      w: ml + W + mr,
      above,
      below,
      style: s,
      draw: (sink, x, baseline) => {
        const y0 = baseline - base;
        this.decorateBox(e, s, sink, x + ml, y0, W, H);
        rec.replay(sink, x + ml, y0);
      },
    };
  }

  baselineProbe: { y: number } | null = null;

  decorateBox(e: Elem, s: Style, out: Sink, x: number, y: number, w: number, h: number): void {
    if (s.background && s.exact) out.rect(e.depth, x, y, w, h, s.background);
    const [t, r, b, l] = s.border;
    if (t.w) out.rect(e.depth, x, y, w, t.w, edgeColour(t, true));
    if (b.w) out.rect(e.depth, x, y + h - b.w, w, b.w, edgeColour(b, false));
    if (l.w) out.rect(e.depth, x, y, l.w, h, edgeColour(l, true));
    if (r.w) out.rect(e.depth, x + w - r.w, y, r.w, h, edgeColour(r, false));
  }

  /**
   * Lines of an inline run: words broken at spaces (and after a hyphen between letters), each
   * line placed in the flow as one unbreakable piece, aligned, its text drawn.
   */
  inline(owner: Elem, run: (Elem | string)[], x: number, width: number, flow: Flow): void {
    const os = this.styled(owner);
    const pieces = this.pieces(owner, run, width);
    // Segments: what may not be broken. A space ends one and is kept (it may hang at a line end).
    type Bit = { piece: Piece; text: string; w: number };
    type Seg = { bits: Bit[]; w: number; space: Bit | null; br: boolean };
    const segs: Seg[] = [];
    let cur: Seg = { bits: [], w: 0, space: null, br: false };
    let lastSpace = true; // at the start of a line, a space collapses away
    const nowrap = (st: Style) => st.whiteSpace !== "normal";
    const pushSeg = () => {
      segs.push(cur);
      cur = { bits: [], w: 0, space: null, br: false };
    };
    for (const p of pieces) {
      if (p.kind === "br") {
        cur.br = true;
        pushSeg();
        lastSpace = true;
        continue;
      }
      if (p.kind === "atomic") {
        if (cur.bits.length) pushSeg();
        cur.bits.push({ piece: p, text: "", w: p.w });
        cur.w = p.w;
        pushSeg();
        lastSpace = false;
        continue;
      }
      const face = this.fonts.face(p.style);
      const parts = p.text.split(/( )/);
      for (const t of parts) {
        if (t === "") continue;
        if (t === " ") {
          if (lastSpace) continue;
          lastSpace = true;
          if (nowrap(p.style)) {
            const w = face.width(" ", p.style.fontSize);
            cur.bits.push({ piece: p, text: " ", w });
            cur.w += w;
            continue;
          }
          cur.space = { piece: p, text: " ", w: face.width(" ", p.style.fontSize) };
          pushSeg();
          continue;
        }
        lastSpace = false;
        // A hyphen between letters is a break opportunity after it.
        const hy = nowrap(p.style) ? [t] : t.split(/(?<=\p{L}-)(?=\p{L})/u);
        hy.forEach((h, k) => {
          const w = face.width(h, p.style.fontSize);
          cur.bits.push({ piece: p, text: h, w });
          cur.w += w;
          if (k < hy.length - 1) pushSeg();
        });
      }
    }
    if (cur.bits.length || cur.br) pushSeg();

    // Lines.
    type Line = { segs: Seg[]; w: number; br: boolean };
    const lines: Line[] = [];
    let line: Line = { segs: [], w: 0, br: false };
    let spaceBefore = 0;
    for (const sg of segs) {
      const add = (line.segs.length ? spaceBefore : 0) + sg.w;
      if (line.segs.length && line.w + add > width + 0.01) {
        lines.push(line);
        line = { segs: [], w: 0, br: false };
      }
      line.w += (line.segs.length ? spaceBefore : 0) + sg.w;
      line.segs.push(sg);
      spaceBefore = sg.space ? sg.space.w : 0;
      if (sg.br) {
        line.br = true;
        lines.push(line);
        line = { segs: [], w: 0, br: false };
        spaceBefore = 0;
      }
    }
    if (line.segs.length) lines.push(line);

    const strut = this.extent(os, os.fontSize);
    for (const ln of lines) {
      const hasContent = ln.segs.some((s) => s.bits.length > 0);
      if (!hasContent && !ln.br) continue;
      let above = strut[0];
      let below = strut[1];
      for (const sg of ln.segs) {
        for (const b of [...sg.bits, ...(sg.space ? [sg.space] : [])]) {
          if (b.piece.kind === "atomic") {
            above = Math.max(above, b.piece.above);
            below = Math.max(below, b.piece.below);
          } else if (b.piece.kind === "text") {
            const ps = b.piece.style;
            const parent = b.piece.boxes.length ? ps : ps;
            const [a, d] = this.extent(ps, this.parentSize(parent, os));
            above = Math.max(above, a);
            below = Math.max(below, d);
          }
        }
      }
      const offset =
        os.textAlign === "center"
          ? (width - ln.w) / 2
          : os.textAlign === "right"
            ? width - ln.w
            : 0;
      this.reaches(
        x + Math.max(0, offset) + ln.w,
        () =>
          `a line ${Math.round(ln.w)} px wide in ${Math.round(width)} px (${ln.segs
            .map((sg) =>
              sg.bits
                .map((b) => (b.piece.kind === "atomic" ? `[box ${Math.round(b.w)} px]` : b.text))
                .join(""),
            )
            .join(" ")
            .slice(0, 80)})`,
      );
      const h = above + below;
      if (h > this.pageH) this.refuse.add("a line taller than a page");
      const at = flow.place(h);
      const out = flow.sinkFor(at.page);
      const baseline = at.y + above;
      if (this.baselineProbe) this.baselineProbe.y = baseline;
      let cx = x + Math.max(0, offset);
      ln.segs.forEach((sg, k) => {
        for (const b of sg.bits) {
          this.drawBit(b, out, cx, baseline, os);
          cx += b.w;
        }
        if (sg.space && k < ln.segs.length - 1) {
          this.drawBit(sg.space, out, cx, baseline, os);
          cx += sg.space.w;
        }
      });
    }
  }

  parentSize(s: Style, owner: Style): number {
    return s.verticalAlign === "baseline" ? s.fontSize : Math.max(s.fontSize * 1.2, owner.fontSize);
  }

  drawBit(
    b: { piece: Piece; text: string; w: number },
    out: Sink,
    x: number,
    baseline: number,
    os: Style,
  ): void {
    const p = b.piece;
    if (p.kind === "atomic") {
      p.draw(out, x, baseline);
      return;
    }
    if (p.kind !== "text") return;
    const s = p.style;
    const y =
      baseline - this.shift(s, s.verticalAlign === "baseline" ? s.fontSize : s.fontSize * 1.2);
    const face = this.fonts.face(s);
    const m = METRICS[s.font];
    for (const box of p.boxes) {
      const bs = this.styled(box);
      if (bs.background)
        out.rect(
          box.depth,
          x,
          y - m.ascent * bs.fontSize,
          b.w,
          (m.ascent + m.descent) * bs.fontSize,
          bs.background,
        );
    }
    if (b.text.trim() !== "" || b.text === " ") out.text(x, y, face, s.fontSize, s.color, b.text);
    else if (b.text === " ") out.text(x, y, face, s.fontSize, s.color, b.text);
    for (const d of s.decorations) {
      const t = Math.max(1, s.fontSize * 0.073);
      const dy =
        d.line === "underline"
          ? s.fontSize * 0.106
          : d.line === "line-through"
            ? -s.fontSize * 0.3
            : -m.ascent * s.fontSize;
      out.rect(FG_LAYER, x, y + dy, b.w, t, d.color);
    }
    void os;
  }

  /** Min-content and max-content widths of inline content (and simple blocks within it). */
  intrinsic(nodes: (Elem | string)[], parent: Elem, cb: number): [number, number] {
    let min = 0;
    let lineMax = 0;
    let max = 0;
    let word = 0;
    let pendingSpace = 0;
    let lastSpace = true;
    const endWord = () => {
      if (word > min) min = word;
      word = 0;
    };
    const endLine = () => {
      endWord();
      if (lineMax > max) max = lineMax;
      lineMax = 0;
      pendingSpace = 0;
      lastSpace = true;
    };
    const walk = (ns: (Elem | string)[], p: Elem) => {
      const ps = this.styled(p);
      for (const n of ns) {
        if (typeof n === "string") {
          const face = this.fonts.face(ps);
          const text = ps.whiteSpace === "pre" ? n : n.replace(/[ \t\n\r\f]+/g, " ");
          for (const t of text.split(/( )/)) {
            if (t === "") continue;
            if (t === " ") {
              if (lastSpace) continue;
              lastSpace = true;
              const w = face.width(" ", ps.fontSize);
              if (ps.whiteSpace !== "normal") {
                word += w;
                lineMax += w;
              } else {
                endWord();
                pendingSpace = w;
              }
              continue;
            }
            lastSpace = false;
            const w = face.width(t, ps.fontSize);
            const hy = ps.whiteSpace !== "normal" ? [t] : t.split(/(?<=\p{L}-)(?=\p{L})/u);
            if (hy.length > 1) {
              for (const h of hy) {
                word += face.width(h, ps.fontSize);
                endWord();
              }
            } else word += w;
            lineMax += pendingSpace + w;
            pendingSpace = 0;
          }
          continue;
        }
        const s = this.styled(n);
        if (s.display === "none") continue;
        if (n.tag === "br") {
          endLine();
          continue;
        }
        if (n.tag === "img") {
          const img = this.imageOf(n);
          if (!img) continue;
          const pct = s.width !== "auto" && s.width.u === "%";
          const [w] = this.imageSize(n, cb, img);
          const W = w + this.boxH(s, cb) + px(s.margin[1], cb) + px(s.margin[3], cb);
          if (this.isBlock(n)) {
            endLine();
            if (!pct && W > min) min = W;
            if (W > max) max = W;
            continue;
          }
          endWord();
          if (!pct && W > min) min = W;
          lineMax += pendingSpace + W;
          pendingSpace = 0;
          lastSpace = false;
          continue;
        }
        const extra = this.boxH(s, cb) + px(s.margin[1], cb) + px(s.margin[3], cb);
        if (this.isBlock(n) || s.display === "inline-block") {
          if (this.isBlock(n)) endLine();
          else endWord();
          let [a, b] =
            s.display === "table" ? this.tableIntrinsic(n) : this.intrinsic(n.kids, n, cb);
          if (s.width !== "auto" && s.width.u === "px") a = b = s.width.v;
          if (a + extra > min) min = a + extra;
          if (this.isBlock(n)) {
            if (b + extra > max) max = b + extra;
          } else {
            lineMax += pendingSpace + b + extra;
            pendingSpace = 0;
            lastSpace = false;
          }
          continue;
        }
        walk(n.kids, n);
      }
    };
    walk(nodes, parent);
    endLine();
    return [min, max];
  }

  // --- tables ------------------------------------------------------------------------

  rowsOf(table: Elem): Elem[] {
    const head: Elem[] = [];
    const body: Elem[] = [];
    const foot: Elem[] = [];
    for (const k of table.kids) {
      if (typeof k === "string") continue;
      const s = this.styled(k);
      if (s.display === "none") continue;
      if (k.tag === "caption" || k.tag === "colgroup" || k.tag === "col") {
        this.refuse.add(`a table <${k.tag}>`);
        continue;
      }
      const group =
        s.display === "table-header-group"
          ? head
          : s.display === "table-footer-group"
            ? foot
            : body;
      if (s.display === "table-row") body.push(k);
      else if (/^table-(header|footer|row)-group$/.test(s.display)) {
        if (s.background || s.border.some((b) => b.w)) this.refuse.add("a styled table row group");
        for (const r of k.kids) {
          if (typeof r === "string") continue;
          if (this.styled(r).display === "none") continue;
          if (this.styled(r).display !== "table-row")
            this.refuse.add(`a <${r.tag}> in a row group`);
          else group.push(r);
        }
      } else this.refuse.add(`a <${k.tag}> (${s.display}) in a table`);
    }
    if (head.length) this.refuse.add("a table header (repeated on each page by Chrome)");
    return [...head, ...body, ...foot];
  }

  cellsOf(row: Elem): Elem[] {
    const out: Elem[] = [];
    for (const k of row.kids) {
      if (typeof k === "string") continue;
      const s = this.styled(k);
      if (s.display === "none") continue;
      if (s.display !== "table-cell") this.refuse.add(`a <${k.tag}> in a table row`);
      else out.push(k);
    }
    return out;
  }

  tableIntrinsic(table: Elem): [number, number] {
    const g = this.grid(table, this.pageW);
    const ts = this.styled(table);
    const extra = ts.collapse ? 0 : ts.spacing * (g.cols + 1) + ts.border[1].w + ts.border[3].w;
    return [g.min.reduce((a, b) => a + b, 0) + extra, g.max.reduce((a, b) => a + b, 0) + extra];
  }

  /** Each column's min- and max-content width, borders and padding in. */
  private readonly grids = new Map<Elem, { cb: number; g: Grid }>();

  grid(table: Elem, cb: number): Grid {
    const hit = this.grids.get(table);
    if (hit && hit.cb === cb) return hit.g;
    const g = this.computeGrid(table, cb);
    this.grids.set(table, { cb, g });
    return g;
  }

  computeGrid(table: Elem, cb: number): Grid {
    const rows = this.rowsOf(table);
    const cells = rows.map((r) => this.cellsOf(r));
    const cols = Math.max(0, ...cells.map((c) => c.length));
    const min = new Array<number>(cols).fill(0);
    const max = new Array<number>(cols).fill(0);
    const ts = this.styled(table);
    for (const [ri, row] of cells.entries()) {
      row.forEach((c, k) => {
        const s = this.styled(c);
        let [a, b] = this.intrinsic(c.kids, c, cb);
        if (s.width !== "auto" && s.width.u === "px") {
          a = Math.max(a, s.width.v);
          b = Math.max(a, s.width.v);
        } else if (s.width !== "auto") this.refuse.add("a cell width in %");
        // Collapsed: the WINNING edge on each side, as the row is laid out (collapsedSides). The
        // cell's own border halves left the content narrower than the column, and at minimum
        // width -- shrink-to-fit's -- text ran into the next column (T1-3 review: 2.1 pt).
        const edges = ts.collapse
          ? this.collapsedSides(row, rows[ri], k, ts).reduce((x, y) => x + y, 0)
          : s.border[1].w + s.border[3].w;
        const extra = px(s.padding[1], cb) + px(s.padding[3], cb) + edges;
        if (a + extra > min[k]) min[k] = a + extra;
        if (b + extra > max[k]) max[k] = b + extra;
      });
    }
    return { rows, cells, cols, min, max };
  }

  /**
   * A collapsed cell's left and right border halves: on each side the winning edge of its own,
   * its neighbour's, and -- at the row's ends -- the row's and the table's. One rule for sizing the
   * columns and laying the row out.
   */
  collapsedSides(row: Elem[], rowEl: Elem, k: number, ts: Style): [number, number] {
    const [left, right] = this.collapsedEdges(row, rowEl, k, ts);
    return [left.w / 2, right.w / 2];
  }

  /** The winning left and right edges of a collapsed cell ({@link collapsedSides}). */
  collapsedEdges(row: Elem[], rowEl: Elem, k: number, ts: Style): [Edge, Edge] {
    const edgeOf = (c: Elem | undefined, side: number): Edge =>
      c ? this.styled(c).border[side] : NO_EDGE;
    const own = this.styled(row[k]).border;
    const last = k === row.length - 1;
    const left = winEdge(
      edgeOf(row[k - 1], 1),
      own[3],
      k === 0 ? this.styled(rowEl).border[3] : NO_EDGE,
      k === 0 ? ts.border[3] : NO_EDGE,
    );
    const right = winEdge(
      own[1],
      edgeOf(row[k + 1], 3),
      last ? this.styled(rowEl).border[1] : NO_EDGE,
      last ? ts.border[1] : NO_EDGE,
    );
    return [left, right];
  }

  /** A table: its columns sized, then row by row in the flow, each row unbreakable. */
  table(e: Elem, x: number, cbWidth: number, flow: Flow, sink: (p: number) => Sink): void {
    const ts = this.styled(e);
    if (ts.breakBefore === "page") flow.forceBreak();
    const g = this.grid(e, cbWidth);
    if (g.cols === 0) return;
    const collapse = ts.collapse;
    const sp = collapse ? 0 : ts.spacing;
    const tb = ts.border.map((b) => b.w);
    const tpad = collapse ? [0, 0, 0, 0] : ts.padding.map((p) => px(p, cbWidth));
    const outerH = collapse ? 0 : tb[1] + tb[3] + tpad[1] + tpad[3] + sp * (g.cols + 1);
    const sumMin = g.min.reduce((a, b) => a + b, 0);
    const sumMax = g.max.reduce((a, b) => a + b, 0);
    const ml = px(ts.margin[3], cbWidth);
    const mr = px(ts.margin[1], cbWidth);
    const avail = cbWidth - ml - mr - outerH;
    let W: number;
    if (ts.width !== "auto") W = Math.max(px(ts.width, cbWidth) - outerH, sumMin);
    else W = Math.max(sumMin, Math.min(avail, sumMax));
    const widths = g.max.map((mx, k) => {
      if (W >= sumMax) return sumMax > 0 ? mx + ((W - sumMax) * mx) / sumMax : W / g.cols;
      if (sumMax === sumMin) return g.min[k];
      return g.min[k] + ((mx - g.min[k]) * (W - sumMin)) / (sumMax - sumMin);
    });
    const tableW = W + outerH;
    let left = x + ml;
    if (ts.margin[1] === "auto" && ts.margin[3] === "auto")
      left = x + Math.max(0, (cbWidth - tableW) / 2);
    this.reaches(
      left + tableW,
      () =>
        `a table ${Math.round(tableW)} px wide (${g.cols} columns, first row "${textOf(g.rows[0]).slice(0, 60)}")`,
    );

    // Rows measured: each cell's content in a recorder, its height.
    type CellBox = { el: Elem; rec: Recorder; h: number; x: number; w: number };
    const colX: number[] = [];
    let cx = left + (collapse ? 0 : tb[3] + tpad[3] + sp);
    for (const w of widths) {
      colX.push(cx);
      cx += w + sp;
    }

    const measureRow = (ri: number): { boxes: CellBox[]; h: number } => {
      const row = g.cells[ri];
      const boxes: CellBox[] = [];
      let h = 0;
      row.forEach((c, k) => {
        const s = this.styled(c);
        const pad = s.padding.map((p) => px(p, cbWidth));
        let bl: number;
        let br: number;
        let bt: number;
        let bb: number;
        if (collapse) {
          [bl, br] = this.collapsedSides(row, g.rows[ri], k, ts);
          bt = this.hEdge(g, ri, k, ts).w / 2;
          bb = this.hEdge(g, ri + 1, k, ts).w / 2;
        } else {
          bl = s.border[3].w;
          br = s.border[1].w;
          bt = s.border[0].w;
          bb = s.border[2].w;
        }
        const inner = widths[k] - pad[1] - pad[3] - bl - br;
        // The content is always centred (the UA's middle): a cell, or its row, set to top or bottom
        // put "Fy 50.0" beside the wrong line of the cell next to it (T1-3 review).
        for (const va of [s.verticalAlign, this.styled(g.rows[ri]).verticalAlign]) {
          if (va === "top" || va === "bottom")
            this.refuse.add(`vertical-align: ${va} in a table cell`);
        }
        const rec = new Recorder();
        // A cell is its own formatting context: its children's margins stay inside it.
        const f = new Flow(Number.POSITIVE_INFINITY, () => rec);
        this.blockChildren(c, 0, inner, f, () => rec);
        if (f.breakInBox) this.refuse.add("a forced page break inside a table cell");
        f.y += f.collapsed();
        f.clearMargins();
        const ch = f.y + pad[0] + pad[2] + bt + bb;
        if (s.height !== "auto") this.refuse.add("a cell height");
        boxes.push({ el: c, rec, h: ch, x: colX[k], w: widths[k] });
        void bl;
        if (ch > h) h = ch;
      });
      return { boxes, h };
    };

    // The table's own `break-inside: avoid`, as Blink applies it (see {@link block}): moved on to
    // the next page when it does not fit in the room left. Rows measured ahead are kept for the
    // layout; the measuring stops once past the room.
    const measured: { boxes: CellBox[]; h: number }[] = [];
    const top = collapse ? 0 : tb[0] + tpad[0] + sp;
    const bottom = collapse ? 0 : tb[2] + tpad[2] + sp;
    if (ts.avoidInside && flow.hasContent) {
      const room = flow.room();
      let total = top + bottom;
      for (let ri = 0; ri < g.rows.length && total <= room; ri++) {
        measured.push(measureRow(ri));
        total += measured[ri].h + (collapse ? 0 : sp);
      }
      if (total > room) flow.newPage(false);
    }
    /** A row of header cells only (`th`): kept with the row after it. */
    const isHeader = (ri: number) =>
      g.cells[ri].length > 0 && g.cells[ri].every((c) => c.tag === "th");
    // Collapsed borders drawn as a grid, each line once (owner, 2026-11-11: "the resulting pdf is
    // minimized"): a row's top edges merged along it where they are alike; each column's edge
    // merged down the page; a row's bottom edge drawn only where no row below shares it -- the
    // table's last, or the last before a page break. The same lines, in the same places.
    type HSeg = { x0: number; x1: number; e: Edge };
    type VSeg = { page: number; x: number; y0: number; y1: number; e: Edge };
    const alike = (a: Edge, b: Edge) => a.w === b.w && a.color.every((v, i) => v === b.color[i]);
    const drawH = (page: number, y: number, segs: HSeg[]) => {
      const out = flow.sinkFor(page);
      let cur: HSeg | null = null;
      const emit = (s: HSeg | null) => {
        if (s && s.e.w > 0)
          out.rect(BORDER_LAYER, s.x0, y - s.e.w / 2, s.x1 - s.x0, s.e.w, s.e.color);
      };
      for (const s of segs) {
        if (cur && alike(cur.e, s.e) && s.x0 <= cur.x1 + 0.01) cur.x1 = Math.max(cur.x1, s.x1);
        else {
          emit(cur);
          cur = { ...s };
        }
      }
      emit(cur);
    };
    const vOpen = new Map<number, VSeg>();
    const emitV = (v: VSeg) => {
      if (v.e.w > 0)
        flow
          .sinkFor(v.page)
          .rect(BORDER_LAYER, v.x - v.e.w / 2, v.y0, v.e.w, v.y1 - v.y0, v.e.color);
    };
    const vEdge = (key: number, seg: VSeg) => {
      const o = vOpen.get(key);
      if (
        o &&
        o.page === seg.page &&
        Math.abs(o.y1 - seg.y0) < 0.01 &&
        Math.abs(o.x - seg.x) < 0.01 &&
        alike(o.e, seg.e)
      ) {
        o.y1 = seg.y1;
        return;
      }
      if (o) emitV(o);
      vOpen.set(key, seg);
    };
    let lastBottom: { page: number; y: number; segs: HSeg[] } | null = null;

    const entry = { start: null as Placed | null };
    flow.open.push(entry);
    if (top > 0) flow.place(top);
    for (let ri = 0; ri < g.rows.length; ri++) {
      // Header rows keep with the first row after them: none is left at a page's foot apart from
      // the body it heads (they were: "X Y Z" at one page's foot, "ID Coordinate…" atop the next).
      if (isHeader(ri) && (ri === 0 || !isHeader(ri - 1)) && flow.hasContent) {
        let need = 0;
        let j = ri;
        for (; j < g.rows.length && isHeader(j); j++) {
          measured[j] ??= measureRow(j);
          need += measured[j].h;
        }
        if (j < g.rows.length) {
          measured[j] ??= measureRow(j);
          need += measured[j].h;
        }
        if (need > flow.room()) flow.newPage(false);
      }
      const { boxes, h } = measured[ri] ?? measureRow(ri);
      measured[ri] = undefined as unknown as { boxes: CellBox[]; h: number }; // let it go
      if (h > flow.height) this.refuse.add("a table row taller than a page");
      const at = flow.place(h + (ri < g.rows.length - 1 && !collapse ? sp : 0));
      const out = flow.sinkFor(at.page);
      const row = g.rows[ri];
      const rs = this.styled(row);
      const x0 = colX[0];
      const x1 = colX[colX.length - 1] + widths[widths.length - 1];
      if (rs.background && rs.exact) out.rect(row.depth, x0, at.y, x1 - x0, h, rs.background);
      const tops: HSeg[] = [];
      const bottoms: HSeg[] = [];
      for (const [k, b] of boxes.entries()) {
        const s = this.styled(b.el);
        const pad = s.padding.map((p) => px(p, cbWidth));
        if (s.background && s.exact) out.rect(b.el.depth, b.x, at.y, b.w, h, s.background);
        let bl = 0;
        let bt = 0;
        let bb = 0;
        if (collapse) {
          const row2 = g.cells[ri];
          const [L, R] = this.collapsedEdges(row2, g.rows[ri], k, ts);
          const T = this.hEdge(g, ri, k, ts);
          const B = this.hEdge(g, ri + 1, k, ts);
          bl = L.w / 2;
          bt = T.w / 2;
          bb = B.w / 2;
          const x0e = b.x - L.w / 2;
          const x1e = b.x + b.w + R.w / 2;
          tops.push({ x0: x0e, x1: x1e, e: T });
          bottoms.push({ x0: x0e, x1: x1e, e: B });
          vEdge(k, { page: at.page, x: b.x, y0: at.y, y1: at.y + h, e: L });
          if (k === row2.length - 1) {
            vEdge(k + 1, { page: at.page, x: b.x + b.w, y0: at.y, y1: at.y + h, e: R });
          }
        } else {
          this.decorateBox(b.el, { ...s, background: null }, out, b.x, at.y, b.w, h);
          bl = s.border[3].w;
          bt = s.border[0].w;
          bb = s.border[2].w;
        }
        // vertical-align: middle (the UA's for rows), the content centred in the cell.
        const contentH = b.h - pad[0] - pad[2] - bt - bb;
        const free = h - pad[0] - pad[2] - bt - bb - contentH;
        b.rec.replay(out, b.x + bl + pad[3], at.y + bt + pad[0] + free / 2);
      }
      if (collapse) {
        // The row above ends a page fragment: its bottom edge is drawn there; on the same page
        // this row's top edge is the line they share.
        if (lastBottom && lastBottom.page !== at.page)
          drawH(lastBottom.page, lastBottom.y, lastBottom.segs);
        drawH(at.page, at.y, tops);
        lastBottom = { page: at.page, y: at.y + h, segs: bottoms };
      }
    }
    if (lastBottom) drawH(lastBottom.page, lastBottom.y, lastBottom.segs);
    for (const v of vOpen.values()) emitV(v);
    if (bottom > 0) flow.place(bottom);
    flow.open.pop();
    const end = flow.here();
    if (!collapse) this.decorate(e, ts, left, tableW, entry.start ?? end, end, flow, sink);
    else if (ts.background) this.refuse.add("a background on a collapsed table");
    if (ts.breakAfter === "page") flow.forceBreak();
  }

  /** The border between row `ri - 1` and row `ri` in column `k` (collapsed: the wider wins). */
  hEdge(g: { rows: Elem[]; cells: Elem[][] }, ri: number, k: number, ts: Style): Edge {
    const above = ri > 0 ? g.cells[ri - 1][k] : undefined;
    const below = ri < g.rows.length ? g.cells[ri][k] : undefined;
    const es: Edge[] = [];
    if (above) es.push(this.styled(above).border[2], this.styled(g.rows[ri - 1]).border[2]);
    if (below) es.push(this.styled(below).border[0], this.styled(g.rows[ri]).border[0]);
    if (ri === 0) es.push(ts.border[0]);
    if (ri === g.rows.length) es.push(ts.border[2]);
    let best = NO_EDGE;
    for (const e of es) {
      if (e.style === "hidden") return NO_EDGE;
      if (e.w > best.w) best = e;
    }
    return best;
  }
}

/** Unicode's default-ignorable characters a report might hold: drawn as nothing by Chrome. */
const INVISIBLE_RANGES: [number, number][] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
];
const isInvisible = (cp: number): boolean => INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b);

/** The edge that wins a collapsed border: a hidden one over all, then the widest. */
function winEdge(...es: Edge[]): Edge {
  return es.reduce(
    (a, b) =>
      b.style === "hidden" || a.style === "hidden"
        ? a.style === "hidden"
          ? a
          : b
        : b.w > a.w
          ? b
          : a,
    NO_EDGE,
  );
}

/** An element's text, its whitespace collapsed (for naming it in a refusal). */
function textOf(e: Elem | undefined): string {
  if (!e) return "";
  const walk = (n: Elem | string): string =>
    typeof n === "string" ? n : n.kids.map(walk).join(" ");
  return walk(e).replace(/\s+/g, " ").trim();
}

/** An inset / outset edge as Chrome shades it: the top-left side darker, the bottom-right as is. */
function edgeColour(e: Edge, topLeft: boolean): RGBA {
  if (e.style === "inset" ? topLeft : e.style === "outset" ? !topLeft : false) {
    return [e.color[0] * (2 / 3), e.color[1] * (2 / 3), e.color[2] * (2 / 3), e.color[3]];
  }
  return e.color;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** What {@link renderDocument} returns. */
export type NativeRender = {
  /** The PDF, or null when anything was refused. */
  pdf: Uint8Array | null;
  pages: number;
  /** The shrink-to-fit: 1, or the page's width over the width the document reaches. */
  scale: number;
  /** What the renderer could not draw, each named: any one means no PDF. */
  refused: string[];
};

/**
 * A JPEG's EXIF orientation (1–8), or null when it has none: the APP1 `Exif` segment's TIFF
 * header, IFD0, tag 0x0112. Anything malformed reads as none -- the decoder judges the image.
 */
function jpegOrientation(b: Uint8Array): number | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xda || marker === 0xd9 || len < 2) return null; // the image data: no EXIF
    const s = i + 4;
    if (
      marker === 0xe1 &&
      len >= 16 &&
      String.fromCharCode(...b.subarray(s, s + 6)) === "Exif\0\0"
    ) {
      const t = s + 6;
      const le = b[t] === 0x49 && b[t + 1] === 0x49;
      if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return null;
      const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o: number) =>
        le
          ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
          : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const ifd = t + u32(t + 4);
      const end = Math.min(b.length, i + 2 + len);
      if (ifd + 2 > end) return null;
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > end) return null;
        if (u16(e) === 0x0112) return u16(e + 8);
      }
      return null;
    }
    i += 2 + len;
  }
  return null;
}

/** A data URI's bytes. */
function dataBytes(uri: string): { type: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?),([\s\S]*)$/i.exec(uri.trim());
  if (!m) return null;
  const base64 = /;base64/i.test(m[2]);
  const data = m[3];
  const bytes = base64
    ? Uint8Array.from(atob(data.replace(/\s+/g, "")), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(data));
  return { type: m[1].toLowerCase(), bytes };
}

/**
 * The baked document as a PDF, laid out by this module -- no browser. Letter pages, 0.5 in margins
 * (the document's own `@page`). Returns the PDF only when nothing was refused.
 *
 * @param html the document {@link assembleDocument} made
 * @param fonts the faces to draw in and embed ({@link RenderFonts}; the runtime's
 *   `readRenderFonts` reads the ones the package ships)
 */
export async function renderDocument(html: string, fonts: RenderFonts): Promise<NativeRender> {
  const refuse = new Refusals();
  const root = parseDocument(html, refuse);
  const head = root.kids.find((k): k is Elem => typeof k !== "string" && k.tag === "head");
  const body = root.kids.find((k): k is Elem => typeof k !== "string" && k.tag === "body");
  if (!body) return { pdf: null, pages: 0, scale: 1, refused: ["no <body>"] };
  const rules: Rule[] = [];
  parseSheet(UA_CSS, 0, refuse, rules);
  const sheets: string[] = [];
  const collect = (e: Elem) => {
    for (const k of e.kids) {
      if (typeof k === "string") continue;
      if (k.tag === "style") sheets.push(k.kids.join(""));
      else if (k.tag === "link" && /stylesheet/i.test(k.attrs?.get("rel") ?? "")) {
        // The document's CSP forbids outside loads: Chrome applies no linked sheet either.
      } else collect(k);
    }
  };
  if (head) collect(head);
  collect(body);
  const page = /@page\s*\{([^}]*)\}/i.exec(sheets.join("\n"))?.[1] ?? "";
  if (!/size:\s*Letter/i.test(page) || !/margin:\s*0\.5in/i.test(page)) {
    refuse.add(`a page other than Letter with 0.5 in margins (@page {${page.trim()}})`);
  }
  for (const s of sheets) parseSheet(s, 1, refuse, rules);
  const cascade = new Cascade(rules, refuse);

  const pdf = await PDFDocument.create();
  pdf.setProducer("s3d-reportcompiler native renderer");
  pdf.setCreator("s3d-reportcompiler");
  // No render-time stamp: the same document makes the same PDF.
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  // The document's language, as Chrome writes it (a joined native-only PDF had none; T1-3).
  const lang = root.attrs?.get("lang")?.trim();
  if (lang) pdf.setLanguage(lang);
  const faces = await Fonts.load(pdf, fonts, refuse);

  // Every image the document draws, embedded once.
  const images = new Map<string, Img>();
  const embedAll = async (e: Elem) => {
    for (const k of e.kids) {
      if (typeof k === "string") continue;
      if (k.tag === "img") {
        const src = k.attrs?.get("src") ?? "";
        if (!images.has(src)) {
          let d: ReturnType<typeof dataBytes>;
          try {
            d = dataBytes(src);
          } catch (err) {
            // A bare `%` in a URI, bad base64: it threw out of the render as a crash (T1-3 review).
            refuse.add(`an image whose data cannot be read (${(err as Error).message})`);
            continue;
          }
          if (!d) continue; // refused where drawn
          let embedded: { ref: PDFRef; width: number; height: number } | null = null;
          try {
            const jpeg = d.type === "image/jpeg" || d.type === "image/jpg";
            // Chrome turns a JPEG by its EXIF orientation; drawn as stored it lay on its side,
            // and the pixel check (which reads the stored pixels) passed (T1-3 review).
            const turned = jpeg ? jpegOrientation(d.bytes) : null;
            if (turned !== null && turned !== 1) {
              refuse.add(`a JPEG turned by its EXIF orientation (${turned})`);
            }
            if (jpeg) embedded = await pdf.embedJpg(d.bytes);
            else if (d.type === "image/png") embedded = await pdf.embedPng(d.bytes);
            else refuse.add(`an image of type ${d.type}`);
          } catch (err) {
            refuse.add(`an image that could not be read (${(err as Error).message})`);
          }
          if (embedded)
            images.set(src, { ref: embedded.ref, w: embedded.width, h: embedded.height });
        }
      }
      await embedAll(k);
    }
  };
  await embedAll(body);

  // Chrome's shrink-to-fit (measured 2026-11-11 on the 36ft report: every size printed at 0.8467
  // of CSS's 0.75 pt/px = 720 / 850 px, its widest table): laid out at the page's width first; a
  // document reaching past it is laid out again at the width it reaches (at most twice the page),
  // the page's height in the same ratio, and every page scaled down to fit -- Blink's
  // `ForceLayoutForPagination`. The body's box is the page's content box (the document sets
  // `html, body { margin: 0; padding: 0 }`).
  const lay = (w: number, h: number, final: boolean, sinkFor: (p: number) => Sink) => {
    const layout = new Layout(cascade, faces, images, refuse, { w, h, final });
    const flow = new Flow(h, sinkFor);
    layout.block(body, 0, w, flow, sinkFor);
    return { layout, flow };
  };
  const first = lay(CONTENT_W, CONTENT_H, false, () => NULL_SINK);
  const width = Math.min(Math.max(CONTENT_W, Math.ceil(first.layout.reach)), 2 * CONTENT_W);
  const scale = CONTENT_W / width;
  const sinks: PageSink[] = [];
  const sinkFor = (p: number): Sink => {
    while (sinks.length <= p) sinks.push(new PageSink(PT * scale));
    return sinks[p];
  };
  sinkFor(0);
  const laid = lay(width, CONTENT_H / scale, true, sinkFor);
  if (laid.flow.pastFoot) refuse.add("content past the foot of a page");

  if (refuse.list.size > 0)
    return { pdf: null, pages: sinks.length, refused: [...refuse.list], scale };

  // The pages: each one's operators, its fonts, images and alpha states.
  const alphaRefs = new Map<number, PDFRef>();
  for (const s of sinks) {
    const p = pdf.addPage([PAGE_W_PT, PAGE_H_PT]);
    // The content FIRST: writing it is what finds the alpha states it uses (resources attached
    // before it left /GS… names undefined, and every zebra row opaque, 2026-11-11).
    const content = s.content();
    for (const face of s.fonts) p.node.setFontDictionary(PDFName.of(face.name), face.font.ref);
    for (const img of s.images) p.node.setXObject(PDFName.of(`Im${img.ref.objectNumber}`), img.ref);
    for (const a of s.alphas) {
      let ref = alphaRefs.get(a);
      if (!ref) {
        ref = pdf.context.register(pdf.context.obj({ Type: "ExtGState", ca: a, CA: a }));
        alphaRefs.set(a, ref);
      }
      p.node.setExtGState(PDFName.of(`GS${Math.round(a * 1000)}`), ref);
    }
    const stream = pdf.context.flateStream(content);
    p.node.set(PDFName.of("Contents"), pdf.context.register(stream));
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  return { pdf: bytes, pages: sinks.length, scale, refused: [] };
}
