/**
 * How a report's HTML text is styled, read from its source, and compared with how the PDF prints
 * it (roadmap task 18 group 9b; owner, 2026-11-09: "Text styling (weight, colour, size of HTML
 * text and SVG labels) should match the html as close as possible when converting to pdf").
 *
 * The source side builds the body's element tree by HTML's own nesting, runs the cascade over it
 * -- the report's rules, the inline styles, the browser's own defaults ({@link htmlDefaults}) --
 * and gives every word of its text the weight, style, colour (with its alpha) and size it is drawn
 * in. Maths (the report's own delimiters), drawings (checked label by label, group 9a), scripts and
 * what is not displayed are left out. The PDF side gives every printed word the style of the piece
 * it starts in (the font's PostScript name, its fill and alpha, its size). Compared by counts, as
 * the words themselves are (#89): for each word and style, the PDF must print at least as many in
 * that style as the source holds.
 *
 * Pure: no I/O, no dependency beyond this package's own readers.
 *
 * @module
 */

import {
  cssRules,
  declarationsOf,
  fontItalic,
  fontSizePx,
  fontWeight,
  htmlDefaults,
  matches,
  type Node,
  type PdfRun,
  type PdfRunStyle,
  paintOf,
  type Rule,
} from "./report_svg.ts";
import { decodeEntities } from "./report_core.ts";

/** How a word is drawn: bold or not, italic or not, its colour (sRGB 0–1) and alpha, its size. */
export type TextStyle = {
  bold: boolean;
  italic: boolean;
  colour: number[];
  alpha: number;
  /** In CSS px for a source word, in points for a printed one (Chrome prints 1 px as 1 pt here). */
  size: number;
};

/** One word with how it is drawn. */
export type StyledWord = { word: string; style: TextStyle };

const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
const CLOSES_P = new Set(
  (
    "address article aside blockquote center details dialog dir div dl fieldset figcaption " +
    "figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section " +
    "summary table ul li dd dt"
  ).split(" "),
);
/** Elements whose content is not drawn as text, or is checked elsewhere (drawings, maths). */
const NOT_TEXT = new Set(
  "script style template noscript title head textarea select datalist svg math object iframe canvas".split(
    " ",
  ),
);
/** Elements that do not end a word: their text runs on into what follows (phrasing content). */
const PHRASING = new Set(
  (
    "a abbr b bdi bdo cite code data del dfn em font i ins kbd label mark q s samp small span " +
    "strike strong time tt u var big"
  ).split(" "),
);

/**
 * Where an end tag's search for its element stops (the HTML Standard's scopes): a cell's, a row's
 * or a section's end never leaves its table; `</table>` closes the nearest table; any other end
 * tag never crosses a table, a cell or a caption. A stray `</td>` with no cell open in its own
 * table closed the table around it (the samples' "User input" row, measured 2026-11-10).
 */
export function endScope(name: string): string[] {
  if (/^(td|th|tr|tbody|thead|tfoot|caption)$/.test(name)) return ["table", "html", "template"];
  if (name === "table") return ["html", "template"];
  const scope = ["table", "td", "th", "caption", "html", "template", "object", "applet", "marquee"];
  return name === "p" ? [...scope, "button"] : scope;
}

/**
 * The element tree of an HTML fragment, by HTML's nesting: void elements hold nothing, an end tag
 * closes up to its element (or nothing), a start tag closes what HTML closes for it (an open `<p>`
 * before a block, a cell before a cell, a row before a row, a list item before an item). The
 * content of raw-text elements and of `<svg>` / `<math>` is not parsed (none of it is text here).
 */
export function parseHtml(html: string): Node {
  const root: Node = { tag: "#root", attrs: new Map(), children: [], text: "" };
  const stack: Node[] = [root];
  const src = html.replace(/<!--[\s\S]*?-->/g, "");
  const closeTo = (names: string[], stopAt: string[] = []) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stopAt.includes(stack[k].tag)) return;
      if (names.includes(stack[k].tag)) {
        stack.length = k;
        return;
      }
    }
  };
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>|([^<]+|<)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      top.children.push({ tag: "#text", attrs: new Map(), children: [], text: m[4] });
      continue;
    }
    const name = m[2].toLowerCase();
    if (m[1]) {
      closeTo([name], endScope(name));
      continue;
    }
    if (CLOSES_P.has(name)) closeTo(["p"], ["table", "td", "th", "button"]);
    if (name === "li") closeTo(["li"], ["ul", "ol"]);
    if (name === "dt" || name === "dd") closeTo(["dt", "dd"], ["dl"]);
    if (name === "td" || name === "th") closeTo(["td", "th"], ["tr", "table"]);
    if (name === "tr") closeTo(["tr"], ["table", "tbody", "thead", "tfoot"]);
    if (name === "tbody" || name === "thead" || name === "tfoot")
      closeTo(["tbody", "thead", "tfoot"], ["table"]);
    const attrs = new Map<string, string>();
    for (const a of m[3].matchAll(/([^\s=/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      if (!attrs.has(a[1].toLowerCase()))
        attrs.set(a[1].toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
    }
    // A row straight inside a table is in the <tbody> the parser makes for it (`table>tbody>tr`
    // matched nothing: the samples' italic `td.align-right` rule, measured 2026-11-10).
    if (name === "tr" && stack[stack.length - 1].tag === "table") {
      const tbody: Node = { tag: "tbody", attrs: new Map(), children: [], text: "" };
      stack[stack.length - 1].children.push(tbody);
      stack.push(tbody);
    }
    const node: Node = { tag: name, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (VOID.has(name)) continue;
    if (NOT_TEXT.has(name)) {
      // passed over to its end (an <svg>'s or <math>'s nesting balanced)
      const close = new RegExp(`<(/?)${name}(?=[\\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>`, "gi");
      close.lastIndex = re.lastIndex;
      let depth = m[3].trimEnd().endsWith("/") ? 0 : 1;
      for (let c = close.exec(src); c && depth > 0; c = close.exec(src)) {
        if (name === "svg" || name === "math") depth += c[1] ? -1 : c[0].endsWith("/>") ? 0 : 1;
        else if (c[1]) depth = 0;
        re.lastIndex = c.index + c[0].length;
      }
      if (depth > 0) re.lastIndex = src.length; // unterminated: the rest is its content
      continue;
    }
    // HTML ignores a `/>` on an element that is not void: it opens all the same.
    stack.push(node);
  }
  return root;
}

/** The cascade over HTML: `!important` inline, `!important` rules, inline, rules -- no attributes. */
function htmlCascade(rules: Rule[]) {
  return (n: Node, prop: string, ancestors: Node[]): string | undefined => {
    let best: { important: boolean; spec: number; order: number; value: string } | null = null;
    for (const r of rules) {
      const d = r.decls.get(prop);
      if (!d || !matches(r.sel, n, ancestors)) continue;
      const cand = { important: d.important, spec: r.sel.spec, order: r.order, value: d.value };
      if (
        best === null ||
        cand.important > best.important ||
        (cand.important === best.important &&
          (cand.spec > best.spec || (cand.spec === best.spec && cand.order > best.order)))
      ) {
        best = cand;
      }
    }
    const inline = declarationsOf(n.attrs.get("style") ?? "", new Set([prop])).get(prop);
    if (inline?.important) return inline.value;
    if (best?.important) return best.value;
    if (inline) return inline.value;
    if (best) return best.value;
    // HTML's one presentational colour: <font color>
    if (prop === "color" && n.tag === "font") return n.attrs.get("color");
    return undefined;
  };
}

type Inherited = {
  weight: number;
  italic: boolean;
  size: number;
  /** RGB 0–1 with its alpha as a fourth value. */
  colour: number[];
  opacity: number;
  visible: boolean;
};

/**
 * Every word of a report's text with the style it is drawn in. `body` is the body as a reader sees
 * it, in its `<html>` and `<body>` (`readerBody`), `css` every stylesheet of the report, `maths`
 * the report's maths (its delimited expressions are not text here). What the cascade cannot read
 * -- a selector, a system font -- is named in `unread`.
 */
export function styledWords(
  body: string,
  css: string,
  maths: RegExp | null,
): { words: StyledWord[]; unread: string[] } {
  const unread = new Set<string>();
  const rules = cssRules(css, unread, 0, true);
  const own = htmlCascade(rules);
  const root = parseHtml(body);
  // The flow of text: each piece with its style; a break between blocks.
  const pieces: { text: string; style: Inherited | null }[] = [];
  const brk = () => pieces.push({ text: " ", style: null });
  const step = (n: Node, inh: Inherited, anc: Node[]): Inherited | null => {
    const get = (p: string) => own(n, p, anc) ?? htmlDefaults(n)[p];
    if (get("display")?.trim() === "none" || n.attrs.has("hidden")) return null;
    const vis = get("visibility");
    const colour = get("color");
    const parsed =
      colour === undefined ? inh.colour : (paintOf(colour, inh.colour.slice(0, 3)) ?? inh.colour);
    const fonts = ["font-weight", "font-style", "font-size"].map(get);
    if (fonts.includes("system")) unread.add("text in a system font (the host's, no source's)");
    return {
      weight: fontWeight(fonts[0], inh.weight),
      italic: fontItalic(fonts[1], inh.italic),
      size: fontSizePx(fonts[2], inh.size),
      colour: Array.isArray(parsed) ? parsed : inh.colour,
      opacity: inh.opacity * (Number.parseFloat(get("opacity") ?? "1") || 0),
      visible: vis === undefined ? inh.visible : vis !== "hidden" && vis !== "collapse",
    };
  };
  const walk = (n: Node, inh: Inherited, anc: Node[]) => {
    for (const k of n.children) {
      if (k.tag === "#text") {
        pieces.push({ text: decodeEntities(k.text), style: inh.visible ? inh : null });
        continue;
      }
      if (NOT_TEXT.has(k.tag) || k.tag === "br" || k.tag === "img" || k.tag === "hr") {
        brk();
        continue;
      }
      const here = step(k, inh, [...anc, n]);
      if (!here) continue;
      const block = !PHRASING.has(k.tag);
      if (block) brk();
      walk(k, here, [...anc, n]);
      if (block) brk();
    }
  };
  // From the document's own <html> and <body>, which `readerBody` puts around it.
  if (body.match(/^\s*<html\b[^>]*\sdata-s3d-reveal-unread/i))
    unread.add("a report script that reveals by a selector this reader cannot match");
  walk(
    root,
    { weight: 400, italic: false, size: 16, colour: [0, 0, 0], opacity: 1, visible: true },
    [],
  );

  // One string, a style per character; the report's maths blanked.
  let flow = "";
  const styleAt: (Inherited | null)[] = [];
  for (const p of pieces) {
    flow += p.text;
    for (let k = 0; k < p.text.length; k++) styleAt.push(p.style);
  }
  if (maths) flow = flow.replace(maths, (m) => " ".repeat(m.length));
  const words: StyledWord[] = [];
  for (const m of flow.matchAll(WORD)) {
    const s = styleAt[m.index ?? 0];
    if (!s) continue;
    words.push({ word: m[0].toLowerCase(), style: sourceStyle(s) });
  }
  return { words, unread: [...unread] };
}

/** A word: letters (two or more) or a number, as both sides tokenise it. */
export const WORD: RegExp = /\p{L}{2,}|\p{N}+(?:\.\p{N}+)?/gu;

function sourceStyle(s: Inherited): TextStyle {
  return {
    bold: s.weight >= 600,
    italic: s.italic,
    colour: s.colour.slice(0, 3),
    alpha: (s.colour[3] ?? 1) * s.opacity,
    size: s.size,
  };
}

/** A PostScript font name's weight words. */
const BOLD_NAME = /bold|black|heavy|semibold|demibold|demi\b|ultra/i;

/** How a printed piece is drawn, as a {@link TextStyle}. */
export function printedStyle(s: PdfRunStyle): TextStyle {
  const name = s.font.replace(/^[A-Z]{6}\+/, "");
  return {
    bold: BOLD_NAME.test(name) || s.mode === 2,
    italic: /italic|oblique/i.test(name) || Math.abs(s.skew ?? 0) > 0.1,
    colour: s.fill.slice(0, 3),
    alpha: s.alpha,
    size: s.size,
  };
}

/**
 * A printed run's words, each with the style of the piece it starts in. A word whose piece the PDF
 * reader could not pair with its show has no style, and matches no source word's: it fails, loudly.
 */
export function printedWords(run: PdfRun): StyledWord[] {
  const pieces = run.pieces ?? [];
  const out: StyledWord[] = [];
  // Maths is MathJax's, not the report's text: blanked, as the source side blanks it -- and a
  // symbol set right after a word ("Bending Moment" + M, no space between) stays apart from it.
  let text = run.text;
  pieces.forEach((p, k) => {
    if (!/MathJax_/i.test(p.style?.font ?? "")) return;
    const to = pieces[k + 1]?.at ?? text.length;
    text = text.slice(0, p.at) + " ".repeat(to - p.at) + text.slice(to);
  });
  for (const m of text.matchAll(WORD)) {
    const at = m.index ?? 0;
    let piece: (typeof pieces)[number] | undefined;
    for (const p of pieces) if (p.at <= at) piece = p;
    out.push({
      word: m[0].toLowerCase(),
      style: piece?.style
        ? printedStyle(piece.style)
        : { bold: false, italic: false, colour: [-1, -1, -1], alpha: -1, size: -1 },
    });
  }
  return out;
}

/** A style as a key, its size left out: weight, slant, colour (8-bit) and alpha (two places). */
export function styleKey(s: TextStyle): string {
  const hex = s.colour
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return `${s.bold ? "bold" : "regular"} ${s.italic ? "italic" : "upright"} #${hex} alpha ${s.alpha.toFixed(2)}`;
}

/**
 * The print's scale, CSS px to points: Chrome fits the report's laid-out width to the page (the
 * samples: 13 px printed at 7.2 pt, measured 2026-11-10 -- Letter's 540 pt between its margins
 * over about 975 px). Measured from the document, not predicted from a layout: the median ratio
 * over the words whose size is one on each side. A uniform scale is the layout's; any word off it
 * is a size changed. `null` when no word gives a ratio.
 */
export function printScale(source: StyledWord[], printed: StyledWord[]): number | null {
  const sizes = (ws: StyledWord[]) => {
    const m = new Map<string, Set<number>>();
    for (const w of ws) {
      const k = `${w.word}\u0000${styleKey(w.style)}`;
      const s = m.get(k) ?? new Set<number>();
      s.add(Math.round(w.style.size * 100) / 100);
      m.set(k, s);
    }
    return m;
  };
  const src = sizes(source);
  const pdf = sizes(printed);
  const ratios: number[] = [];
  for (const [k, a] of src) {
    const b = pdf.get(k);
    if (a.size === 1 && b?.size === 1) ratios.push([...b][0] / [...a][0]);
  }
  if (ratios.length === 0) return null;
  ratios.sort((x, y) => x - y);
  return ratios[Math.floor(ratios.length / 2)];
}

/**
 * Whether the PDF prints every source word in its style: each source occurrence of a word paired
 * with a printed one of the same weight and slant, its colour within 3 of 255 per channel, its
 * alpha within 0.02, its size the source's at the print's scale ({@link printScale}) within 2 %.
 * Tolerances, not keys: 0.87 × 0.5 = 0.435 rounded to two places differed by side (measured
 * 2026-11-10). The PDF may print more (the drawings' labels, the template). A word judged only
 * where the PDF printed it: an occurrence it does not print is the word check's to name. Each
 * word printed otherwise named once, with its counts and both styles.
 */
export function compareStyles(
  source: StyledWord[],
  printed: StyledWord[],
): {
  problems: string[];
  scale: number | null;
  /** Source occurrences judged: paired, or set against one the PDF printed otherwise. */
  judged: number;
} {
  const scale = printScale(source, printed) ?? 1;
  let judged = 0;
  const group = (ws: StyledWord[]) => {
    const g = new Map<string, TextStyle[]>();
    for (const w of ws) g.set(w.word, [...(g.get(w.word) ?? []), w.style]);
    return g;
  };
  const same = (s: TextStyle, p: TextStyle) =>
    s.bold === p.bold &&
    s.italic === p.italic &&
    [0, 1, 2].every((c) => Math.abs(s.colour[c] - p.colour[c]) <= 3 / 255) &&
    Math.abs(s.alpha - p.alpha) <= 0.02 &&
    Math.abs(p.size - s.size * scale) <= 0.02 * s.size * scale + 0.01;
  const got = group(printed);
  const problems: string[] = [];
  for (const [word, styles] of group(source)) {
    const left = [...(got.get(word) ?? [])];
    const missed: TextStyle[] = [];
    for (const s of styles) {
      const at = left.findIndex((p) => same(s, p));
      if (at >= 0) left.splice(at, 1);
      else missed.push(s);
    }
    // Only a word the PDF prints is judged here: an occurrence it does not print at all (cut by
    // a wrap -- `word-break: break-all` printed "Zorbl" / "axian", task 18 item 3 -- or lost) is
    // the word check's, which joins wraps and names what is missing. So a miss counts while an
    // occurrence the PDF printed in some other style is left over.
    const wrong = Math.min(missed.length, left.length);
    // Said, so a reading that loses words (glued, unpaired) is seen, not passed as judged.
    judged += styles.length - missed.length + wrong;
    if (wrong === 0) continue;
    const what = (s: TextStyle) => `${styleKey(s)} at ${Number(s.size.toFixed(2))} px`;
    const shown = [...new Set(missed.map(what))].slice(0, 2).join(", ");
    const printedAs = [
      ...new Set(left.map((p) => `${styleKey(p)} at ${Number((p.size / scale).toFixed(2))} px`)),
    ]
      .slice(0, 2)
      .join(", ");
    problems.push(
      `"${word}": ${wrong} of its ${styles.length} printed otherwise than its source -- wanted ${shown}; printed ${printedAs}`,
    );
  }
  return { problems, scale, judged };
}
