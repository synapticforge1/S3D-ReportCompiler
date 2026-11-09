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
  /** The lighting primitives' light, positions in USER units (task 18 8k). */
  light?: Light;
  /** `lighting-color`, straight RGB in sRGB 0-1. */
  lightColour?: number[];
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
  /** User space at a position of the raster, pixel corners at integers (task 18 8k). */
  toUser?: (i: number, j: number) => number[];
  /** What an feImage paints, a raster of the run's size (premultiplied sRGB), or null. */
  image?: (p: Primitive) => Raster | null;
  /** Chrome's device pixels a pixel of this raster spans (feTile snaps to them). */
  device?: number;
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

/**
 * Everything outside a pixel region made transparent -- the region rounded OUT to whole pixels, as
 * Skia's crop rounds it (task 18 8k: a centre test dropped a partly covered edge row, 182 pixels of
 * Chrome's turbulence).
 */
function cut(r: Raster, region: number[]): Raster {
  const out = blank(r.width, r.height);
  const x0 = Math.floor(region[0] + 1e-6);
  const y0 = Math.floor(region[1] + 1e-6);
  const x1 = Math.ceil(region[2] - 1e-6);
  const y1 = Math.ceil(region[3] - 1e-6);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      const k = 4 * (y * r.width + x);
      for (let c = 0; c < 4; c++) out.data[k + c] = r.data[k + c];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// task 18 8k: the rest of Filter Effects 1's primitives
// ---------------------------------------------------------------------------

/**
 * feTurbulence's noise, the specification's reference algorithm (Filter Effects 1 § 15.27, the
 * SVG 1.1 code): a lattice and gradients from its seeded generator, `noise2`, octaves summed.
 */
export class Turbulence {
  private lattice = new Int32Array(0x200 + 2);
  private gradient: Float64Array[][] = [];
  constructor(seed: number) {
    const B = 0x100;
    const [m, a, q, r] = [2147483647, 16807, 127773, 2836];
    let s = Math.trunc(seed);
    if (s <= 0) s = -(s % (m - 1)) + 1;
    if (s > m - 1) s = m - 1;
    const rand = () => {
      s = a * (s % q) - r * Math.trunc(s / q);
      if (s <= 0) s += m;
      return s;
    };
    this.gradient = Array.from({ length: 4 }, () =>
      Array.from({ length: B + B + 2 }, () => new Float64Array(2)),
    );
    let i = 0;
    for (let k = 0; k < 4; k++) {
      for (i = 0; i < B; i++) {
        this.lattice[i] = i;
        const g = this.gradient[k][i];
        for (let j = 0; j < 2; j++) g[j] = ((rand() % (B + B)) - B) / B;
        const len = Math.sqrt(g[0] * g[0] + g[1] * g[1]);
        g[0] /= len;
        g[1] /= len;
      }
    }
    while (--i) {
      const k = this.lattice[i];
      const j = rand() % B;
      this.lattice[i] = this.lattice[j];
      this.lattice[j] = k;
    }
    for (i = 0; i < B + 2; i++) {
      this.lattice[B + i] = this.lattice[i];
      for (let k = 0; k < 4; k++) {
        this.gradient[k][B + i][0] = this.gradient[k][i][0];
        this.gradient[k][B + i][1] = this.gradient[k][i][1];
      }
    }
  }
  private noise2(ch: number, vx: number, vy: number, st: number[] | null): number {
    const [BM, N] = [0xff, 0x1000];
    let t = vx + N;
    let bx0 = Math.trunc(t) & BM;
    let bx1 = (bx0 + 1) & BM;
    const rx0 = t - Math.trunc(t);
    const rx1 = rx0 - 1;
    t = vy + N;
    let by0 = Math.trunc(t) & BM;
    let by1 = (by0 + 1) & BM;
    const ry0 = t - Math.trunc(t);
    const ry1 = ry0 - 1;
    if (st) {
      const [w, h, wx, wy] = st;
      if (bx0 >= wx) bx0 -= w;
      if (bx1 >= wx) bx1 -= w;
      if (by0 >= wy) by0 -= h;
      if (by1 >= wy) by1 -= h;
    }
    bx0 &= BM;
    bx1 &= BM;
    by0 &= BM;
    by1 &= BM;
    const L = this.lattice;
    const [i, j] = [L[bx0], L[bx1]];
    const [b00, b10, b01, b11] = [L[i + by0], L[j + by0], L[i + by1], L[j + by1]];
    const curve = (x: number) => x * x * (3 - 2 * x);
    const lerp = (x: number, p: number, q2: number) => p + x * (q2 - p);
    const [sx, sy] = [curve(rx0), curve(ry0)];
    const G = this.gradient[ch];
    const a = lerp(sx, rx0 * G[b00][0] + ry0 * G[b00][1], rx1 * G[b10][0] + ry0 * G[b10][1]);
    const b = lerp(sx, rx0 * G[b01][0] + ry1 * G[b01][1], rx1 * G[b11][0] + ry1 * G[b11][1]);
    return lerp(sy, a, b);
  }
  /**
   * One channel's sum at a point of user space: fractal noise, or turbulence (absolute values).
   * `stitch`, when stitching, is the lattice width and height a tile spans at the (already
   * fitted) frequencies; the wrap points are counted from the noise's origin, as Skia counts them
   * (task 18 8k, measured: Skia's `StitchData` sets wrapX = 4096 + width, where the specification
   * adds the tile's x -- the specification's form FAILED Chrome's stitched noise).
   */
  value(
    ch: number,
    x: number,
    y: number,
    freq: number[],
    octaves: number,
    fractal: boolean,
    stitch: number[] | null,
  ): number {
    const [fx, fy] = freq;
    let st: number[] | null = stitch
      ? [stitch[0], stitch[1], 0x1000 + stitch[0], 0x1000 + stitch[1]]
      : null;
    let [vx, vy] = [x * fx, y * fy];
    let [sum, ratio] = [0, 1];
    for (let o = 0; o < octaves; o++) {
      const n = this.noise2(ch, vx, vy, st);
      sum += (fractal ? n : Math.abs(n)) / ratio;
      vx *= 2;
      vy *= 2;
      ratio *= 2;
      // stitching doubles with the octave: width, height, and their wrap points
      if (st) st = [st[0] * 2, st[1] * 2, 2 * st[2] - 0x1000, 2 * st[3] - 0x1000];
    }
    return sum;
  }
}

/**
 * feTurbulence over a raster whose pixel centres map to user space by `toUser` (x, y of pixel
 * column i, row j); straight RGBA from the four channels, premultiplied (Filter Effects 1 § 15.27).
 */
export function turbulence(
  width: number,
  height: number,
  toUser: (i: number, j: number) => number[],
  freq: number[],
  octaves: number,
  seed: number,
  fractal: boolean,
  stitch: number[] | null,
): Raster {
  const t = new Turbulence(seed);
  const out = blank(width, height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const [x, y] = toUser(i + 0.5, j + 0.5);
      const v = [0, 1, 2, 3].map((ch) => {
        const s = t.value(ch, x, y, freq, octaves, fractal, stitch);
        return Math.max(0, Math.min(1, fractal ? (s + 1) / 2 : s));
      });
      out.data.set([v[0] * v[3], v[1] * v[3], v[2] * v[3], v[3]], 4 * (j * width + i));
    }
  }
  return out;
}

/**
 * feDisplacementMap: `src` sampled at each pixel displaced by `scale` x (channel - 0.5) of `map`.
 * `doubt` (given) is marked where the map cannot say which pixel is read: its colour channels are
 * read unpremultiplied, so one 8-bit level of the map moves the point by scale / (255 x alpha) --
 * the whole range where alpha is near nothing -- and Chrome's 8-bit map may differ from this
 * one's by a level (measured, task 18 8k: 40 pixels, each where the map's alpha was 0 to 3 of
 * 255). Such a pixel is doubtful only if the source differs within that reach.
 */
export function displacement(
  src: Raster,
  map: Raster,
  sx: number,
  sy: number,
  xc: number,
  yc: number,
  doubt?: Uint8Array,
): Raster {
  const out = blank(src.width, src.height);
  const at = (x: number, y: number, c: number) =>
    x < 0 || y < 0 || x >= src.width || y >= src.height ? 0 : src.data[4 * (y * src.width + x) + c];
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const k = 4 * (y * src.width + x);
      const a = map.data[k + 3];
      const ch = (c: number) => (c === 3 ? a : a > 0 ? map.data[k + c] / a : 0);
      const px = x + sx * (ch(xc) - 0.5);
      const py = y + sy * (ch(yc) - 0.5);
      const [x0, y0] = [Math.floor(px), Math.floor(py)];
      for (let c = 0; c < 4; c++) out.data[k + c] = at(x0, y0, c);
      if (!doubt) continue;
      // one level of the map, in pixels moved (at most the whole range, scale / 2 each way)
      const reach = (s: number, c: number) =>
        Math.min(
          Math.abs(s) / 2,
          c === 3 ? Math.abs(s) / 255 : Math.abs(s) / (255 * Math.max(a, 1 / 255)),
        );
      const [ex, ey] = [reach(sx, xc), reach(sy, yc)];
      const lo = [Math.floor(px - ex), Math.floor(py - ey)];
      const hi = [Math.floor(px + ex), Math.floor(py + ey)];
      search: for (let v = lo[1]; v <= hi[1]; v++)
        for (let u = lo[0]; u <= hi[0]; u++)
          for (let c = 0; c < 4; c++)
            if (Math.abs(at(u, v, c) - at(x0, y0, c)) > 12 / 255) {
              doubt[y * src.width + x] = 1;
              break search;
            }
    }
  }
  return out;
}

/** feConvolveMatrix, in pixels (Filter Effects 1 § 15.13): the kernel applied rotated, edges by mode. */
export function convolve(
  r: Raster,
  order: number[],
  kernel: number[],
  divisor: number,
  bias: number,
  target: number[],
  edge: string,
  preserveAlpha: boolean,
): Raster {
  const [ox, oy] = order;
  const out = blank(r.width, r.height);
  const sample = (x: number, y: number, c: number) => {
    let [xx, yy] = [x, y];
    if (edge === "wrap") {
      xx = ((xx % r.width) + r.width) % r.width;
      yy = ((yy % r.height) + r.height) % r.height;
    } else if (edge === "duplicate") {
      xx = Math.max(0, Math.min(r.width - 1, xx));
      yy = Math.max(0, Math.min(r.height - 1, yy));
    } else if (xx < 0 || yy < 0 || xx >= r.width || yy >= r.height) return 0;
    const k = 4 * (yy * r.width + xx);
    if (!preserveAlpha) return r.data[k + c];
    const a = r.data[k + 3];
    return c === 3 ? a : a > 0 ? r.data[k + c] / a : 0;
  };
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const k = 4 * (y * r.width + x);
      const v = [0, 0, 0, 0];
      for (let c = 0; c < (preserveAlpha ? 3 : 4); c++) {
        let s = 0;
        for (let j = 0; j < oy; j++)
          for (let i = 0; i < ox; i++)
            s +=
              sample(x - target[0] + i, y - target[1] + j, c) *
              kernel[(oy - 1 - j) * ox + (ox - 1 - i)];
        v[c] = s / divisor + bias * (preserveAlpha ? 1 : r.data[k + 3]);
      }
      if (preserveAlpha) {
        const a = r.data[k + 3];
        for (let c = 0; c < 3; c++) out.data[k + c] = Math.max(0, Math.min(1, v[c])) * a;
        out.data[k + 3] = a;
      } else {
        out.data[k + 3] = Math.max(0, Math.min(1, v[3]));
        for (let c = 0; c < 3; c++) out.data[k + c] = Math.max(0, Math.min(out.data[k + 3], v[c]));
      }
    }
  }
  return out;
}

/** A light for the lighting primitives (Filter Effects 1 § 15.15-15.17), positions in pixels. */
export type Light =
  | { kind: "distant"; azimuth: number; elevation: number }
  | { kind: "point"; x: number; y: number; z: number }
  | {
      kind: "spot";
      x: number;
      y: number;
      z: number;
      at: number[];
      exponent: number;
      cone: number | null;
    };

/**
 * feDiffuseLighting and feSpecularLighting: the alpha as a surface (times `surfaceScale`), its
 * normal by the specification's Sobel kernels (edges and corners by their own), lit by `light`
 * in `colour` (linear or sRGB as the filter works); diffuse is opaque, specular's alpha the most
 * of its colour.
 */
export function lighting(
  r: Raster,
  specular: boolean,
  surfaceScale: number,
  constant: number,
  exponent: number,
  colour: number[],
  light: Light,
): Raster {
  const [W, H] = [r.width, r.height];
  const A = (x: number, y: number) =>
    r.data[4 * (Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) + 3];
  const out = blank(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // The specification's Sobel normal and its border table, as one rule: the weighted
      // differences of the rows (columns) there are -- weight 2 for its own, 1 for each other --
      // over their weights' sum, doubled where the difference is one-sided (inside 1/4, a border
      // row 1/3, a border column 1/2, a corner 2/3).
      const [left, right, up, down] = [x > 0, x < W - 1, y > 0, y < H - 1];
      const across = (dy: number) => A(right ? x + 1 : x, y + dy) - A(left ? x - 1 : x, y + dy);
      const along = (dx: number) => A(x + dx, down ? y + 1 : y) - A(x + dx, up ? y - 1 : y);
      const rows = [...(up ? [-1] : []), 0, ...(down ? [1] : [])];
      const cols = [...(left ? [-1] : []), 0, ...(right ? [1] : [])];
      const weight = (d: number) => (d === 0 ? 2 : 1);
      const gx =
        ((left && right ? 1 : 2) / rows.reduce((s, d) => s + weight(d), 0)) *
        rows.reduce((s, d) => s + weight(d) * across(d), 0);
      const gy =
        ((up && down ? 1 : 2) / cols.reduce((s, d) => s + weight(d), 0)) *
        cols.reduce((s, d) => s + weight(d) * along(d), 0);
      const nx = -surfaceScale * gx;
      const ny = -surfaceScale * gy;
      const nlen = Math.hypot(nx, ny, 1);
      const N = [nx / nlen, ny / nlen, 1 / nlen];
      const z = surfaceScale * A(x, y);
      let L: number[];
      let Lc = colour;
      if (light.kind === "distant") {
        const [az, el] = [(light.azimuth * Math.PI) / 180, (light.elevation * Math.PI) / 180];
        L = [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)];
      } else {
        const d = [light.x - (x + 0.5), light.y - (y + 0.5), light.z - z];
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        L = d.map((v) => v / len);
        if (light.kind === "spot") {
          const s = [light.at[0] - light.x, light.at[1] - light.y, light.at[2] - light.z];
          const sl = Math.hypot(s[0], s[1], s[2]) || 1;
          const minusLdotS = -(L[0] * s[0] + L[1] * s[1] + L[2] * s[2]) / sl;
          // Skia's cone: cut at its angle, faded over the last 0.016 of its cosine (antialiased)
          const outer = light.cone === null ? -1 : Math.cos((light.cone * Math.PI) / 180);
          let f = minusLdotS > 0 && minusLdotS >= outer ? minusLdotS ** light.exponent : 0;
          if (light.cone !== null && minusLdotS < outer + 0.016)
            f *= Math.max(0, (minusLdotS - outer) / 0.016);
          Lc = colour.map((c) => c * f);
        }
      }
      let rgb: number[];
      let a: number;
      if (!specular) {
        const ndl = Math.max(0, N[0] * L[0] + N[1] * L[1] + N[2] * L[2]);
        rgb = Lc.map((c) => Math.min(1, constant * ndl * c));
        a = 1;
      } else {
        const Hh = [L[0], L[1], L[2] + 1];
        const hl = Math.hypot(Hh[0], Hh[1], Hh[2]) || 1;
        const ndh = Math.max(0, (N[0] * Hh[0] + N[1] * Hh[1] + N[2] * Hh[2]) / hl);
        rgb = Lc.map((c) => Math.min(1, constant * ndh ** exponent * c));
        a = Math.max(...rgb);
      }
      // As premultiplied, both (measured: Chrome's specular pixel is the light's colour at the
      // alpha, so R, G, B with alpha their most is already premultiplied); diffuse is opaque.
      out.data.set([rgb[0], rgb[1], rgb[2], a], 4 * (y * W + x));
    }
  }
  return out;
}

/**
 * feTile: the input's subregion (pixels [x0, y0, x1, y1]) repeated over the raster -- its corner
 * and size rounded to whole DEVICE pixels (`device`: device pixels a raster pixel), as Chrome tiles
 * (task 18 8k, measured: a 10-unit tile repeats every 46 device pixels, 9.92 units).
 */
export function tile(r: Raster, region: number[], device = 1): Raster {
  const snap = (v: number) => Math.round(v * device) / device;
  const [x0, y0] = [snap(region[0]), snap(region[1])];
  const [w, h] = [
    Math.max(1 / device, snap(region[2]) - x0),
    Math.max(1 / device, snap(region[3]) - y0),
  ];
  const out = blank(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      // the pixel's centre, back into the tile, to the source pixel there
      const sx = Math.floor(x0 + ((((x + 0.5 - x0) % w) + w) % w));
      const sy = Math.floor(y0 + ((((y + 0.5 - y0) % h) + h) % h));
      if (sx < 0 || sy < 0 || sx >= r.width || sy >= r.height) continue;
      for (let c = 0; c < 4; c++)
        out.data[4 * (y * r.width + x) + c] = r.data[4 * (sy * r.width + sx) + c];
    }
  }
  return out;
}

/** A light's x, y (pixels) and z as an object. */
function xyz(p: number[], z: number) {
  return { x: p[0], y: p[1], z };
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
  // task 18 8k
  "feturbulence",
  "fedisplacementmap",
  "feconvolvematrix",
  "fediffuselighting",
  "fespecularlighting",
  "fetile",
  "feimage",
]);

/**
 * A filter run on its source graphic (premultiplied, sRGB as rasterised): each primitive's inputs
 * (`SourceGraphic`, `SourceAlpha`, a named result, or the one before), its own operation, cut to
 * its subregion; the last one's result, back in sRGB and cut to the filter region.
 */
export function runFilter(run: FilterRun, sourceSrgb: Raster): Raster & { doubt: Uint8Array } {
  const { width: W, height: H } = sourceSrgb;
  const source = run.linear ? convert(sourceSrgb, true) : sourceSrgb;
  const alphaOnly = (r: Raster) => {
    const out = blank(W, H);
    for (let k = 0; k < W * H; k++) out.data[4 * k + 3] = r.data[4 * k + 3];
    return out;
  };
  const results = new Map<string, Raster>();
  const regions = new Map<string, number[]>();
  /** The pixels whose value this run cannot settle (a displacement's, above). */
  const doubt = new Uint8Array(W * H);
  let last = source;
  let lastRegion = run.region;
  const input = (name: string | undefined) => {
    if (name === undefined || name === "") return last;
    if (name === "SourceGraphic") return source;
    if (name === "SourceAlpha") return alphaOnly(source);
    const r = results.get(name);
    if (!r) throw new Error(`the filter input "${name}"`);
    return r;
  };
  /** An input's subregion in pixels (feTile repeats it). */
  const regionOf = (name: string | undefined) =>
    name === undefined || name === "" ? lastRegion : (regions.get(name) ?? run.region);
  const toUser = run.toUser ?? ((i: number, j: number) => [i * run.unit[0], j * run.unit[1]]);
  // pixels from user space, for a light's place (the raster is axis-aligned to user space)
  const [ox, oy] = toUser(0, 0);
  const fromUser = (x: number, y: number) => [(x - ox) / run.unit[0], (y - oy) / run.unit[1]];
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
  /**
   * A primitive's default subregion (Filter Effects 1 § 9.4): for one with inputs, the union of
   * theirs (`SourceGraphic` and `SourceAlpha` the filter region's); for a generator (flood,
   * turbulence, image), the filter region (task 18 8k: every primitive took the filter region, so
   * an feTile of an offset flood tiled the whole region where Chrome tiles the flood's).
   */
  const defaultRegion = (p: Primitive): number[] => {
    const inputs =
      p.tag === "femerge"
        ? (p.nodes ?? [])
        : p.tag === "fecomposite" || p.tag === "feblend" || p.tag === "fedisplacementmap"
          ? [p.attrs.in, p.attrs.in2]
          : // feTile replicates to fill: the filter region, as generators (§ 9.4's exception)
            ["feflood", "feturbulence", "feimage", "fetile"].includes(p.tag)
            ? []
            : [p.attrs.in];
    if (inputs.length === 0) return run.region;
    const boxes = inputs.map((name) =>
      name === "SourceGraphic" || name === "SourceAlpha" ? run.region : regionOf(name),
    );
    return [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ];
  };
  for (const p of run.primitives) {
    const a = p.attrs;
    const region = p.region ?? defaultRegion(p);
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
      case "feturbulence": {
        let [fx, fy] = pair(a.basefrequency, 0).map((f) => Math.max(0, f));
        let stitch: number[] | null = null;
        if (a.stitchtiles === "stitch") {
          // Skia's stitching (via Blink): the tile -- the subregion -- in device pixels, rounded;
          // each frequency fitted to a whole number of periods in it, the nearer by ratio; the
          // lattice width and height it spans then rounded.
          const [tw, th] = [Math.round(region[2] - region[0]), Math.round(region[3] - region[1])];
          const fit = (f: number, size: number, unit: number) => {
            const perPixel = f * unit;
            if (perPixel === 0 || size <= 0) return f;
            const lo = Math.floor(size * perPixel) / size;
            const hi = Math.ceil(size * perPixel) / size;
            return (lo > 0 && perPixel / lo < hi / perPixel ? lo : hi) / unit;
          };
          fx = fit(fx, tw, run.unit[0]);
          fy = fit(fy, th, run.unit[1]);
          stitch = [Math.round(tw * fx * run.unit[0]), Math.round(th * fy * run.unit[1])];
        }
        // Stitched noise is counted from the tile's corner (its wrap is from the noise origin).
        const [cx, cy] = stitch ? toUser(region[0], region[1]) : [0, 0];
        out = turbulence(
          W,
          H,
          // Chrome's noise lies about 1.6 device pixels on, in x and y, from the pixel's centre
          // `turbulence` takes -- measured, not derived: at three placings of the region (two at
          // fractions of a pixel) every offset from 1.25 to 2.0 matches all six cases, 1.1 and
          // 2.25 do not (turbulence of type "turbulence" 178 -> 0 pixels off, a displacement by
          // noise 54 -> 0); the middle of that window
          (i, j) => {
            const d = 1.625 / (run.device ?? 1);
            const [x, y] = toUser(i + d, j + d);
            return [x - cx, y - cy];
          },
          [fx, fy],
          // Blink caps the octaves at 9 (what 8 bits can show, and one)
          Math.min(9, Math.max(0, Math.trunc(num(a.numoctaves, 1)))),
          num(a.seed, 0),
          a.type === "fractalNoise",
          stitch,
        );
        break;
      }
      case "fedisplacementmap": {
        const channel = (s: string | undefined) => ({ R: 0, G: 1, B: 2, A: 3 })[s ?? "A"] ?? 3;
        const scale = num(a.scale, 0);
        out = displacement(
          input(a.in),
          input(a.in2),
          scale / run.unit[0],
          scale / run.unit[1],
          channel(a.xchannelselector),
          channel(a.ychannelselector),
          doubt,
        );
        break;
      }
      case "feconvolvematrix": {
        const [ox2, oy2] = pair(a.order, 3).map((v) => Math.trunc(v));
        const kernel = (a.kernelmatrix ?? "")
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        if (kernel.length !== ox2 * oy2 || ox2 < 1 || oy2 < 1)
          throw new Error("a convolution's kernel");
        const sum = kernel.reduce((s, v) => s + v, 0);
        out = convolve(
          input(a.in),
          [ox2, oy2],
          kernel,
          num(a.divisor, sum === 0 ? 1 : sum) || 1,
          num(a.bias, 0),
          [num(a.targetx, Math.floor(ox2 / 2)), num(a.targety, Math.floor(oy2 / 2))],
          a.edgemode ?? "duplicate",
          a.preservealpha === "true",
        );
        break;
      }
      case "fediffuselighting":
      case "fespecularlighting": {
        if (!p.light) throw new Error(`a <${p.tag}> with no light`);
        const specular = p.tag === "fespecularlighting";
        const L = p.light;
        // a light's place, in pixels; its height scaled as its x is
        const lit: Light =
          L.kind === "distant"
            ? L
            : L.kind === "point"
              ? { ...L, ...xyz(fromUser(L.x, L.y), L.z / run.unit[0]) }
              : {
                  ...L,
                  ...xyz(fromUser(L.x, L.y), L.z / run.unit[0]),
                  at: [...fromUser(L.at[0], L.at[1]), L.at[2] / run.unit[0]],
                };
        out = lighting(
          input(a.in),
          specular,
          // the surface is in device pixels, its height scaled with them (measured: Chrome's
          // edges match only at surfaceScale times pixels a unit, as its light's height is)
          num(a.surfacescale, 1) / Math.sqrt(run.unit[0] * run.unit[1]),
          num(specular ? a.specularconstant : a.diffuseconstant, 1),
          num(a.specularexponent, 1),
          space([...(p.lightColour ?? [1, 1, 1]), 1]).slice(0, 3),
          lit,
        );
        break;
      }
      case "fetile":
        out = tile(input(a.in), regionOf(a.in), run.device ?? 1);
        break;
      case "feimage": {
        const img = run.image?.(p) ?? null;
        if (!img) throw new Error("an <feImage> this check cannot paint");
        out = run.linear ? convert(img, true) : img;
        break;
      }
      default:
        throw new Error(`the filter primitive <${p.tag}>`);
    }
    out = cut(out, region);
    // each result as Chrome keeps it: 8 bits a channel, premultiplied (task 18 8k)
    for (let q = 0; q < out.data.length; q++) out.data[q] = Math.round(out.data[q] * 255) / 255;
    last = out;
    lastRegion = region;
    if (a.result) {
      results.set(a.result, out);
      regions.set(a.result, region);
    }
  }
  return { ...cut(run.linear ? convert(last, false) : last, run.region), doubt };
}
