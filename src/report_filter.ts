/**
 * The verification's own SVG filter primitives (roadmap task 18 group 8i), so a filtered element
 * -- which Chrome writes as ONE image of its filter's output (measured 2026-11-09) -- can be
 * compared with its source run through the same filter. Pure: no I/O, no DOM. Not part of the
 * package's API (the exports map does not name it); the drawing check uses it.
 *
 * A raster is premultiplied RGBA, 0-1, row by row, in the filter's colour space (Filter Effects 1
 * § 9: linearRGB unless `color-interpolation-filters` says sRGB; measured: Chrome's green 136
 * through `slope 0.5 intercept 0.2` is 154, which only linear arithmetic gives).
 *
 * @module
 */

/** A premultiplied RGBA raster, 0-1. */
export type Raster = { width: number; height: number; data: Float64Array };

/** One primitive as read from its element: its name, its attributes, its `feFunc*` children. */
export type Primitive = {
  tag: string;
  attrs: Record<string, string>;
  /** The flood colour (`flood-color` x `flood-opacity`, straight RGBA in sRGB 0-1), for floods. */
  flood?: number[];
  funcs?: Record<string, Record<string, string>>;
  /** feMerge's `feMergeNode`s, each its `in` (undefined: the one before). */
  nodes?: (string | undefined)[];
  /** The subregion in pixels of the raster, [x0, y0, x1, y1], or the whole when absent. */
  region?: number[];
};

/** A filter ready to run: its primitives, its colour space, the pixel size in user units. */
export type FilterRun = {
  primitives: Primitive[];
  linear: boolean;
  /** User units a pixel spans, across and down (for stdDeviation, dx, radius). */
  unit: number[];
  /** The filter region in pixels, [x0, y0, x1, y1]: nothing is painted outside it. */
  region: number[];
};

export function blank(width: number, height: number): Raster {
  return { width, height, data: new Float64Array(width * height * 4) };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** A raster's colours moved between sRGB and linearRGB (straightened, converted, premultiplied). */
export function convert(r: Raster, linear: boolean): Raster {
  const out = blank(r.width, r.height);
  const f = linear ? toLinear : toSrgb;
  for (let k = 0; k < r.width * r.height; k++) {
    const a = r.data[4 * k + 3];
    out.data[4 * k + 3] = a;
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) out.data[4 * k + c] = f(Math.min(1, r.data[4 * k + c] / a)) * a;
  }
  return out;
}

/** Each pixel through `fn` on its straight (unpremultiplied) RGBA. */
function perPixel(r: Raster, fn: (rgba: number[]) => number[]): Raster {
  const out = blank(r.width, r.height);
  for (let k = 0; k < r.width * r.height; k++) {
    const a = r.data[4 * k + 3];
    const straight = [0, 1, 2].map((c) => (a > 0 ? r.data[4 * k + c] / a : 0)).concat(a);
    const v = fn(straight).map((x) => Math.max(0, Math.min(1, x)));
    out.data[4 * k + 3] = v[3];
    for (let c = 0; c < 3; c++) out.data[4 * k + c] = v[c] * v[3];
  }
  return out;
}

/** A separable Gaussian blur, standard deviations in pixels, edges transparent. */
export function blur(r: Raster, sx: number, sy: number): Raster {
  const pass = (src: Raster, s: number, horizontal: boolean): Raster => {
    if (s <= 0) return src;
    const radius = Math.ceil(3 * s);
    const kernel = Array.from({ length: 2 * radius + 1 }, (_, k) =>
      Math.exp(-((k - radius) ** 2) / (2 * s * s)),
    );
    const sum = kernel.reduce((a, b) => a + b, 0);
    const out = blank(src.width, src.height);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const acc = [0, 0, 0, 0];
        for (let k = -radius; k <= radius; k++) {
          const [xx, yy] = horizontal ? [x + k, y] : [x, y + k];
          if (xx < 0 || yy < 0 || xx >= src.width || yy >= src.height) continue;
          const w = kernel[k + radius] / sum;
          const at = 4 * (yy * src.width + xx);
          for (let c = 0; c < 4; c++) acc[c] += w * src.data[at + c];
        }
        out.data.set(acc, 4 * (y * src.width + x));
      }
    }
    return out;
  };
  return pass(pass(r, sx, true), sy, false);
}

/** The raster moved by dx, dy pixels (fractions by bilinear sampling), what moves in transparent. */
export function offset(r: Raster, dx: number, dy: number): Raster {
  const out = blank(r.width, r.height);
  const at = (x: number, y: number, c: number) =>
    x < 0 || y < 0 || x >= r.width || y >= r.height ? 0 : r.data[4 * (y * r.width + x) + c];
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const [sx, sy] = [x - dx, y - dy];
      const [x0, y0] = [Math.floor(sx), Math.floor(sy)];
      const [fx, fy] = [sx - x0, sy - y0];
      for (let c = 0; c < 4; c++) {
        out.data[4 * (y * r.width + x) + c] =
          at(x0, y0, c) * (1 - fx) * (1 - fy) +
          at(x0 + 1, y0, c) * fx * (1 - fy) +
          at(x0, y0 + 1, c) * (1 - fx) * fy +
          at(x0 + 1, y0 + 1, c) * fx * fy;
      }
    }
  }
  return out;
}

/** Morphology: each channel's least (erode) or most (dilate) over a box of radii rx, ry pixels. */
export function morphology(r: Raster, dilate: boolean, rx: number, ry: number): Raster {
  const pass = (src: Raster, radius: number, horizontal: boolean): Raster => {
    const out = blank(src.width, src.height);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const acc = dilate ? [0, 0, 0, 0] : [1, 1, 1, 1];
        for (let k = -radius; k <= radius; k++) {
          const [xx, yy] = horizontal ? [x + k, y] : [x, y + k];
          const inside = xx >= 0 && yy >= 0 && xx < src.width && yy < src.height;
          for (let c = 0; c < 4; c++) {
            const v = inside ? src.data[4 * (yy * src.width + xx) + c] : 0;
            acc[c] = dilate ? Math.max(acc[c], v) : Math.min(acc[c], v);
          }
        }
        out.data.set(acc, 4 * (y * src.width + x));
      }
    }
    return out;
  };
  return pass(pass(r, Math.round(rx), true), Math.round(ry), false);
}

/** `a` over `b`, premultiplied. */
function overRaster(a: Raster, b: Raster): Raster {
  const out = blank(a.width, a.height);
  for (let k = 0; k < a.width * a.height; k++) {
    const ia = a.data[4 * k + 3];
    for (let c = 0; c < 4; c++)
      out.data[4 * k + c] = a.data[4 * k + c] + b.data[4 * k + c] * (1 - ia);
  }
  return out;
}

/** feComposite: over, in, out, atop, xor, arithmetic (k1..k4), premultiplied. */
export function composite(a: Raster, b: Raster, op: string, k: number[] = [0, 0, 0, 0]): Raster {
  if (op === "over") return overRaster(a, b);
  const out = blank(a.width, a.height);
  for (let p = 0; p < a.width * a.height; p++) {
    const [aa, ab] = [a.data[4 * p + 3], b.data[4 * p + 3]];
    for (let c = 0; c < 4; c++) {
      const [x, y] = [a.data[4 * p + c], b.data[4 * p + c]];
      let v: number;
      if (op === "in") v = x * ab;
      else if (op === "out") v = x * (1 - ab);
      else if (op === "atop") v = x * ab + y * (1 - aa);
      else if (op === "xor") v = x * (1 - ab) + y * (1 - aa);
      else v = k[0] * x * y + k[1] * x + k[2] * y + k[3];
      out.data[4 * p + c] = Math.max(0, Math.min(1, v));
    }
    // arithmetic keeps colour within alpha, as premultiplied values must be
    if (op === "arithmetic")
      for (let c = 0; c < 3; c++)
        out.data[4 * p + c] = Math.min(out.data[4 * p + c], out.data[4 * p + 3]);
  }
  return out;
}

/** feBlend's separable modes, on premultiplied colours (Compositing and Blending 1 § 5.1). */
export function blend(a: Raster, b: Raster, mode: string): Raster {
  const f: Record<string, (cs: number, cb: number) => number> = {
    normal: (cs) => cs,
    multiply: (cs, cb) => cs * cb,
    screen: (cs, cb) => cs + cb - cs * cb,
    darken: (cs, cb) => Math.min(cs, cb),
    lighten: (cs, cb) => Math.max(cs, cb),
    difference: (cs, cb) => Math.abs(cs - cb),
    exclusion: (cs, cb) => cs + cb - 2 * cs * cb,
    overlay: (cs, cb) => (cb <= 0.5 ? 2 * cs * cb : 1 - 2 * (1 - cs) * (1 - cb)),
    "hard-light": (cs, cb) => (cs <= 0.5 ? 2 * cs * cb : 1 - 2 * (1 - cs) * (1 - cb)),
  };
  const B = f[mode];
  if (!B) throw new Error(`the blend mode "${mode}"`);
  const out = blank(a.width, a.height);
  for (let p = 0; p < a.width * a.height; p++) {
    const [as, ab] = [a.data[4 * p + 3], b.data[4 * p + 3]];
    const ao = as + ab - as * ab;
    out.data[4 * p + 3] = ao;
    for (let c = 0; c < 3; c++) {
      const cs = as > 0 ? a.data[4 * p + c] / as : 0;
      const cb = ab > 0 ? b.data[4 * p + c] / ab : 0;
      // premultiplied: (1 - ab) cs as + (1 - as) cb ab + as ab B(cs, cb)
      out.data[4 * p + c] = (1 - ab) * cs * as + (1 - as) * cb * ab + as * ab * B(cs, cb);
    }
  }
  return out;
}

/** feColorMatrix: matrix, saturate, hueRotate, luminanceToAlpha, on straight colours. */
export function colorMatrix(r: Raster, type: string, values: number[]): Raster {
  let m: number[];
  if (type === "saturate") {
    const s = values[0] ?? 1;
    m = [
      0.213 + 0.787 * s,
      0.715 - 0.715 * s,
      0.072 - 0.072 * s,
      0,
      0,
      0.213 - 0.213 * s,
      0.715 + 0.285 * s,
      0.072 - 0.072 * s,
      0,
      0,
      0.213 - 0.213 * s,
      0.715 - 0.715 * s,
      0.072 + 0.928 * s,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
    ];
  } else if (type === "hueRotate") {
    const a = ((values[0] ?? 0) * Math.PI) / 180;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    m = [
      0.213 + c * 0.787 - s * 0.213,
      0.715 - c * 0.715 - s * 0.715,
      0.072 - c * 0.072 + s * 0.928,
      0,
      0,
      0.213 - c * 0.213 + s * 0.143,
      0.715 + c * 0.285 + s * 0.14,
      0.072 - c * 0.072 - s * 0.283,
      0,
      0,
      0.213 - c * 0.213 - s * 0.787,
      0.715 - c * 0.715 + s * 0.715,
      0.072 + c * 0.928 + s * 0.072,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
    ];
  } else if (type === "luminanceToAlpha") {
    m = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2125, 0.7154, 0.0721, 0, 0];
  } else {
    m =
      values.length === 20 ? values : [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  }
  return perPixel(r, (v) =>
    [0, 1, 2, 3].map(
      (row) =>
        m[5 * row] * v[0] +
        m[5 * row + 1] * v[1] +
        m[5 * row + 2] * v[2] +
        m[5 * row + 3] * v[3] +
        m[5 * row + 4],
    ),
  );
}

/** feComponentTransfer: each channel's function (identity, table, discrete, linear, gamma). */
export function componentTransfer(
  r: Raster,
  funcs: Record<string, Record<string, string>>,
): Raster {
  const fn = (spec: Record<string, string> | undefined) => {
    const type = spec?.type ?? "identity";
    const num = (k: string, d: number) => {
      const v = Number.parseFloat(spec?.[k] ?? "");
      return Number.isFinite(v) ? v : d;
    };
    const table = (spec?.tablevalues ?? "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    return (c: number): number => {
      if (type === "linear") return num("slope", 1) * c + num("intercept", 0);
      if (type === "gamma") return num("amplitude", 1) * c ** num("exponent", 1) + num("offset", 0);
      if (type === "table" && table.length > 0) {
        const n = table.length - 1;
        if (n === 0) return table[0];
        const k = Math.min(n - 1, Math.floor(c * n));
        return table[k] + (c * n - k) * (table[k + 1] - table[k]);
      }
      if (type === "discrete" && table.length > 0)
        return table[Math.min(table.length - 1, Math.floor(c * table.length))];
      return c;
    };
  };
  const f = ["fefuncr", "fefuncg", "fefuncb", "fefunca"].map((t) => fn(funcs[t]));
  return perPixel(r, (v) => v.map((c, k) => f[k](c)));
}

/** A raster of one straight colour (in the filter's space already), over a pixel region. */
export function flood(width: number, height: number, rgba: number[], region: number[]): Raster {
  const out = blank(width, height);
  for (
    let y = Math.max(0, Math.floor(region[1]));
    y < Math.min(height, Math.ceil(region[3]));
    y++
  ) {
    for (
      let x = Math.max(0, Math.floor(region[0]));
      x < Math.min(width, Math.ceil(region[2]));
      x++
    ) {
      out.data.set(
        [rgba[0] * rgba[3], rgba[1] * rgba[3], rgba[2] * rgba[3], rgba[3]],
        4 * (y * width + x),
      );
    }
  }
  return out;
}

/** Everything outside a pixel region made transparent. */
function cut(r: Raster, region: number[]): Raster {
  const out = blank(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (x + 0.5 < region[0] || x + 0.5 > region[2] || y + 0.5 < region[1] || y + 0.5 > region[3])
        continue;
      const k = 4 * (y * r.width + x);
      for (let c = 0; c < 4; c++) out.data[k + c] = r.data[k + c];
    }
  }
  return out;
}

/** The primitives this module runs; any other is named by the reader, not passed. */
export const PRIMITIVES = new Set([
  "fegaussianblur",
  "feoffset",
  "feflood",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "femerge",
  "feblend",
  "femorphology",
  "fedropshadow",
]);

/**
 * A filter run on its source graphic (premultiplied, sRGB as rasterised): each primitive's inputs
 * (`SourceGraphic`, `SourceAlpha`, a named result, or the one before), its own operation, cut to
 * its subregion; the last one's result, back in sRGB and cut to the filter region.
 */
export function runFilter(run: FilterRun, sourceSrgb: Raster): Raster {
  const { width: W, height: H } = sourceSrgb;
  const source = run.linear ? convert(sourceSrgb, true) : sourceSrgb;
  const alphaOnly = (r: Raster) => {
    const out = blank(W, H);
    for (let k = 0; k < W * H; k++) out.data[4 * k + 3] = r.data[4 * k + 3];
    return out;
  };
  const results = new Map<string, Raster>();
  let last = source;
  const input = (name: string | undefined) => {
    if (name === undefined || name === "") return last;
    if (name === "SourceGraphic") return source;
    if (name === "SourceAlpha") return alphaOnly(source);
    const r = results.get(name);
    if (!r) throw new Error(`the filter input "${name}"`);
    return r;
  };
  const num = (s: string | undefined, d: number) => {
    const v = Number.parseFloat(s ?? "");
    return Number.isFinite(v) ? v : d;
  };
  const pair = (s: string | undefined, d: number) => {
    const v = (s ?? "")
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    return [v[0] ?? d, v[1] ?? v[0] ?? d];
  };
  const space = (rgba: number[]) =>
    run.linear ? [toLinear(rgba[0]), toLinear(rgba[1]), toLinear(rgba[2]), rgba[3]] : rgba;
  for (const p of run.primitives) {
    const a = p.attrs;
    const region = p.region ?? run.region;
    let out: Raster;
    switch (p.tag) {
      case "fegaussianblur": {
        const [sx, sy] = pair(a.stddeviation, 0);
        out = blur(input(a.in), sx / run.unit[0], sy / run.unit[1]);
        break;
      }
      case "feoffset":
        out = offset(input(a.in), num(a.dx, 0) / run.unit[0], num(a.dy, 0) / run.unit[1]);
        break;
      case "feflood":
        out = flood(W, H, space(p.flood ?? [0, 0, 0, 1]), region);
        break;
      case "fecolormatrix":
        out = colorMatrix(
          input(a.in),
          a.type ?? "matrix",
          (a.values ?? "")
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number),
        );
        break;
      case "fecomponenttransfer":
        out = componentTransfer(input(a.in), p.funcs ?? {});
        break;
      case "fecomposite":
        out = composite(input(a.in), input(a.in2), a.operator ?? "over", [
          num(a.k1, 0),
          num(a.k2, 0),
          num(a.k3, 0),
          num(a.k4, 0),
        ]);
        break;
      case "femerge":
        // each node over the ones before it
        out = blank(W, H);
        for (const n of p.nodes ?? []) out = overRaster(input(n), out);
        break;
      case "feblend":
        out = blend(input(a.in), input(a.in2), a.mode ?? "normal");
        break;
      case "femorphology": {
        const [rx, ry] = pair(a.radius, 0);
        out = morphology(input(a.in), a.operator === "dilate", rx / run.unit[0], ry / run.unit[1]);
        break;
      }
      case "fedropshadow": {
        const src = input(a.in);
        const [sx, sy] = pair(a.stddeviation, 2);
        const shadowAlpha = offset(
          blur(alphaOnly(src), sx / run.unit[0], sy / run.unit[1]),
          num(a.dx, 2) / run.unit[0],
          num(a.dy, 2) / run.unit[1],
        );
        const colour = composite(
          flood(W, H, space(p.flood ?? [0, 0, 0, 1]), region),
          shadowAlpha,
          "in",
        );
        out = overRaster(src, colour);
        break;
      }
      default:
        throw new Error(`the filter primitive <${p.tag}>`);
    }
    out = cut(out, region);
    last = out;
    if (a.result) results.set(a.result, out);
  }
  return cut(run.linear ? convert(last, false) : last, run.region);
}
