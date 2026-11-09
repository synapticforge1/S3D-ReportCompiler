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
};

/** An SVG gradient, resolved (its `href` chain followed), as {@link gradientColour} reads it. */
export type Gradient = {
  kind: "linear" | "radial";
  /** `objectBoundingBox` (the default) or `userSpaceOnUse`. */
  units: string;
  transform: Matrix;
  /** linear: x1 y1 x2 y2; radial: cx cy r fx fy -- in `units`. */
  geometry: number[];
  spread: string;
  /** Offset 0-1, RGB 0-1. */
  stops: { offset: number; colour: number[] }[];
};

/** A PDF shading as pdf.js gives it (`["RadialAxial", kind, bbox, stops, p0, p1, r0, r1]`), with its matrix. */
export type PdfShading = { ir: unknown[]; matrix: Matrix };

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

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  teal: "#008080",
  navy: "#000080",
  purple: "#800080",
  orange: "#ffa500",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  dimgray: "#696969",
  dimgrey: "#696969",
  darkred: "#8b0000",
  darkgreen: "#006400",
  darkblue: "#00008b",
  steelblue: "#4682b4",
  lightblue: "#add8e6",
  brown: "#a52a2a",
  pink: "#ffc0cb",
  gold: "#ffd700",
  indigo: "#4b0082",
  violet: "#ee82ee",
  coral: "#ff7f50",
  salmon: "#fa8072",
  tomato: "#ff6347",
  crimson: "#dc143c",
  orchid: "#da70d6",
  tan: "#d2b48c",
  khaki: "#f0e68c",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  whitesmoke: "#f5f5f5",
  gainsboro: "#dcdcdc",
};

/** A paint as RGB 0-1; `null` for none; `undefined` when it cannot be read (a gradient, a pattern). */
function paintOf(value: string, current: number[]): number[] | null | undefined {
  const v = value.trim().toLowerCase();
  if (v === "none" || v === "transparent") return null;
  if (v === "currentcolor") return current;
  if (/^url\(/.test(v)) return undefined;
  const hex = NAMED[v] ?? v;
  const three = /^#([0-9a-f]{3})$/.exec(hex)?.[1];
  if (three) return [...three].map((c) => parseInt(c + c, 16) / 255);
  const six = /^#([0-9a-f]{6})$/.exec(hex)?.[1];
  if (six) return [0, 2, 4].map((k) => parseInt(six.slice(k, k + 2), 16) / 255);
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)/.exec(v);
  if (rgb)
    return rgb
      .slice(1, 4)
      .map((c) => (c.endsWith("%") ? parseFloat(c) / 100 : parseFloat(c) / 255));
  return undefined;
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
  return stopColour(g.stops, spreadOf(t, g.spread));
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

/** A marker's transform at a vertex: viewBox (meet), ref point, markerUnits, orient. */
function markerMatrix(
  marker: Node,
  x: number,
  y: number,
  angle: number,
  slot: number,
  sw: number,
): Matrix {
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
  let view: Matrix = IDENTITY;
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    const s = Math.min(mw / vb[2], mh / vb[3]);
    view = [s, 0, 0, s, -vb[0] * s + (mw - vb[2] * s) / 2, -vb[1] * s + (mh - vb[3] * s) / 2];
  }
  const [rx, ry] = apply(view, num("refx", 0), num("refy", 0));
  const [c, s] = [Math.cos(rad), Math.sin(rad)];
  return mul(
    mul(mul(mul(view, [1, 0, 0, 1, -rx, -ry]), [scale, 0, 0, scale, 0, 0]), [c, s, -s, c, 0, 0]),
    [1, 0, 0, 1, x, y],
  );
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
const UNREAD = new Set(["foreignobject", "image", "switch"]);

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
): { shapes: SvgShape[]; labels: SvgLabel[]; unread: string[] } {
  const root = parse(svg);
  const shapes: SvgShape[] = [];
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
    const stops: { offset: number; colour: number[] }[] = [];
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
      const opacity = Number.parseFloat(own(s, "stop-opacity") ?? "1");
      // Chrome draws a gradient with transparent stops as a tiling pattern under a luminosity
      // mask (measured), which this reader does not yet evaluate.
      if (Number.isFinite(opacity) && opacity < 1)
        return { unread: "a gradient with stop-opacity" };
      stops.push({ offset, colour });
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
  /** A fill or stroke value: a colour, a gradient, nothing, or what this reader cannot evaluate. */
  const resolvePaint = (
    value: string,
    current: number[],
  ): { rgb: number[] } | { gradient: Gradient } | { unread: string } | null => {
    const v = value.trim();
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)\s*(.*)$/i.exec(v);
    if (url) {
      const target = ids.get(url[1]);
      // A reference to nothing paints its fallback, or nothing (as a browser does).
      if (!target) return url[2].trim() ? resolvePaint(url[2], current) : null;
      if (target.tag === "lineargradient" || target.tag === "radialgradient")
        return readGradient(target);
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
  };
  const walk = (n: Node, e: Matrix, inh: Inherited, depth: number) => {
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
      opacity: inh.opacity * (Number.parseFloat(own(n, "opacity", ancestors) ?? "1") || 0),
      markers: inh.markers,
    };
    for (const p of ["filter", "mask"]) {
      const v = own(n, p, ancestors);
      if (v && v !== "none") unread.add(`the ${p} of a <${n.tag}>`);
    }
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
    if (n.tag === "svg" && depth > 0) {
      // A nested drawing: its own viewport, at x, y, and its viewBox scaled to fit (meet).
      const [x, y] = [Number(n.attrs.get("x") ?? 0), Number(n.attrs.get("y") ?? 0)];
      const vb = (n.attrs.get("viewbox") ?? "").split(/[\s,]+/).map(Number);
      let inner: Matrix = [1, 0, 0, 1, x, y];
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        const w = Number(n.attrs.get("width") ?? vb[2]);
        const h = Number(n.attrs.get("height") ?? vb[3]);
        const s = Math.min(w / vb[2], h / vb[3]);
        inner = [
          s,
          0,
          0,
          s,
          x - vb[0] * s + (w - vb[2] * s) / 2,
          y - vb[1] * s + (h - vb[3] * s) / 2,
        ];
      }
      m = mul(inner, m);
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
      const fill = fillPaint !== null && "rgb" in fillPaint ? fillPaint.rgb : null;
      const stroke = strokePaint !== null && "rgb" in strokePaint ? strokePaint.rgb : null;
      const fillGradient =
        fillPaint !== null && "gradient" in fillPaint ? fillPaint.gradient : undefined;
      const strokeGradient =
        strokePaint !== null && "gradient" in strokePaint ? strokePaint.gradient : undefined;
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
      shapes.push({
        what,
        lines,
        e: m,
        // Nothing to fill where the outline encloses nothing (a line drawn as a path): Chrome
        // paints no fill there (measured).
        fill: enclosed(lines) > 1e-9 ? fill : null,
        stroke,
        strokeWidth: Number.isFinite(width) ? width : 1,
        dashed: pattern.some((v) => v > 0)
          ? dash(lines, pattern, Number.parseFloat(here.dashoffset) || 0)
          : lines,
        fillAlpha: alpha(here.fillOpacity) * here.opacity,
        strokeAlpha: alpha(here.strokeOpacity) * here.opacity,
        cap: here.cap.trim().toLowerCase(),
        ...(fillGradient && enclosed(lines) > 1e-9 ? { fillGradient } : {}),
        ...(strokeGradient ? { strokeGradient } : {}),
      });
      // Its markers, drawn as Chrome draws them (measured): the marker's own shapes, in its own
      // coordinates, under a transform that sets it at a vertex -- scaled by the stroke width,
      // turned to the path's direction when `orient` says so, its ref point on the vertex.
      if (
        ["path", "line", "polyline", "polygon"].includes(what) &&
        here.markers.some((r) => r !== "none")
      ) {
        const sw = Number.isFinite(width) ? width : 1;
        const spots = vertexSpots(lines);
        here.markers.forEach((ref, slot) => {
          const id = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(ref.trim())?.[1];
          const marker = id ? ids.get(id) : undefined;
          if (marker?.tag !== "marker") return; // none, or a reference to nothing
          const at =
            slot === 0 ? spots.slice(0, 1) : slot === 2 ? spots.slice(-1) : spots.slice(1, -1);
          for (const spot of at) {
            const placed = mul(markerMatrix(marker, spot.x, spot.y, spot.angle, slot, sw), m);
            const content: Node = {
              tag: "g",
              attrs: new Map(
                [...marker.attrs].filter(([k]) => !["transform", "display", "id"].includes(k)),
              ),
              children: marker.children,
              text: "",
            };
            walk(content, placed, start, depth + 1);
          }
        });
      }
    };
    switch (n.tag) {
      case "path":
        shape("path", pathLines(n.attrs.get("d") ?? ""));
        break;
      case "line":
        shape("line", [
          {
            points: [
              [num("x1"), num("y1")],
              [num("x2"), num("y2")],
            ],
            closed: false,
          },
        ]);
        break;
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
        shape(n.tag, [{ points, closed: n.tag === "polygon" }]);
        break;
      }
      case "rect": {
        const [x, y, w, h] = [num("x"), num("y"), num("width"), num("height")];
        if (w <= 0 || h <= 0) break;
        let rx = num("rx", Number.NaN);
        let ry = num("ry", Number.NaN);
        if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
        if (Number.isNaN(ry)) ry = rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        if (rx <= 0 || ry <= 0) {
          shape("rect", [
            {
              points: [
                [x, y],
                [x + w, y],
                [x + w, y + h],
                [x, y + h],
              ],
              closed: true,
            },
          ]);
        } else {
          const d =
            `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} ` +
            `A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} ` +
            `V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
          shape("rect", pathLines(d));
        }
        break;
      }
      case "circle":
        if (num("r") > 0) shape("circle", [ellipse(num("cx"), num("cy"), num("r"), num("r"))]);
        break;
      case "ellipse":
        if (num("rx") > 0 && num("ry") > 0)
          shape("ellipse", [ellipse(num("cx"), num("cy"), num("rx"), num("ry"))]);
        break;
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
        const at: Matrix = [1, 0, 0, 1, num("x"), num("y")];
        ancestors.push(n);
        walk(
          target.tag === "symbol" ? { ...target, tag: "g" } : target,
          mul(at, m),
          here,
          depth + 1,
        );
        ancestors.pop();
        return;
      }
    }
    ancestors.push(n);
    for (const c of n.children) walk(c, m, here, depth + 1);
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
  };
  for (const c of root.children) walk(c, IDENTITY, start, 0);
  return { shapes, labels, unread: [...unread] };
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

/** Outcome of {@link compareSvg}. */
export type SvgCheck = { compared: number; problems: string[] };

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
): SvgCheck {
  const problems = svg.unread.map((u) => `${u} is not verified`);
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
    ...(shape.fill !== null || shape.fillGradient ? [{ shape, kind: "fill" as const }] : []),
    ...((shape.stroke !== null || shape.strokeGradient) && shape.strokeWidth > 0 && draws(shape)
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
  const paints = (v: PdfVector, as: "fill" | "stroke", d: Duty) => {
    const solid = as === "fill" ? v.fill : v.stroke;
    const shading = as === "fill" ? v.fillShading : v.strokeShading;
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
  const base = votes.sort((a, b) => b.n - a.n)[0]?.base;
  if (base === undefined) {
    if (duties.length > 0)
      problems.push(`none of its ${duties.length} shape(s) drawn as in its source`);
    return { compared: 0, problems };
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
    const g = gradientOf(d);
    if (!g) {
      const got = c.as === "fill" ? c.v.fill : c.v.stroke;
      const want = d.kind === "fill" ? d.shape.fill : d.shape.stroke;
      return close(got, want) ? null : `${hex(got)}, ${hex(want)} in its source`;
    }
    const shading = c.as === "fill" ? c.v.fillShading : c.v.strokeShading;
    if (!shading) return "drawn without its gradient";
    const box = bounds(d.shape.lines);
    for (const [x, y] of samples(d)) {
      const want = gradientColour(g, x, y, box);
      const [px, py] = apply(c.v.m, x, y);
      const got = shadingColour(shading, px, py);
      if (got === null) return "a gradient this reader cannot read";
      if (got.some((v, i) => Math.abs(v - want[i]) > 6 / 255)) {
        return `gradient ${hex(got)} at (${x.toFixed(1)}, ${y.toFixed(1)}), ${hex(want)} in its source`;
      }
    }
    return null;
  };
  const matched: PdfVector[] = [];
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
    const right = options.find(
      (c) =>
        paintDifference(c, d) === null &&
        Math.abs(alphaOf(c) - alpha) <= 0.02 &&
        (d.kind === "fill" || c.as === "fill" || widthOk(c.v, d)),
    );
    if (right) {
      used.add(key(right.v, right.as));
      matched.push(right.v);
      return;
    }
    const [first] = options;
    if (first) {
      const differs = paintDifference(first, d);
      missing.push(
        differs !== null
          ? `a <${d.shape.what}>'s ${d.kind} ${differs}`
          : Math.abs(alphaOf(first) - alpha) > 0.02
            ? `a <${d.shape.what}>'s ${d.kind} at opacity ${alphaOf(first).toFixed(2)}, ${alpha.toFixed(2)} in its source`
            : `a <${d.shape.what}>'s stroke ${first.v.lineWidth.toFixed(2)} wide, ${d.shape.strokeWidth} in its source`,
      );
    } else missing.push(`a <${d.shape.what}>'s ${d.kind} not drawn as in its source`);
  });
  if (missing.length > 0)
    problems.push(`${missing.length} of ${duties.length} -- ${missing.slice(0, 3).join("; ")}`);
  // Nothing else painted among them: a path between its first and last matched one, page by page.
  const extra = new Set<string>();
  for (const page of new Set(matched.map((v) => v.page))) {
    const orders = matched.filter((v) => v.page === page).map((v) => v.order);
    const [lo, hi] = [Math.min(...orders), Math.max(...orders)];
    for (const v of vectors) {
      if (v.page !== page || v.order < lo || v.order > hi) continue;
      // A path with no extent draws nothing: Chrome writes one for a line with no length (the
      // NaN grid line, measured), and it shows nothing.
      if (length(v.lines) === 0 && enclosed(v.lines) === 0) continue;
      for (const kind of ["fill", "stroke"] as const) {
        const painted =
          kind === "fill"
            ? v.fill !== null || v.fillShading || v.fillOther
            : v.stroke !== null || v.strokeShading || v.strokeOther;
        if (painted && !used.has(key(v, kind))) extra.add(key(v, kind));
      }
    }
  }
  if (extra.size > 0) {
    // Name the first: its paint, colour, size and where it starts, in the drawing's coordinates.
    const [first] = [...extra];
    const [page, order, kind] = first.split(":");
    const v = vectors.find((x) => x.page === Number(page) && x.order === Number(order));
    let what = "";
    if (v) {
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
  const pages = new Set(matched.map((v) => v.page));
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
  return { compared: matched.length + placed, problems };
}
