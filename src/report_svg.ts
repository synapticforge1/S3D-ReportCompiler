/**
 * The verification's own reading of an inline SVG drawing, and its comparison with the paths and
 * text the finished PDF draws (roadmap task 18 group 8). Pure: no I/O, no DOM. Not part of the
 * package's API (the exports map does not name it); the CLI uses it.
 *
 * Measured on Chrome's PDFs (2026-11-08): each SVG shape is one PDF path in the shape's OWN
 * coordinates (relative commands resolved, curves and arcs as Béziers), under a transform that is
 * the element's SVG transform times one base transform for the whole drawing; a shape with a
 * fill and a stroke is two paths, the fill first; a circle or an arc is many small Béziers; a
 * label is text whose baseline origin is the SVG text's anchor point. So both sides are compared
 * in the shape's own coordinates, flattened, within a tolerance.
 *
 * @module
 */

import { decodeEntities } from "./report_core.ts";
import { blank, PRIMITIVES, type Primitive, runFilter } from "./report_filter.ts";

/** A transform as PDF and pdf.js write it, [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = number[];

/**
 * A polyline: its points, and whether it closes back to its first; for a path, also its
 * vertices (each command's end point), where markers stand.
 */
export type Polyline = { points: number[][]; closed: boolean; vertices?: number[][] };

/** One drawn shape of the source SVG, in its own coordinates. */
export type SvgShape = {
  /** What it is, for a message: `path`, `line`, `rect`, ... */
  what: string;
  lines: Polyline[];
  /** Its transform within the drawing (its own and its ancestors'). */
  e: Matrix;
  fill: number[] | null;
  stroke: number[] | null;
  strokeWidth: number;
  /** The stroke as drawn: its dashes, each an open polyline (the whole outline when not dashed). */
  dashed: Polyline[];
  /** Fill and stroke alpha: their own opacity times every `opacity` around them. */
  fillAlpha: number;
  strokeAlpha: number;
  /** `stroke-linecap`: a zero-length stroke draws a dot with `round` or `square`, nothing with `butt`. */
  cap: string;
  /** A gradient the fill or stroke paints with, in place of `fill` / `stroke` (then null). */
  fillGradient?: Gradient;
  strokeGradient?: Gradient;
  /**
   * Group 8d (2026-11-09): what the check read the drawing without, so a change to it passed --
   * the clips around the shape (its viewports, `clip-path`), in the DRAWING's coordinates; its
   * `fill-rule`; `stroke-linejoin` and `stroke-miterlimit`; `paint-order` (the stroke first).
   */
  clips?: SvgClip[];
  evenOdd?: boolean;
  join?: string;
  miter?: number;
  strokeFirst?: boolean;
  /** Group 8g: a pattern the fill or stroke paints with, in place of `fill` / `stroke`. */
  fillPattern?: SvgPattern;
  strokePattern?: SvgPattern;
  /** Group 8h: the mask over it (its own, or an ancestor's). */
  mask?: SvgMask;
};

/** One region of a clip: polygons under a fill rule, itself clipped by `within` when set. */
export type ClipPart = { polygons: number[][][]; evenOdd: boolean; within?: SvgClip };

/**
 * A clip: the union of its parts, cut by `within` (a clip path's own `clip-path`). No parts clips
 * everything away, as an empty `<clipPath>` does.
 */
export type SvgClip = { parts: ClipPart[]; within?: SvgClip };

/** A clip the PDF sets, as polygons on the page under its rule (`W` or `W*`). */
export type PdfClip = { polygons: number[][][]; evenOdd: boolean };

/** An SVG gradient, resolved (its `href` chain followed), as {@link gradientColour} reads it. */
export type Gradient = {
  kind: "linear" | "radial";
  /** `objectBoundingBox` (the default) or `userSpaceOnUse`. */
  units: string;
  transform: Matrix;
  /** linear: x1 y1 x2 y2; radial: cx cy r fx fy -- in `units`. */
  geometry: number[];
  spread: string;
  /** Offset 0-1, RGB 0-1; its `stop-opacity` (times its colour's own alpha), 1 when opaque. */
  stops: { offset: number; colour: number[]; opacity?: number }[];
};

/** An image's pixels, RGBA, row 0 at the top. */
export type RasterPixels = { width: number; height: number; data: Uint8Array };

/**
 * A soft mask as the PDF defines it (group 8h): its subtype, its transfer function (256 values,
 * as pdf.js gives it), and what its group paints, in order -- fills on the page, or images.
 */
export type PdfMask = {
  subtype: "Alpha" | "Luminosity";
  transfer?: number[];
  items: (
    | { kind: "fill"; polygons: number[][][]; evenOdd: boolean; colour: number[]; alpha: number }
    | { kind: "image"; m: Matrix; pixels: RasterPixels | null }
  )[];
};

/** A soft mask's value, 0 to 1, at a point of the page: its group composited, then its transfer. */
export function pdfMaskValue(mask: PdfMask, x: number, y: number): number {
  let rgba = [0, 0, 0, 0];
  for (const it of mask.items) {
    if (it.kind === "fill") {
      if (polygonsContain(it.polygons, it.evenOdd, x, y)) rgba = over(it.colour, it.alpha, rgba);
    } else if (it.pixels) {
      const [u, v] = apply(invert(it.m), x, y);
      if (u < 0 || u >= 1 || v <= 0 || v > 1) continue;
      const { width: w, height: h, data } = it.pixels;
      const k =
        4 * (Math.min(h - 1, Math.floor((1 - v) * h)) * w + Math.min(w - 1, Math.floor(u * w)));
      rgba = over([data[k] / 255, data[k + 1] / 255, data[k + 2] / 255], data[k + 3] / 255, rgba);
    }
  }
  // Luminosity: the group over a black backdrop, its luminance; Alpha: its alpha.
  const value =
    mask.subtype === "Luminosity"
      ? (0.2125 * rgba[0] + 0.7154 * rgba[1] + 0.0721 * rgba[2]) * rgba[3]
      : rgba[3];
  return mask.transfer ? mask.transfer[Math.round(value * 255)] / 255 : value;
}

/**
 * An SVG `<mask>` over a shape (group 8h): luminance or alpha, its region and the matrix from
 * its content to the drawing, its content read as the drawing's shapes are.
 */
export type SvgMask = {
  type: "luminance" | "alpha";
  region: number[][];
  toDrawing: Matrix;
  content: SvgShape[];
};

/**
 * A source mask's value at a point of the drawing: 0 outside its region; else its content there,
 * as luminance times alpha (measured: Chrome's #808080 is 128 -- sRGB luminance, not linear) or
 * alpha; `null` within `tol` of an edge.
 */
export function svgMaskValue(m: SvgMask, x: number, y: number, tol: number): number | null {
  if (edgeDistance([m.region], x, y) < tol) return null;
  if (!polygonsContain([m.region], false, x, y)) return 0;
  const back = invert(m.toDrawing);
  const [cx, cy] = apply(back, x, y);
  const c = contentColour(m.content, cx, cy, tol * scaleOf(back));
  if (c === null) return null;
  return m.type === "alpha" ? c[3] : (0.2125 * c[0] + 0.7154 * c[1] + 0.0721 * c[2]) * c[3];
}

/** A raster a PDF paints with: the unit square under `m` (row 0 at v = 1), its pixels. */
export type PdfRaster = { m: Matrix; pixels: RasterPixels | null };

/**
 * An SVG `<pattern>`, resolved (its `href` chain followed): the tile in `units`, the transform,
 * how its content is laid (a viewBox, or `contentUnits`), and its content as shapes in content
 * coordinates (group 8g).
 */
export type SvgPattern = {
  tile: number[];
  units: string;
  contentUnits: string;
  transform: Matrix;
  viewBox: number[] | null;
  par: string;
  content: SvgShape[];
};

/** A PDF shading as pdf.js gives it (`["RadialAxial", kind, bbox, stops, p0, p1, r0, r1]`), with its matrix. */
export type PdfShading = { ir: unknown[]; matrix: Matrix };

/**
 * One raster `<image>` of the source SVG (group 8f): its data URI, its viewport (x, y, width,
 * height) in its user space, `preserveAspectRatio`, its transform within the drawing, its alpha,
 * and the clips around it (with its own viewport's, for `slice`).
 */
export type SvgImage = {
  uri: string;
  box: number[];
  par: string;
  e: Matrix;
  alpha: number;
  clips: SvgClip[];
};

/** One image the PDF paints: the unit square under `m`, its pixel size, clips and alpha. */
export type PdfImagePaint = {
  page: number;
  order: number;
  m: Matrix;
  width: number;
  height: number;
  alpha: number;
  clips: PdfClip[];
  /** Its pixels (group 8i: a filter's output is compared with them). */
  pixels?: RasterPixels | null;
};

/**
 * An element drawn through a `filter` (group 8i): its content as shapes in the drawing's
 * coordinates, its user space to the drawing (`e`), its box and the filter region in that space
 * ([x0, y0, x1, y1]), the primitives ready to run (lengths in user units, subregions in user
 * units), whether they work in linearRGB, its opacity, and what it is named in a message.
 */
export type SvgFilterUse = {
  what: string;
  content: SvgShape[];
  e: Matrix;
  region: number[];
  primitives: Primitive[];
  linear: boolean;
  alpha: number;
};

/** One text label of the source SVG. */
export type SvgLabel = {
  text: string;
  x: number;
  y: number;
  anchor: string;
  size: number;
  e: Matrix;
};

/** One path the PDF paints, in its own coordinates, with the transform it is drawn under. */
export type PdfVector = {
  page: number;
  order: number;
  fill: number[] | null;
  stroke: number[] | null;
  /** Fill and stroke alpha, every enclosing group's multiplied in. */
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  lines: Polyline[];
  m: Matrix;
  /** The shading a fill or stroke paints with, in place of `fill` / `stroke` (then null). */
  fillShading?: PdfShading;
  strokeShading?: PdfShading;
  /** A paint this reader cannot evaluate (a tiling pattern), named. */
  fillOther?: string;
  strokeOther?: string;
  /** Group 8e: a gradient's alpha as its own (grey) shading, read from a luminosity soft mask. */
  fillAlphaShading?: PdfShading;
  strokeAlphaShading?: PdfShading;
  /** Group 8g: a pattern as Chrome writes it, one raster image under `m` (unit square to page). */
  fillRaster?: PdfRaster;
  strokeRaster?: PdfRaster;
  /** Group 8h: the soft mask it is painted under. */
  mask?: PdfMask;
  /** Group 8d: every clip in force (page space), the fill rule, line cap / join (PDF codes), miter limit. */
  clips?: PdfClip[];
  evenOdd?: boolean;
  cap?: number;
  join?: number;
  miter?: number;
};

/** One run of text the PDF draws on a page: its baseline origin, advance width and size. */
export type PdfRun = {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  /** The direction its text runs in, a unit vector (a label may be rotated). */
  dx: number;
  dy: number;
};

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a` then `b`. */
export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const [a, b, c, d] = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

function apply(m: Matrix, x: number, y: number): number[] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** How far a transform scales lengths (the square root of its determinant). */
function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/** Whether polygons hold a point, by a fill rule (crossings for even-odd, winding for non-zero). */
export function polygonsContain(polygons: number[][][], evenOdd: boolean, x: number, y: number) {
  let winding = 0;
  let crossings = 0;
  for (const p of polygons) {
    for (let k = 0; k < p.length; k++) {
      const [ax, ay] = p[k];
      const [bx, by] = p[(k + 1) % p.length];
      if (ay <= y !== by <= y && ax + ((y - ay) / (by - ay)) * (bx - ax) > x) {
        crossings++;
        winding += by > ay ? 1 : -1;
      }
    }
  }
  return evenOdd ? crossings % 2 === 1 : winding !== 0;
}

/** Whether a source clip holds a point of the drawing. */
export function clipContains(c: SvgClip, x: number, y: number): boolean {
  if (c.within && !clipContains(c.within, x, y)) return false;
  return c.parts.some(
    (p) =>
      polygonsContain(p.polygons, p.evenOdd, x, y) &&
      (p.within === undefined || clipContains(p.within, x, y)),
  );
}

/** Every polygon of a source clip, its parts' and their `within`s', for edges and bounds. */
function clipPolygons(c: SvgClip): number[][][] {
  return [
    ...c.parts.flatMap((p) => [...p.polygons, ...(p.within ? clipPolygons(p.within) : [])]),
    ...(c.within ? clipPolygons(c.within) : []),
  ];
}

/** The box of polygons, [x0, y0, x1, y1]; an empty box (x0 > x1) for none. */
function polygonBox(polygons: number[][][]): number[] {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polygons) {
    for (const [x, y] of p) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
  }
  return box;
}

/** How far a point stands from the nearest edge of polygons. */
function edgeDistance(polygons: number[][][], x: number, y: number): number {
  let best = Infinity;
  for (const p of polygons) {
    for (let k = 0; k < p.length; k++) {
      const [ax, ay] = p[k];
      const [bx, by] = p[(k + 1) % p.length];
      const [dx, dy] = [bx - ax, by - ay];
      const len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
  }
  return best;
}

/** Polylines as polygons under a transform (each closed for the fill). */
function polygonsOf(lines: Polyline[], m: Matrix): number[][][] {
  return lines.map((l) => l.points.map(([x, y]) => apply(m, x, y)));
}

/**
 * A viewBox fitted into a viewport `w` by `h` by `preserveAspectRatio` (SVG 1.1 7.8): `none`
 * stretches; otherwise one scale, the smaller (`meet`, the default) or the larger (`slice`), the
 * box aligned by its x and y keyword (`xMidYMid`, the default).
 */
function viewBoxMatrix(vb: number[], w: number, h: number, par: string | undefined): Matrix {
  const [align = "xMidYMid", fit = "meet"] = (par ?? "").trim().split(/\s+/).filter(Boolean);
  if (align === "none")
    return [w / vb[2], 0, 0, h / vb[3], -vb[0] * (w / vb[2]), -vb[1] * (h / vb[3])];
  const s = fit === "slice" ? Math.max(w / vb[2], h / vb[3]) : Math.min(w / vb[2], h / vb[3]);
  const at = (key: string, room: number) =>
    align.includes(`${key}Min`) ? 0 : align.includes(`${key}Max`) ? room : room / 2;
  return [s, 0, 0, s, -vb[0] * s + at("x", w - vb[2] * s), -vb[1] * s + at("Y", h - vb[3] * s)];
}

/** A rectangle as one polygon under a transform. */
function rectPolygon(x: number, y: number, w: number, h: number, m: Matrix): number[][] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ].map(([px, py]) => apply(m, px, py));
}

// ---------------------------------------------------------------------------
// Reading the SVG
// ---------------------------------------------------------------------------

type Node = { tag: string; attrs: Map<string, string>; children: Node[]; text: string };

/** The SVG as a tree of elements, text kept (entities decoded), comments and CDATA dropped. */
function parse(svg: string): Node {
  const root: Node = { tag: "#root", attrs: new Map(), children: [], text: "" };
  const stack = [root];
  const src = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const tag = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>|([^<]+)/g;
  for (const m of src.matchAll(tag)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined) {
      top.text += m[4];
      top.children.push({ tag: "#text", attrs: new Map(), children: [], text: m[4] });
      continue;
    }
    const name = m[2].toLowerCase();
    if (m[1]) {
      const at = stack.map((n) => n.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const attrs = new Map<string, string>();
    for (const a of m[3].matchAll(/([^\s=/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs.set(a[1].toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? ""));
    }
    const node: Node = { tag: name, attrs, children: [], text: "" };
    top.children.push(node);
    if (!m[3].trimEnd().endsWith("/")) stack.push(node);
  }
  return root;
}

/** An SVG `transform` list as one matrix: the rightmost applies first. */
function transformOf(list: string | undefined): Matrix {
  if (!list) return IDENTITY;
  const parts = [...list.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi)];
  let out = IDENTITY;
  for (let k = parts.length - 1; k >= 0; k--) {
    const v = (parts[k][2].match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    const kind = parts[k][1].toLowerCase();
    let t = IDENTITY;
    if (kind === "matrix" && v.length === 6) t = v;
    else if (kind === "translate") t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (kind === "scale") t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (kind === "rotate") {
      const r = ((v[0] ?? 0) * Math.PI) / 180;
      const [c, s] = [Math.cos(r), Math.sin(r)];
      const rot = [c, s, -s, c, 0, 0];
      const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
      t = mul(mul([1, 0, 0, 1, -cx, -cy], rot), [1, 0, 0, 1, cx, cy]);
    } else if (kind === "skewx") t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (kind === "skewy") t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    out = mul(out, t);
  }
  return out;
}

/**
 * Every CSS named colour (CSS Color 4 § 6.1, all 148). Group 8d: the reader knew 47, so a drawing
 * in `darkslategray` failed as unreadable.
 */
const NAMED: Record<string, string> = Object.fromEntries(
  (
    "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc " +
    "bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a " +
    "burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 " +
    "cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b " +
    "darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 " +
    "darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc " +
    "darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b " +
    "darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 " +
    "deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff " +
    "firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc " +
    "ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f " +
    "grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 " +
    "khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd " +
    "lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 " +
    "lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a " +
    "lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 " +
    "lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 " +
    "magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 " +
    "mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a " +
    "mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa " +
    "mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 " +
    "olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa " +
    "palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 " +
    "peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 " +
    "rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 " +
    "salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d " +
    "silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa " +
    "springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 " +
    "turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 " +
    "yellowgreen 9acd32"
  )
    .split(" ")
    .flatMap((w, k, all) => (k % 2 === 0 ? [[w, `#${all[k + 1]}`]] : [])),
);

/**
 * A paint as RGB 0-1, with its alpha as a fourth value when below 1 (`rgba()`, `hsla()`,
 * `#rrggbbaa`: group 8d -- the alpha was dropped); `null` for none; `undefined` when it cannot be
 * read (a gradient, a pattern).
 */
function paintOf(value: string, current: number[]): number[] | null | undefined {
  const v = value.trim().toLowerCase();
  if (v === "none" || v === "transparent") return null;
  if (v === "currentcolor") return current;
  if (/^url\(/.test(v)) return undefined;
  const withAlpha = (rgb: number[], a: number) =>
    a >= 1 ? rgb : [...rgb, Math.max(0, Math.min(1, a))];
  const hex = NAMED[v] ?? v;
  const short = /^#([0-9a-f]{3,4})$/.exec(hex)?.[1];
  if (short) {
    const c = [...short].map((d) => parseInt(d + d, 16) / 255);
    return withAlpha(c.slice(0, 3), c[3] ?? 1);
  }
  const long = /^#([0-9a-f]{6}(?:[0-9a-f]{2})?)$/.exec(hex)?.[1];
  if (long) {
    const c = [0, 2, 4, 6].flatMap((k) =>
      k < long.length ? [parseInt(long.slice(k, k + 2), 16) / 255] : [],
    );
    return withAlpha(c.slice(0, 3), c[3] ?? 1);
  }
  // rgb() / hsl(), comma or space separated, an alpha after a comma or a slash
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(v);
  if (!fn) return undefined;
  const parts = fn[2].split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const number = (s: string, whole: number) =>
    s.endsWith("%") ? (Number.parseFloat(s) / 100) * whole : Number.parseFloat(s);
  const alpha = parts[3] === undefined ? 1 : number(parts[3], 1);
  if (fn[1].startsWith("rgb")) {
    const c = parts.slice(0, 3).map((s) => number(s, 255) / 255);
    if (c.some((x) => !Number.isFinite(x)) || !Number.isFinite(alpha)) return undefined;
    return withAlpha(
      c.map((x) => Math.max(0, Math.min(1, x))),
      alpha,
    );
  }
  // hsl: hue in degrees (a bare number, or deg), saturation and lightness in percent
  const h = (((Number.parseFloat(parts[0]) % 360) + 360) % 360) / 360;
  const [s, l] = [number(parts[1], 1), number(parts[2], 1)].map((x) => Math.max(0, Math.min(1, x)));
  if (![h, s, l, alpha].every(Number.isFinite) || !/^-?[\d.]+(deg)?$/.test(parts[0]))
    return undefined;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return withAlpha([channel(h + 1 / 3), channel(h), channel(h - 1 / 3)], alpha);
}

// ---------------------------------------------------------------------------
// Gradients, both sides: each evaluated at a point, so a gradient is compared by its colours
// where the shape is, whatever stops either side writes (Chrome writes a one-stop gradient as two
// stops of one colour, measured).
// ---------------------------------------------------------------------------

/** Where `t` falls under a spread method: pad, repeat, reflect. */
function spreadOf(t: number, spread: string): number {
  if (spread === "repeat") return t - Math.floor(t);
  if (spread === "reflect") {
    const r = t - 2 * Math.floor(t / 2);
    return r > 1 ? 2 - r : r;
  }
  return Math.max(0, Math.min(1, t));
}

/** The colour of stops at `t`, linearly between them. */
function stopColour(stops: { offset: number; colour: number[] }[], t: number): number[] {
  if (stops.length === 0) return [0, 0, 0];
  if (t <= stops[0].offset) return stops[0].colour;
  for (let k = 1; k < stops.length; k++) {
    const [a, b] = [stops[k - 1], stops[k]];
    if (t <= b.offset) {
      const u = b.offset === a.offset ? 1 : (t - a.offset) / (b.offset - a.offset);
      return a.colour.map((c, i) => c + (b.colour[i] - c) * u);
    }
  }
  return stops[stops.length - 1].colour;
}

/**
 * The radial `t` of a point between two circles (centre p0 radius r0, centre p1 radius r1): the
 * largest t with |point - c(t)| = r(t), r(t) >= 0 -- the two-circle gradient both SVG and PDF use.
 */
function radialT(x: number, y: number, p0: number[], r0: number, p1: number[], r1: number): number {
  const [cdx, cdy, dr] = [p1[0] - p0[0], p1[1] - p0[1], r1 - r0];
  const [px, py] = [x - p0[0], y - p0[1]];
  const a = cdx * cdx + cdy * cdy - dr * dr;
  const b = px * cdx + py * cdy + r0 * dr;
  const c = px * px + py * py - r0 * r0;
  if (Math.abs(a) < 1e-12) return b === 0 ? 0 : c / (2 * b);
  const disc = b * b - a * c;
  if (disc < 0) return 0;
  const roots = [(b + Math.sqrt(disc)) / a, (b - Math.sqrt(disc)) / a];
  return Math.max(...roots.filter((t) => r0 + t * dr >= 0), 0);
}

/** A source gradient's colour at a point of the shape, in the shape's own coordinates. */
export function gradientColour(g: Gradient, x: number, y: number, box: number[]): number[] {
  return stopColour(g.stops, gradientT(g, x, y, box));
}

/** A source gradient's alpha at a point of the shape: its stops' opacities, as its colours run. */
export function gradientAlpha(g: Gradient, x: number, y: number, box: number[]): number {
  const t = gradientT(g, x, y, box);
  return stopColour(
    g.stops.map((s) => ({ offset: s.offset, colour: [s.opacity ?? 1] })),
    t,
  )[0];
}

/** Where a point of the shape falls along a gradient, 0 to 1, its spread applied. */
function gradientT(g: Gradient, x: number, y: number, box: number[]): number {
  // To the gradient's space: the shape's bounding box as the unit square, then its transform.
  let to: Matrix = IDENTITY;
  if (g.units !== "userSpaceOnUse") {
    const [w, h] = [box[2] - box[0], box[3] - box[1]];
    to = [w || 1, 0, 0, h || 1, box[0], box[1]];
  }
  const back = invert(mul(g.transform, to));
  const [u, v] = apply(back, x, y);
  let t: number;
  if (g.kind === "linear") {
    const [x1, y1, x2, y2] = g.geometry;
    const [dx, dy] = [x2 - x1, y2 - y1];
    const len = dx * dx + dy * dy;
    t = len === 0 ? 1 : ((u - x1) * dx + (v - y1) * dy) / len;
  } else {
    const [cx, cy, r, fx, fy] = g.geometry;
    t = radialT(u, v, [fx, fy], 0, [cx, cy], r);
  }
  return spreadOf(t, g.spread);
}

/** A PDF shading's colour at a point on the page (default user space), as pdf.js describes it. */
export function shadingColour(s: PdfShading, x: number, y: number): number[] | null {
  const [kind, type, , stops, p0, p1, r0, r1] = s.ir as [
    string,
    string,
    unknown,
    [number, string][],
    number[],
    number[],
    number,
    number,
  ];
  if (kind !== "RadialAxial" || !Array.isArray(stops)) return null;
  const parsed = stops.map(([offset, hex]) => ({
    offset,
    colour: [1, 3, 5].map((k) => parseInt(String(hex).slice(k, k + 2), 16) / 255),
  }));
  const [u, v] = apply(invert(s.matrix), x, y);
  let t: number;
  if (type === "axial") {
    const [dx, dy] = [p1[0] - p0[0], p1[1] - p0[1]];
    const len = dx * dx + dy * dy;
    t = len === 0 ? 1 : ((u - p0[0]) * dx + (v - p0[1]) * dy) / len;
  } else t = radialT(u, v, p0, r0 ?? 0, p1, r1 ?? 0);
  // Chrome extends both ends (pad), as SVG's default does.
  return stopColour(parsed, Math.max(0, Math.min(1, t)));
}

/** `src` at alpha `a` over `dst` (straight RGBA, 0-1). */
function over(c: number[], a: number, dst: number[]): number[] {
  const out = a + dst[3] * (1 - a);
  if (out <= 0) return [0, 0, 0, 0];
  return [0, 1, 2].map((k) => (c[k] * a + dst[k] * dst[3] * (1 - a)) / out).concat(out);
}

/**
 * A source pattern's colour (straight RGBA, 0-1) at a point of the shape it paints, in the
 * shape's own coordinates (`box`: the shape's bounding box, for objectBoundingBox units); `null`
 * where the point stands within `tol` of an edge -- a tile's seam, a content shape's outline, a
 * stroke's side, end or corner -- where a raster's antialiasing mixes the two (group 8g).
 */
export function patternColour(
  p: SvgPattern,
  x: number,
  y: number,
  box: number[],
  tol: number,
): number[] | null {
  const [bw, bh] = [box[2] - box[0] || 1, box[3] - box[1] || 1];
  let [tx, ty, tw, th] = p.tile;
  if (p.units !== "userSpaceOnUse")
    [tx, ty, tw, th] = [box[0] + tx * bw, box[1] + ty * bh, tw * bw, th * bh];
  const back = invert(p.transform);
  const [qx, qy] = apply(back, x, y);
  const tq = tol * scaleOf(back);
  const lx = qx - tx - Math.floor((qx - tx) / tw) * tw;
  const ly = qy - ty - Math.floor((qy - ty) / th) * th;
  if (lx < tq || lx > tw - tq || ly < tq || ly > th - tq) return null;
  const toContent: Matrix = p.viewBox
    ? invert(viewBoxMatrix(p.viewBox, tw, th, p.par))
    : p.contentUnits === "objectBoundingBox"
      ? [1 / bw, 0, 0, 1 / bh, 0, 0]
      : IDENTITY;
  const [cx, cy] = apply(toContent, lx, ly);
  return contentColour(p.content, cx, cy, tq * scaleOf(toContent));
}

/**
 * What content shapes paint at a point of their coordinates, composited in order (straight RGBA,
 * 0-1); `null` within `tc` of an edge -- an outline, a stroke's side, end or corner (group 8g, 8h).
 */
function contentColour(content: SvgShape[], cx: number, cy: number, tc: number): number[] | null {
  let rgba = [0, 0, 0, 0];
  for (const s of content) {
    const toOwn = invert(s.e);
    const [ox, oy] = apply(toOwn, cx, cy);
    const t = tc * scaleOf(toOwn);
    const sbox = bounds(s.lines);
    if (s.fill || s.fillGradient) {
      const polys = s.lines.map((l) => l.points);
      if (edgeDistance(polys, ox, oy) < t) return null;
      if (polygonsContain(polys, s.evenOdd ?? false, ox, oy)) {
        const g = s.fillGradient;
        const colour = g ? gradientColour(g, ox, oy, sbox) : (s.fill as number[]);
        rgba = over(colour, s.fillAlpha * (g ? gradientAlpha(g, ox, oy, sbox) : 1), rgba);
      }
    }
    if ((s.stroke || s.strokeGradient) && s.strokeWidth > 0) {
      const half = s.strokeWidth / 2;
      const d = reach([[ox, oy]], s.dashed);
      if (Math.abs(d - half) < t) return null;
      // A dash's end (its cap) and a corner (its join, a miter reaching out) are edges too.
      for (const l of s.dashed) {
        const pts = l.points;
        if (!l.closed) {
          for (const e of [pts[0], pts[pts.length - 1]])
            if (Math.hypot(ox - e[0], oy - e[1]) < half * Math.SQRT2 + t) return null;
        }
        for (let k = 1; k < pts.length - 1; k++) {
          const [a, b, c] = [pts[k - 1], pts[k], pts[k + 1]];
          const turn = Math.abs(
            Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]),
          );
          if (
            Math.min(turn, 2 * Math.PI - turn) > 0.15 &&
            Math.hypot(ox - b[0], oy - b[1]) < half * (s.miter ?? 4) + t
          )
            return null;
        }
      }
      if (d < half) {
        const g = s.strokeGradient;
        const colour = g ? gradientColour(g, ox, oy, sbox) : (s.stroke as number[]);
        rgba = over(colour, s.strokeAlpha * (g ? gradientAlpha(g, ox, oy, sbox) : 1), rgba);
      }
    }
  }
  return rgba;
}

/**
 * How a pattern raster differs from the source pattern (group 8g): every pixel whose centre lies
 * on the painted area -- inside the fill, or within the stroke -- its colour over the white page
 * against the pattern's own: BETWEEN the least and the most of each channel the source paints
 * within a pixel of it (9 by 9 points over the pixel widened by a pixel all round), within
 * 16/255 -- 8/255 where the source is one colour all that way. Chrome rasterises a pattern at a
 * pixel a point over the whole viewport and blurs an edge by resampling its tile (measured
 * 2026-11-09: an edge pixel 80% red where its exact coverage is 56%; faintly up to a pixel away,
 * 18 and 25 levels at 0.8 and 0.9 of a pixel), and any such blur mixes only colours within that
 * reach; a shape moved by more than a pixel flips whole pixels, far past that -- a pixel a point
 * is the raster's own precision. (Skipping edge pixels instead
 * hid any shift under 1.4 units, found by the test.) A stroke's caps and corners, whose shape
 * this does not model, are still skipped.
 */
export function rasterDifference(
  p: SvgPattern,
  r: PdfRaster,
  shape: SvgShape,
  kind: "fill" | "stroke",
  m: Matrix,
): string | null {
  if (!r.pixels) return "a pattern whose image does not decode";
  const { width: W, height: H, data } = r.pixels;
  const unitToShape = mul(r.m, invert(m));
  const box = bounds(shape.lines);
  const polys = shape.lines.map((l) => l.points);
  const half = kind === "stroke" ? shape.strokeWidth / 2 : 0;
  // Only the pixels over the shape's box (and its stroke), found through the inverse.
  const shapeToUnit = invert(unitToShape);
  const corners = [
    [box[0] - half, box[1] - half],
    [box[2] + half, box[1] - half],
    [box[2] + half, box[3] + half],
    [box[0] - half, box[3] + half],
  ].map(([cx, cy]) => apply(shapeToUnit, cx, cy));
  const us = corners.map((c) => c[0]);
  const vs = corners.map((c) => c[1]);
  const i0 = Math.max(0, Math.floor(Math.min(...us) * W));
  const i1 = Math.min(W - 1, Math.ceil(Math.max(...us) * W));
  const j0 = Math.max(0, Math.floor((1 - Math.max(...vs)) * H));
  const j1 = Math.min(H - 1, Math.ceil((1 - Math.min(...vs)) * H));
  let compared = 0;
  let differ = 0;
  let first = "";
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const [x, y] = apply(unitToShape, (i + 0.5) / W, 1 - (j + 0.5) / H);
      // The raster is the pattern over the whole viewport, uncut: a pixel on the shape is judged
      // whole (the path's own fill cuts it on the page).
      if (
        kind === "fill"
          ? !polygonsContain(polys, shape.evenOdd ?? false, x, y)
          : reach([[x, y]], shape.dashed) > half
      )
        continue;
      // The range of each channel over the white page the source paints within half a pixel.
      const lo = [1, 1, 1];
      const hi = [0, 0, 0];
      let skip = false;
      for (let a = 0; a < 9 && !skip; a++) {
        for (let b = 0; b < 9 && !skip; b++) {
          const [sx, sy] = apply(
            unitToShape,
            (i - 1 + (3 * (a + 0.5)) / 9) / W,
            1 - (j - 1 + (3 * (b + 0.5)) / 9) / H,
          );
          const c = patternColour(p, sx, sy, box, 0);
          if (c === null) skip = true;
          else
            for (let k = 0; k < 3; k++) {
              const v = c[3] * c[k] + (1 - c[3]);
              lo[k] = Math.min(lo[k], v);
              hi[k] = Math.max(hi[k], v);
            }
        }
      }
      if (skip) continue;
      const k = 4 * (j * W + i);
      const a = data[k + 3] / 255;
      const got = [0, 1, 2].map((c) => (a * data[k + c] + (1 - a) * 255) / 255);
      compared++;
      // Where the source is one colour all that way, the pixel is that colour (8 levels); beside
      // an edge, anything the blur can mix (16 levels outside its range).
      const uniform = [0, 1, 2].every((c) => hi[c] - lo[c] < 1 / 255);
      const slack = (uniform ? 8 : 16) / 255;
      if (got.some((g, c) => g < lo[c] - slack || g > hi[c] + slack)) {
        // the nearest the source allows there
        const wanted = [0, 1, 2].map((c) => (got[c] < lo[c] ? lo[c] : hi[c]));
        differ++;
        if (!first)
          first = ` (first at (${x.toFixed(1)}, ${y.toFixed(1)}): ${hex(got)}, ${hex(wanted)} at most in its source)`;
      }
    }
  }
  if (compared === 0) return "a pattern with no pixel clear of an edge to compare";
  return differ === 0 ? null : `pattern: ${differ} of ${compared} pixels differ${first}`;
}

/**
 * How a filter's image differs from the source run through the filter (group 8i), or null. The
 * expected raster is laid on the image's own pixel lattice, widened to the whole filter region;
 * the content is painted there (3 by 3 points a pixel) and run through the primitives; each image
 * pixel inside its clips is held, over the white page, to the range of the expected pixels within
 * one of it, 12 levels outside (Chrome's blur and edges are its own; measured within that); and
 * the expected result beyond the image must be clear. Where the content's edges are uncertain (a
 * stroke's caps and corners), the pixels the filter spreads them to are skipped.
 */
export function filterDifference(
  use: SvgFilterUse,
  p: PdfImagePaint,
  toPage: Matrix,
): string | null {
  if (!p.pixels) return "an image that does not decode";
  if (Math.abs(p.alpha - use.alpha) > 0.02)
    return `at opacity ${p.alpha.toFixed(2)}, ${use.alpha.toFixed(2)} in its source`;
  const { width: W, height: H, data } = p.pixels;
  const run = filterExpected(use, p.m, W, H, toPage);
  if (typeof run === "string") return run;
  const { expected, gi0, gj0, GW, GH, doubtful, ox, oy, ux, uy } = run;
  const overWhite = (r: typeof expected, k: number) =>
    [0, 1, 2].map((c) => r.data[4 * k + c] + (1 - r.data[4 * k + 3]));
  let compared = 0;
  let differ = 0;
  let first = "";
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const [px, py] = apply(p.m, (i + 0.5) / W, 1 - (j + 0.5) / H);
      if (!p.clips.every((c) => polygonsContain(c.polygons, c.evenOdd, px, py))) continue;
      const [gi, gj] = [i - gi0, j - gj0];
      if (doubtful[gj * GW + gi]) continue;
      const lo = [1, 1, 1];
      const hi = [0, 0, 0];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const [a, b] = [gi + di, gj + dj];
          if (a < 0 || b < 0 || a >= GW || b >= GH) continue;
          const v = overWhite(expected, b * GW + a);
          for (let c = 0; c < 3; c++) {
            lo[c] = Math.min(lo[c], v[c]);
            hi[c] = Math.max(hi[c], v[c]);
          }
        }
      const k = 4 * (j * W + i);
      const al = data[k + 3] / 255;
      const got = [0, 1, 2].map((c) => (al * data[k + c] + (1 - al) * 255) / 255);
      compared++;
      if (got.some((g, c) => g < lo[c] - 12 / 255 || g > hi[c] + 12 / 255)) {
        differ++;
        if (!first) {
          const want = [0, 1, 2].map((c) => (got[c] < lo[c] ? lo[c] : hi[c]));
          const [ex, ey] = [ox + (i + 0.5) * ux, oy + (j + 0.5) * uy];
          first = ` (first at (${ex.toFixed(1)}, ${ey.toFixed(1)}): ${hex(got)}, ${hex(want)} at most in its source)`;
        }
      }
    }
  }
  // Nothing the filter paints may lie beyond the image (two pixels clear of its edge).
  let beyond = 0;
  for (let gj = 0; gj < GH; gj++) {
    for (let gi = 0; gi < GW; gi++) {
      const [i, j] = [gi + gi0, gj + gj0];
      if (i >= -2 && j >= -2 && i < W + 2 && j < H + 2) continue;
      if (doubtful[gj * GW + gi]) continue;
      if (expected.data[4 * (gj * GW + gi) + 3] > 0.06) beyond++;
    }
  }
  if (beyond > 0) return `paints ${beyond} pixel(s) beyond the image Chrome drew of it`;
  if (compared === 0) return "an image with no pixel to compare";
  return differ === 0 ? null : `: ${differ} of ${compared} pixels differ${first}`;
}

/**
 * A filter's expected output on the lattice of an image of `W` by `H` pixels painted under `m`
 * (its unit square on the page), widened to the filter region: the raster (premultiplied sRGB),
 * where it sits against the image's pixels (`gi0`, `gj0`), and the pixels whose value the content's
 * uncertain edges reach (`doubtful`); or why it cannot be laid out or run.
 */
export function filterExpected(use: SvgFilterUse, m: Matrix, W: number, H: number, toPage: Matrix) {
  const U = mul(m, invert(toPage)); // the image's unit square in the element's user space
  if (Math.abs(U[1]) > 1e-6 * Math.abs(U[0]) || Math.abs(U[2]) > 1e-6 * Math.abs(U[3]))
    return "drawn turned, which this check does not run";
  const [ux, uy] = [U[0] / W, -U[3] / H];
  if (!(ux > 0 && uy > 0)) return "drawn flipped, which this check does not run";
  const [ox, oy] = apply(U, 0, 1); // the top left of pixel (0, 0)
  const [rx0, ry0, rx1, ry1] = use.region;
  const gi0 = Math.floor((rx0 - ox) / ux) - 2;
  const gj0 = Math.floor((ry0 - oy) / uy) - 2;
  const GW = Math.ceil((rx1 - ox) / ux) + 2 - gi0;
  const GH = Math.ceil((ry1 - oy) / uy) + 2 - gj0;
  if (GW <= 0 || GH <= 0 || GW * GH > 4e6) return "a filter region this check cannot lay out";
  const toGrid = (x: number, y: number) => [(x - ox) / ux - gi0, (y - oy) / uy - gj0];
  // The source graphic, premultiplied sRGB, and where it is uncertain.
  const source = blank(GW, GH);
  const unsure = new Uint8Array(GW * GH);
  for (let gj = 0; gj < GH; gj++) {
    for (let gi = 0; gi < GW; gi++) {
      const acc = [0, 0, 0, 0];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          const ux2 = ox + (gi0 + gi + (a + 0.5) / 3) * ux;
          const uy2 = oy + (gj0 + gj + (b + 0.5) / 3) * uy;
          const [dx, dy] = apply(use.e, ux2, uy2);
          const c = contentColour(use.content, dx, dy, 0);
          if (c === null) {
            unsure[gj * GW + gi] = 1;
            continue;
          }
          for (let k = 0; k < 3; k++) acc[k] += (c[k] * c[3]) / 9;
          acc[3] += c[3] / 9;
        }
      }
      source.data.set(acc, 4 * (gj * GW + gi));
    }
  }
  const region = [...toGrid(rx0, ry0), ...toGrid(rx1, ry1)];
  let expected: ReturnType<typeof runFilter>;
  try {
    expected = runFilter(
      {
        primitives: use.primitives.map((q) =>
          q.region
            ? {
                ...q,
                region: [...toGrid(q.region[0], q.region[1]), ...toGrid(q.region[2], q.region[3])],
              }
            : q,
        ),
        linear: use.linear,
        unit: [ux, uy],
        region,
      },
      source,
    );
  } catch (e) {
    return `${(e as Error).message} is not verified`;
  }
  // How far the chain carries an uncertain pixel: blurs (3 sigma), offsets, morphology.
  let reachPx = 1;
  for (const q of use.primitives) {
    const v = (s: string | undefined) =>
      (s ?? "0")
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
    if (q.tag === "fegaussianblur" || q.tag === "fedropshadow")
      reachPx += (3 * Math.max(0, ...v(q.attrs.stddeviation))) / Math.min(ux, uy);
    if (q.tag === "feoffset" || q.tag === "fedropshadow")
      reachPx +=
        Math.max(Math.abs(Number(q.attrs.dx ?? 0)) / ux, Math.abs(Number(q.attrs.dy ?? 0)) / uy) ||
        0;
    if (q.tag === "femorphology") reachPx += Math.max(0, ...v(q.attrs.radius)) / Math.min(ux, uy);
  }
  const reachI = Math.ceil(reachPx);
  const doubtful = new Uint8Array(GW * GH);
  for (let gj = 0; gj < GH; gj++)
    for (let gi = 0; gi < GW; gi++)
      if (unsure[gj * GW + gi])
        for (let dj = -reachI; dj <= reachI; dj++)
          for (let di = -reachI; di <= reachI; di++) {
            const [a, b] = [gi + di, gj + dj];
            if (a >= 0 && b >= 0 && a < GW && b < GH) doubtful[b * GW + a] = 1;
          }
  return { expected, gi0, gj0, GW, GH, doubtful, ox, oy, ux, uy };
}

/** A path's `d` as polylines, every command (arcs as their curve), curves in 16 segments. */
export function pathLines(d: string): Polyline[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Polyline[] = [];
  let line: number[][] = [];
  let [x, y, sx, sy] = [0, 0, 0, 0];
  let [lcx, lcy] = [0, 0]; // the last control point, for S and T
  let cmd = "";
  let prevCmd = "";
  let k = 0;
  const num = () => Number(tokens[k++]);
  const flag = () => {
    // A flag may be packed with what follows ("01" is two flags): read one digit.
    const t = tokens[k];
    if (t === undefined) return 0;
    if (t.length > 1 && /^[01]/.test(t)) {
      tokens[k] = t.slice(1);
      return Number(t[0]);
    }
    k++;
    return Number(t);
  };
  // The current subpath's vertices: each command's end point (a move's start), for markers.
  let verts: number[][] = [];
  const flush = (closed: boolean) => {
    if (line.length > 0) out.push({ points: line, closed, vertices: verts });
    line = [];
    verts = [];
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    for (let s = 1; s <= 16; s++) {
      const t = s / 16;
      const u = 1 - t;
      line.push([
        u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey,
      ]);
    }
    [lcx, lcy, x, y] = [x2, y2, ex, ey];
  };
  const quad = (x1: number, y1: number, ex: number, ey: number) => {
    for (let s = 1; s <= 16; s++) {
      const t = s / 16;
      const u = 1 - t;
      line.push([u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey]);
    }
    [lcx, lcy, x, y] = [x1, y1, ex, ey];
  };
  const arc = (
    rx: number,
    ry: number,
    rot: number,
    large: number,
    sweep: number,
    ex: number,
    ey: number,
  ) => {
    // SVG 1.1 F.6.5: endpoint to centre parameterisation.
    if (rx === 0 || ry === 0) {
      line.push([ex, ey]);
      [x, y] = [ex, ey];
      return;
    }
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (rot * Math.PI) / 180;
    const [cp, sp] = [Math.cos(phi), Math.sin(phi)];
    const dx = (x - ex) / 2;
    const dy = (y - ey) / 2;
    const x1 = cp * dx + sp * dy;
    const y1 = -sp * dx + cp * dy;
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
    const cx1 = (co * rx * y1) / ry;
    const cy1 = (-co * ry * x1) / rx;
    const cx = cp * cx1 - sp * cy1 + (x + ex) / 2;
    const cy = sp * cx1 + cp * cy1 + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    else if (sweep && dt < 0) dt += 2 * Math.PI;
    const steps = Math.max(16, Math.ceil((Math.abs(dt) / Math.PI) * 32));
    for (let s = 1; s <= steps; s++) {
      const t = t1 + (dt * s) / steps;
      line.push([
        cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp,
        cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp,
      ]);
    }
    [x, y] = [ex, ey];
  };
  while (k < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[k])) cmd = tokens[k++];
    else if (cmd === "") break;
    const rel = cmd === cmd.toLowerCase();
    const [ox, oy] = rel ? [x, y] : [0, 0];
    switch (cmd.toUpperCase()) {
      case "M": {
        flush(false);
        [x, y] = [ox + num(), oy + num()];
        [sx, sy] = [x, y];
        line = [[x, y]];
        cmd = rel ? "l" : "L"; // further pairs are line-tos
        break;
      }
      case "L":
        [x, y] = [ox + num(), oy + num()];
        line.push([x, y]);
        break;
      case "H":
        x = ox + num();
        line.push([x, y]);
        break;
      case "V":
        y = oy + num();
        line.push([x, y]);
        break;
      case "C": {
        const v = [num(), num(), num(), num(), num(), num()];
        cubic(ox + v[0], oy + v[1], ox + v[2], oy + v[3], ox + v[4], oy + v[5]);
        break;
      }
      case "S": {
        const smooth = /[CcSs]/.test(prevCmd);
        const [x1, y1] = smooth ? [2 * x - lcx, 2 * y - lcy] : [x, y];
        const v = [num(), num(), num(), num()];
        cubic(x1, y1, ox + v[0], oy + v[1], ox + v[2], oy + v[3]);
        break;
      }
      case "Q": {
        const v = [num(), num(), num(), num()];
        quad(ox + v[0], oy + v[1], ox + v[2], oy + v[3]);
        break;
      }
      case "T": {
        const smooth = /[QqTt]/.test(prevCmd);
        const [x1, y1] = smooth ? [2 * x - lcx, 2 * y - lcy] : [x, y];
        const v = [num(), num()];
        quad(x1, y1, ox + v[0], oy + v[1]);
        break;
      }
      case "A": {
        const [rx, ry, rot] = [num(), num(), num()];
        const [large, sweep] = [flag(), flag()];
        const [ex, ey] = [ox + num(), oy + num()];
        arc(rx, ry, rot, large, sweep, ex, ey);
        break;
      }
      case "Z":
        [x, y] = [sx, sy];
        flush(true);
        line = [[x, y]];
        verts = [[x, y]];
        break;
      default:
        k = tokens.length;
    }
    if (!line.length) line = [[x, y]];
    if (cmd.toUpperCase() !== "Z") verts.push([x, y]);
    prevCmd = cmd;
    if (Number.isNaN(x) || Number.isNaN(y)) break;
  }
  if (line.length > 1) out.push({ points: line, closed: false, vertices: verts });
  return out.filter((l) => l.points.length > 1 || l.closed);
}

/**
 * A stroke's dashes (SVG `stroke-dasharray`, `stroke-dashoffset`), each an open polyline, as
 * Chrome writes them (measured: a dashed line is one path of its dash segments).
 */
function dash(lines: Polyline[], pattern: number[], offset: number): Polyline[] {
  const pat = pattern.length % 2 ? [...pattern, ...pattern] : pattern;
  const total = pat.reduce((a, b) => a + b, 0);
  if (pat.length === 0 || total <= 0 || pat.some((v) => v < 0)) return lines;
  const out: Polyline[] = [];
  for (const l of lines) {
    const pts = l.closed ? [...l.points, l.points[0]] : l.points;
    // where in the pattern the line starts
    let at = ((offset % total) + total) % total;
    let k = 0;
    while (at >= pat[k]) {
      at -= pat[k];
      k = (k + 1) % pat.length;
    }
    let left = pat[k] - at;
    let on = k % 2 === 0;
    let cur: number[][] = on ? [pts[0]] : [];
    for (let s = 1; s < pts.length; s++) {
      let [ax, ay] = pts[s - 1];
      const [bx, by] = pts[s];
      let seg = Math.hypot(bx - ax, by - ay);
      while (seg > 1e-9) {
        const step = Math.min(seg, left);
        const t = step / seg;
        const [nx, ny] = [ax + (bx - ax) * t, ay + (by - ay) * t];
        if (on) cur.push([nx, ny]);
        [ax, ay] = [nx, ny];
        seg -= step;
        left -= step;
        if (left <= 1e-9) {
          if (on && cur.length > 1) out.push({ points: cur, closed: false });
          k = (k + 1) % pat.length;
          left = pat[k];
          on = !on;
          cur = on ? [[ax, ay]] : [];
        }
      }
    }
    if (on && cur.length > 1) out.push({ points: cur, closed: false });
  }
  return out;
}

/** The area polylines enclose (each closed for the sum), by the shoelace formula. */
function enclosed(lines: Polyline[]): number {
  let sum = 0;
  for (const { points: p } of lines) {
    for (let k = 0; k < p.length; k++) {
      const [ax, ay] = p[k];
      const [bx, by] = p[(k + 1) % p.length];
      sum += ax * by - bx * ay;
    }
  }
  return Math.abs(sum) / 2;
}

/**
 * A shape's vertices in order, across its subpaths, each with the direction a marker there turns
 * to (`orient="auto"`): the way out at the first, the way in at the last, between the two at the
 * others -- read from the flattened outline, so a curve's tangent, not its chord.
 */
function vertexSpots(lines: Polyline[]): { x: number; y: number; angle: number }[] {
  const out: { x: number; y: number; angle: number }[] = [];
  for (const l of lines) {
    const pts = l.points;
    const verts = l.vertices ?? pts;
    let from = 0;
    for (const v of verts) {
      // the vertex in the flattened points (they hold it exactly), searched forward
      let i = from;
      while (i < pts.length && Math.hypot(pts[i][0] - v[0], pts[i][1] - v[1]) > 1e-6) i++;
      if (i >= pts.length) i = from;
      from = i;
      const prev = i > 0 ? pts[i - 1] : l.closed ? pts[pts.length - 1] : null;
      const next = i < pts.length - 1 ? pts[i + 1] : l.closed ? pts[0] : null;
      const inA = prev ? Math.atan2(v[1] - prev[1], v[0] - prev[0]) : null;
      const outA = next ? Math.atan2(next[1] - v[1], next[0] - v[0]) : null;
      let angle = outA ?? inA ?? 0;
      if (inA !== null && outA !== null) {
        let d = outA - inA;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        angle = inA + d / 2;
      }
      out.push({ x: v[0], y: v[1], angle });
    }
  }
  // The first and last vertex of the whole path face along the path, not between subpaths.
  if (out.length > 0 && lines[0]) {
    const p = lines[0].points;
    if (p.length > 1) out[0].angle = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]);
    const q = lines[lines.length - 1].points;
    if (q.length > 1) {
      const [a, b] = [q[q.length - 2], q[q.length - 1]];
      out[out.length - 1].angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  return out;
}

/**
 * A marker at a vertex: the transform of its content (viewBox by `preserveAspectRatio`, ref
 * point, markerUnits, orient), and of its viewport, the box 0..width by 0..height it is clipped to.
 */
function markerMatrix(
  marker: Node,
  x: number,
  y: number,
  angle: number,
  slot: number,
  sw: number,
): { content: Matrix; viewport: Matrix; width: number; height: number } {
  const num = (a: string, d: number) => {
    const v = Number.parseFloat(marker.attrs.get(a) ?? "");
    return Number.isFinite(v) ? v : d;
  };
  const orient = (marker.attrs.get("orient") ?? "0").trim();
  let rad = 0;
  if (orient === "auto") rad = angle;
  else if (orient === "auto-start-reverse") rad = slot === 0 ? angle + Math.PI : angle;
  else rad = ((Number.parseFloat(orient) || 0) * Math.PI) / 180;
  const scale = (marker.attrs.get("markerunits") ?? "strokeWidth") === "userSpaceOnUse" ? 1 : sw;
  const [mw, mh] = [num("markerwidth", 3), num("markerheight", 3)];
  const vb = (marker.attrs.get("viewbox") ?? "").split(/[\s,]+/).map(Number);
  const view: Matrix =
    vb.length === 4 && vb[2] > 0 && vb[3] > 0
      ? viewBoxMatrix(vb, mw, mh, marker.attrs.get("preserveaspectratio"))
      : IDENTITY;
  const [rx, ry] = apply(view, num("refx", 0), num("refy", 0));
  const [c, s] = [Math.cos(rad), Math.sin(rad)];
  const viewport = mul(
    mul(mul([1, 0, 0, 1, -rx, -ry], [scale, 0, 0, scale, 0, 0]), [c, s, -s, c, 0, 0]),
    [1, 0, 0, 1, x, y],
  );
  return { content: mul(view, viewport), viewport, width: mw, height: mh };
}

/** An ellipse as a closed polyline of 64 points. */
function ellipse(cx: number, cy: number, rx: number, ry: number): Polyline {
  return {
    points: Array.from({ length: 64 }, (_, k) => [
      cx + rx * Math.cos((k / 64) * 2 * Math.PI),
      cy + ry * Math.sin((k / 64) * 2 * Math.PI),
    ]),
    closed: true,
  };
}

/**
 * A basic shape's outline in its own coordinates: path, line, polyline, polygon, rect (rounded
 * corners as arcs), circle, ellipse; `null` for any other element, an empty list for a shape with
 * nothing to draw (a rect with no width).
 */
function geometryOf(n: Node): Polyline[] | null {
  const num = (a: string, d = 0) => {
    const v = Number.parseFloat(n.attrs.get(a) ?? "");
    return Number.isFinite(v) ? v : d;
  };
  switch (n.tag) {
    case "path":
      return pathLines(n.attrs.get("d") ?? "");
    case "line":
      return [
        {
          points: [
            [num("x1"), num("y1")],
            [num("x2"), num("y2")],
          ],
          closed: false,
        },
      ];
    case "polyline":
    case "polygon": {
      const v =
        (n.attrs.get("points") ?? "")
          .match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)
          ?.map(Number) ?? [];
      const points = Array.from({ length: Math.floor(v.length / 2) }, (_, k) => [
        v[2 * k],
        v[2 * k + 1],
      ]);
      return [{ points, closed: n.tag === "polygon" }];
    }
    case "rect": {
      const [x, y, w, h] = [num("x"), num("y"), num("width"), num("height")];
      if (w <= 0 || h <= 0) return [];
      let rx = num("rx", Number.NaN);
      let ry = num("ry", Number.NaN);
      if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
      if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx <= 0 || ry <= 0) {
        return [
          {
            points: [
              [x, y],
              [x + w, y],
              [x + w, y + h],
              [x, y + h],
            ],
            closed: true,
          },
        ];
      }
      return pathLines(
        `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} ` +
          `A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} ` +
          `V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`,
      );
    }
    case "circle":
      return num("r") > 0 ? [ellipse(num("cx"), num("cy"), num("r"), num("r"))] : [];
    case "ellipse":
      return num("rx") > 0 && num("ry") > 0
        ? [ellipse(num("cx"), num("cy"), num("rx"), num("ry"))]
        : [];
    default:
      return null;
  }
}

/**
 * A length in user units: a number (an SVG attribute's own), px, or a percentage of `whole`; NaN
 * for any other unit, which this reader does not convert.
 */
function cssLength(s: string, whole: number): number {
  const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|%)?$/i.exec(s.trim());
  if (!m) return Number.NaN;
  const v = Number(m[1]);
  return m[2] === "%" ? (v / 100) * whole : v;
}

/**
 * A CSS basic shape (`circle()`, `ellipse()`, `inset()`, `polygon()`, `path()`) as polygons in
 * the element's user space, laid on its reference box [x0, y0, x1, y1]; `null` for one this reader
 * cannot read. Chrome lays them on the STROKE box by default (measured 2026-11-09: `circle(15px at
 * 30px 20px)` on a rect at 10,10 with a 10 wide stroke centred at 35,25).
 */
function basicShape(fn: string, args: string, box: number[]): ClipPart | null {
  const [w, h] = [box[2] - box[0], box[3] - box[1]];
  const at = (x: number, y: number) => [box[0] + x, box[1] + y];
  const position = (words: string[]): number[] | null => {
    if (words.length === 0) return [w / 2, h / 2];
    if (words.length !== 2) return null;
    const key: Record<string, [string, number]> = {
      left: ["x", 0],
      right: ["x", 1],
      top: ["y", 0],
      bottom: ["y", 1],
    };
    let [a, b] = words;
    if (key[a]?.[0] === "y" || key[b]?.[0] === "x") [a, b] = [b, a];
    const one = (s: string, whole: number) =>
      s === "center" ? whole / 2 : key[s] ? key[s][1] * whole : cssLength(s, whole);
    const p = [one(a, w), one(b, h)];
    return p.every(Number.isFinite) ? p : null;
  };
  const radius = (s: string | undefined, c: number[], along: "x" | "y" | "both") => {
    const sides = {
      x: [c[0], w - c[0]],
      y: [c[1], h - c[1]],
      both: [c[0], w - c[0], c[1], h - c[1]],
    }[along];
    if (s === undefined || s === "closest-side") return Math.min(...sides.map(Math.abs));
    if (s === "farthest-side") return Math.max(...sides.map(Math.abs));
    const whole = along === "x" ? w : along === "y" ? h : Math.hypot(w, h) / Math.SQRT2;
    return cssLength(s, whole);
  };
  const ring = (cx: number, cy: number, rx: number, ry: number) =>
    ellipse(cx, cy, rx, ry).points.map(([x, y]) => at(x, y));
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (fn === "circle" || fn === "ellipse") {
    const k = words.indexOf("at");
    const radii = k < 0 ? words : words.slice(0, k);
    const c = position(k < 0 ? [] : words.slice(k + 1));
    if (!c) return null;
    const [rx, ry] =
      fn === "circle"
        ? [radius(radii[0], c, "both"), radius(radii[0], c, "both")]
        : [radius(radii[0], c, "x"), radius(radii[1], c, "y")];
    if (radii.length > (fn === "circle" ? 1 : 2) || !Number.isFinite(rx) || !Number.isFinite(ry))
      return null;
    return { polygons: [ring(c[0], c[1], rx, ry)], evenOdd: false };
  }
  if (fn === "inset") {
    const k = words.indexOf("round");
    const v = (k < 0 ? words : words.slice(0, k)).map((s, i) => cssLength(s, i % 2 ? w : h));
    const round = k < 0 ? [] : words.slice(k + 1).map((s) => cssLength(s, Math.min(w, h)));
    if (v.length < 1 || v.length > 4 || v.some((x) => !Number.isFinite(x))) return null;
    // top right bottom left, as margins are written
    const [t, r = t, b = t, l = r] = v;
    const [x0, y0, x1, y1] = [l, t, w - r, h - b];
    if (round.length > 1 || round.some((x) => !Number.isFinite(x))) return null;
    if (x1 <= x0 || y1 <= y0) return { polygons: [], evenOdd: false };
    const rr = Math.min(round[0] ?? 0, (x1 - x0) / 2, (y1 - y0) / 2);
    const lines =
      rr > 0
        ? pathLines(
            `M ${x0 + rr} ${y0} H ${x1 - rr} A ${rr} ${rr} 0 0 1 ${x1} ${y0 + rr} V ${y1 - rr} ` +
              `A ${rr} ${rr} 0 0 1 ${x1 - rr} ${y1} H ${x0 + rr} A ${rr} ${rr} 0 0 1 ${x0} ${y1 - rr} ` +
              `V ${y0 + rr} A ${rr} ${rr} 0 0 1 ${x0 + rr} ${y0} Z`,
          )
        : [
            {
              points: [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
              ],
              closed: true,
            },
          ];
    return { polygons: lines.map((l) => l.points.map(([x, y]) => at(x, y))), evenOdd: false };
  }
  if (fn === "polygon" || fn === "path") {
    const items = args.split(",").map((s) => s.trim());
    let evenOdd = false;
    if (/^(nonzero|evenodd)$/i.test(items[0] ?? "")) {
      evenOdd = items.shift()?.toLowerCase() === "evenodd";
    }
    if (fn === "path") {
      const d = /^(["'])([\s\S]*)\1$/.exec(items.join(",").trim())?.[2];
      if (d === undefined) return null;
      return {
        polygons: pathLines(d).map((l) => l.points.map(([x, y]) => at(x, y))),
        evenOdd,
      };
    }
    const points = items.map((s) => {
      const [a, b] = s.split(/\s+/);
      return [cssLength(a ?? "", w), cssLength(b ?? "", h)];
    });
    if (points.length < 3 || points.flat().some((x) => !Number.isFinite(x))) return null;
    return { polygons: [points.map(([x, y]) => at(x, y))], evenOdd };
  }
  return null;
}

/** What draws nothing itself: definitions, and what is drawn only where referenced. */
const NOT_DRAWN = new Set([
  "defs",
  "symbol",
  "clippath",
  "mask",
  "marker",
  "pattern",
  "lineargradient",
  "radialgradient",
  "filter",
  "title",
  "desc",
  "metadata",
  "style",
  "script",
]);

/** What this reader does not compare, named in a failure rather than passed. */
const UNREAD = new Set(["foreignobject", "switch"]);

/** The SVG elements a stylesheet rule could restyle here. */
const SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "line",
  "rect",
  "circle",
  "ellipse",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "use",
]);

/** The properties this reader takes from stylesheets. */
const SVG_PROPS = new Set([
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "fill-opacity",
  "opacity",
  "display",
  "visibility",
  "stroke-linecap",
  "font-size",
  "text-anchor",
  "color",
  "transform",
  "marker-start",
  "marker-mid",
  "marker-end",
  "marker",
  "filter",
  "mask",
  "stop-color",
  "stop-opacity",
  // group 8d
  "clip-path",
  "clip-rule",
  "fill-rule",
  "paint-order",
  "stroke-linejoin",
  "stroke-miterlimit",
  "overflow",
]);

/** One compound selector: a tag (or any), classes, an id, attribute tests. */
type Compound = {
  tag: string | null;
  classes: string[];
  id: string | null;
  attrs: [string, string | null][];
};
/** A selector: its compounds left to right, each with the combinator BEFORE it (null for the first). */
type Selector = { parts: { c: Compound; before: " " | ">" | null }[]; spec: number };
type Rule = {
  sel: Selector;
  decls: Map<string, { value: string; important: boolean }>;
  order: number;
};

/**
 * A stylesheet's rules a print applies: top level and `@media` print or all (not screen); other
 * at-rules skipped. A selector this reader cannot match that could restyle an SVG element is named
 * in `unread`; an HTML rule it cannot match is passed over (it cannot restyle a drawing).
 */
function cssRules(css: string, unread: Set<string>, startOrder: number): Rule[] {
  const rules: Rule[] = [];
  let order = startOrder;
  const body = (text: string) => {
    let k = 0;
    while (k < text.length) {
      const open = text.indexOf("{", k);
      if (open < 0) break;
      const prelude = text.slice(k, open).trim();
      // the block's end, braces balanced
      let depth = 1;
      let end = open + 1;
      for (; end < text.length && depth > 0; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}") depth--;
      }
      const inner = text.slice(open + 1, end - 1);
      k = end;
      if (prelude.startsWith("@")) {
        const m = /^@media\s+([^{]*)$/i.exec(prelude);
        if (m && (/\b(print|all)\b/i.test(m[1]) || !/\bscreen\b/i.test(m[1]))) body(inner);
        continue;
      }
      const decls = new Map<string, { value: string; important: boolean }>();
      for (const d of inner.split(";")) {
        const at = d.indexOf(":");
        if (at < 0) continue;
        const prop = d.slice(0, at).trim().toLowerCase();
        if (!SVG_PROPS.has(prop)) continue;
        const raw = d.slice(at + 1).trim();
        decls.set(prop, {
          value: raw.replace(/!\s*important\s*$/i, "").trim(),
          important: /!\s*important\s*$/i.test(raw),
        });
      }
      if (decls.size === 0) continue;
      for (const s of prelude.split(",")) {
        const sel = parseSelector(s.trim());
        if (sel) rules.push({ sel, decls, order: order++ });
        else {
          // Only a selector that could reach an SVG element matters.
          const last =
            s
              .trim()
              .split(/[\s>+~]+/)
              .pop() ?? "";
          const tag = /^[a-zA-Z][\w-]*/.exec(last)?.[0]?.toLowerCase();
          if ((tag && SVG_TAGS.has(tag)) || /\bsvg\b/i.test(s))
            unread.add(`the style rule "${s.trim()}"`);
        }
      }
    }
  };
  body(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  return rules;
}

/** A selector of compounds with descendant and child combinators; `null` for anything else. */
function parseSelector(s: string): Selector | null {
  if (!s || /[+~:]|::/.test(s)) return null;
  const tokens = s
    .replace(/\s*>\s*/g, " > ")
    .split(/\s+/)
    .filter(Boolean);
  const parts: { c: Compound; before: " " | ">" | null }[] = [];
  let pending: " " | ">" | null = null;
  let spec = 0;
  for (const t of tokens) {
    if (t === ">") {
      if (parts.length === 0) return null;
      pending = ">";
      continue;
    }
    const m = /^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(t);
    if (!m || (!m[1] && !m[2])) return null;
    const c: Compound = {
      tag: m[1] && m[1] !== "*" ? m[1].toLowerCase() : null,
      classes: [],
      id: null,
      attrs: [],
    };
    for (const p of m[2].matchAll(
      /([.#])([\w-]+)|\[\s*([\w:-]+)\s*(?:=\s*["']?([^"'\]]*)["']?)?\s*\]/g,
    )) {
      if (p[1] === ".") c.classes.push(p[2]);
      else if (p[1] === "#") c.id = p[2];
      else c.attrs.push([p[3].toLowerCase(), p[4] ?? null]);
    }
    spec += (c.id ? 10000 : 0) + (c.classes.length + c.attrs.length) * 100 + (c.tag ? 1 : 0);
    parts.push({ c, before: parts.length === 0 ? null : (pending ?? " ") });
    pending = null;
  }
  return parts.length && pending === null ? { parts, spec } : null;
}

/** Whether a node matches a compound selector. */
function matchesCompound(n: Node, c: Compound): boolean {
  if (c.tag !== null && c.tag !== n.tag) return false;
  if (c.id !== null && n.attrs.get("id") !== c.id) return false;
  const classes = (n.attrs.get("class") ?? "").split(/\s+/);
  if (!c.classes.every((k) => classes.includes(k))) return false;
  return c.attrs.every(([a, v]) => n.attrs.has(a) && (v === null || n.attrs.get(a) === v));
}

/** Whether a node, with its ancestors (nearest last), matches a selector: right to left, backtracking. */
function matches(sel: Selector, n: Node, ancestors: Node[]): boolean {
  const k = sel.parts.length - 1;
  if (!matchesCompound(n, sel.parts[k].c)) return false;
  const left = (part: number, upTo: number): boolean => {
    if (part < 0) return true;
    const how = sel.parts[part + 1].before;
    if (how === ">")
      return (
        upTo >= 0 && matchesCompound(ancestors[upTo], sel.parts[part].c) && left(part - 1, upTo - 1)
      );
    for (let a = upTo; a >= 0; a--) {
      if (matchesCompound(ancestors[a], sel.parts[part].c) && left(part - 1, a - 1)) return true;
    }
    return false;
  };
  return left(k - 1, ancestors.length - 1);
}

/**
 * The shapes and labels a reader sees in one SVG drawing, each in its own coordinates with its
 * transform within the drawing; and what could not be read, by name.
 */
export function readSvg(
  svg: string,
  /** The report's stylesheets outside the drawing: a browser styles an SVG with them too. */
  outerCss = "",
): {
  shapes: SvgShape[];
  labels: SvgLabel[];
  unread: string[];
  viewport: number[] | null;
  images: SvgImage[];
  filters: SvgFilterUse[];
} {
  const root = parse(svg);
  const shapes: SvgShape[] = [];
  const images: SvgImage[] = [];
  const filters: SvgFilterUse[] = [];
  /** The copies of filtered elements being read for their content (their filter set aside). */
  const filtering = new Set<Node>();
  const labels: SvgLabel[] = [];
  const unread = new Set<string>();
  // Every stylesheet rule that could restyle the drawing: the report's, then the drawing's own
  // (later in the document, so later in the cascade).
  const ids = new Map<string, Node>();
  const inner: string[] = [];
  const index = (n: Node) => {
    if (n.tag === "style") inner.push(n.text);
    const id = n.attrs.get("id");
    if (id) ids.set(id, n);
    n.children.forEach(index);
  };
  index(root);
  const outer = cssRules(outerCss, unread, 0);
  const rules = [...outer, ...cssRules(inner.join("\n"), unread, outer.length)];
  /**
   * A property for a node, by the cascade: an `!important` rule, then the inline style, then the
   * rules by specificity and order, then the presentation attribute.
   */
  const own = (n: Node, prop: string, ancestors: Node[] = []): string | undefined => {
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
    if (best?.important) return best.value;
    for (const d of (n.attrs.get("style") ?? "").split(";")) {
      const at = d.indexOf(":");
      if (at > 0 && d.slice(0, at).trim().toLowerCase() === prop) {
        return d
          .slice(at + 1)
          .replace(/!\s*important\s*$/i, "")
          .trim();
      }
    }
    return best?.value ?? n.attrs.get(prop);
  };
  const ancestors: Node[] = [];
  /**
   * A gradient element as a {@link Gradient}: its `href` chain followed for what it does not say
   * itself (attributes, and stops from the first with any). No stops paints nothing.
   */
  const readGradient = (node: Node): { gradient: Gradient } | { unread: string } | null => {
    const chain: Node[] = [];
    for (let at: Node | undefined = node; at && chain.length < 10 && !chain.includes(at);) {
      chain.push(at);
      const ref: string = (at.attrs.get("href") ?? at.attrs.get("xlink:href") ?? "").replace(
        /^#/,
        "",
      );
      at = ref ? ids.get(ref) : undefined;
    }
    const attr = (a: string) => chain.find((c) => c.attrs.has(a))?.attrs.get(a);
    const units = attr("gradientunits") ?? "objectBoundingBox";
    const length = (a: string, d: number): number | null => {
      const v = attr(a);
      if (v === undefined) return d;
      const n = Number.parseFloat(v);
      if (!Number.isFinite(n)) return d;
      if (v.trim().endsWith("%")) return units === "userSpaceOnUse" ? null : n / 100;
      return n;
    };
    const kind = node.tag === "radialgradient" ? "radial" : "linear";
    const raw =
      kind === "linear"
        ? [length("x1", 0), length("y1", 0), length("x2", 1), length("y2", 0)]
        : [length("cx", 0.5), length("cy", 0.5), length("r", 0.5)];
    if (raw.some((v) => v === null)) return { unread: "a gradient in percentages of its viewport" };
    const geometry = raw as number[];
    if (kind === "radial")
      geometry.push(
        length("fx", geometry[0]) ?? geometry[0],
        length("fy", geometry[1]) ?? geometry[1],
      );
    const holder = chain.find((c) => c.children.some((k) => k.tag === "stop"));
    const stops: Gradient["stops"] = [];
    let last = 0;
    for (const s of holder?.children.filter((k) => k.tag === "stop") ?? []) {
      const o = s.attrs.get("offset") ?? "0";
      let offset = Number.parseFloat(o);
      if (!Number.isFinite(offset)) offset = 0;
      if (o.trim().endsWith("%")) offset /= 100;
      offset = Math.max(last, Math.min(1, Math.max(0, offset)));
      last = offset;
      const colour = paintOf(
        own(s, "stop-color", [...ancestors, holder as Node]) ?? "black",
        [0, 0, 0],
      );
      if (!colour) return { unread: `a gradient stop coloured "${own(s, "stop-color") ?? ""}"` };
      // A stop colour's own alpha is a stop opacity too. Chrome draws a gradient with transparent
      // stops as a tiling pattern: its alpha a luminosity mask of its own shading (group 8e).
      const raw = own(s, "stop-opacity") ?? "1";
      const value = Number.parseFloat(raw);
      const opacity =
        Math.max(
          0,
          Math.min(
            1,
            Number.isFinite(value) ? (raw.trim().endsWith("%") ? value / 100 : value) : 1,
          ),
        ) * (colour[3] ?? 1);
      stops.push({ offset, colour: colour.slice(0, 3), opacity });
    }
    if (stops.length === 0) return null;
    return {
      gradient: {
        kind,
        units,
        transform: transformOf(attr("gradienttransform")),
        geometry,
        spread: (attr("spreadmethod") ?? "pad").toLowerCase(),
        stops,
      },
    };
  };
  /** The patterns being read, so one that holds itself is named, not followed forever. */
  const resolving = new Set<Node>();
  /**
   * A `<pattern>` as an {@link SvgPattern} (group 8g): its `href` chain followed for what it does
   * not say itself (attributes, and content from the first with any); its content read as the
   * drawing's shapes are. A tile with no area paints nothing.
   */
  const readPattern = (node: Node): { pattern: SvgPattern } | { unread: string } | null => {
    const chain: Node[] = [];
    for (let at: Node | undefined = node; at && chain.length < 10 && !chain.includes(at);) {
      chain.push(at);
      const ref: string = (at.attrs.get("href") ?? at.attrs.get("xlink:href") ?? "").replace(
        /^#/,
        "",
      );
      at = ref ? ids.get(ref) : undefined;
    }
    const attr = (a: string) => chain.find((c) => c.attrs.has(a))?.attrs.get(a);
    const units = (attr("patternunits") ?? "objectBoundingBox").trim();
    const contentUnits = (attr("patterncontentunits") ?? "userSpaceOnUse").trim();
    const length = (a: string): number => {
      const v = attr(a);
      if (v === undefined) return 0;
      const n = Number.parseFloat(v);
      if (!Number.isFinite(n)) return 0;
      if (v.trim().endsWith("%")) return units === "userSpaceOnUse" ? Number.NaN : n / 100;
      return n;
    };
    const tile = ["x", "y", "width", "height"].map(length);
    if (tile.some(Number.isNaN)) return { unread: "a pattern in percentages of its viewport" };
    if (tile[2] <= 0 || tile[3] <= 0) return null;
    const vb = (attr("viewbox") ?? "").split(/[\s,]+/).map(Number);
    const viewBox = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb : null;
    const holder = chain.find((c) => c.children.some((k) => k.tag !== "#text"));
    if (!holder) return null;
    if (resolving.has(holder)) return { unread: "a pattern that holds itself" };
    if (/^(visible|auto)$/.test((own(holder, "overflow", []) ?? "hidden").trim()))
      return { unread: "a pattern whose overflow shows" };
    resolving.add(holder);
    const [s, l, im] = [shapes.length, labels.length, images.length];
    walk(
      { tag: "g", attrs: new Map(), children: holder.children, text: "" },
      IDENTITY,
      start,
      1,
      [],
    );
    resolving.delete(holder);
    const content = shapes.splice(s);
    if (labels.splice(l).length + images.splice(im).length > 0)
      return { unread: "a pattern holding text or an image" };
    if (content.some((c) => c.fillPattern || c.strokePattern))
      return { unread: "a pattern inside a pattern" };
    return {
      pattern: {
        tile,
        units,
        contentUnits,
        transform: transformOf(attr("patterntransform")),
        viewBox,
        par: attr("preserveaspectratio") ?? "xMidYMid meet",
        content,
      },
    };
  };
  /** A fill or stroke value: a colour, a gradient, nothing, or what this reader cannot evaluate. */
  const resolvePaint = (
    value: string,
    current: number[],
  ):
    | { rgb: number[] }
    | { gradient: Gradient }
    | { pattern: SvgPattern }
    | { unread: string }
    | null => {
    const v = value.trim();
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)\s*(.*)$/i.exec(v);
    if (url) {
      const target = ids.get(url[1]);
      // A reference to nothing paints its fallback, or nothing (as a browser does).
      if (!target) return url[2].trim() ? resolvePaint(url[2], current) : null;
      if (target.tag === "lineargradient" || target.tag === "radialgradient")
        return readGradient(target);
      if (target.tag === "pattern") return readPattern(target);
      return { unread: `"${v}" (a <${target.tag}>)` };
    }
    const p = paintOf(v, current);
    if (p === undefined) return { unread: `"${v}"` };
    return p === null ? null : { rgb: p };
  };
  type Inherited = {
    fill: string;
    stroke: string;
    width: string;
    color: string;
    size: string;
    anchor: string;
    visible: boolean;
    dasharray: string;
    dashoffset: string;
    fillOpacity: string;
    strokeOpacity: string;
    cap: string;
    /** Every `opacity` around, multiplied (it is not inherited; it composes). */
    opacity: number;
    /** marker-start, marker-mid, marker-end. */
    markers: string[];
    // group 8d, each inherited
    fillRule: string;
    clipRule: string;
    join: string;
    miter: string;
    paintOrder: string;
    /** Group 8h: the mask over this subtree (not a CSS inheritance: it applies to what is inside). */
    mask?: SvgMask;
  };
  /**
   * The mask a `mask` value puts on an element whose user space maps to the drawing by `m`
   * (group 8h): a `<mask>` -- its region in `maskUnits` (by default the box widened by a tenth
   * all round), its content in `maskContentUnits`, `mask-type` -- read as an {@link SvgMask};
   * `null` for none or a reference to nothing; a string names what this reader cannot read.
   */
  const maskOf = (value: string, n: Node, anc: Node[], m: Matrix): SvgMask | null | string => {
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/i.exec(value.trim());
    if (!url) return value.trim() === "none" ? null : `the mask "${value.trim()}" of a <${n.tag}>`;
    const target = ids.get(url[1]);
    if (target?.tag !== "mask") return null;
    const units = (target.attrs.get("maskunits") ?? "objectBoundingBox").trim();
    const contentUnits = (target.attrs.get("maskcontentunits") ?? "userSpaceOnUse").trim();
    const bbox = bboxOf(n, anc);
    if (!bbox && (units === "objectBoundingBox" || contentUnits === "objectBoundingBox"))
      return `a mask in the units of a <${n.tag}>'s box`;
    const [bx, by, bw, bh] = bbox
      ? [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]]
      : [0, 0, 1, 1];
    const length = (a: string, d: number, whole: number, origin: number) => {
      const v = target.attrs.get(a);
      const raw =
        v === undefined
          ? d
          : v.trim().endsWith("%")
            ? Number.parseFloat(v) / 100
            : Number.parseFloat(v);
      if (!Number.isFinite(raw)) return Number.NaN;
      if (units !== "objectBoundingBox") return v === undefined ? Number.NaN : raw;
      return origin + raw * whole;
    };
    const region = [
      length("x", -0.1, bw, bx),
      length("y", -0.1, bh, by),
      length("width", 1.2, bw, 0),
      length("height", 1.2, bh, 0),
    ];
    if (region.some(Number.isNaN)) return "a mask whose region is in percentages of its viewport";
    const type =
      (own(target, "mask-type", anc) ?? "luminance").trim() === "alpha" ? "alpha" : "luminance";
    const [s, l, im] = [shapes.length, labels.length, images.length];
    walk(
      { tag: "g", attrs: new Map(), children: target.children, text: "" },
      IDENTITY,
      start,
      1,
      [],
    );
    const content = shapes.splice(s);
    if (labels.splice(l).length + images.splice(im).length > 0)
      return "a mask holding text or an image";
    if (content.some((c) => c.fillPattern || c.strokePattern || c.mask))
      return "a mask holding a pattern or a mask";
    return {
      type,
      region: rectPolygon(region[0], region[1], region[2], region[3], m),
      toDrawing: mul(contentUnits === "objectBoundingBox" ? [bw, 0, 0, bh, bx, by] : IDENTITY, m),
      content,
    };
  };
  /**
   * An element's box in its own user space (its geometry, not its stroke): its shape's, or its
   * children's under their transforms; `null` when it has none this reader can measure (text).
   */
  const bboxOf = (n: Node, anc: Node[], depth = 0): number[] | null => {
    if (depth > 32 || own(n, "display", anc) === "none") return null;
    const lines = geometryOf(n);
    if (lines) return lines.length ? bounds(lines) : null;
    if (n.tag === "text" || n.tag === "tspan") return null;
    let box: number[] | null = null;
    const children =
      n.tag === "use"
        ? [ids.get((n.attrs.get("href") ?? n.attrs.get("xlink:href") ?? "").replace(/^#/, ""))]
        : n.children;
    for (const c of children) {
      if (!c || c.tag === "#text" || NOT_DRAWN.has(c.tag)) continue;
      const b = bboxOf(c, [...anc, n], depth + 1);
      if (!b) continue;
      let t = transformOf(own(c, "transform", [...anc, n]));
      if (n.tag === "use")
        t = mul(t, [1, 0, 0, 1, Number(n.attrs.get("x") ?? 0), Number(n.attrs.get("y") ?? 0)]);
      const corners = [
        apply(t, b[0], b[1]),
        apply(t, b[2], b[1]),
        apply(t, b[2], b[3]),
        apply(t, b[0], b[3]),
      ];
      const cb = polygonBox([corners]);
      box = box
        ? [
            Math.min(box[0], cb[0]),
            Math.min(box[1], cb[1]),
            Math.max(box[2], cb[2]),
            Math.max(box[3], cb[3]),
          ]
        : cb;
    }
    return box;
  };
  /**
   * The clip a `clip-path` value sets on an element whose user space maps to the drawing by `m`:
   * a `<clipPath>` (its shapes, each by its `clip-rule`, under its transform and units, cut by its
   * own `clip-path`), or a CSS basic shape on the element's stroke box (by default) or fill box;
   * `null` for none (a reference to nothing is no clip, as in a browser); a string names what this
   * reader cannot read.
   */
  const clipOf = (
    value: string,
    n: Node,
    anc: Node[],
    m: Matrix,
    strokeWidth: number,
    depth: number,
  ): SvgClip | null | string => {
    const v = value.trim();
    if (v === "" || v === "none") return null;
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/i.exec(v);
    if (url) {
      const target = ids.get(url[1]);
      if (target?.tag !== "clippath") return null;
      if (depth > 8) return "a clip path that refers back to itself";
      let units: Matrix = IDENTITY;
      if ((target.attrs.get("clippathunits") ?? "").trim() === "objectBoundingBox") {
        const b = bboxOf(n, anc);
        if (!b) return `a clip path in the units of a <${n.tag}>'s box`;
        units = [b[2] - b[0], 0, 0, b[3] - b[1], b[0], b[1]];
      }
      const toDrawing = mul(mul(transformOf(own(target, "transform", anc)), units), m);
      const parts: ClipPart[] = [];
      const holder = [...anc, n, target];
      const add = (c: Node, t: Matrix, path: Node[]): string | null => {
        if (c.tag === "#text" || own(c, "display", path) === "none") return null;
        const vis = own(c, "visibility", path);
        if (vis === "hidden" || vis === "collapse") return null;
        const t2 = mul(transformOf(own(c, "transform", path)), t);
        if (c.tag === "use") {
          const ref = ids.get(
            (c.attrs.get("href") ?? c.attrs.get("xlink:href") ?? "").replace(/^#/, ""),
          );
          if (!ref || geometryOf(ref) === null)
            return "a clip path's <use> of something not a shape";
          const at: Matrix = [
            1,
            0,
            0,
            1,
            Number(c.attrs.get("x") ?? 0),
            Number(c.attrs.get("y") ?? 0),
          ];
          return add(ref, mul(at, t2), [...path, c]);
        }
        const lines = geometryOf(c);
        if (lines === null) return `a clip path's <${c.tag}>`;
        const rule = (
          own(c, "clip-rule", path) ??
          own(target, "clip-rule", anc) ??
          "nonzero"
        ).trim();
        const part: ClipPart = { polygons: polygonsOf(lines, t2), evenOdd: rule === "evenodd" };
        const inner = own(c, "clip-path", path);
        if (inner && inner !== "none") {
          const w = clipOf(inner, c, path, t2, 0, depth + 1);
          if (typeof w === "string") return w;
          if (w) part.within = w;
        }
        parts.push(part);
        return null;
      };
      for (const c of target.children) {
        const why = add(c, toDrawing, holder);
        if (why) return why;
      }
      const clip: SvgClip = { parts };
      const self = own(target, "clip-path", anc);
      if (self && self !== "none") {
        const w = clipOf(self, n, anc, m, strokeWidth, depth + 1);
        if (typeof w === "string") return w;
        if (w) clip.within = w;
      }
      return clip;
    }
    // A basic shape, with or without a reference box (before or after it); or a box alone.
    const fn = /(circle|ellipse|inset|polygon|path)\(([\s\S]*)\)/i.exec(v);
    const rest = (fn ? v.replace(fn[0], " ") : v).trim();
    const b = bboxOf(n, anc);
    if (!b || (rest !== "" && !/^[\w-]+$/.test(rest)))
      return `the clip-path "${v}" of a <${n.tag}>`;
    const word = (rest || "border-box").toLowerCase();
    let box: number[];
    if (["fill-box", "content-box", "padding-box"].includes(word)) box = b;
    else if (["stroke-box", "border-box", "margin-box"].includes(word)) {
      const half = strokeWidth / 2;
      box = [b[0] - half, b[1] - half, b[2] + half, b[3] + half];
    } else return `the clip-path "${v}" of a <${n.tag}>`;
    if (!fn) {
      // a box alone clips to the box
      return {
        parts: [
          {
            polygons: [rectPolygon(box[0], box[1], box[2] - box[0], box[3] - box[1], m)],
            evenOdd: false,
          },
        ],
      };
    }
    const part = basicShape(fn[1].toLowerCase(), fn[2], box);
    if (!part) return `the clip-path "${v}" of a <${n.tag}>`;
    return {
      parts: [
        {
          polygons: part.polygons.map((p) => p.map(([x, y]) => apply(m, x, y))),
          evenOdd: part.evenOdd,
        },
      ],
    };
  };
  /**
   * An element's `filter` read as an {@link SvgFilterUse}, or why it cannot be: a `<filter>`
   * (region in `filterUnits`, by default the box widened by a tenth all round; lengths in
   * `primitiveUnits`; one `color-interpolation-filters` for all) of primitives this check runs,
   * over content this check can paint (shapes; not text, images, masks or patterns).
   */
  const readFilterUse = (
    value: string,
    n: Node,
    e: Matrix,
    m: Matrix,
    inh: Inherited,
    depth: number,
    outerClips: SvgClip[],
    alpha: number,
  ): string | null => {
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/i.exec(value.trim());
    if (!url) return `the filter "${value.trim()}" of a <${n.tag}>`;
    const target = ids.get(url[1]);
    // a reference to nothing is no filter: the element is not drawn (CSS Filter Effects § 5)
    if (target?.tag !== "filter") return null;
    const bbox = bboxOf(n, ancestors);
    if (!bbox) return `a filter on a <${n.tag}> this check cannot measure`;
    const [bx, by, bw, bh] = [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]];
    const units = (target.attrs.get("filterunits") ?? "objectBoundingBox").trim();
    const pUnits = (target.attrs.get("primitiveunits") ?? "userSpaceOnUse").trim();
    const len = (
      node: Node,
      a: string,
      d: number | null,
      whole: number,
      origin: number,
      inUnits: string,
    ) => {
      const v = node.attrs.get(a);
      if (v === undefined)
        return d === null ? null : inUnits === "objectBoundingBox" ? origin + d * whole : d;
      const n2 = v.trim().endsWith("%") ? Number.parseFloat(v) / 100 : Number.parseFloat(v);
      if (!Number.isFinite(n2)) return Number.NaN;
      if (inUnits === "objectBoundingBox" || v.trim().endsWith("%")) return origin + n2 * whole;
      return n2;
    };
    const rx = len(target, "x", -0.1, bw, bx, units) as number;
    const ry = len(target, "y", -0.1, bh, by, units) as number;
    const rw = len(target, "width", 1.2, bw, 0, units) as number;
    const rh = len(target, "height", 1.2, bh, 0, units) as number;
    if (
      [rx, ry, rw, rh].some(Number.isNaN) ||
      (units !== "objectBoundingBox" && !target.attrs.has("width"))
    )
      return "a filter region in percentages of its viewport";
    const spaces = new Set<string>();
    const primitives: Primitive[] = [];
    // lengths of a primitive in user units: a fraction of the box under objectBoundingBox
    const scaled = (v: string | undefined, horizontal: boolean[]) => {
      if (v === undefined || pUnits !== "objectBoundingBox") return v;
      return v
        .trim()
        .split(/[\s,]+/)
        .map((x, k) => String(Number(x) * ((horizontal[k] ?? horizontal[0]) ? bw : bh)))
        .join(" ");
    };
    for (const p of target.children.filter((c) => c.tag !== "#text")) {
      if (!PRIMITIVES.has(p.tag)) return `the filter primitive <${p.tag}>`;
      spaces.add(
        (
          own(p, "color-interpolation-filters", [target]) ??
          own(target, "color-interpolation-filters", []) ??
          "linearRGB"
        )
          .trim()
          .toLowerCase(),
      );
      const attrs: Record<string, string> = Object.fromEntries(p.attrs);
      if (p.tag === "fegaussianblur" || p.tag === "fedropshadow")
        attrs.stddeviation =
          scaled(attrs.stddeviation, [true, false]) ?? (p.tag === "fedropshadow" ? "2" : "0");
      if (p.tag === "femorphology") attrs.radius = scaled(attrs.radius, [true, false]) ?? "0";
      for (const [k, h] of [
        ["dx", true],
        ["dy", false],
      ] as const)
        if (attrs[k] !== undefined) attrs[k] = scaled(attrs[k], [h]) as string;
      const prim: Primitive = { tag: p.tag, attrs };
      if (p.tag === "feflood" || p.tag === "fedropshadow") {
        const c = paintOf(own(p, "flood-color", [target]) ?? "black", [0, 0, 0]);
        const o = Number.parseFloat(own(p, "flood-opacity", [target]) ?? "1");
        if (!c) return `a flood coloured "${own(p, "flood-color", [target])}"`;
        prim.flood = [c[0], c[1], c[2], (c[3] ?? 1) * (Number.isFinite(o) ? o : 1)];
      }
      if (p.tag === "fecomponenttransfer")
        prim.funcs = Object.fromEntries(
          p.children
            .filter((c) => c.tag.startsWith("fefunc"))
            .map((c) => [c.tag, Object.fromEntries(c.attrs)]),
        );
      if (p.tag === "femerge")
        prim.nodes = p.children
          .filter((c) => c.tag === "femergenode")
          .map((c) => c.attrs.get("in"));
      // a subregion of its own, in user units [x0, y0, x1, y1] (converted to pixels by the check)
      if (["x", "y", "width", "height"].some((a) => p.attrs.has(a))) {
        const sx = len(p, "x", null, bw, bx, pUnits) ?? rx;
        const sy = len(p, "y", null, bh, by, pUnits) ?? ry;
        const sw = len(p, "width", null, bw, 0, pUnits) ?? rw;
        const sh = len(p, "height", null, bh, 0, pUnits) ?? rh;
        if ([sx, sy, sw, sh].some(Number.isNaN))
          return "a filter primitive's region in percentages";
        prim.region = [sx, sy, sx + sw, sy + sh];
      }
      primitives.push(prim);
    }
    if (spaces.size > 1) return "a filter whose primitives work in different colour spaces";
    // Its content: the element itself, walked as a copy with the filter set aside.
    const copy: Node = { ...n, attrs: new Map(n.attrs) };
    filtering.add(copy);
    const [s, l, im, before] = [shapes.length, labels.length, images.length, filters.length];
    walk(copy, e, inh, depth, outerClips);
    filtering.delete(copy);
    const content = shapes.splice(s);
    if (labels.splice(l).length + images.splice(im).length + filters.splice(before).length > 0)
      return "a filter over text, an image or another filter";
    if (content.some((c) => c.fillPattern || c.strokePattern || c.mask))
      return "a filter over a pattern or a mask";
    filters.push({
      what: n.tag,
      content,
      e: m,
      region: [rx, ry, rx + rw, ry + rh],
      primitives,
      linear: [...spaces][0] !== "srgb",
      alpha,
    });
    return null;
  };
  const walk = (n: Node, e: Matrix, inh: Inherited, depth: number, outerClips: SvgClip[] = []) => {
    if (n.tag === "#text" || NOT_DRAWN.has(n.tag) || depth > 32) return;
    if (UNREAD.has(n.tag)) {
      unread.add(`<${n.tag}>`);
      return;
    }
    if (own(n, "display", ancestors) === "none") return;
    const vis = own(n, "visibility", ancestors);
    const here: Inherited = {
      fill: own(n, "fill", ancestors) ?? inh.fill,
      stroke: own(n, "stroke", ancestors) ?? inh.stroke,
      width: own(n, "stroke-width", ancestors) ?? inh.width,
      color: own(n, "color", ancestors) ?? inh.color,
      size: own(n, "font-size", ancestors) ?? inh.size,
      anchor: own(n, "text-anchor", ancestors) ?? inh.anchor,
      visible: vis === undefined ? inh.visible : vis !== "hidden" && vis !== "collapse",
      dasharray: own(n, "stroke-dasharray", ancestors) ?? inh.dasharray,
      dashoffset: own(n, "stroke-dashoffset", ancestors) ?? inh.dashoffset,
      fillOpacity: own(n, "fill-opacity", ancestors) ?? inh.fillOpacity,
      strokeOpacity: own(n, "stroke-opacity", ancestors) ?? inh.strokeOpacity,
      cap: own(n, "stroke-linecap", ancestors) ?? inh.cap,
      // A filtered element's copy is read at opacity 1: its opacity applies to the filter's image.
      opacity: filtering.has(n)
        ? 1
        : inh.opacity * (Number.parseFloat(own(n, "opacity", ancestors) ?? "1") || 0),
      markers: inh.markers,
      fillRule: own(n, "fill-rule", ancestors) ?? inh.fillRule,
      clipRule: own(n, "clip-rule", ancestors) ?? inh.clipRule,
      join: own(n, "stroke-linejoin", ancestors) ?? inh.join,
      miter: own(n, "stroke-miterlimit", ancestors) ?? inh.miter,
      paintOrder: own(n, "paint-order", ancestors) ?? inh.paintOrder,
      mask: inh.mask,
    };
    const filter = filtering.has(n) ? undefined : own(n, "filter", ancestors);
    // Markers inherit; `marker` sets all three.
    const all = own(n, "marker", ancestors);
    here.markers = [
      own(n, "marker-start", ancestors) ?? all ?? inh.markers[0],
      own(n, "marker-mid", ancestors) ?? all ?? inh.markers[1],
      own(n, "marker-end", ancestors) ?? all ?? inh.markers[2],
    ];
    // The transform as the cascade gives it: a stylesheet's CSS `transform` (with its units) wins.
    const cssTransform = own(n, "transform", ancestors)?.replace(/(-?[\d.]+)(?:px|deg)\b/g, "$1");
    let m = mul(transformOf(cssTransform), e);
    // Its mask (group 8h), over it and all it holds; one inside another is not read yet.
    const maskValue = own(n, "mask", ancestors);
    if (maskValue && maskValue.trim() !== "none") {
      const mk = maskOf(maskValue, n, ancestors, m);
      if (typeof mk === "string") {
        unread.add(mk);
        return;
      }
      if (mk && inh.mask) {
        unread.add("a mask inside a mask");
        return;
      }
      if (mk) here.mask = mk;
    }
    // The clips around this element and what it holds (group 8d): those around it, then its own
    // `clip-path` in its user space.
    let clips = outerClips;
    const clipValue = own(n, "clip-path", ancestors);
    if (clipValue && clipValue.trim() !== "none") {
      const sw = Number.parseFloat(here.width);
      const c = clipOf(clipValue, n, ancestors, m, Number.isFinite(sw) ? sw : 1, 0);
      if (typeof c === "string") {
        unread.add(c);
        return;
      }
      if (c) clips = [...clips, c];
    }
    // A filter (group 8i): Chrome writes the element, filtered, as one image. Its content is read
    // by walking a copy of it with the filter set aside; the filter is read for the drawing check
    // to run on that content.
    if (filter && filter.trim() !== "none") {
      const why = readFilterUse(filter, n, e, m, inh, depth, outerClips, here.opacity);
      if (why) unread.add(why);
      return;
    }
    if (n.tag === "svg" && depth > 0) {
      // A nested drawing: its own viewport at x, y, its viewBox fitted by preserveAspectRatio,
      // and clipped to the viewport unless its overflow shows it (group 8d: neither was read).
      const [x, y] = [Number(n.attrs.get("x") ?? 0), Number(n.attrs.get("y") ?? 0)];
      const vb = (n.attrs.get("viewbox") ?? "").split(/[\s,]+/).map(Number);
      const w = cssLength(n.attrs.get("width") ?? "", 0);
      const h = cssLength(n.attrs.get("height") ?? "", 0);
      const hasBox = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
      if (!(w > 0 && h > 0) && (hasBox || n.attrs.has("width") || n.attrs.has("height"))) {
        unread.add("a nested <svg> sized other than in user units");
        return;
      }
      const fitted = hasBox
        ? viewBoxMatrix(vb, w, h, n.attrs.get("preserveaspectratio"))
        : IDENTITY;
      if (
        w > 0 &&
        h > 0 &&
        !/^(visible|auto)$/.test((own(n, "overflow", ancestors) ?? "hidden").trim())
      ) {
        clips = [...clips, { parts: [{ polygons: [rectPolygon(x, y, w, h, m)], evenOdd: false }] }];
      }
      m = mul(mul(fitted, [1, 0, 0, 1, x, y]), m);
    }
    const num = (a: string, d = 0) => {
      const v = Number.parseFloat(n.attrs.get(a) ?? "");
      return Number.isFinite(v) ? v : d;
    };
    const colour = paintOf(here.color, [0, 0, 0]) ?? [0, 0, 0];
    const shape = (what: string, lines: Polyline[]) => {
      if (!here.visible || lines.length === 0) return;
      const fillPaint = resolvePaint(here.fill, colour);
      const strokePaint = resolvePaint(here.stroke, colour);
      for (const p of [fillPaint, strokePaint]) {
        if (p !== null && "unread" in p) {
          unread.add(`a <${what}> painted with ${p.unread}`);
          return;
        }
      }
      // A colour's own alpha (rgba, #rrggbbaa) multiplies its opacity.
      const fillRgb = fillPaint !== null && "rgb" in fillPaint ? fillPaint.rgb : null;
      const strokeRgb = strokePaint !== null && "rgb" in strokePaint ? strokePaint.rgb : null;
      const fill = fillRgb ? fillRgb.slice(0, 3) : null;
      const stroke = strokeRgb ? strokeRgb.slice(0, 3) : null;
      const fillGradient =
        fillPaint !== null && "gradient" in fillPaint ? fillPaint.gradient : undefined;
      const strokeGradient =
        strokePaint !== null && "gradient" in strokePaint ? strokePaint.gradient : undefined;
      const fillPattern =
        fillPaint !== null && "pattern" in fillPaint ? fillPaint.pattern : undefined;
      const strokePattern =
        strokePaint !== null && "pattern" in strokePaint ? strokePaint.pattern : undefined;
      const width = Number.parseFloat(here.width);
      const pattern =
        here.dasharray === "none" ? [] : (here.dasharray.match(/[\d.]+/g) ?? []).map(Number);
      const alpha = (v: string) => {
        const a = Number.parseFloat(v);
        return Math.max(
          0,
          Math.min(1, Number.isFinite(a) ? (v.trim().endsWith("%") ? a / 100 : a) : 1),
        );
      };
      const sw = Number.isFinite(width) ? width : 1;
      // A shape whose box misses a clip around it is not drawn at all: Chrome leaves it out
      // (measured, group 8d: a rect outside its clip path was no path), so there is nothing to find.
      const box = polygonBox(polygonsOf(lines, m));
      const reach = (stroke || strokeGradient || strokePattern ? sw / 2 : 0) * scaleOf(m);
      const shown = clips.every((c) => {
        const cb = polygonBox(clipPolygons(c));
        return (
          cb[0] <= box[2] + reach &&
          box[0] - reach <= cb[2] &&
          cb[1] <= box[3] + reach &&
          box[1] - reach <= cb[3]
        );
      });
      if (!shown) return;
      const join = here.join.trim().toLowerCase();
      if (!["miter", "round", "bevel"].includes(join)) {
        unread.add(`a <${what}> joined "${join}"`);
        return;
      }
      const order = here.paintOrder.trim().toLowerCase().split(/\s+/);
      shapes.push({
        what,
        lines,
        e: m,
        // Nothing to fill where the outline encloses nothing (a line drawn as a path): Chrome
        // paints no fill there (measured).
        fill: enclosed(lines) > 1e-9 ? fill : null,
        stroke,
        strokeWidth: sw,
        dashed: pattern.some((v) => v > 0)
          ? dash(lines, pattern, Number.parseFloat(here.dashoffset) || 0)
          : lines,
        fillAlpha: alpha(here.fillOpacity) * here.opacity * (fillRgb?.[3] ?? 1),
        strokeAlpha: alpha(here.strokeOpacity) * here.opacity * (strokeRgb?.[3] ?? 1),
        cap: here.cap.trim().toLowerCase(),
        ...(fillGradient && enclosed(lines) > 1e-9 ? { fillGradient } : {}),
        ...(strokeGradient ? { strokeGradient } : {}),
        ...(fillPattern && enclosed(lines) > 1e-9 ? { fillPattern } : {}),
        ...(strokePattern ? { strokePattern } : {}),
        clips,
        evenOdd: here.fillRule.trim().toLowerCase() === "evenodd",
        join,
        miter: Number.parseFloat(here.miter) || 4,
        // `paint-order` names what comes first; the rest follow in fill, stroke, markers order.
        strokeFirst: order[0] === "stroke" || (order[0] === "markers" && order[1] === "stroke"),
        ...(here.mask ? { mask: here.mask } : {}),
      });
      // Its markers, drawn as Chrome draws them (measured): the marker's own shapes, in its own
      // coordinates, under a transform that sets it at a vertex -- scaled by the stroke width,
      // turned to the path's direction when `orient` says so, its ref point on the vertex.
      if (
        ["path", "line", "polyline", "polygon"].includes(what) &&
        here.markers.some((r) => r !== "none")
      ) {
        const spots = vertexSpots(lines);
        here.markers.forEach((ref, slot) => {
          const id = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(ref.trim())?.[1];
          const marker = id ? ids.get(id) : undefined;
          if (marker?.tag !== "marker") return; // none, or a reference to nothing
          const at =
            slot === 0 ? spots.slice(0, 1) : slot === 2 ? spots.slice(-1) : spots.slice(1, -1);
          for (const spot of at) {
            const mm = markerMatrix(marker, spot.x, spot.y, spot.angle, slot, sw);
            const placed = mul(mm.content, m);
            // A marker is clipped to its viewport unless its overflow shows it (measured: Chrome
            // clips each marker to its box).
            let markerClips = clips;
            if (!/^(visible|auto)$/.test((own(marker, "overflow", []) ?? "hidden").trim())) {
              markerClips = [
                ...clips,
                {
                  parts: [
                    {
                      polygons: [rectPolygon(0, 0, mm.width, mm.height, mul(mm.viewport, m))],
                      evenOdd: false,
                    },
                  ],
                },
              ];
            }
            const content: Node = {
              tag: "g",
              attrs: new Map(
                [...marker.attrs].filter(([k]) => !["transform", "display", "id"].includes(k)),
              ),
              children: marker.children,
              text: "",
            };
            walk(content, placed, start, depth + 1, markerClips);
          }
        });
      }
    };
    const geometry = geometryOf(n);
    if (geometry) {
      shape(n.tag, geometry);
      return; // a shape draws no children
    }
    switch (n.tag) {
      case "image": {
        // A raster image (group 8f): Chrome paints it as an image (measured), checked by where it
        // is painted and, by the caller, pixel for pixel. An SVG one, or one not embedded, is not.
        const uri = (n.attrs.get("href") ?? n.attrs.get("xlink:href") ?? "").trim();
        const [w, h] = [num("width", Number.NaN), num("height", Number.NaN)];
        if (!/^data:image\/(?!svg\+xml)/i.test(uri)) {
          unread.add(`an <image> of "${uri.slice(0, 40)}"`);
          return;
        }
        if (!(w > 0 && h > 0)) {
          if (Number.isNaN(w) || Number.isNaN(h)) unread.add("an <image> sized by its own pixels");
          return;
        }
        if (!here.visible) return;
        const par = (n.attrs.get("preserveaspectratio") ?? "xMidYMid meet").trim();
        const box = [num("x"), num("y"), w, h];
        // `slice` overflows its viewport, which clips it.
        const own = /\bslice\b/.test(par)
          ? [
              ...clips,
              { parts: [{ polygons: [rectPolygon(box[0], box[1], w, h, m)], evenOdd: false }] },
            ]
          : clips;
        images.push({ uri, box, par, e: m, alpha: here.opacity, clips: own });
        return;
      }
      case "text": {
        // The text and its own tspans: a tspan with its own x or y is a label of its own.
        const size = Number.parseFloat(here.size) || 16;
        const words = (k: Node): string =>
          k.tag === "#text"
            ? k.text
            : k.tag === "tspan" && (k.attrs.has("x") || k.attrs.has("y"))
              ? " "
              : k.children.map(words).join("");
        const text = decodeEntities(n.children.map(words).join("")).replace(/\s+/g, " ").trim();
        if (text && here.visible)
          labels.push({ text, x: num("x"), y: num("y"), anchor: here.anchor, size, e: m });
        for (const t of n.children) {
          if (t.tag === "tspan" && (t.attrs.has("x") || t.attrs.has("y"))) {
            const tt = decodeEntities(t.children.map(words).join("")).replace(/\s+/g, " ").trim();
            const tx = Number.parseFloat(t.attrs.get("x") ?? n.attrs.get("x") ?? "0");
            const ty = Number.parseFloat(t.attrs.get("y") ?? n.attrs.get("y") ?? "0");
            if (tt && here.visible)
              labels.push({
                text: tt,
                x: tx,
                y: ty,
                anchor: own(t, "text-anchor", [...ancestors, n]) ?? here.anchor,
                size,
                e: m,
              });
          }
        }
        return; // its children are its text
      }
      case "use": {
        const ref = (n.attrs.get("href") ?? n.attrs.get("xlink:href") ?? "").replace(/^#/, "");
        const target = ids.get(ref);
        if (!target) {
          unread.add(`<use> of "#${ref}"`);
          return;
        }
        let at: Matrix = [1, 0, 0, 1, num("x"), num("y")];
        let useClips = clips;
        if (target.tag === "symbol") {
          // A symbol is a viewport the use sizes (group 8d: its viewBox and clip were not read).
          const vb = (target.attrs.get("viewbox") ?? "").split(/[\s,]+/).map(Number);
          const w = cssLength(n.attrs.get("width") ?? target.attrs.get("width") ?? "", 0);
          const h = cssLength(n.attrs.get("height") ?? target.attrs.get("height") ?? "", 0);
          const hasBox = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
          if (w > 0 && h > 0) {
            if (hasBox)
              at = mul(viewBoxMatrix(vb, w, h, target.attrs.get("preserveaspectratio")), at);
            if (!/^(visible|auto)$/.test((own(target, "overflow", []) ?? "hidden").trim())) {
              useClips = [
                ...clips,
                {
                  parts: [
                    {
                      polygons: [rectPolygon(num("x"), num("y"), w, h, m)],
                      evenOdd: false,
                    },
                  ],
                },
              ];
            }
          } else if (hasBox) {
            unread.add(`a <symbol> with a viewBox, used without a size in user units`);
            return;
          }
        }
        ancestors.push(n);
        walk(
          target.tag === "symbol" ? { ...target, tag: "g" } : target,
          mul(at, m),
          here,
          depth + 1,
          useClips,
        );
        ancestors.pop();
        return;
      }
    }
    ancestors.push(n);
    for (const c of n.children) walk(c, m, here, depth + 1, clips);
    ancestors.pop();
  };
  const start: Inherited = {
    fill: "black",
    stroke: "none",
    width: "1",
    color: "black",
    size: "16",
    anchor: "start",
    visible: true,
    dasharray: "none",
    dashoffset: "0",
    fillOpacity: "1",
    strokeOpacity: "1",
    cap: "butt",
    opacity: 1,
    markers: ["none", "none", "none"],
    fillRule: "nonzero",
    clipRule: "nonzero",
    join: "miter",
    miter: "4",
    paintOrder: "normal",
  };
  // The drawing's viewport in its own coordinates: its width and height, back through its viewBox;
  // a browser clips the drawing to it unless its overflow shows it (group 8d).
  let viewport: number[] | null = null;
  for (const c of root.children) {
    let clips: SvgClip[] = [];
    if (c.tag === "svg" && viewport === null) {
      const w = cssLength(c.attrs.get("width") ?? "", 0);
      const h = cssLength(c.attrs.get("height") ?? "", 0);
      const vb = (c.attrs.get("viewbox") ?? "").split(/[\s,]+/).map(Number);
      if (w > 0 && h > 0) {
        const fitted =
          vb.length === 4 && vb[2] > 0 && vb[3] > 0
            ? viewBoxMatrix(vb, w, h, c.attrs.get("preserveaspectratio"))
            : IDENTITY;
        const region = rectPolygon(0, 0, w, h, invert(fitted));
        viewport = polygonBox([region]);
        if (!/^(visible|auto)$/.test((own(c, "overflow", []) ?? "hidden").trim()))
          clips = [{ parts: [{ polygons: [region], evenOdd: false }] }];
      }
    }
    walk(c, IDENTITY, start, 0, clips);
  }
  return { shapes, labels, unread: [...unread], viewport, images, filters };
}

// ---------------------------------------------------------------------------
// Comparing it with the PDF
// ---------------------------------------------------------------------------

/** The points of polylines, a segment at most `step` long, so two outlines can be measured. */
function dense(lines: Polyline[], step: number): number[][] {
  const out: number[][] = [];
  for (const l of lines) {
    const pts = l.closed ? [...l.points, l.points[0]] : l.points;
    out.push(pts[0]);
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1];
      const [bx, by] = pts[k];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let s = 1; s <= n; s++) out.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
    }
  }
  return out;
}

/** The farthest any point of `a` stands from the polylines `b`. */
function reach(a: number[][], b: Polyline[]): number {
  const segs: number[][] = [];
  for (const l of b) {
    const pts = l.closed ? [...l.points, l.points[0]] : l.points;
    if (pts.length === 1) segs.push([...pts[0], ...pts[0]]);
    for (let k = 1; k < pts.length; k++) segs.push([...pts[k - 1], ...pts[k]]);
  }
  let worst = 0;
  for (const [px, py] of a) {
    let best = Number.POSITIVE_INFINITY;
    for (const [ax, ay, bx, by] of segs) {
      const [dx, dy] = [bx - ax, by - ay];
      const len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
      best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
      if (best === 0) break;
    }
    worst = Math.max(worst, best);
    if (worst === Number.POSITIVE_INFINITY) break;
  }
  return worst;
}

function bounds(lines: Polyline[]): number[] {
  const xs = lines.flatMap((l) => l.points.map((p) => p[0]));
  const ys = lines.flatMap((l) => l.points.map((p) => p[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Whether two outlines are one shape: each within `tol` of the other, both ways. */
function sameOutline(a: Polyline[], b: Polyline[], tol: number): boolean {
  const [ba, bb] = [bounds(a), bounds(b)];
  if (ba.some((v, k) => Math.abs(v - bb[k]) > tol * 2)) return false;
  const step = Math.max(tol, 0.25);
  return reach(dense(a, step), b) <= tol && reach(dense(b, step), a) <= tol;
}

const close = (a: number[] | null, b: number[] | null) =>
  a === null || b === null ? a === b : a.every((v, k) => Math.abs(v - b[k]) <= 2.5 / 255);

const hex = (c: number[] | null) =>
  c === null
    ? "none"
    : `#${c
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;

/** Two transforms alike, to a part in a thousand of the drawing's scale. */
function sameMatrix(a: Matrix, b: Matrix): boolean {
  const s = Math.max(scaleOf(a), scaleOf(b), 1e-9);
  return (
    a.slice(0, 4).every((v, k) => Math.abs(v - b[k]) <= 1e-3 * s) &&
    Math.abs(a[4] - b[4]) <= 0.5 &&
    Math.abs(a[5] - b[5]) <= 0.5
  );
}

/**
 * Outcome of {@link compareSvg}; `images` names each source image matched to a paint, with the
 * source's pixel crop the paint must show (the caller compares the pixels).
 */
export type SvgCheck = {
  compared: number;
  problems: string[];
  images: { uri: string; page: number; order: number; crop: number[] }[];
};

/**
 * Where a source image is painted (group 8f, measured on Chrome 2026-11-09): its pixels fitted to
 * its viewport by `preserveAspectRatio`; under `slice`, only the WHOLE pixels its viewport shows
 * are written (a 4x2 image sliced into 30x40 at x-mid is written as its pixels 1 to 3, placed
 * where they fall, then clipped). `crop` is [x, y, width, height] in source pixels; `unit` maps
 * the PDF image's unit square (row 0 at the top, v = 1) into the drawing.
 */
export function imagePlacement(
  img: SvgImage,
  iw: number,
  ih: number,
): { crop: number[]; unit: Matrix } {
  const [x, y, w, h] = img.box;
  const fit = mul(viewBoxMatrix([0, 0, iw, ih], w, h, img.par), [1, 0, 0, 1, x, y]);
  let crop = [0, 0, iw, ih];
  if (/\bslice\b/.test(img.par)) {
    const back = invert(fit);
    const [x0, y0] = apply(back, x, y);
    const [x1, y1] = apply(back, x + w, y + h);
    const snap = (v: number) => Math.round(v * 1e6) / 1e6;
    const cx0 = Math.max(0, Math.floor(snap(Math.min(x0, x1))));
    const cy0 = Math.max(0, Math.floor(snap(Math.min(y0, y1))));
    const cx1 = Math.min(iw, Math.ceil(snap(Math.max(x0, x1))));
    const cy1 = Math.min(ih, Math.ceil(snap(Math.max(y0, y1))));
    crop = [cx0, cy0, cx1 - cx0, cy1 - cy0];
  }
  const toPixels: Matrix = [crop[2], 0, 0, -crop[3], crop[0], crop[1] + crop[3]];
  return { crop, unit: mul(mul(toPixels, fit), img.e) };
}

/**
 * One source drawing against the paths and text the PDF draws for its report: every fill and
 * every stroke of every shape matched by one PDF path -- the same outline in the shape's own
 * coordinates, under the shape's transform times the drawing's one base transform (found by a
 * vote), in the same colour, a stroke at the same width -- no other path painted among them, and
 * every label set where the source puts it. `used` carries what earlier drawings already matched.
 */
export function compareSvg(
  svg: ReturnType<typeof readSvg>,
  vectors: PdfVector[],
  runs: PdfRun[],
  used: Set<string>,
  /** Group 8f: the images the PDF paints, and each source image's pixel size (its decoded URI). */
  imagePaints: PdfImagePaint[] = [],
  sizeOf: (uri: string) => number[] | null = () => null,
): SvgCheck {
  const problems = svg.unread.map((u) => `${u} is not verified`);
  const imageKey = (p: PdfImagePaint) => `${p.page}:${p.order}:image`;
  // Each source image placed (its crop and where it lands), or why it cannot be.
  const placings = svg.images.map((img) => {
    const size = sizeOf(img.uri);
    return { img, placing: size ? imagePlacement(img, size[0], size[1]) : null };
  });
  type Duty = { shape: SvgShape; kind: "fill" | "stroke" };
  // A stroke draws nothing where it has no length and butt caps -- an SVG length a browser cannot
  // read is 0, and a client set's chart with a collapsed range writes `y1="NaN"` (408 grid lines
  // in 14 reports, measured): no line, and nothing to find.
  const length = (lines: Polyline[]) =>
    lines.reduce(
      (n, l) =>
        n +
        (l.closed ? [...l.points, l.points[0]] : l.points).reduce(
          (s, p, k, a) => (k ? s + Math.hypot(p[0] - a[k - 1][0], p[1] - a[k - 1][1]) : 0),
          0,
        ),
      0,
    );
  const draws = (shape: SvgShape) =>
    length(shape.dashed) > 1e-9 || (shape.cap !== "butt" && shape.lines.length > 0);
  const duties: Duty[] = svg.shapes.flatMap((shape) => [
    ...(shape.fill !== null || shape.fillGradient || shape.fillPattern
      ? [{ shape, kind: "fill" as const }]
      : []),
    ...((shape.stroke !== null || shape.strokeGradient || shape.strokePattern) &&
    shape.strokeWidth > 0 &&
    draws(shape)
      ? [{ shape, kind: "stroke" as const }]
      : []),
  ]);
  const key = (v: PdfVector, kind: string) => `${v.page}:${v.order}:${kind}`;
  // Each duty's candidates: a free PDF path of its kind with its outline (tolerance: half a unit
  // of the drawing, or a hundredth of the shape's size), and the base transform it implies.
  // A stroke is compared by its dashes, as drawn.
  const outlineOf = (d: Duty) => (d.kind === "stroke" ? d.shape.dashed : d.shape.lines);
  // A stroke may also be drawn as the FILL of its outline: Chrome fills a dashed stroke wider
  // than a device unit as its dashes' outlines, half the width either side of the centreline
  // (measured: [10..12] x [94.75..95.25] for a 0.5 dash at y 95). Such a fill stands half the
  // width from the source's centreline, both ways -- which also proves the width.
  const outlinedStroke = (d: Duty, v: PdfVector, tol: number) => {
    const half = d.shape.strokeWidth / 2;
    const centre = d.shape.dashed;
    const [bc, bv] = [bounds(centre), bounds(v.lines)];
    if (bc.some((x, i) => Math.abs(x - bv[i]) > half + 2 * tol)) return false;
    const step = Math.max(Math.min(tol, half), 0.1);
    const out = reach(dense(v.lines, step), centre);
    return (
      reach(dense(centre, step), v.lines) <= half + tol &&
      Math.abs(out - half) <= Math.max(0.1, 0.1 * half) + 0.02
    );
  };
  // The duty's paint: a colour, or a gradient. A PDF path paints its fill or stroke with a colour,
  // a shading (a gradient), or something else (a tiling pattern); a duty takes a path of its kind.
  const gradientOf = (d: Duty) =>
    d.kind === "fill" ? d.shape.fillGradient : d.shape.strokeGradient;
  const patternOf = (d: Duty) => (d.kind === "fill" ? d.shape.fillPattern : d.shape.strokePattern);
  const paints = (v: PdfVector, as: "fill" | "stroke", d: Duty) => {
    const solid = as === "fill" ? v.fill : v.stroke;
    const shading = as === "fill" ? v.fillShading : v.strokeShading;
    const raster = as === "fill" ? v.fillRaster : v.strokeRaster;
    if (patternOf(d)) return raster !== undefined;
    return gradientOf(d) ? shading !== undefined : solid !== null;
  };
  type Candidate = { v: PdfVector; base: Matrix; as: "fill" | "stroke" };
  const candidates: Candidate[][] = duties.map((d) => {
    const b = bounds(d.shape.lines);
    const tol = Math.max(0.5, 0.01 * Math.hypot(b[2] - b[0], b[3] - b[1]));
    const found: Candidate[] = [];
    for (const v of vectors) {
      const base = mul(invert(d.shape.e), v.m);
      if (d.kind === "fill") {
        if (
          paints(v, "fill", d) &&
          !used.has(key(v, "fill")) &&
          sameOutline(d.shape.lines, v.lines, tol)
        ) {
          found.push({ v, base, as: "fill" });
        }
      } else if (
        paints(v, "stroke", d) &&
        !used.has(key(v, "stroke")) &&
        sameOutline(outlineOf(d), v.lines, tol)
      ) {
        found.push({ v, base, as: "stroke" });
      } else if (paints(v, "fill", d) && !used.has(key(v, "fill")) && outlinedStroke(d, v, tol)) {
        found.push({ v, base, as: "fill" });
      }
    }
    return found;
  });
  /** A stroke's width as drawn: the source's, or a hairline (0) where it draws under a point. */
  const widthOk = (v: PdfVector, d: Duty) =>
    Math.abs(v.lineWidth - d.shape.strokeWidth) <= 0.1 * d.shape.strokeWidth + 0.05 ||
    (v.lineWidth === 0 && d.shape.strokeWidth * scaleOf(v.m) <= 1);
  // The drawing's base transform: the one most duties agree on.
  const votes: { base: Matrix; n: number }[] = [];
  for (const c of candidates) {
    const seen: Matrix[] = [];
    for (const { base } of c) {
      if (seen.some((s) => sameMatrix(s, base))) continue;
      seen.push(base);
      const vote = votes.find((t) => sameMatrix(t.base, base));
      if (vote) vote.n++;
      else votes.push({ base, n: 1 });
    }
  }
  // An image votes too (group 8f): the base its paint implies, its crop's pixels where the source
  // puts them -- so a drawing of an image alone is placed.
  for (const { placing } of placings) {
    if (!placing) continue;
    const seen: Matrix[] = [];
    for (const p of imagePaints) {
      if (used.has(imageKey(p)) || p.width !== placing.crop[2] || p.height !== placing.crop[3])
        continue;
      const b = mul(invert(placing.unit), p.m);
      if (seen.some((s) => sameMatrix(s, b))) continue;
      seen.push(b);
      const vote = votes.find((t) => sameMatrix(t.base, b));
      if (vote) vote.n++;
      else votes.push({ base: b, n: 1 });
    }
  }
  // With nothing else to place it, a drawing is placed by its labels (group 8i, found when a
  // drawing of filtered elements alone PASSED unchecked -- and so did one of labels alone): a run
  // with a label's text gives the scale (the sizes), the turn (its direction) and the place (its
  // anchor). Each such placing is one vote; the label it came from is then trivially in place.
  if (votes.length === 0) {
    for (const l of svg.labels) {
      for (const r of runs) {
        if (r.text.replace(/\s+/g, "") !== l.text.replace(/\s+/g, "") || l.size <= 0) continue;
        const s = r.size / (l.size * scaleOf(l.e));
        const T: Matrix = [s * r.dx, s * r.dy, s * r.dy, -s * r.dx, 0, 0];
        const f = l.anchor === "middle" ? 0.5 : l.anchor === "end" ? 1 : 0;
        const [ax, ay] = [r.x + r.dx * r.width * f, r.y + r.dy * r.width * f];
        const [lx, ly] = apply(l.e, l.x, l.y);
        const [tx, ty] = apply(T, lx, ly);
        const b: Matrix = [T[0], T[1], T[2], T[3], ax - tx, ay - ty];
        const vote = votes.find((t) => sameMatrix(t.base, b));
        if (vote) vote.n++;
        else votes.push({ base: b, n: 1 });
      }
    }
  }
  const base = votes.sort((a, b) => b.n - a.n)[0]?.base;
  if (base === undefined) {
    const things = duties.length + svg.images.length + svg.filters.length + svg.labels.length;
    if (things > 0)
      problems.push(
        svg.filters.length > 0 && duties.length + svg.images.length + svg.labels.length === 0
          ? `its ${svg.filters.length} filtered element(s) cannot be placed: nothing else in it is drawn to place them by`
          : `none of its ${things} shape(s), image(s), filter(s) and label(s) drawn as in its source`,
      );
    return { compared: 0, problems, images: [] };
  }
  /**
   * Where a gradient is compared: points inside a fill (a 5 by 5 grid of its box, those inside
   * its outline), or along a stroke's centreline -- in the shape's own coordinates.
   */
  const samples = (d: Duty): number[][] => {
    if (d.kind === "stroke") {
      const pts = dense(d.shape.dashed, Math.max(0.5, length(d.shape.dashed) / 12));
      return pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 9)) === 0).slice(0, 9);
    }
    const b = bounds(d.shape.lines);
    const inside: number[][] = [];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        const [x, y] = [
          b[0] + ((i + 0.5) / 5) * (b[2] - b[0]),
          b[1] + ((j + 0.5) / 5) * (b[3] - b[1]),
        ];
        let winding = 0;
        for (const l of d.shape.lines) {
          for (let k = 0; k < l.points.length; k++) {
            const [ax, ay] = l.points[k];
            const [bx, by] = l.points[(k + 1) % l.points.length];
            if (ay <= y !== by <= y && ax + ((y - ay) / (by - ay)) * (bx - ax) > x)
              winding += by > ay ? 1 : -1;
          }
        }
        if (winding !== 0) inside.push([x, y]);
      }
    }
    return inside.length ? inside : [[(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]];
  };
  /** How a candidate's paint differs from the duty's, or null when it is the same. */
  const paintDifference = (c: Candidate, d: Duty): string | null => {
    const pattern = patternOf(d);
    if (pattern) {
      const raster = c.as === "fill" ? c.v.fillRaster : c.v.strokeRaster;
      if (!raster) return "drawn without its pattern";
      return rasterDifference(pattern, raster, d.shape, d.kind, c.v.m);
    }
    const g = gradientOf(d);
    if (!g) {
      const got = c.as === "fill" ? c.v.fill : c.v.stroke;
      const want = d.kind === "fill" ? d.shape.fill : d.shape.stroke;
      return close(got, want) ? null : `${hex(got)}, ${hex(want)} in its source`;
    }
    const shading = c.as === "fill" ? c.v.fillShading : c.v.strokeShading;
    if (!shading) return "drawn without its gradient";
    // Group 8e: its alpha too, wherever either side has one -- the source's stop opacities, the
    // PDF's luminosity mask (a grey shading: its luminance is the alpha).
    const alphaShading = c.as === "fill" ? c.v.fillAlphaShading : c.v.strokeAlphaShading;
    const translucent = g.stops.some((s) => (s.opacity ?? 1) < 1);
    if (translucent && !alphaShading) return "drawn without its gradient's stop opacity";
    const box = bounds(d.shape.lines);
    for (const [x, y] of samples(d)) {
      const want = gradientColour(g, x, y, box);
      const [px, py] = apply(c.v.m, x, y);
      const got = shadingColour(shading, px, py);
      if (got === null) return "a gradient this reader cannot read";
      if (got.some((v, i) => Math.abs(v - want[i]) > 6 / 255)) {
        return `gradient ${hex(got)} at (${x.toFixed(1)}, ${y.toFixed(1)}), ${hex(want)} in its source`;
      }
      if (alphaShading) {
        const grey = shadingColour(alphaShading, px, py);
        if (grey === null) return "a gradient's opacity this reader cannot read";
        const gotAlpha = 0.2126 * grey[0] + 0.7152 * grey[1] + 0.0722 * grey[2];
        const wantAlpha = gradientAlpha(g, x, y, box);
        if (Math.abs(gotAlpha - wantAlpha) > 6 / 255)
          return `gradient opacity ${gotAlpha.toFixed(2)} at (${x.toFixed(1)}, ${y.toFixed(1)}), ${wantAlpha.toFixed(2)} in its source`;
      }
    }
    return null;
  };
  /**
   * How a candidate's drawing differs from the duty's, beyond paint (group 8d): a fill's rule; a
   * stroke's cap, join and miter limit (as PDF writes them: 0 butt / miter, 1 round, 2 square /
   * bevel) -- where the PDF says them, and not on a hairline, whose ends and corners show nothing.
   */
  const CAPS: Record<string, number> = { butt: 0, round: 1, square: 2 };
  const JOINS: Record<string, number> = { miter: 0, round: 1, bevel: 2 };
  const styleDifference = (c: Candidate, d: Duty): string | null => {
    if (d.kind === "fill") {
      const want = d.shape.evenOdd ?? false;
      if (c.v.evenOdd !== undefined && c.v.evenOdd !== want)
        return `filled ${c.v.evenOdd ? "even-odd" : "non-zero"}, ${want ? "even-odd" : "non-zero"} in its source`;
      return null;
    }
    if (c.as === "fill" || c.v.lineWidth === 0) return null;
    const name = (table: Record<string, number>, code: number) =>
      Object.keys(table).find((k) => table[k] === code) ?? String(code);
    const cap = CAPS[d.shape.cap] ?? 0;
    if (c.v.cap !== undefined && c.v.cap !== cap)
      return `capped ${name(CAPS, c.v.cap)}, ${d.shape.cap} in its source`;
    const join = JOINS[d.shape.join ?? "miter"] ?? 0;
    if (c.v.join !== undefined && c.v.join !== join)
      return `joined ${name(JOINS, c.v.join)}, ${d.shape.join ?? "miter"} in its source`;
    const miter = d.shape.miter ?? 4;
    if (join === 0 && c.v.miter !== undefined && Math.abs(c.v.miter - miter) > 0.01)
      return `miter limit ${c.v.miter}, ${miter} in its source`;
    return null;
  };
  /**
   * Whether the clips around a matched path cut it as the source's cut the shape (group 8d): each
   * clip side asked, at the same points of the drawing, whether it holds them -- points over the
   * shape (inside a fill, along a stroke), and points either side of every clip edge, source's and
   * PDF's, that lie on the shape. Asking points rather than comparing clip lists is what the
   * measurements need: Chrome merges rectangular clips and adds a clip's box before the clip.
   * Points near an edge are skipped (curves are flattened differently on the two sides).
   */
  const clipDifference = (c: Candidate, d: Duty): string | null => {
    const src = d.shape.clips ?? [];
    const toDrawing = invert(base);
    const pdf = (c.v.clips ?? []).map((k) => ({
      polygons: k.polygons.map((p) => p.map(([x, y]) => apply(toDrawing, x, y))),
      evenOdd: k.evenOdd,
    }));
    if (src.length === 0 && pdf.length === 0) return null;
    const outline = outlineOf(d);
    const area = polygonsOf(outline, d.shape.e);
    const shapeBox = polygonBox(area);
    const half = d.kind === "stroke" ? (d.shape.strokeWidth / 2) * scaleOf(d.shape.e) : 0;
    const diag = Math.hypot(shapeBox[2] - shapeBox[0], shapeBox[3] - shapeBox[1]);
    const tol = Math.max(0.75 / Math.max(scaleOf(base), 1e-9), 0.01 * diag);
    const edges = [...src.flatMap(clipPolygons), ...pdf.flatMap((k) => k.polygons)];
    const centre: Polyline[] = outline.map((l) => ({
      points: l.points.map(([x, y]) => apply(d.shape.e, x, y)),
      closed: l.closed,
    }));
    // On the shape: inside a fill by its rule; within half the width of a stroke's centreline.
    const onShape = (x: number, y: number) =>
      x >= shapeBox[0] - half &&
      x <= shapeBox[2] + half &&
      y >= shapeBox[1] - half &&
      y <= shapeBox[3] + half &&
      (d.kind === "fill"
        ? polygonsContain(area, d.shape.evenOdd ?? false, x, y)
        : reach([[x, y]], centre) <= half);
    const points: number[][] = [];
    if (d.kind === "fill") {
      for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
          const p = [
            shapeBox[0] + ((i + 0.5) / 9) * (shapeBox[2] - shapeBox[0]),
            shapeBox[1] + ((j + 0.5) / 9) * (shapeBox[3] - shapeBox[1]),
          ];
          if (onShape(p[0], p[1])) points.push(p);
        }
      }
    } else {
      const along = dense(centre, Math.max(tol, length(centre) / 24));
      points.push(...along.filter((_, i) => i % Math.max(1, Math.floor(along.length / 24)) === 0));
    }
    return clipsDisagree(src, pdf, edges, onShape, points, tol);
  };
  /**
   * The points test itself, shared by shapes and images: `seeds` over the area, and points either
   * side of every clip edge that lie on it (`onArea`); a point near an edge is skipped.
   */
  const clipsDisagree = (
    src: SvgClip[],
    pdf: PdfClip[],
    edges: number[][][],
    onArea: (x: number, y: number) => boolean,
    seeds: number[][],
    tol: number,
  ): string | null => {
    const points = [...seeds];
    for (const p of edges) {
      // about 48 probes a polygon, none closer than the tolerance
      const ring = dense(
        [{ points: p, closed: true }],
        Math.max(tol, length([{ points: p, closed: true }]) / 48),
      );
      for (let k = 1; k < ring.length; k++) {
        const [ax, ay] = ring[k - 1];
        const [bx, by] = ring[k];
        const len = Math.hypot(bx - ax, by - ay);
        if (len === 0) continue;
        const [mx, my] = [(ax + bx) / 2, (ay + by) / 2];
        const [nx, ny] = [-(by - ay) / len, (bx - ax) / len];
        for (const s of [-2.5, 2.5]) {
          const q = [mx + nx * s * tol, my + ny * s * tol];
          if (onArea(q[0], q[1])) points.push(q);
        }
      }
    }
    for (const [x, y] of points) {
      if (edges.some((p) => edgeDistance([p], x, y) < tol)) continue;
      const want = src.every((k) => clipContains(k, x, y));
      const got = pdf.every((k) => polygonsContain(k.polygons, k.evenOdd, x, y));
      if (want !== got)
        return `clipped differently: (${x.toFixed(1)}, ${y.toFixed(1)}) ${want ? "shown" : "cut"} in its source, ${got ? "shown" : "cut"} in the PDF`;
    }
    return null;
  };
  /**
   * Whether the mask over a matched path is the source's (group 8h): at points over the shape and
   * either side of every edge of the source mask's region and content, the PDF's soft mask (1
   * where there is none) against the source mask's value, within 10 levels; a point near a source
   * edge is skipped (the mask is a raster there).
   */
  const maskDifference = (c: Candidate, d: Duty): string | null => {
    const src = d.shape.mask;
    const pdf = c.v.mask;
    if (!src && !pdf) return null;
    const outline = outlineOf(d);
    const area = polygonsOf(outline, d.shape.e);
    const box = polygonBox(area);
    const half = d.kind === "stroke" ? (d.shape.strokeWidth / 2) * scaleOf(d.shape.e) : 0;
    const tol = Math.max(
      1 / Math.max(scaleOf(base), 1e-9),
      0.01 * Math.hypot(box[2] - box[0], box[3] - box[1]),
    );
    const centre: Polyline[] = outline.map((l) => ({
      points: l.points.map(([x, y]) => apply(d.shape.e, x, y)),
      closed: l.closed,
    }));
    const onShape = (x: number, y: number) =>
      d.kind === "fill"
        ? polygonsContain(area, d.shape.evenOdd ?? false, x, y)
        : reach([[x, y]], centre) <= half;
    const points: number[][] = [];
    for (let i = 0; i < 9; i++)
      for (let j = 0; j < 9; j++) {
        const p = [
          box[0] + ((i + 0.5) / 9) * (box[2] - box[0]),
          box[1] + ((j + 0.5) / 9) * (box[3] - box[1]),
        ];
        if (onShape(p[0], p[1])) points.push(p);
      }
    if (d.kind === "stroke") points.push(...dense(centre, Math.max(tol, length(centre) / 24)));
    const edges = src
      ? [src.region, ...src.content.flatMap((s) => polygonsOf(s.lines, mul(s.e, src.toDrawing)))]
      : [];
    for (const p of edges) {
      const ring = dense(
        [{ points: p, closed: true }],
        Math.max(tol, length([{ points: p, closed: true }]) / 48),
      );
      for (let k = 1; k < ring.length; k++) {
        const [ax, ay] = ring[k - 1];
        const [bx, by] = ring[k];
        const len = Math.hypot(bx - ax, by - ay);
        if (len === 0) continue;
        for (const s of [-2.5, 2.5]) {
          const q = [
            (ax + bx) / 2 - ((by - ay) / len) * s * tol,
            (ay + by) / 2 + ((bx - ax) / len) * s * tol,
          ];
          if (onShape(q[0], q[1])) points.push(q);
        }
      }
    }
    for (const [x, y] of points) {
      const want = src ? svgMaskValue(src, x, y, tol) : 1;
      if (want === null) continue;
      const [px, py] = apply(base, x, y);
      const got = pdf ? pdfMaskValue(pdf, px, py) : 1;
      if (Math.abs(got - want) > 10 / 255)
        return `masked ${got.toFixed(2)} at (${x.toFixed(1)}, ${y.toFixed(1)}), ${want.toFixed(2)} in its source`;
    }
    return null;
  };
  const matched: PdfVector[] = [];
  const matchOf = new Map<Duty, Candidate>();
  const missing: string[] = [];
  duties.forEach((d, k) => {
    const options = candidates[k].filter(
      (c) => sameMatrix(c.base, base) && !used.has(key(c.v, c.as)),
    );
    const alpha = d.kind === "fill" ? d.shape.fillAlpha : d.shape.strokeAlpha;
    // A hairline (width 0) carries its true width in its alpha: Chrome draws a stroke thinner than
    // a unit at alpha times its width (measured: 0.1 at 0.27 wide written as 0.027). Read back.
    const alphaOf = (c: Candidate) =>
      c.as === "fill"
        ? c.v.fillAlpha
        : c.v.lineWidth === 0
          ? c.v.strokeAlpha / Math.max(1e-6, Math.min(1, d.shape.strokeWidth * scaleOf(c.v.m)))
          : c.v.strokeAlpha;
    const looksRight = (c: Candidate) =>
      paintDifference(c, d) === null &&
      Math.abs(alphaOf(c) - alpha) <= 0.02 &&
      (d.kind === "fill" || c.as === "fill" || widthOk(c.v, d)) &&
      styleDifference(c, d) === null;
    const right = options.find(
      (c) => looksRight(c) && clipDifference(c, d) === null && maskDifference(c, d) === null,
    );
    if (right) {
      used.add(key(right.v, right.as));
      matched.push(right.v);
      matchOf.set(d, right);
      return;
    }
    // Say what differs, from the nearest: one right but for its clip, else the first.
    const first = options.find(looksRight) ?? options[0];
    if (first) {
      const differs = paintDifference(first, d);
      const styled = styleDifference(first, d);
      missing.push(
        differs !== null
          ? `a <${d.shape.what}>'s ${d.kind} ${differs}`
          : Math.abs(alphaOf(first) - alpha) > 0.02
            ? `a <${d.shape.what}>'s ${d.kind} at opacity ${alphaOf(first).toFixed(2)}, ${alpha.toFixed(2)} in its source`
            : d.kind === "stroke" && first.as === "stroke" && !widthOk(first.v, d)
              ? `a <${d.shape.what}>'s stroke ${first.v.lineWidth.toFixed(2)} wide, ${d.shape.strokeWidth} in its source`
              : styled !== null
                ? `a <${d.shape.what}>'s ${d.kind} ${styled}`
                : `a <${d.shape.what}>'s ${d.kind} ${clipDifference(first, d) ?? maskDifference(first, d) ?? "not drawn as in its source"}`,
      );
    } else missing.push(`a <${d.shape.what}>'s ${d.kind} not drawn as in its source`);
  });
  // Fill and stroke in the order `paint-order` gives (group 8d): the stroke after the fill unless
  // the source says the stroke first.
  for (const shape of svg.shapes) {
    const fill = [...matchOf].find(([d]) => d.shape === shape && d.kind === "fill")?.[1];
    const stroke = [...matchOf].find(([d]) => d.shape === shape && d.kind === "stroke")?.[1];
    if (!fill || !stroke || fill.v.page !== stroke.v.page) continue;
    const strokeFirst = stroke.v.order < fill.v.order;
    if (strokeFirst !== (shape.strokeFirst ?? false))
      missing.push(
        `a <${shape.what}>'s ${strokeFirst ? "stroke" : "fill"} painted first, its ${strokeFirst ? "fill" : "stroke"} first in its source`,
      );
  }
  // Each image (group 8f): a free paint whose unit square lands where the source puts its crop
  // (three corners, so neither flipped nor turned), its pixel size the crop's, at its alpha, cut by
  // the same clips. Its pixels are the caller's to compare.
  const imageMatches: SvgCheck["images"] = [];
  const matchedImages: PdfImagePaint[] = [];
  for (const { img, placing } of placings) {
    const name = `an <image> at (${img.box[0]}, ${img.box[1]})`;
    if (!placing) {
      missing.push(`${name}: its source does not decode`);
      continue;
    }
    const at = mul(placing.unit, base);
    const corners = [
      [0, 0],
      [1, 0],
      [0, 1],
    ];
    const want = corners.map(([u, v]) => apply(at, u, v));
    const tol = Math.max(0.5, 0.01 * Math.hypot(want[1][0] - want[0][0], want[2][1] - want[0][1]));
    const placed = imagePaints.filter(
      (p) =>
        p.page === (matched[0]?.page ?? p.page) &&
        !used.has(imageKey(p)) &&
        corners.every(([u, v], k) => {
          const [px, py] = apply(p.m, u, v);
          return Math.hypot(px - want[k][0], py - want[k][1]) <= tol;
        }),
    );
    // Its clips, asked as a shape's are: over the image as painted, and either side of every edge.
    const clipWhy = (p: PdfImagePaint) => {
      const toDrawing = invert(base);
      const pdf = p.clips.map((k) => ({
        polygons: k.polygons.map((q) => q.map(([x, y]) => apply(toDrawing, x, y))),
        evenOdd: k.evenOdd,
      }));
      const area = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ].map(([u, v]) => apply(placing.unit, u, v));
      const box = polygonBox([area]);
      const ctol = Math.max(
        0.75 / Math.max(scaleOf(base), 1e-9),
        0.01 * Math.hypot(box[2] - box[0], box[3] - box[1]),
      );
      const seeds: number[][] = [];
      for (let i = 0; i < 7; i++)
        for (let j = 0; j < 7; j++) seeds.push(apply(placing.unit, (i + 0.5) / 7, (j + 0.5) / 7));
      const edges = [...img.clips.flatMap(clipPolygons), ...pdf.flatMap((k) => k.polygons)];
      return clipsDisagree(
        img.clips,
        pdf,
        edges,
        (x, y) => polygonsContain([area], false, x, y),
        seeds,
        ctol,
      );
    };
    const right = placed.find(
      (p) =>
        p.width === placing.crop[2] &&
        p.height === placing.crop[3] &&
        Math.abs(p.alpha - img.alpha) <= 0.02 &&
        clipWhy(p) === null,
    );
    if (right) {
      used.add(imageKey(right));
      matchedImages.push(right);
      imageMatches.push({ uri: img.uri, page: right.page, order: right.order, crop: placing.crop });
      continue;
    }
    const [first] = placed;
    missing.push(
      !first
        ? `${name} not painted where its source puts it`
        : first.width !== placing.crop[2] || first.height !== placing.crop[3]
          ? `${name} painted ${first.width}x${first.height}, its source's ${placing.crop[2]}x${placing.crop[3]} pixels`
          : Math.abs(first.alpha - img.alpha) > 0.02
            ? `${name} at opacity ${first.alpha.toFixed(2)}, ${img.alpha.toFixed(2)} in its source`
            : `${name} ${clipWhy(first)}`,
    );
  }
  // Each filtered element (group 8i): a free image painted within its filter region, its pixels
  // the source's content run through the filter by this check's own primitives.
  for (const use of svg.filters) {
    const toPage = mul(use.e, base);
    const [x0, y0, x1, y1] = use.region;
    const regionOnPage = polygonBox([
      [apply(toPage, x0, y0), apply(toPage, x1, y0), apply(toPage, x1, y1), apply(toPage, x0, y1)],
    ]);
    const slackPt = 1.5;
    const within = (p: PdfImagePaint) => {
      const b = polygonBox(
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ].map(([u, v]) => [apply(p.m, u, v)]),
      );
      return (
        b[0] >= regionOnPage[0] - slackPt &&
        b[1] >= regionOnPage[1] - slackPt &&
        b[2] <= regionOnPage[2] + slackPt &&
        b[3] <= regionOnPage[3] + slackPt
      );
    };
    let why = "not painted as one image within its filter region";
    let right: PdfImagePaint | null = null;
    for (const p of imagePaints) {
      if (used.has(imageKey(p)) || !p.pixels || !within(p)) continue;
      const w = filterDifference(use, p, toPage);
      if (w === null) {
        right = p;
        break;
      }
      why = w;
    }
    if (right) {
      used.add(imageKey(right));
      matchedImages.push(right);
    } else missing.push(`a <${use.what}>'s filter ${why}`);
  }
  if (missing.length > 0)
    problems.push(
      `${missing.length} of ${duties.length + svg.images.length + svg.filters.length} -- ${missing.slice(0, 3).join("; ")}`,
    );
  // Nothing else painted among them: a path between its first and last matched one, page by page.
  const extra = new Set<string>();
  // Where the source has a stroked element that draws nothing (no length, butt caps): its point.
  const silent = svg.shapes
    .filter((s) => (s.stroke !== null || s.strokeGradient || s.strokePattern) && !draws(s))
    .flatMap((s) => s.lines.flatMap((l) => l.points.map(([x, y]) => apply(s.e, x, y))));
  // Group 8d: and before the first and after the last, while what is painted lies on the drawing
  // (its viewport placed on the page, or its shapes' box): a hidden shape drawn last passed.
  const region = svg.viewport ?? polygonBox(svg.shapes.flatMap((s) => polygonsOf(s.lines, s.e)));
  const onPage = polygonBox([
    [
      apply(base, region[0], region[1]),
      apply(base, region[2], region[1]),
      apply(base, region[2], region[3]),
      apply(base, region[0], region[3]),
    ],
  ]);
  const onDrawing = (v: PdfVector) => {
    const b = polygonBox(polygonsOf(v.lines, v.m));
    return (
      b[0] > b[2] ||
      (b[0] >= onPage[0] - 1 &&
        b[1] >= onPage[1] - 1 &&
        b[2] <= onPage[2] + 1 &&
        b[3] <= onPage[3] + 1)
    );
  };
  // An image paint lies on the drawing as a path does: its unit square inside the placed region.
  const imageOnDrawing = (p: PdfImagePaint) => {
    const b = polygonBox(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ].map(([u, v]) => [apply(p.m, u, v)]),
    );
    return (
      b[0] >= onPage[0] - 1 &&
      b[1] >= onPage[1] - 1 &&
      b[2] <= onPage[2] + 1 &&
      b[3] <= onPage[3] + 1
    );
  };
  const pagesDrawn = new Set([...matched.map((v) => v.page), ...matchedImages.map((p) => p.page)]);
  for (const page of pagesDrawn) {
    const orders = [...matched, ...matchedImages]
      .filter((v) => v.page === page)
      .map((v) => v.order);
    let [lo, hi] = [Math.min(...orders), Math.max(...orders)];
    // Paths and images alike, in paint order, each with whether it lies on the drawing.
    const here = [
      ...vectors
        .filter((v) => v.page === page)
        .map((v) => ({ order: v.order, on: () => onDrawing(v) })),
      ...imagePaints
        .filter((p) => p.page === page)
        .map((p) => ({ order: p.order, on: () => imageOnDrawing(p) })),
    ].sort((a, b) => a.order - b.order);
    const at = (order: number) => here.findIndex((v) => v.order === order);
    for (let k = at(lo) - 1; k >= 0 && here[k].on(); k--) lo = here[k].order;
    for (let k = at(hi) + 1; k < here.length && here[k].on(); k++) hi = here[k].order;
    for (const p of imagePaints) {
      if (p.page === page && p.order >= lo && p.order <= hi && !used.has(imageKey(p)))
        extra.add(imageKey(p));
    }
    for (const v of vectors) {
      if (v.page !== page || v.order < lo || v.order > hi) continue;
      // A path a reader cannot see draws nothing: Chrome writes the NaN grid line as one with no
      // length (the client set, measured) or as a hairline 0.018 units long, 0.008 pt on the page
      // (the zip set, measured 2026-11-09, found once the span reached past the last match). Under
      // 0.05 pt across, its stroke width included, is far below any mark (a hairline is 0.12 pt).
      if (length(v.lines) === 0 && enclosed(v.lines) === 0) continue;
      const vb = polygonBox(polygonsOf(v.lines, v.m));
      const across = Math.hypot(vb[2] - vb[0], vb[3] - vb[1]) + v.lineWidth * scaleOf(v.m);
      if (across < 0.05) continue;
      // And a sliver standing on a source element that draws nothing (a line with no length and
      // butt caps): the NaN grid line again, its leftover length growing with x (0.12 units at
      // x 497, measured) -- that element, not something added.
      const inDrawing = polygonsOf(v.lines, mul(v.m, invert(base)));
      const db = polygonBox(inDrawing);
      if (
        Math.hypot(db[2] - db[0], db[3] - db[1]) < 1 &&
        silent.some(([sx, sy]) =>
          inDrawing.flat().every(([x, y]) => Math.hypot(x - sx, y - sy) < 1),
        )
      )
        continue;
      for (const kind of ["fill", "stroke"] as const) {
        const painted =
          kind === "fill"
            ? v.fill !== null || v.fillShading || v.fillOther || v.fillRaster
            : v.stroke !== null || v.strokeShading || v.strokeOther || v.strokeRaster;
        if (painted && !used.has(key(v, kind))) extra.add(key(v, kind));
      }
    }
  }
  if (extra.size > 0) {
    // Name the first: its paint, colour, size and where it starts, in the drawing's coordinates.
    const [first] = [...extra];
    const [page, order, kind] = first.split(":");
    const v = vectors.find((x) => x.page === Number(page) && x.order === Number(order));
    const image = imagePaints.find((x) => x.page === Number(page) && x.order === Number(order));
    let what = "";
    if (kind === "image" && image) {
      const at = apply(mul(image.m, invert(base)), 0, 1);
      what = ` (first: an image ${image.width}x${image.height} from (${at[0].toFixed(1)}, ${at[1].toFixed(1)}))`;
    } else if (v) {
      const p0 = v.lines[0]?.points[0] ?? [0, 0];
      const at = apply(mul(v.m, invert(base)), p0[0], p0[1]);
      const points = v.lines.reduce((n, l) => n + l.points.length, 0);
      what = ` (first: a ${kind} ${hex(kind === "fill" ? v.fill : v.stroke)} of ${points} point(s) from (${at[0].toFixed(1)}, ${at[1].toFixed(1)}))`;
    }
    problems.push(
      `${extra.size} path(s) drawn among its shapes that its source does not have${what}`,
    );
  }
  // Each label where the source puts it: a run with its text, on its baseline, at its anchor, on
  // a page its shapes are drawn on.
  const pages = new Set([...matched, ...matchedImages].map((v) => v.page));
  // a drawing of labels alone: any page of its report
  if (pages.size === 0) for (const r of runs) pages.add(r.page);
  let placed = 0;
  for (const l of svg.labels) {
    const at = mul(l.e, base);
    const [x, y] = apply(at, l.x, l.y);
    const size = l.size * scaleOf(at);
    const want = l.text.replace(/\s+/g, "");
    // The run's anchor point: its baseline origin moved along its own direction by none, half or
    // all of its width (`start`, `middle`, `end`), so a rotated label is read along its rotation.
    const anchorOf = (r: PdfRun) => {
      const f = l.anchor === "middle" ? 0.5 : l.anchor === "end" ? 1 : 0;
      return [r.x + r.dx * r.width * f, r.y + r.dy * r.width * f];
    };
    const found = runs.some((r) => {
      if (!pages.has(r.page) || r.text.replace(/\s+/g, "") !== want) return false;
      const [ax, ay] = anchorOf(r);
      return Math.hypot(ax - x, ay - y) <= 0.6 * size;
    });
    if (found) placed++;
    else {
      // Say where it was looked for, and where the nearest run with its text stands.
      const near = runs
        .filter((r) => pages.has(r.page) && r.text.replace(/\s+/g, "") === want)
        .map((r) => ({ r, d: Math.hypot(anchorOf(r)[0] - x, anchorOf(r)[1] - y) }))
        .sort((a, b) => a.d - b.d)[0];
      const where = near
        ? `; printed at (${near.r.x.toFixed(1)}, ${near.r.y.toFixed(1)}) ${near.r.width.toFixed(1)} wide`
        : "; not printed on its page";
      problems.push(
        `the label "${l.text}" not where its source puts it (${l.anchor} at (${x.toFixed(1)}, ${y.toFixed(1)}), size ${size.toFixed(1)}${where})`,
      );
    }
  }
  return {
    compared: matched.length + matchedImages.length + placed,
    problems,
    images: imageMatches,
  };
}
