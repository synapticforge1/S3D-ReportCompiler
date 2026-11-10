/**
 * WebP decoding for the verification's pixel check (roadmap task 18 group 7b; owner, 2026-11-08:
 * "Can we build a method for verifying the SVG, GIF and WebP file types also?" -- by OWN decoders):
 * the RIFF container; VP8L (lossless); VP8 (lossy), its chroma upsampled as libwebp's "fancy"
 * upsampler does and converted by its fixed-point YUV -> RGB; VP8X with its ALPH chunk. Chrome
 * decodes WebP with libwebp and writes plain pixels into the PDF, so the comparison is the one PNG
 * has -- the decoder must give libwebp's own pixels.
 *
 * Ported from libwebp (read 2026-11-10: src/dec/vp8_dec.c, tree_dec.c, quant_dec.c, frame_dec.c,
 * vp8l_dec.c, alpha_dec.c; src/dsp/dec.c, lossless.c, filters.c, upsampling.c, yuv.h; its constant
 * tables extracted mechanically, never retyped). Pure: no I/O.
 *
 * Portions of this file are derived from libwebp, under this notice:
 *
 * Copyright (c) 2010, Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification, are permitted
 * provided that the following conditions are met:
 *
 *   * Redistributions of source code must retain the above copyright notice, this list of
 *     conditions and the following disclaimer.
 *
 *   * Redistributions in binary form must reproduce the above copyright notice, this list of
 *     conditions and the following disclaimer in the documentation and/or other materials provided
 *     with the distribution.
 *
 *   * Neither the name of Google nor the names of its contributors may be used to endorse or
 *     promote products derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY
 * WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * @module
 */

/** Decoded pixels: RGBA, straight (not premultiplied) alpha, row by row from the top. */
export type WebpPixels = { width: number; height: number; data: Uint8Array };

/**
 * A WebP file's pixels, as libwebp decodes them; throws, by name, on what it cannot read (an
 * animation, a malformed stream).
 *
 * @param bytes the whole file (RIFF ... WEBP)
 */
export function decodeWebp(bytes: Uint8Array): WebpPixels {
  const tag = (p: number) =>
    String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
  const u32 = (p: number) =>
    (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  if (bytes.length < 20 || tag(0) !== "RIFF" || tag(8) !== "WEBP")
    throw new Error("not a WebP file");
  const end = Math.min(bytes.length, 8 + u32(4));
  let vp8: Uint8Array | null = null;
  let vp8l: Uint8Array | null = null;
  let alph: Uint8Array | null = null;
  for (let p = 12; p + 8 <= end;) {
    const t = tag(p);
    const size = u32(p + 4);
    const body = bytes.subarray(p + 8, Math.min(end, p + 8 + size));
    if (t === "VP8 " && !vp8 && !vp8l) vp8 = body;
    else if (t === "VP8L" && !vp8 && !vp8l) vp8l = body;
    else if (t === "ALPH" && !alph) alph = body;
    else if (t === "ANIM" || t === "ANMF") throw new Error("an animated WebP");
    p += 8 + size + (size & 1);
  }
  if (vp8l) return decodeVp8l(vp8l);
  if (vp8) {
    const img = decodeVp8(vp8);
    if (alph) applyAlpha(img, alph);
    return img;
  }
  throw new Error("WebP with no image");
}

// ---------------------------------------------------------------------------------------------
// VP8L (lossless): webp_lossless_bitstream_specification, libwebp vp8l_dec.c / lossless.c
// ---------------------------------------------------------------------------------------------

/** Bits, least significant first. Past the end it reads zeros and says so. */
class LsbReader {
  private readonly buf: Uint8Array;
  private pos = 0;
  private bit = 0;
  eos = false;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.buf.length) {
        this.eos = true;
        return v;
      }
      v |= ((this.buf[this.pos] >> this.bit) & 1) << i;
      if (++this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    return v >>> 0;
  }
}

/** A canonical prefix code, read a bit at a time (the first bit read is the code's highest). */
class PrefixCode {
  /** A code of one symbol takes no bits. */
  private readonly single: number;
  private readonly first: Int32Array; // per length: the first code
  private readonly count: Int32Array; // per length: how many codes
  private readonly offset: Int32Array; // per length: where its symbols start in `symbols`
  private readonly symbols: Int32Array;
  constructor(lengths: number[]) {
    const used = lengths.map((l, s) => [l, s]).filter(([l]) => l > 0);
    if (used.length === 0) throw new Error("WebP: an empty prefix code");
    this.single = used.length === 1 ? used[0][1] : -1;
    this.first = new Int32Array(16);
    this.count = new Int32Array(16);
    this.offset = new Int32Array(16);
    for (const [l] of used) this.count[l]++;
    this.symbols = new Int32Array(used.length);
    let code = 0;
    let at = 0;
    for (let l = 1; l < 16; l++) {
      code = (code + this.count[l - 1]) << 1;
      this.first[l] = code;
      this.offset[l] = at;
      at += this.count[l];
    }
    const next = this.offset.slice();
    for (let s = 0; s < lengths.length; s++)
      if (lengths[s] > 0) this.symbols[next[lengths[s]]++] = s;
  }
  read(br: LsbReader): number {
    if (this.single >= 0) return this.single;
    let code = 0;
    for (let l = 1; l < 16; l++) {
      code = (code << 1) | br.read(1);
      const d = code - this.first[l];
      if (d >= 0 && d < this.count[l]) return this.symbols[this.offset[l] + d];
    }
    throw new Error("WebP: a bad prefix code");
  }
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const CODE_TO_PLANE = [
  0x18, 0x07, 0x17, 0x19, 0x28, 0x06, 0x27, 0x29, 0x16, 0x1a, 0x26, 0x2a, 0x38, 0x05, 0x37, 0x39,
  0x15, 0x1b, 0x36, 0x3a, 0x25, 0x2b, 0x48, 0x04, 0x47, 0x49, 0x14, 0x1c, 0x35, 0x3b, 0x46, 0x4a,
  0x24, 0x2c, 0x58, 0x45, 0x4b, 0x34, 0x3c, 0x03, 0x57, 0x59, 0x13, 0x1d, 0x56, 0x5a, 0x23, 0x2d,
  0x44, 0x4c, 0x55, 0x5b, 0x33, 0x3d, 0x68, 0x02, 0x67, 0x69, 0x12, 0x1e, 0x66, 0x6a, 0x22, 0x2e,
  0x54, 0x5c, 0x43, 0x4d, 0x65, 0x6b, 0x32, 0x3e, 0x78, 0x01, 0x77, 0x79, 0x53, 0x5d, 0x11, 0x1f,
  0x64, 0x6c, 0x42, 0x4e, 0x76, 0x7a, 0x21, 0x2f, 0x75, 0x7b, 0x31, 0x3f, 0x63, 0x6d, 0x52, 0x5e,
  0x00, 0x74, 0x7c, 0x41, 0x4f, 0x10, 0x20, 0x62, 0x6e, 0x30, 0x73, 0x7d, 0x51, 0x5f, 0x40, 0x72,
  0x7e, 0x61, 0x6f, 0x50, 0x71, 0x7f, 0x60, 0x70,
];

function readPrefixCode(br: LsbReader, alphabet: number): PrefixCode {
  const lengths = new Array<number>(alphabet).fill(0);
  if (br.read(1)) {
    // simple: one or two symbols
    const n = br.read(1) + 1;
    const first = br.read(br.read(1) === 0 ? 1 : 8);
    lengths[first] = 1;
    if (n === 2) lengths[br.read(8)] = 1;
    return new PrefixCode(lengths);
  }
  const clLengths = new Array<number>(19).fill(0);
  const num = br.read(4) + 4;
  for (let i = 0; i < num; i++) clLengths[CODE_LENGTH_ORDER[i]] = br.read(3);
  const lengthCode = new PrefixCode(clLengths);
  let max = alphabet;
  if (br.read(1)) {
    const nbits = 2 + 2 * br.read(3);
    max = 2 + br.read(nbits);
    if (max > alphabet) throw new Error("WebP: a code length count past its alphabet");
  }
  let prev = 8;
  let s = 0;
  while (s < alphabet) {
    if (max-- === 0) break;
    const len = lengthCode.read(br);
    if (len < 16) {
      lengths[s++] = len;
      if (len !== 0) prev = len;
    } else {
      const slot = len - 16;
      const repeat = br.read([2, 3, 7][slot]) + [3, 3, 11][slot];
      if (s + repeat > alphabet) throw new Error("WebP: code lengths past the alphabet");
      for (let r = 0; r < repeat; r++) lengths[s++] = len === 16 ? prev : 0;
    }
  }
  return new PrefixCode(lengths);
}

type Transform = { type: number; bits: number; xsize: number; data: Uint32Array };

const subSample = (size: number, bits: number) => (size + (1 << bits) - 1) >> bits;

function copyDistance(sym: number, br: LsbReader): number {
  if (sym < 4) return sym + 1;
  const extra = (sym - 2) >> 1;
  return ((2 + (sym & 1)) << extra) + br.read(extra) + 1;
}

/** One image stream of the format: the main image (level 0) or a sub-image (no transforms). */
function decodeImageStream(
  br: LsbReader,
  xsize: number,
  ysize: number,
  level0: boolean,
  transforms: Transform[],
): Uint32Array {
  let width = xsize;
  if (level0) {
    let seen = 0;
    while (br.read(1)) {
      const type = br.read(2);
      if (seen & (1 << type)) throw new Error("WebP: a transform twice");
      seen |= 1 << type;
      const t: Transform = { type, bits: 0, xsize: width, data: new Uint32Array(0) };
      if (type === 0 || type === 1) {
        t.bits = 2 + br.read(3);
        t.data = decodeImageStream(
          br,
          subSample(width, t.bits),
          subSample(ysize, t.bits),
          false,
          transforms,
        );
      } else if (type === 3) {
        const n = br.read(8) + 1;
        t.bits = n > 16 ? 0 : n > 4 ? 1 : n > 2 ? 2 : 3;
        const raw = decodeImageStream(br, n, 1, false, transforms);
        // the palette is delta-coded, byte by byte; padded black to what its bundling can index
        const map = new Uint32Array(1 << (8 >> t.bits));
        map[0] = raw[0];
        for (let i = 1; i < n; i++) {
          let v = 0;
          for (let c = 0; c < 32; c += 8)
            v |= (((((raw[i] >>> c) & 0xff) + ((map[i - 1] >>> c) & 0xff)) & 0xff) << c) >>> 0;
          map[i] = v >>> 0;
        }
        t.data = map;
        width = subSample(width, t.bits);
      }
      transforms.push(t);
    }
  }
  let cacheBits = 0;
  if (br.read(1)) {
    cacheBits = br.read(4);
    if (cacheBits < 1 || cacheBits > 11) throw new Error("WebP: a bad colour cache");
  }
  // the prefix codes, one group per tile of the meta image (level 0 only)
  let metaBits = 0;
  let meta: Uint32Array | null = null;
  let groups = 1;
  if (level0 && br.read(1)) {
    metaBits = 2 + br.read(3);
    meta = decodeImageStream(
      br,
      subSample(width, metaBits),
      subSample(ysize, metaBits),
      false,
      transforms,
    );
    for (let i = 0; i < meta.length; i++) {
      meta[i] = (meta[i] >>> 8) & 0xffff;
      groups = Math.max(groups, meta[i] + 1);
    }
  }
  const cacheSize = cacheBits > 0 ? 1 << cacheBits : 0;
  const codes: PrefixCode[][] = [];
  for (let g = 0; g < groups; g++)
    codes.push([256 + 24 + cacheSize, 256, 256, 256, 40].map((a) => readPrefixCode(br, a)));
  const cache = new Uint32Array(cacheSize);
  const hashShift = 32 - cacheBits;
  const insert = (argb: number) => {
    if (cacheSize) cache[Math.imul(argb, 0x1e35a7bd) >>> hashShift] = argb;
  };
  const metaW = subSample(width, metaBits);
  const out = new Uint32Array(width * ysize);
  let pos = 0;
  while (pos < out.length) {
    const x = pos % width;
    const y = (pos / width) | 0;
    const group = codes[meta ? meta[(y >> metaBits) * metaW + (x >> metaBits)] : 0];
    const s = group[0].read(br);
    if (s < 256) {
      const r = group[1].read(br);
      const b = group[2].read(br);
      const a = group[3].read(br);
      out[pos] = ((a << 24) | (r << 16) | (s << 8) | b) >>> 0;
      insert(out[pos++]);
    } else if (s < 256 + 24) {
      const length = copyDistance(s - 256, br);
      const code = copyDistance(group[4].read(br), br);
      let dist: number;
      if (code > 120) dist = code - 120;
      else {
        const p = CODE_TO_PLANE[code - 1];
        dist = Math.max(1, (p >> 4) * width + (8 - (p & 0xf)));
      }
      if (dist > pos || pos + length > out.length)
        throw new Error("WebP: a backward reference out of the image");
      for (let i = 0; i < length; i++, pos++) {
        out[pos] = out[pos - dist];
        insert(out[pos]);
      }
    } else {
      const key = s - 280;
      if (key >= cacheSize) throw new Error("WebP: a bad colour cache key");
      out[pos] = cache[key];
      insert(out[pos++]);
    }
    if (br.eos) throw new Error("WebP: the lossless stream ends early");
  }
  return out;
}

// (`a & b` is negative in JavaScript once its top bit is set; the sum taken `>>> 0` is the same
// 32 bits either way)
const average2 = (a: number, b: number) => ((((a ^ b) & 0xfefefefe) >>> 1) + (a & b)) >>> 0;
const clip255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const addPixels = (a: number, b: number) =>
  ((((a & 0xff00ff00) + (b & 0xff00ff00)) & 0xff00ff00) |
    (((a & 0x00ff00ff) + (b & 0x00ff00ff)) & 0x00ff00ff)) >>>
  0;
const channels = (c: number) => [c >>> 24, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff];
const pack = (v: number[]) => ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0;

function predict(mode: number, left: number, t: number, tl: number, tr: number): number {
  switch (mode) {
    case 0:
      return 0xff000000;
    case 1:
      return left;
    case 2:
      return t;
    case 3:
      return tr;
    case 4:
      return tl;
    case 5:
      return average2(average2(left, tr), t);
    case 6:
      return average2(left, tl);
    case 7:
      return average2(left, t);
    case 8:
      return average2(tl, t);
    case 9:
      return average2(t, tr);
    case 10:
      return average2(average2(left, tl), average2(t, tr));
    case 11: {
      // Select(top, left, top-left)
      const [a, b, c] = [channels(t), channels(left), channels(tl)];
      let paMinusPb = 0;
      for (let k = 0; k < 4; k++) paMinusPb += Math.abs(b[k] - c[k]) - Math.abs(a[k] - c[k]);
      return paMinusPb <= 0 ? t : left;
    }
    case 12: {
      const [a, b, c] = [channels(left), channels(t), channels(tl)];
      return pack(a.map((v, k) => clip255(v + b[k] - c[k])));
    }
    case 13: {
      const ave = channels(average2(left, t));
      const c = channels(tl);
      return pack(ave.map((v, k) => clip255(v + Math.trunc((v - c[k]) / 2))));
    }
    default:
      return 0xff000000; // modes 14 and 15 are black, as libwebp has them
  }
}

function inverseTransforms(
  img: Uint32Array,
  width: number,
  height: number,
  transforms: Transform[],
): Uint32Array {
  let data = img;
  for (let i = transforms.length - 1; i >= 0; i--) {
    const t = transforms[i];
    if (t.type === 2) {
      for (let k = 0; k < data.length; k++) {
        const argb = data[k];
        const g = (argb >>> 8) & 0xff;
        const rb = ((argb & 0x00ff00ff) + ((g << 16) | g)) & 0x00ff00ff;
        data[k] = ((argb & 0xff00ff00) | rb) >>> 0;
      }
    } else if (t.type === 0) {
      const w = t.xsize;
      const tiles = subSample(w, t.bits);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < w; x++) {
          const k = y * w + x;
          let pred: number;
          if (y === 0) pred = x === 0 ? 0xff000000 : data[k - 1];
          else if (x === 0) pred = data[k - w];
          else {
            const mode = (t.data[(y >> t.bits) * tiles + (x >> t.bits)] >>> 8) & 0xf;
            pred = predict(mode, data[k - 1], data[k - w], data[k - w - 1], data[k - w + 1]);
          }
          data[k] = addPixels(data[k], pred);
        }
    } else if (t.type === 1) {
      const w = t.xsize;
      const tiles = subSample(w, t.bits);
      const s8 = (v: number) => ((v & 0xff) << 24) >> 24;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < w; x++) {
          const k = y * w + x;
          const m = t.data[(y >> t.bits) * tiles + (x >> t.bits)];
          const [g2r, g2b, r2b] = [s8(m), s8(m >>> 8), s8(m >>> 16)];
          const argb = data[k];
          const green = s8(argb >>> 8);
          let red = (argb >>> 16) & 0xff;
          let blue = argb & 0xff;
          red = (red + ((g2r * green) >> 5)) & 0xff;
          blue = (blue + ((g2b * green) >> 5)) & 0xff;
          blue = (blue + ((r2b * s8(red)) >> 5)) & 0xff;
          data[k] = ((argb & 0xff00ff00) | (red << 16) | blue) >>> 0;
        }
    } else {
      // colour indexing: each packed pixel's green holds 1, 2, 4 or 8 indices
      const w = t.xsize;
      const packedW = subSample(w, t.bits);
      const per = 1 << t.bits;
      const bitsPer = 8 >> t.bits;
      const mask = (1 << bitsPer) - 1;
      const out = new Uint32Array(w * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < w; x++) {
          const packed = (data[y * packedW + (x >> t.bits)] >>> 8) & 0xff;
          out[y * w + x] = t.data[(packed >> ((x & (per - 1)) * bitsPer)) & mask];
        }
      data = out;
    }
  }
  void width;
  return data;
}

/** A VP8L bitstream (its own header, or none for an alpha plane): ARGB pixels. */
function decodeLosslessStream(br: LsbReader, width: number, height: number): Uint32Array {
  const transforms: Transform[] = [];
  const img = decodeImageStream(br, width, height, true, transforms);
  return inverseTransforms(img, width, height, transforms);
}

function decodeVp8l(body: Uint8Array): WebpPixels {
  const br = new LsbReader(body);
  if (br.read(8) !== 0x2f) throw new Error("WebP: a bad lossless signature");
  const width = br.read(14) + 1;
  const height = br.read(14) + 1;
  br.read(1); // alpha used: a hint only
  if (br.read(3) !== 0) throw new Error("WebP: an unknown lossless version");
  const argb = decodeLosslessStream(br, width, height);
  const data = new Uint8Array(width * height * 4);
  for (let k = 0; k < argb.length; k++) {
    const c = argb[k];
    data.set([(c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff, c >>> 24], 4 * k);
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------------------------
// ALPH: the alpha plane of a lossy image (libwebp alpha_dec.c, dsp/filters.c)
// ---------------------------------------------------------------------------------------------

function applyAlpha(img: WebpPixels, chunk: Uint8Array): void {
  const { width, height } = img;
  if (chunk.length < 2) throw new Error("WebP: an empty alpha chunk");
  const method = chunk[0] & 3;
  const filter = (chunk[0] >> 2) & 3;
  // (bits 4-5 say the levels were quantised: a hint for dithering, which Chrome does not ask for)
  if (chunk[0] >> 6 !== 0 || method > 1) throw new Error("WebP: an unknown alpha method");
  let deltas: Uint8Array;
  if (method === 0) {
    deltas = chunk.subarray(1, 1 + width * height);
    if (deltas.length < width * height) throw new Error("WebP: a short alpha plane");
  } else {
    const argb = decodeLosslessStream(new LsbReader(chunk.subarray(1)), width, height);
    deltas = new Uint8Array(width * height);
    for (let k = 0; k < argb.length; k++) deltas[k] = (argb[k] >>> 8) & 0xff;
  }
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const prev = y > 0 ? row - width : -1;
    if (filter === 0) {
      for (let x = 0; x < width; x++) alpha[row + x] = deltas[row + x];
    } else if (filter === 1 || prev < 0) {
      // horizontal; the first row of every filter is horizontal
      let pred = prev < 0 ? 0 : alpha[prev];
      for (let x = 0; x < width; x++) {
        alpha[row + x] = (pred + deltas[row + x]) & 0xff;
        pred = alpha[row + x];
      }
    } else if (filter === 2) {
      for (let x = 0; x < width; x++) alpha[row + x] = (alpha[prev + x] + deltas[row + x]) & 0xff;
    } else {
      let [top, topLeft, left] = [alpha[prev], alpha[prev], alpha[prev]];
      for (let x = 0; x < width; x++) {
        top = alpha[prev + x];
        const g = left + top - topLeft;
        left = (deltas[row + x] + (g < 0 ? 0 : g > 255 ? 255 : g)) & 0xff;
        topLeft = top;
        alpha[row + x] = left;
      }
    }
  }
  for (let k = 0; k < width * height; k++) img.data[4 * k + 3] = alpha[k];
}

// ---------------------------------------------------------------------------------------------
// VP8 (lossy): RFC 6386, libwebp vp8_dec.c, tree_dec.c, quant_dec.c, frame_dec.c, dsp/dec.c
// ---------------------------------------------------------------------------------------------

/**
 * The boolean entropy decoder (RFC 6386 § 7). Past the end it reads zeros and sets `eof`, as
 * libwebp's does: this one holds a byte more ahead than libwebp's, so its first byte past the end
 * is a look-ahead libwebp has not yet asked for, and the second is libwebp's end of data.
 */
class BoolDecoder {
  private readonly buf: Uint8Array;
  private readonly end: number;
  private value: number;
  private range = 255;
  private count = 0;
  private pos: number;
  eof = false;
  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf;
    this.end = end;
    this.pos = start;
    this.value = (this.byte() << 8) | this.byte();
  }
  private byte(): number {
    if (this.pos < this.end) return this.buf[this.pos++];
    if (this.pos++ > this.end) this.eof = true;
    return 0;
  }
  bit(prob: number): number {
    const split = 1 + (((this.range - 1) * prob) >> 8);
    const big = split << 8;
    let b: number;
    if (this.value >= big) {
      b = 1;
      this.range -= split;
      this.value -= big;
    } else {
      b = 0;
      this.range = split;
    }
    while (this.range < 128) {
      this.value <<= 1;
      this.range <<= 1;
      if (++this.count === 8) {
        this.count = 0;
        this.value |= this.byte();
      }
    }
    return b;
  }
  literal(n: number): number {
    let v = 0;
    while (n-- > 0) v |= this.bit(128) << n;
    return v;
  }
  signed(n: number): number {
    const v = this.literal(n);
    return this.bit(128) ? -v : v;
  }
}

const DC_TABLE = [
  4, 5, 6, 7, 8, 9, 10, 10, 11, 12, 13, 14, 15, 16, 17, 17, 18, 19, 20, 20, 21, 21, 22, 22, 23, 23,
  24, 25, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 37, 38, 39, 40, 41, 42, 43, 44, 45,
  46, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68,
  69, 70, 71, 72, 73, 74, 75, 76, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 93,
  95, 96, 98, 100, 101, 102, 104, 106, 108, 110, 112, 114, 116, 118, 122, 124, 126, 128, 130, 132,
  134, 136, 138, 140, 143, 145, 148, 151, 154, 157,
];
const AC_TABLE = [
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53,
  54, 55, 56, 57, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96,
  98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 119, 122, 125, 128, 131, 134, 137, 140, 143, 146,
  149, 152, 155, 158, 161, 164, 167, 170, 173, 177, 181, 185, 189, 193, 197, 201, 205, 209, 213,
  217, 221, 225, 229, 234, 239, 245, 249, 254, 259, 264, 269, 274, 279, 284,
];
const BANDS = [0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 0];
const ZIGZAG = [0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15];
const CAT3456 = [
  [173, 148, 140],
  [176, 155, 140, 135],
  [180, 157, 141, 134, 130],
  [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129],
];
// the 4x4 intra-mode tree, as libwebp's generic parse walks it
const YMODES_INTRA4 = [-0, 1, -1, 2, -2, 3, 4, 6, -3, 5, -4, -5, -6, 7, -7, 8, -8, -9];

const BPS = 32;
const clip8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const mul1 = (a: number) => ((a * 20091) >> 16) + a;
const mul2 = (a: number) => (a * 35468) >> 16;

type Quant = { y1: number[]; y2: number[]; uv: number[] };
type FInfo = { limit: number; ilevel: number; inner: number; hev: number };
type Mb = {
  segment: number;
  skip: number;
  i4x4: boolean;
  imodes: number[];
  uvmode: number;
  coeffs: Int16Array;
  nzY: number;
  nzUV: number;
};

function decodeVp8(body: Uint8Array): WebpPixels {
  if (body.length < 10) throw new Error("WebP: a short lossy frame");
  const bits = body[0] | (body[1] << 8) | (body[2] << 16);
  if (bits & 1) throw new Error("WebP: not a key frame");
  if (!((bits >> 4) & 1)) throw new Error("WebP: a frame not shown");
  const partLen = bits >> 5;
  if (body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a)
    throw new Error("WebP: a bad lossy signature");
  const width = ((body[7] << 8) | body[6]) & 0x3fff;
  const height = ((body[9] << 8) | body[8]) & 0x3fff;
  if (!width || !height) throw new Error("WebP: an empty image");
  const mbW = (width + 15) >> 4;
  const mbH = (height + 15) >> 4;
  const p0 = 10;
  if (p0 + partLen > body.length) throw new Error("WebP: a short first partition");
  const br = new BoolDecoder(body, p0, p0 + partLen);
  br.literal(1); // colour space
  br.literal(1); // clamping type
  // segments (9.3)
  const useSegment = br.bit(128);
  let updateMap = 0;
  let absoluteDelta = 1;
  const quantizer = [0, 0, 0, 0];
  const filterStrength = [0, 0, 0, 0];
  const segProbs = [255, 255, 255];
  if (useSegment) {
    updateMap = br.bit(128);
    if (br.bit(128)) {
      absoluteDelta = br.bit(128);
      for (let s = 0; s < 4; s++) quantizer[s] = br.bit(128) ? br.signed(7) : 0;
      for (let s = 0; s < 4; s++) filterStrength[s] = br.bit(128) ? br.signed(6) : 0;
    }
    if (updateMap) for (let s = 0; s < 3; s++) segProbs[s] = br.bit(128) ? br.literal(8) : 255;
  }
  // filter header (9.4)
  const simple = br.bit(128);
  const level = br.literal(6);
  const sharpness = br.literal(3);
  const useLfDelta = br.bit(128);
  const refLfDelta = [0, 0, 0, 0];
  const modeLfDelta = [0, 0, 0, 0];
  if (useLfDelta && br.bit(128)) {
    for (let i = 0; i < 4; i++) if (br.bit(128)) refLfDelta[i] = br.signed(6);
    for (let i = 0; i < 4; i++) if (br.bit(128)) modeLfDelta[i] = br.signed(6);
  }
  const filterType = level === 0 ? 0 : simple ? 1 : 2;
  // partitions (9.5)
  const numParts = 1 << br.literal(2);
  let at = p0 + partLen;
  const sizesAt = at;
  at += 3 * (numParts - 1);
  const parts: BoolDecoder[] = [];
  for (let p = 0; p < numParts; p++) {
    let size: number;
    if (p < numParts - 1) {
      const s = sizesAt + 3 * p;
      size = Math.min(
        body[s] | (body[s + 1] << 8) | (body[s + 2] << 16),
        Math.max(0, body.length - at),
      );
    } else size = Math.max(0, body.length - at);
    // the last partition must start inside the data (vp8_dec.c ParsePartitions)
    if (p === numParts - 1 && at >= body.length)
      throw new Error("WebP: the lossy frame is cut short");
    parts.push(new BoolDecoder(body, at, at + size));
    at += size;
  }
  // quantisers (9.6)
  const baseQ = br.literal(7);
  const dq = [0, 0, 0, 0, 0].map(() => (br.bit(128) ? br.signed(4) : 0));
  const [dqy1Dc, dqy2Dc, dqy2Ac, dquvDc, dquvAc] = dq;
  const clipQ = (v: number, m: number) => (v < 0 ? 0 : v > m ? m : v);
  const quants: Quant[] = [];
  for (let s = 0; s < 4; s++) {
    let q: number;
    if (useSegment) q = quantizer[s] + (absoluteDelta ? 0 : baseQ);
    else if (s > 0) {
      quants.push(quants[0]);
      continue;
    } else q = baseQ;
    const y2ac = (AC_TABLE[clipQ(q + dqy2Ac, 127)] * 101581) >> 16;
    quants.push({
      y1: [DC_TABLE[clipQ(q + dqy1Dc, 127)], AC_TABLE[clipQ(q, 127)]],
      y2: [DC_TABLE[clipQ(q + dqy2Dc, 127)] * 2, y2ac < 8 ? 8 : y2ac],
      uv: [DC_TABLE[clipQ(q + dquvDc, 117)], AC_TABLE[clipQ(q + dquvAc, 127)]],
    });
  }
  br.bit(128); // refresh entropy probabilities: ignored (one key frame)
  // coefficient probabilities (13)
  const proba = new Uint8Array(4 * 8 * 3 * 11);
  for (let i = 0; i < proba.length; i++)
    proba[i] = br.bit(COEFFS_UPDATE_PROBA[i]) ? br.literal(8) : COEFFS_PROBA0[i];
  const useSkip = br.bit(128);
  const skipP = useSkip ? br.literal(8) : 0;
  // per segment and mode: the loop filter's strengths (frame_dec.c PrecomputeFilterStrengths)
  const fstrengths: FInfo[][] = [];
  for (let s = 0; s < 4; s++) {
    const base = useSegment ? filterStrength[s] + (absoluteDelta ? 0 : level) : level;
    const pair: FInfo[] = [];
    for (let i4 = 0; i4 <= 1; i4++) {
      let lv = base;
      if (useLfDelta) {
        lv += refLfDelta[0];
        if (i4) lv += modeLfDelta[0];
      }
      lv = lv < 0 ? 0 : lv > 63 ? 63 : lv;
      if (lv > 0) {
        let il = lv;
        if (sharpness > 0) {
          il >>= sharpness > 4 ? 2 : 1;
          if (il > 9 - sharpness) il = 9 - sharpness;
        }
        if (il < 1) il = 1;
        pair.push({
          limit: 2 * lv + il,
          ilevel: il,
          inner: i4,
          hev: lv >= 40 ? 2 : lv >= 15 ? 1 : 0,
        });
      } else pair.push({ limit: 0, ilevel: 0, inner: i4, hev: 0 });
    }
    fstrengths.push(pair);
  }
  // the planes, reconstructed unfiltered (prediction reads them), then filtered into the output
  const yW = mbW * 16;
  const uvW = mbW * 8;
  const Y = new Uint8Array(yW * mbH * 16);
  const U = new Uint8Array(uvW * mbH * 8);
  const V = new Uint8Array(uvW * mbH * 8);
  const finfo: FInfo[] = new Array(mbW * mbH);
  // contexts
  const intraT = new Uint8Array(4 * mbW);
  const intraL = new Uint8Array(4);
  const nzTop = new Uint8Array(mbW); // bits: 4 luma, 2 u, 2 v columns (libwebp's mb->nz)
  const nzDcTop = new Uint8Array(mbW);
  // the work buffer, libwebp's yuv_b layout
  const work = new Uint8Array(BPS * 17 + BPS * 9);
  const yOff = BPS * 1 + 8;
  const uOff = yOff + BPS * 16 + BPS;
  const vOff = uOff + 16;
  const topY = new Uint8Array(16 * mbW);
  const topU = new Uint8Array(8 * mbW);
  const topV = new Uint8Array(8 * mbW);
  for (let mbY = 0; mbY < mbH; mbY++) {
    const token = parts[mbY & (numParts - 1)];
    // the row's intra modes (partition 0)
    const mbs: Mb[] = [];
    intraL.fill(0);
    for (let mbX = 0; mbX < mbW; mbX++) {
      const segment = updateMap
        ? !br.bit(segProbs[0])
          ? br.bit(segProbs[1])
          : br.bit(segProbs[2]) + 2
        : 0;
      const skip = useSkip ? br.bit(skipP) : 0;
      const i4x4 = !br.bit(145);
      const imodes: number[] = [];
      const top = intraT.subarray(4 * mbX, 4 * mbX + 4);
      if (!i4x4) {
        const ymode = br.bit(156) ? (br.bit(128) ? 1 : 3) : br.bit(163) ? 2 : 0;
        imodes.push(ymode);
        top.fill(ymode);
        intraL.fill(ymode);
      } else {
        for (let y = 0; y < 4; y++) {
          let ymode = intraL[y];
          for (let x = 0; x < 4; x++) {
            const base = (top[x] * 10 + ymode) * 9;
            let i = YMODES_INTRA4[br.bit(BMODES_PROBA[base])];
            while (i > 0) i = YMODES_INTRA4[2 * i + br.bit(BMODES_PROBA[base + i])];
            ymode = -i;
            top[x] = ymode;
          }
          for (let x = 0; x < 4; x++) imodes.push(top[x]);
          intraL[y] = ymode;
        }
      }
      const uvmode = !br.bit(142) ? 0 : !br.bit(114) ? 2 : br.bit(183) ? 1 : 3;
      mbs.push({
        segment,
        skip,
        i4x4,
        imodes,
        uvmode,
        coeffs: new Int16Array(384),
        nzY: 0,
        nzUV: 0,
      });
    }
    if (br.eof) throw new Error("WebP: the first partition ends early");
    // the row's residuals (its token partition)
    let nzLeft = 0;
    let nzDcLeft = 0;
    for (let mbX = 0; mbX < mbW; mbX++) {
      const mb = mbs[mbX];
      let skip = useSkip ? mb.skip : 0;
      if (!skip) {
        const r = parseResiduals(
          token,
          proba,
          quants[mb.segment],
          mb,
          nzTop[mbX],
          nzDcTop[mbX],
          nzLeft,
          nzDcLeft,
        );
        nzTop[mbX] = r.tnz;
        nzLeft = r.lnz;
        if (!mb.i4x4) {
          nzDcTop[mbX] = r.dcNz;
          nzDcLeft = r.dcNz;
        }
        skip = mb.nzY === 0 && mb.nzUV === 0 ? 1 : 0;
      } else {
        nzTop[mbX] = 0;
        nzLeft = 0;
        if (!mb.i4x4) {
          nzDcTop[mbX] = 0;
          nzDcLeft = 0;
        }
        mb.nzY = 0;
        mb.nzUV = 0;
      }
      if (filterType > 0) {
        const f = fstrengths[mb.segment][mb.i4x4 ? 1 : 0];
        finfo[mbY * mbW + mbX] = { ...f, inner: f.inner | (skip ? 0 : 1) };
      }
      if (token.eof) throw new Error("WebP: the lossy frame ends early");
    }
    // reconstruct the row (frame_dec.c ReconstructRow)
    for (let j = 0; j < 16; j++) work[yOff + j * BPS - 1] = 129;
    for (let j = 0; j < 8; j++) {
      work[uOff + j * BPS - 1] = 129;
      work[vOff + j * BPS - 1] = 129;
    }
    if (mbY > 0) {
      work[yOff - 1 - BPS] = 129;
      work[uOff - 1 - BPS] = 129;
      work[vOff - 1 - BPS] = 129;
    } else {
      work.fill(127, yOff - BPS - 1, yOff - BPS - 1 + 21);
      work.fill(127, uOff - BPS - 1, uOff - BPS - 1 + 9);
      work.fill(127, vOff - BPS - 1, vOff - BPS - 1 + 9);
    }
    for (let mbX = 0; mbX < mbW; mbX++) {
      const mb = mbs[mbX];
      if (mbX > 0) {
        for (let j = -1; j < 16; j++)
          work.copyWithin(yOff + j * BPS - 4, yOff + j * BPS + 12, yOff + j * BPS + 16);
        for (let j = -1; j < 8; j++) {
          work.copyWithin(uOff + j * BPS - 4, uOff + j * BPS + 4, uOff + j * BPS + 8);
          work.copyWithin(vOff + j * BPS - 4, vOff + j * BPS + 4, vOff + j * BPS + 8);
        }
      }
      if (mbY > 0) {
        work.set(topY.subarray(16 * mbX, 16 * mbX + 16), yOff - BPS);
        work.set(topU.subarray(8 * mbX, 8 * mbX + 8), uOff - BPS);
        work.set(topV.subarray(8 * mbX, 8 * mbX + 8), vOff - BPS);
      }
      let nz = mb.nzY;
      if (mb.i4x4) {
        const tr = yOff - BPS + 16;
        if (mbY > 0) {
          if (mbX >= mbW - 1) work.fill(topY[16 * mbX + 15], tr, tr + 4);
          else work.set(topY.subarray(16 * (mbX + 1), 16 * (mbX + 1) + 4), tr);
        }
        for (const r of [4, 8, 12]) work.copyWithin(tr + r * BPS, tr, tr + 4);
        for (let n = 0; n < 16; n++, nz = (nz << 2) >>> 0) {
          const dst = yOff + (n & 3) * 4 + (n >> 2) * 4 * BPS;
          predLuma4(work, dst, mb.imodes[n]);
          doTransform(nz, mb.coeffs, n * 16, work, dst);
        }
      } else {
        predLuma16(work, yOff, checkMode(mbX, mbY, mb.imodes[0]));
        if (nz !== 0)
          for (let n = 0; n < 16; n++, nz = (nz << 2) >>> 0)
            doTransform(nz, mb.coeffs, n * 16, work, yOff + (n & 3) * 4 + (n >> 2) * 4 * BPS);
      }
      const uvMode = checkMode(mbX, mbY, mb.uvmode);
      predChroma8(work, uOff, uvMode);
      predChroma8(work, vOff, uvMode);
      doUVTransform(mb.nzUV >>> 0, mb.coeffs, 16 * 16, work, uOff);
      doUVTransform(mb.nzUV >>> 8, mb.coeffs, 20 * 16, work, vOff);
      if (mbY < mbH - 1) {
        topY.set(work.subarray(yOff + 15 * BPS, yOff + 15 * BPS + 16), 16 * mbX);
        topU.set(work.subarray(uOff + 7 * BPS, uOff + 7 * BPS + 8), 8 * mbX);
        topV.set(work.subarray(vOff + 7 * BPS, vOff + 7 * BPS + 8), 8 * mbX);
      }
      for (let j = 0; j < 16; j++)
        Y.set(work.subarray(yOff + j * BPS, yOff + j * BPS + 16), (mbY * 16 + j) * yW + mbX * 16);
      for (let j = 0; j < 8; j++) {
        U.set(work.subarray(uOff + j * BPS, uOff + j * BPS + 8), (mbY * 8 + j) * uvW + mbX * 8);
        V.set(work.subarray(vOff + j * BPS, vOff + j * BPS + 8), (mbY * 8 + j) * uvW + mbX * 8);
      }
    }
  }
  // the loop filter, macroblock by macroblock in raster order (frame_dec.c DoFilter)
  if (filterType > 0)
    for (let mbY = 0; mbY < mbH; mbY++)
      for (let mbX = 0; mbX < mbW; mbX++) {
        const f = finfo[mbY * mbW + mbX];
        if (f.limit === 0) continue;
        const yp = mbY * 16 * yW + mbX * 16;
        if (filterType === 1) {
          if (mbX > 0) simpleH16(Y, yp, yW, f.limit + 4);
          if (f.inner) for (let k = 1; k < 4; k++) simpleH16(Y, yp + 4 * k, yW, f.limit);
          if (mbY > 0) simpleV16(Y, yp, yW, f.limit + 4);
          if (f.inner) for (let k = 1; k < 4; k++) simpleV16(Y, yp + 4 * k * yW, yW, f.limit);
        } else {
          const up = mbY * 8 * uvW + mbX * 8;
          if (mbX > 0) {
            filterLoop26(Y, yp, 1, yW, 16, f.limit + 4, f.ilevel, f.hev);
            filterLoop26(U, up, 1, uvW, 8, f.limit + 4, f.ilevel, f.hev);
            filterLoop26(V, up, 1, uvW, 8, f.limit + 4, f.ilevel, f.hev);
          }
          if (f.inner) {
            for (let k = 1; k < 4; k++)
              filterLoop24(Y, yp + 4 * k, 1, yW, 16, f.limit, f.ilevel, f.hev);
            filterLoop24(U, up + 4, 1, uvW, 8, f.limit, f.ilevel, f.hev);
            filterLoop24(V, up + 4, 1, uvW, 8, f.limit, f.ilevel, f.hev);
          }
          if (mbY > 0) {
            filterLoop26(Y, yp, yW, 1, 16, f.limit + 4, f.ilevel, f.hev);
            filterLoop26(U, up, uvW, 1, 8, f.limit + 4, f.ilevel, f.hev);
            filterLoop26(V, up, uvW, 1, 8, f.limit + 4, f.ilevel, f.hev);
          }
          if (f.inner) {
            for (let k = 1; k < 4; k++)
              filterLoop24(Y, yp + 4 * k * yW, yW, 1, 16, f.limit, f.ilevel, f.hev);
            filterLoop24(U, up + 4 * uvW, uvW, 1, 8, f.limit, f.ilevel, f.hev);
            filterLoop24(V, up + 4 * uvW, uvW, 1, 8, f.limit, f.ilevel, f.hev);
          }
        }
      }
  return toRgb(Y, U, V, yW, uvW, width, height);
}

function checkMode(mbX: number, mbY: number, mode: number): number {
  if (mode !== 0) return mode;
  if (mbX === 0) return mbY === 0 ? 6 : 5;
  return mbY === 0 ? 4 : 0;
}

/** Residuals of one macroblock (vp8_dec.c ParseResiduals); the non-zero contexts it leaves. */
function parseResiduals(
  br: BoolDecoder,
  proba: Uint8Array,
  q: Quant,
  mb: Mb,
  topNz: number,
  topNzDc: number,
  leftNz: number,
  leftNzDc: number,
): { tnz: number; lnz: number; dcNz: number } {
  const dst = mb.coeffs;
  dst.fill(0);
  let first: number;
  let acType: number;
  let dcNz = 0;
  if (!mb.i4x4) {
    const dc = new Int16Array(16);
    const nz = getCoeffs(br, proba, 1, topNzDc + leftNzDc, q.y2, 0, dc, 0);
    dcNz = nz > 0 ? 1 : 0;
    if (nz > 1) transformWht(dc, dst);
    else {
      const dc0 = (dc[0] + 3) >> 3;
      for (let i = 0; i < 256; i += 16) dst[i] = dc0;
    }
    first = 1;
    acType = 0;
  } else {
    first = 0;
    acType = 3;
  }
  let tnz = topNz & 0x0f;
  let lnz = leftNz & 0x0f;
  let nonZeroY = 0;
  let off = 0;
  for (let y = 0; y < 4; y++) {
    let l = lnz & 1;
    let nzCoeffs = 0;
    for (let x = 0; x < 4; x++) {
      const ctx = l + (tnz & 1);
      const nz = getCoeffs(br, proba, acType, ctx, q.y1, first, dst, off);
      l = nz > first ? 1 : 0;
      tnz = (tnz >> 1) | (l << 7);
      nzCoeffs = nzCodeBits(nzCoeffs, nz, dst[off] !== 0 ? 1 : 0);
      off += 16;
    }
    tnz >>= 4;
    lnz = (lnz >> 1) | (l << 7);
    nonZeroY = ((nonZeroY << 8) | nzCoeffs) >>> 0;
  }
  let outT = tnz;
  let outL = lnz >> 4;
  let nonZeroUV = 0;
  for (let ch = 0; ch < 4; ch += 2) {
    let nzCoeffs = 0;
    let t = topNz >> (4 + ch);
    let lf = leftNz >> (4 + ch);
    for (let y = 0; y < 2; y++) {
      let l = lf & 1;
      for (let x = 0; x < 2; x++) {
        const ctx = l + (t & 1);
        const nz = getCoeffs(br, proba, 2, ctx, q.uv, 0, dst, off);
        l = nz > 0 ? 1 : 0;
        t = (t >> 1) | (l << 3);
        nzCoeffs = nzCodeBits(nzCoeffs, nz, dst[off] !== 0 ? 1 : 0);
        off += 16;
      }
      t >>= 2;
      lf = (lf >> 1) | (l << 5);
    }
    nonZeroUV |= nzCoeffs << (4 * ch);
    outT |= (t << 4) << ch;
    outL |= (lf & 0xf0) << ch;
  }
  mb.nzY = nonZeroY;
  mb.nzUV = nonZeroUV;
  return { tnz: outT & 0xff, lnz: outL & 0xff, dcNz };
}

const nzCodeBits = (nzCoeffs: number, nz: number, dcNz: number) =>
  ((nzCoeffs << 2) | (nz > 3 ? 3 : nz > 1 ? 2 : dcNz)) >>> 0;

/** One block's coefficients (vp8_dec.c GetCoeffs): the last non-zero position plus one. */
function getCoeffs(
  br: BoolDecoder,
  proba: Uint8Array,
  type: number,
  ctx: number,
  dq: number[],
  start: number,
  out: Int16Array,
  off: number,
): number {
  const p = (n: number, c: number) => ((type * 8 + BANDS[n]) * 3 + c) * 11;
  let pp = p(start, ctx);
  for (let n = start; n < 16; n++) {
    if (!br.bit(proba[pp])) return n;
    while (!br.bit(proba[pp + 1])) {
      pp = p(++n, 0);
      if (n === 16) return 16;
    }
    let v: number;
    if (!br.bit(proba[pp + 2])) {
      v = 1;
      pp = p(n + 1, 1);
    } else {
      v = largeValue(br, proba, pp);
      pp = p(n + 1, 2);
    }
    out[off + ZIGZAG[n]] = (br.bit(128) ? -v : v) * dq[n > 0 ? 1 : 0];
  }
  return 16;
}

function largeValue(br: BoolDecoder, proba: Uint8Array, pp: number): number {
  if (!br.bit(proba[pp + 3])) {
    if (!br.bit(proba[pp + 4])) return 2;
    return 3 + br.bit(proba[pp + 5]);
  }
  if (!br.bit(proba[pp + 6])) {
    if (!br.bit(proba[pp + 7])) return 5 + br.bit(159);
    return 7 + 2 * br.bit(165) + br.bit(145);
  }
  const bit1 = br.bit(proba[pp + 8]);
  const bit0 = br.bit(proba[pp + 9 + bit1]);
  const cat = 2 * bit1 + bit0;
  let v = 0;
  // libwebp writes this `v += v + bit`: doubled, then the bit
  for (const prob of CAT3456[cat]) v = 2 * v + br.bit(prob);
  return v + 3 + (8 << cat);
}

function transformWht(input: Int16Array, out: Int16Array): void {
  const tmp = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const a0 = input[i] + input[12 + i];
    const a1 = input[4 + i] + input[8 + i];
    const a2 = input[4 + i] - input[8 + i];
    const a3 = input[i] - input[12 + i];
    tmp[i] = a0 + a1;
    tmp[8 + i] = a0 - a1;
    tmp[4 + i] = a3 + a2;
    tmp[12 + i] = a3 - a2;
  }
  for (let i = 0; i < 4; i++) {
    const dc = tmp[i * 4] + 3;
    const a0 = dc + tmp[3 + i * 4];
    const a1 = tmp[1 + i * 4] + tmp[2 + i * 4];
    const a2 = tmp[1 + i * 4] - tmp[2 + i * 4];
    const a3 = dc - tmp[3 + i * 4];
    out[i * 64] = (a0 + a1) >> 3;
    out[i * 64 + 16] = (a3 + a2) >> 3;
    out[i * 64 + 32] = (a0 - a1) >> 3;
    out[i * 64 + 48] = (a3 - a2) >> 3;
  }
}

function store(dst: Uint8Array, at: number, v: number): void {
  dst[at] = clip8(dst[at] + (v >> 3));
}

function transformOne(c: Int16Array, ci: number, dst: Uint8Array, d: number): void {
  const tmp = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    const a = c[ci + i] + c[ci + i + 8];
    const b = c[ci + i] - c[ci + i + 8];
    const cc = mul2(c[ci + i + 4]) - mul1(c[ci + i + 12]);
    const dd = mul1(c[ci + i + 4]) + mul2(c[ci + i + 12]);
    tmp[4 * i] = a + dd;
    tmp[4 * i + 1] = b + cc;
    tmp[4 * i + 2] = b - cc;
    tmp[4 * i + 3] = a - dd;
  }
  for (let i = 0; i < 4; i++) {
    const dc = tmp[i] + 4;
    const a = dc + tmp[i + 8];
    const b = dc - tmp[i + 8];
    const cc = mul2(tmp[i + 4]) - mul1(tmp[i + 12]);
    const dd = mul1(tmp[i + 4]) + mul2(tmp[i + 12]);
    const row = d + i * BPS;
    store(dst, row, a + dd);
    store(dst, row + 1, b + cc);
    store(dst, row + 2, b - cc);
    store(dst, row + 3, a - dd);
  }
}

function transformAc3(c: Int16Array, ci: number, dst: Uint8Array, d: number): void {
  const a = c[ci] + 4;
  const c4 = mul2(c[ci + 4]);
  const d4 = mul1(c[ci + 4]);
  const c1 = mul2(c[ci + 1]);
  const d1 = mul1(c[ci + 1]);
  const row = (y: number, dc: number) => {
    store(dst, d + y * BPS, dc + d1);
    store(dst, d + y * BPS + 1, dc + c1);
    store(dst, d + y * BPS + 2, dc - c1);
    store(dst, d + y * BPS + 3, dc - d1);
  };
  row(0, a + d4);
  row(1, a + c4);
  row(2, a - c4);
  row(3, a - d4);
}

function transformDc(c: Int16Array, ci: number, dst: Uint8Array, d: number): void {
  const dc = c[ci] + 4;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) store(dst, d + i + j * BPS, dc);
}

function doTransform(bits: number, c: Int16Array, ci: number, dst: Uint8Array, d: number): void {
  switch (bits >>> 30) {
    case 3:
      transformOne(c, ci, dst, d);
      break;
    case 2:
      transformAc3(c, ci, dst, d);
      break;
    case 1:
      transformDc(c, ci, dst, d);
      break;
  }
}

function doUVTransform(bits: number, c: Int16Array, ci: number, dst: Uint8Array, d: number): void {
  if (!(bits & 0xff)) return;
  if (bits & 0xaa) {
    transformOne(c, ci, dst, d);
    transformOne(c, ci + 16, dst, d + 4);
    transformOne(c, ci + 32, dst, d + 4 * BPS);
    transformOne(c, ci + 48, dst, d + 4 * BPS + 4);
  } else {
    if (c[ci]) transformDc(c, ci, dst, d);
    if (c[ci + 16]) transformDc(c, ci + 16, dst, d + 4);
    if (c[ci + 32]) transformDc(c, ci + 32, dst, d + 4 * BPS);
    if (c[ci + 48]) transformDc(c, ci + 48, dst, d + 4 * BPS + 4);
  }
}

function trueMotion(b: Uint8Array, d: number, size: number): void {
  const tl = b[d - BPS - 1];
  for (let y = 0; y < size; y++) {
    const left = b[d + y * BPS - 1];
    for (let x = 0; x < size; x++) b[d + y * BPS + x] = clip8(b[d - BPS + x] + left - tl);
  }
}

function fill(b: Uint8Array, d: number, size: number, v: number): void {
  for (let y = 0; y < size; y++) b.fill(v, d + y * BPS, d + y * BPS + size);
}

function predLuma16(b: Uint8Array, d: number, mode: number): void {
  switch (mode) {
    case 0: {
      let dc = 16;
      for (let j = 0; j < 16; j++) dc += b[d - 1 + j * BPS] + b[d + j - BPS];
      fill(b, d, 16, dc >> 5);
      break;
    }
    case 1:
      trueMotion(b, d, 16);
      break;
    case 2:
      for (let j = 0; j < 16; j++) b.copyWithin(d + j * BPS, d - BPS, d - BPS + 16);
      break;
    case 3:
      for (let j = 0; j < 16; j++) b.fill(b[d + j * BPS - 1], d + j * BPS, d + j * BPS + 16);
      break;
    case 4: {
      let dc = 8;
      for (let j = 0; j < 16; j++) dc += b[d - 1 + j * BPS];
      fill(b, d, 16, dc >> 4);
      break;
    }
    case 5: {
      let dc = 8;
      for (let i = 0; i < 16; i++) dc += b[d + i - BPS];
      fill(b, d, 16, dc >> 4);
      break;
    }
    default:
      fill(b, d, 16, 0x80);
  }
}

function predChroma8(b: Uint8Array, d: number, mode: number): void {
  switch (mode) {
    case 0: {
      let dc = 8;
      for (let i = 0; i < 8; i++) dc += b[d + i - BPS] + b[d - 1 + i * BPS];
      fill(b, d, 8, dc >> 4);
      break;
    }
    case 1:
      trueMotion(b, d, 8);
      break;
    case 2:
      for (let j = 0; j < 8; j++) b.copyWithin(d + j * BPS, d - BPS, d - BPS + 8);
      break;
    case 3:
      for (let j = 0; j < 8; j++) b.fill(b[d + j * BPS - 1], d + j * BPS, d + j * BPS + 8);
      break;
    case 4: {
      // no top: the left
      let dc = 4;
      for (let i = 0; i < 8; i++) dc += b[d - 1 + i * BPS];
      fill(b, d, 8, dc >> 3);
      break;
    }
    case 5: {
      // no left: the top
      let dc = 4;
      for (let i = 0; i < 8; i++) dc += b[d + i - BPS];
      fill(b, d, 8, dc >> 3);
      break;
    }
    default:
      fill(b, d, 8, 0x80);
  }
}

function predLuma4(b: Uint8Array, d: number, mode: number): void {
  const avg3 = (x: number, y: number, z: number) => (x + 2 * y + z + 2) >> 2;
  const avg2 = (x: number, y: number) => (x + y + 1) >> 1;
  const set = (x: number, y: number, v: number) => {
    b[d + x + y * BPS] = v;
  };
  const T = (i: number) => b[d + i - BPS]; // top row; -1 is the top-left
  const L = (j: number) => b[d - 1 + j * BPS]; // left column; -1 is the top-left
  switch (mode) {
    case 0: {
      let dc = 4;
      for (let i = 0; i < 4; i++) dc += T(i) + L(i);
      fill(b, d, 4, dc >> 3);
      break;
    }
    case 1:
      trueMotion(b, d, 4);
      break;
    case 2: {
      const vals = [
        avg3(T(-1), T(0), T(1)),
        avg3(T(0), T(1), T(2)),
        avg3(T(1), T(2), T(3)),
        avg3(T(2), T(3), T(4)),
      ];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x, y, vals[x]);
      break;
    }
    case 3: {
      const [A, B, C, D, E] = [L(-1), L(0), L(1), L(2), L(3)];
      const rows = [avg3(A, B, C), avg3(B, C, D), avg3(C, D, E), avg3(D, E, E)];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x, y, rows[y]);
      break;
    }
    case 4: {
      const [I, J, K, Ll, X] = [L(0), L(1), L(2), L(3), T(-1)];
      const [A, B, C, D] = [T(0), T(1), T(2), T(3)];
      set(0, 3, avg3(J, K, Ll));
      const ijk = avg3(I, J, K);
      set(1, 3, ijk);
      set(0, 2, ijk);
      const xij = avg3(X, I, J);
      set(2, 3, xij);
      set(1, 2, xij);
      set(0, 1, xij);
      const axi = avg3(A, X, I);
      set(3, 3, axi);
      set(2, 2, axi);
      set(1, 1, axi);
      set(0, 0, axi);
      const bax = avg3(B, A, X);
      set(3, 2, bax);
      set(2, 1, bax);
      set(1, 0, bax);
      const cba = avg3(C, B, A);
      set(3, 1, cba);
      set(2, 0, cba);
      set(3, 0, avg3(D, C, B));
      break;
    }
    case 5: {
      const [I, J, K, X] = [L(0), L(1), L(2), T(-1)];
      const [A, B, C, D] = [T(0), T(1), T(2), T(3)];
      set(0, 0, avg2(X, A));
      set(1, 2, avg2(X, A));
      set(1, 0, avg2(A, B));
      set(2, 2, avg2(A, B));
      set(2, 0, avg2(B, C));
      set(3, 2, avg2(B, C));
      set(3, 0, avg2(C, D));
      set(0, 3, avg3(K, J, I));
      set(0, 2, avg3(J, I, X));
      set(0, 1, avg3(I, X, A));
      set(1, 3, avg3(I, X, A));
      set(1, 1, avg3(X, A, B));
      set(2, 3, avg3(X, A, B));
      set(2, 1, avg3(A, B, C));
      set(3, 3, avg3(A, B, C));
      set(3, 1, avg3(B, C, D));
      break;
    }
    case 6: {
      const [A, B, C, D, E, F, G, H] = [T(0), T(1), T(2), T(3), T(4), T(5), T(6), T(7)];
      set(0, 0, avg3(A, B, C));
      const bcd = avg3(B, C, D);
      set(1, 0, bcd);
      set(0, 1, bcd);
      const cde = avg3(C, D, E);
      set(2, 0, cde);
      set(1, 1, cde);
      set(0, 2, cde);
      const def = avg3(D, E, F);
      set(3, 0, def);
      set(2, 1, def);
      set(1, 2, def);
      set(0, 3, def);
      const efg = avg3(E, F, G);
      set(3, 1, efg);
      set(2, 2, efg);
      set(1, 3, efg);
      const fgh = avg3(F, G, H);
      set(3, 2, fgh);
      set(2, 3, fgh);
      set(3, 3, avg3(G, H, H));
      break;
    }
    case 7: {
      const [A, B, C, D, E, F, G, H] = [T(0), T(1), T(2), T(3), T(4), T(5), T(6), T(7)];
      set(0, 0, avg2(A, B));
      set(1, 0, avg2(B, C));
      set(0, 2, avg2(B, C));
      set(2, 0, avg2(C, D));
      set(1, 2, avg2(C, D));
      set(3, 0, avg2(D, E));
      set(2, 2, avg2(D, E));
      set(0, 1, avg3(A, B, C));
      set(1, 1, avg3(B, C, D));
      set(0, 3, avg3(B, C, D));
      set(2, 1, avg3(C, D, E));
      set(1, 3, avg3(C, D, E));
      set(3, 1, avg3(D, E, F));
      set(2, 3, avg3(D, E, F));
      set(3, 2, avg3(E, F, G));
      set(3, 3, avg3(F, G, H));
      break;
    }
    case 8: {
      const [I, J, K, Ll, X] = [L(0), L(1), L(2), L(3), T(-1)];
      const [A, B, C] = [T(0), T(1), T(2)];
      set(0, 0, avg2(I, X));
      set(2, 1, avg2(I, X));
      set(0, 1, avg2(J, I));
      set(2, 2, avg2(J, I));
      set(0, 2, avg2(K, J));
      set(2, 3, avg2(K, J));
      set(0, 3, avg2(Ll, K));
      set(3, 0, avg3(A, B, C));
      set(2, 0, avg3(X, A, B));
      set(1, 0, avg3(I, X, A));
      set(3, 1, avg3(I, X, A));
      set(1, 1, avg3(J, I, X));
      set(3, 2, avg3(J, I, X));
      set(1, 2, avg3(K, J, I));
      set(3, 3, avg3(K, J, I));
      set(1, 3, avg3(Ll, K, J));
      break;
    }
    default: {
      const [I, J, K, Ll] = [L(0), L(1), L(2), L(3)];
      set(0, 0, avg2(I, J));
      set(2, 0, avg2(J, K));
      set(0, 1, avg2(J, K));
      set(2, 1, avg2(K, Ll));
      set(0, 2, avg2(K, Ll));
      set(1, 0, avg3(I, J, K));
      set(3, 0, avg3(J, K, Ll));
      set(1, 1, avg3(J, K, Ll));
      set(3, 1, avg3(K, Ll, Ll));
      set(1, 2, avg3(K, Ll, Ll));
      for (const [x, y] of [
        [3, 2],
        [2, 2],
        [0, 3],
        [1, 3],
        [2, 3],
        [3, 3],
      ])
        set(x, y, Ll);
    }
  }
}

// the loop filters (dsp/dec.c), on a plane: `p` the first pixel past the edge, `h` the step
// across it, `v` the step along it
const sclip1 = (v: number) => (v < -128 ? -128 : v > 127 ? 127 : v);
const sclip2 = (v: number) => (v < -16 ? -16 : v > 15 ? 15 : v);

function doFilter2(b: Uint8Array, p: number, s: number): void {
  const [p1, p0, q0, q1] = [b[p - 2 * s], b[p - s], b[p], b[p + s]];
  const a = 3 * (q0 - p0) + sclip1(p1 - q1);
  const a1 = sclip2((a + 4) >> 3);
  const a2 = sclip2((a + 3) >> 3);
  b[p - s] = clip8(p0 + a2);
  b[p] = clip8(q0 - a1);
}

function doFilter4(b: Uint8Array, p: number, s: number): void {
  const [p1, p0, q0, q1] = [b[p - 2 * s], b[p - s], b[p], b[p + s]];
  const a = 3 * (q0 - p0);
  const a1 = sclip2((a + 4) >> 3);
  const a2 = sclip2((a + 3) >> 3);
  const a3 = (a1 + 1) >> 1;
  b[p - 2 * s] = clip8(p1 + a3);
  b[p - s] = clip8(p0 + a2);
  b[p] = clip8(q0 - a1);
  b[p + s] = clip8(q1 - a3);
}

function doFilter6(b: Uint8Array, p: number, s: number): void {
  const [p2, p1, p0, q0, q1, q2] = [
    b[p - 3 * s],
    b[p - 2 * s],
    b[p - s],
    b[p],
    b[p + s],
    b[p + 2 * s],
  ];
  const a = sclip1(3 * (q0 - p0) + sclip1(p1 - q1));
  const a1 = (27 * a + 63) >> 7;
  const a2 = (18 * a + 63) >> 7;
  const a3 = (9 * a + 63) >> 7;
  b[p - 3 * s] = clip8(p2 + a3);
  b[p - 2 * s] = clip8(p1 + a2);
  b[p - s] = clip8(p0 + a1);
  b[p] = clip8(q0 - a1);
  b[p + s] = clip8(q1 - a2);
  b[p + 2 * s] = clip8(q2 - a3);
}

const hev = (b: Uint8Array, p: number, s: number, t: number) =>
  Math.abs(b[p - 2 * s] - b[p - s]) > t || Math.abs(b[p + s] - b[p]) > t;

const needsFilter = (b: Uint8Array, p: number, s: number, t: number) =>
  4 * Math.abs(b[p - s] - b[p]) + Math.abs(b[p - 2 * s] - b[p + s]) <= t;

function needsFilter2(b: Uint8Array, p: number, s: number, t: number, it: number): boolean {
  const [p3, p2, p1, p0, q0, q1, q2, q3] = [
    b[p - 4 * s],
    b[p - 3 * s],
    b[p - 2 * s],
    b[p - s],
    b[p],
    b[p + s],
    b[p + 2 * s],
    b[p + 3 * s],
  ];
  if (4 * Math.abs(p0 - q0) + Math.abs(p1 - q1) > t) return false;
  return (
    Math.abs(p3 - p2) <= it &&
    Math.abs(p2 - p1) <= it &&
    Math.abs(p1 - p0) <= it &&
    Math.abs(q3 - q2) <= it &&
    Math.abs(q2 - q1) <= it &&
    Math.abs(q1 - q0) <= it
  );
}

function simpleV16(b: Uint8Array, p: number, stride: number, thresh: number): void {
  const t2 = 2 * thresh + 1;
  for (let i = 0; i < 16; i++) if (needsFilter(b, p + i, stride, t2)) doFilter2(b, p + i, stride);
}

function simpleH16(b: Uint8Array, p: number, stride: number, thresh: number): void {
  const t2 = 2 * thresh + 1;
  for (let i = 0; i < 16; i++)
    if (needsFilter(b, p + i * stride, 1, t2)) doFilter2(b, p + i * stride, 1);
}

function filterLoop26(
  b: Uint8Array,
  p: number,
  h: number,
  v: number,
  size: number,
  thresh: number,
  ithresh: number,
  hevT: number,
): void {
  const t2 = 2 * thresh + 1;
  for (let i = 0; i < size; i++, p += v)
    if (needsFilter2(b, p, h, t2, ithresh)) {
      if (hev(b, p, h, hevT)) doFilter2(b, p, h);
      else doFilter6(b, p, h);
    }
}

function filterLoop24(
  b: Uint8Array,
  p: number,
  h: number,
  v: number,
  size: number,
  thresh: number,
  ithresh: number,
  hevT: number,
): void {
  const t2 = 2 * thresh + 1;
  for (let i = 0; i < size; i++, p += v)
    if (needsFilter2(b, p, h, t2, ithresh)) {
      if (hev(b, p, h, hevT)) doFilter2(b, p, h);
      else doFilter4(b, p, h);
    }
}

// YUV -> RGB (yuv.h) with libwebp's "fancy" chroma upsampling (upsampling.c, io_dec.c)
const multHi = (v: number, c: number) => (v * c) >> 8;
const clipYuv = (v: number) => ((v & ~16383) === 0 ? v >> 6 : v < 0 ? 0 : 255);

function toRgb(
  Y: Uint8Array,
  U: Uint8Array,
  V: Uint8Array,
  yW: number,
  uvW: number,
  width: number,
  height: number,
): WebpPixels {
  const data = new Uint8Array(width * height * 4);
  const put = (x: number, y: number, yy: number, u: number, v: number) => {
    const k = 4 * (y * width + x);
    const yv = multHi(yy, 19077);
    data[k] = clipYuv(yv + multHi(v, 26149) - 14234);
    data[k + 1] = clipYuv(yv - multHi(u, 6419) - multHi(v, 13320) + 8708);
    data[k + 2] = clipYuv(yv + multHi(u, 33050) - 17685);
    data[k + 3] = 255;
  };
  // one pair of rows: `top` (and `bottom`, or -1), chroma rows `tuv` (above) and `cuv` (current)
  const pair = (top: number, bottom: number, tuv: number, cuv: number) => {
    const at = (row: number, x: number) => [U[row * uvW + x], V[row * uvW + x]];
    let tl = at(tuv, 0);
    let l = at(cuv, 0);
    const edge = (y: number, x: number, a: number[], b: number[]) =>
      put(x, y, Y[y * yW + x], (3 * a[0] + b[0] + 2) >> 2, (3 * a[1] + b[1] + 2) >> 2);
    edge(top, 0, tl, l);
    if (bottom >= 0) edge(bottom, 0, l, tl);
    const last = (width - 1) >> 1;
    for (let x = 1; x <= last; x++) {
      const t = at(tuv, x);
      const c = at(cuv, x);
      const avg = [0, 1].map((k) => tl[k] + t[k] + l[k] + c[k] + 8);
      const diag12 = [0, 1].map((k) => (avg[k] + 2 * (t[k] + l[k])) >> 3);
      const diag03 = [0, 1].map((k) => (avg[k] + 2 * (tl[k] + c[k])) >> 3);
      put(
        2 * x - 1,
        top,
        Y[top * yW + 2 * x - 1],
        (diag12[0] + tl[0]) >> 1,
        (diag12[1] + tl[1]) >> 1,
      );
      put(2 * x, top, Y[top * yW + 2 * x], (diag03[0] + t[0]) >> 1, (diag03[1] + t[1]) >> 1);
      if (bottom >= 0) {
        put(
          2 * x - 1,
          bottom,
          Y[bottom * yW + 2 * x - 1],
          (diag03[0] + l[0]) >> 1,
          (diag03[1] + l[1]) >> 1,
        );
        put(
          2 * x,
          bottom,
          Y[bottom * yW + 2 * x],
          (diag12[0] + c[0]) >> 1,
          (diag12[1] + c[1]) >> 1,
        );
      }
      tl = t;
      l = c;
    }
    if (!(width & 1)) {
      edge(top, width - 1, tl, l);
      if (bottom >= 0) edge(bottom, width - 1, l, tl);
    }
  };
  pair(0, -1, 0, 0);
  let y = 1;
  for (; y + 1 < height; y += 2) pair(y, y + 1, (y - 1) >> 1, (y + 1) >> 1);
  if (y < height) pair(y, -1, (y - 1) >> 1, (y - 1) >> 1);
  return { width, height, data };
}

// ---------------------------------------------------------------------------------------------
// libwebp tree_dec.c tables, extracted mechanically: the default coefficient probabilities and
// their update probabilities ([4 types][8 bands][3 contexts][11]), and the 4x4 intra-mode
// probabilities ([10 top][10 left][9]).
// ---------------------------------------------------------------------------------------------

const COEFFS_PROBA0 = new Uint8Array([
  128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
  128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 253, 136, 254, 255, 228,
  219, 128, 128, 128, 128, 128, 189, 129, 242, 255, 227, 213, 255, 219, 128, 128, 128, 106, 126,
  227, 252, 214, 209, 255, 255, 128, 128, 128, 1, 98, 248, 255, 236, 226, 255, 255, 128, 128, 128,
  181, 133, 238, 254, 221, 234, 255, 154, 128, 128, 128, 78, 134, 202, 247, 198, 180, 255, 219, 128,
  128, 128, 1, 185, 249, 255, 243, 255, 128, 128, 128, 128, 128, 184, 150, 247, 255, 236, 224, 128,
  128, 128, 128, 128, 77, 110, 216, 255, 236, 230, 128, 128, 128, 128, 128, 1, 101, 251, 255, 241,
  255, 128, 128, 128, 128, 128, 170, 139, 241, 252, 236, 209, 255, 255, 128, 128, 128, 37, 116, 196,
  243, 228, 255, 255, 255, 128, 128, 128, 1, 204, 254, 255, 245, 255, 128, 128, 128, 128, 128, 207,
  160, 250, 255, 238, 128, 128, 128, 128, 128, 128, 102, 103, 231, 255, 211, 171, 128, 128, 128,
  128, 128, 1, 152, 252, 255, 240, 255, 128, 128, 128, 128, 128, 177, 135, 243, 255, 234, 225, 128,
  128, 128, 128, 128, 80, 129, 211, 255, 194, 224, 128, 128, 128, 128, 128, 1, 1, 255, 128, 128,
  128, 128, 128, 128, 128, 128, 246, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128, 255, 128, 128,
  128, 128, 128, 128, 128, 128, 128, 128, 198, 35, 237, 223, 193, 187, 162, 160, 145, 155, 62, 131,
  45, 198, 221, 172, 176, 220, 157, 252, 221, 1, 68, 47, 146, 208, 149, 167, 221, 162, 255, 223,
  128, 1, 149, 241, 255, 221, 224, 255, 255, 128, 128, 128, 184, 141, 234, 253, 222, 220, 255, 199,
  128, 128, 128, 81, 99, 181, 242, 176, 190, 249, 202, 255, 255, 128, 1, 129, 232, 253, 214, 197,
  242, 196, 255, 255, 128, 99, 121, 210, 250, 201, 198, 255, 202, 128, 128, 128, 23, 91, 163, 242,
  170, 187, 247, 210, 255, 255, 128, 1, 200, 246, 255, 234, 255, 128, 128, 128, 128, 128, 109, 178,
  241, 255, 231, 245, 255, 255, 128, 128, 128, 44, 130, 201, 253, 205, 192, 255, 255, 128, 128, 128,
  1, 132, 239, 251, 219, 209, 255, 165, 128, 128, 128, 94, 136, 225, 251, 218, 190, 255, 255, 128,
  128, 128, 22, 100, 174, 245, 186, 161, 255, 199, 128, 128, 128, 1, 182, 249, 255, 232, 235, 128,
  128, 128, 128, 128, 124, 143, 241, 255, 227, 234, 128, 128, 128, 128, 128, 35, 77, 181, 251, 193,
  211, 255, 205, 128, 128, 128, 1, 157, 247, 255, 236, 231, 255, 255, 128, 128, 128, 121, 141, 235,
  255, 225, 227, 255, 255, 128, 128, 128, 45, 99, 188, 251, 195, 217, 255, 224, 128, 128, 128, 1, 1,
  251, 255, 213, 255, 128, 128, 128, 128, 128, 203, 1, 248, 255, 255, 128, 128, 128, 128, 128, 128,
  137, 1, 177, 255, 224, 255, 128, 128, 128, 128, 128, 253, 9, 248, 251, 207, 208, 255, 192, 128,
  128, 128, 175, 13, 224, 243, 193, 185, 249, 198, 255, 255, 128, 73, 17, 171, 221, 161, 179, 236,
  167, 255, 234, 128, 1, 95, 247, 253, 212, 183, 255, 255, 128, 128, 128, 239, 90, 244, 250, 211,
  209, 255, 255, 128, 128, 128, 155, 77, 195, 248, 188, 195, 255, 255, 128, 128, 128, 1, 24, 239,
  251, 218, 219, 255, 205, 128, 128, 128, 201, 51, 219, 255, 196, 186, 128, 128, 128, 128, 128, 69,
  46, 190, 239, 201, 218, 255, 228, 128, 128, 128, 1, 191, 251, 255, 255, 128, 128, 128, 128, 128,
  128, 223, 165, 249, 255, 213, 255, 128, 128, 128, 128, 128, 141, 124, 248, 255, 255, 128, 128,
  128, 128, 128, 128, 1, 16, 248, 255, 255, 128, 128, 128, 128, 128, 128, 190, 36, 230, 255, 236,
  255, 128, 128, 128, 128, 128, 149, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128, 1, 226, 255,
  128, 128, 128, 128, 128, 128, 128, 128, 247, 192, 255, 128, 128, 128, 128, 128, 128, 128, 128,
  240, 128, 255, 128, 128, 128, 128, 128, 128, 128, 128, 1, 134, 252, 255, 255, 128, 128, 128, 128,
  128, 128, 213, 62, 250, 255, 255, 128, 128, 128, 128, 128, 128, 55, 93, 255, 128, 128, 128, 128,
  128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128,
  128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 202, 24,
  213, 235, 186, 191, 220, 160, 240, 175, 255, 126, 38, 182, 232, 169, 184, 228, 174, 255, 187, 128,
  61, 46, 138, 219, 151, 178, 240, 170, 255, 216, 128, 1, 112, 230, 250, 199, 191, 247, 159, 255,
  255, 128, 166, 109, 228, 252, 211, 215, 255, 174, 128, 128, 128, 39, 77, 162, 232, 172, 180, 245,
  178, 255, 255, 128, 1, 52, 220, 246, 198, 199, 249, 220, 255, 255, 128, 124, 74, 191, 243, 183,
  193, 250, 221, 255, 255, 128, 24, 71, 130, 219, 154, 170, 243, 182, 255, 255, 128, 1, 182, 225,
  249, 219, 240, 255, 224, 128, 128, 128, 149, 150, 226, 252, 216, 205, 255, 171, 128, 128, 128, 28,
  108, 170, 242, 183, 194, 254, 223, 255, 255, 128, 1, 81, 230, 252, 204, 203, 255, 192, 128, 128,
  128, 123, 102, 209, 247, 188, 196, 255, 233, 128, 128, 128, 20, 95, 153, 243, 164, 173, 255, 203,
  128, 128, 128, 1, 222, 248, 255, 216, 213, 128, 128, 128, 128, 128, 168, 175, 246, 252, 235, 205,
  255, 255, 128, 128, 128, 47, 116, 215, 255, 211, 212, 255, 255, 128, 128, 128, 1, 121, 236, 253,
  212, 214, 255, 255, 128, 128, 128, 141, 84, 213, 252, 201, 202, 255, 219, 128, 128, 128, 42, 80,
  160, 240, 162, 185, 255, 205, 128, 128, 128, 1, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128,
  244, 1, 255, 128, 128, 128, 128, 128, 128, 128, 128, 238, 1, 255, 128, 128, 128, 128, 128, 128,
  128, 128,
]);
const COEFFS_UPDATE_PROBA = new Uint8Array([
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 176, 246, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 223, 241, 252, 255, 255, 255, 255, 255, 255, 255, 255, 249, 253,
  253, 255, 255, 255, 255, 255, 255, 255, 255, 255, 244, 252, 255, 255, 255, 255, 255, 255, 255,
  255, 234, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255, 253, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 246, 254, 255, 255, 255, 255, 255, 255, 255, 255, 239, 253, 254, 255,
  255, 255, 255, 255, 255, 255, 255, 254, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  248, 254, 255, 255, 255, 255, 255, 255, 255, 255, 251, 255, 254, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 253, 254, 255, 255, 255,
  255, 255, 255, 255, 255, 251, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255, 254, 255, 254,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 253, 255, 254, 255, 255, 255, 255, 255, 255,
  250, 255, 254, 255, 254, 255, 255, 255, 255, 255, 255, 254, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 217, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 225, 252, 241, 253, 255, 255, 254, 255, 255, 255,
  255, 234, 250, 241, 250, 253, 255, 253, 254, 255, 255, 255, 255, 254, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 223, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255, 238, 253, 254, 254,
  255, 255, 255, 255, 255, 255, 255, 255, 248, 254, 255, 255, 255, 255, 255, 255, 255, 255, 249,
  254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 253, 255, 255, 255, 255, 255, 255, 255, 255, 255, 247, 254, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 253, 254,
  255, 255, 255, 255, 255, 255, 255, 255, 252, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 254, 255, 255, 255, 255, 255,
  255, 255, 255, 253, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 254, 253, 255, 255, 255, 255, 255, 255, 255, 255, 250, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 186, 251, 250, 255,
  255, 255, 255, 255, 255, 255, 255, 234, 251, 244, 254, 255, 255, 255, 255, 255, 255, 255, 251,
  251, 243, 253, 254, 255, 254, 255, 255, 255, 255, 255, 253, 254, 255, 255, 255, 255, 255, 255,
  255, 255, 236, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255, 251, 253, 253, 254, 254, 255,
  255, 255, 255, 255, 255, 255, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255, 254, 254, 254,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 254, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 248, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 250, 254, 252, 254, 255, 255, 255, 255, 255, 255, 255, 248, 254, 249,
  253, 255, 255, 255, 255, 255, 255, 255, 255, 253, 253, 255, 255, 255, 255, 255, 255, 255, 255,
  246, 253, 253, 255, 255, 255, 255, 255, 255, 255, 255, 252, 254, 251, 254, 254, 255, 255, 255,
  255, 255, 255, 255, 254, 252, 255, 255, 255, 255, 255, 255, 255, 255, 248, 254, 253, 255, 255,
  255, 255, 255, 255, 255, 255, 253, 255, 254, 254, 255, 255, 255, 255, 255, 255, 255, 255, 251,
  254, 255, 255, 255, 255, 255, 255, 255, 255, 245, 251, 254, 255, 255, 255, 255, 255, 255, 255,
  255, 253, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 251, 253, 255, 255, 255, 255,
  255, 255, 255, 255, 252, 253, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 252, 255, 255, 255, 255, 255, 255, 255, 255, 255, 249,
  255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 253, 255, 255, 255, 255, 255, 255, 255, 255, 250, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 254, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
]);
const BMODES_PROBA = new Uint8Array([
  231, 120, 48, 89, 115, 113, 120, 152, 112, 152, 179, 64, 126, 170, 118, 46, 70, 95, 175, 69, 143,
  80, 85, 82, 72, 155, 103, 56, 58, 10, 171, 218, 189, 17, 13, 152, 114, 26, 17, 163, 44, 195, 21,
  10, 173, 121, 24, 80, 195, 26, 62, 44, 64, 85, 144, 71, 10, 38, 171, 213, 144, 34, 26, 170, 46,
  55, 19, 136, 160, 33, 206, 71, 63, 20, 8, 114, 114, 208, 12, 9, 226, 81, 40, 11, 96, 182, 84, 29,
  16, 36, 134, 183, 89, 137, 98, 101, 106, 165, 148, 72, 187, 100, 130, 157, 111, 32, 75, 80, 66,
  102, 167, 99, 74, 62, 40, 234, 128, 41, 53, 9, 178, 241, 141, 26, 8, 107, 74, 43, 26, 146, 73,
  166, 49, 23, 157, 65, 38, 105, 160, 51, 52, 31, 115, 128, 104, 79, 12, 27, 217, 255, 87, 17, 7,
  87, 68, 71, 44, 114, 51, 15, 186, 23, 47, 41, 14, 110, 182, 183, 21, 17, 194, 66, 45, 25, 102,
  197, 189, 23, 18, 22, 88, 88, 147, 150, 42, 46, 45, 196, 205, 43, 97, 183, 117, 85, 38, 35, 179,
  61, 39, 53, 200, 87, 26, 21, 43, 232, 171, 56, 34, 51, 104, 114, 102, 29, 93, 77, 39, 28, 85, 171,
  58, 165, 90, 98, 64, 34, 22, 116, 206, 23, 34, 43, 166, 73, 107, 54, 32, 26, 51, 1, 81, 43, 31,
  68, 25, 106, 22, 64, 171, 36, 225, 114, 34, 19, 21, 102, 132, 188, 16, 76, 124, 62, 18, 78, 95,
  85, 57, 50, 48, 51, 193, 101, 35, 159, 215, 111, 89, 46, 111, 60, 148, 31, 172, 219, 228, 21, 18,
  111, 112, 113, 77, 85, 179, 255, 38, 120, 114, 40, 42, 1, 196, 245, 209, 10, 25, 109, 88, 43, 29,
  140, 166, 213, 37, 43, 154, 61, 63, 30, 155, 67, 45, 68, 1, 209, 100, 80, 8, 43, 154, 1, 51, 26,
  71, 142, 78, 78, 16, 255, 128, 34, 197, 171, 41, 40, 5, 102, 211, 183, 4, 1, 221, 51, 50, 17, 168,
  209, 192, 23, 25, 82, 138, 31, 36, 171, 27, 166, 38, 44, 229, 67, 87, 58, 169, 82, 115, 26, 59,
  179, 63, 59, 90, 180, 59, 166, 93, 73, 154, 40, 40, 21, 116, 143, 209, 34, 39, 175, 47, 15, 16,
  183, 34, 223, 49, 45, 183, 46, 17, 33, 183, 6, 98, 15, 32, 183, 57, 46, 22, 24, 128, 1, 54, 17,
  37, 65, 32, 73, 115, 28, 128, 23, 128, 205, 40, 3, 9, 115, 51, 192, 18, 6, 223, 87, 37, 9, 115,
  59, 77, 64, 21, 47, 104, 55, 44, 218, 9, 54, 53, 130, 226, 64, 90, 70, 205, 40, 41, 23, 26, 57,
  54, 57, 112, 184, 5, 41, 38, 166, 213, 30, 34, 26, 133, 152, 116, 10, 32, 134, 39, 19, 53, 221,
  26, 114, 32, 73, 255, 31, 9, 65, 234, 2, 15, 1, 118, 73, 75, 32, 12, 51, 192, 255, 160, 43, 51,
  88, 31, 35, 67, 102, 85, 55, 186, 85, 56, 21, 23, 111, 59, 205, 45, 37, 192, 55, 38, 70, 124, 73,
  102, 1, 34, 98, 125, 98, 42, 88, 104, 85, 117, 175, 82, 95, 84, 53, 89, 128, 100, 113, 101, 45,
  75, 79, 123, 47, 51, 128, 81, 171, 1, 57, 17, 5, 71, 102, 57, 53, 41, 49, 38, 33, 13, 121, 57, 73,
  26, 1, 85, 41, 10, 67, 138, 77, 110, 90, 47, 114, 115, 21, 2, 10, 102, 255, 166, 23, 6, 101, 29,
  16, 10, 85, 128, 101, 196, 26, 57, 18, 10, 102, 102, 213, 34, 20, 43, 117, 20, 15, 36, 163, 128,
  68, 1, 26, 102, 61, 71, 37, 34, 53, 31, 243, 192, 69, 60, 71, 38, 73, 119, 28, 222, 37, 68, 45,
  128, 34, 1, 47, 11, 245, 171, 62, 17, 19, 70, 146, 85, 55, 62, 70, 37, 43, 37, 154, 100, 163, 85,
  160, 1, 63, 9, 92, 136, 28, 64, 32, 201, 85, 75, 15, 9, 9, 64, 255, 184, 119, 16, 86, 6, 28, 5,
  64, 255, 25, 248, 1, 56, 8, 17, 132, 137, 255, 55, 116, 128, 58, 15, 20, 82, 135, 57, 26, 121, 40,
  164, 50, 31, 137, 154, 133, 25, 35, 218, 51, 103, 44, 131, 131, 123, 31, 6, 158, 86, 40, 64, 135,
  148, 224, 45, 183, 128, 22, 26, 17, 131, 240, 154, 14, 1, 209, 45, 16, 21, 91, 64, 222, 7, 1, 197,
  56, 21, 39, 155, 60, 138, 23, 102, 213, 83, 12, 13, 54, 192, 255, 68, 47, 28, 85, 26, 85, 85, 128,
  128, 32, 146, 171, 18, 11, 7, 63, 144, 171, 4, 4, 246, 35, 27, 10, 146, 174, 171, 12, 26, 128,
  190, 80, 35, 99, 180, 80, 126, 54, 45, 85, 126, 47, 87, 176, 51, 41, 20, 32, 101, 75, 128, 139,
  118, 146, 116, 128, 85, 56, 41, 15, 176, 236, 85, 37, 9, 62, 71, 30, 17, 119, 118, 255, 17, 18,
  138, 101, 38, 60, 138, 55, 70, 43, 26, 142, 146, 36, 19, 30, 171, 255, 97, 27, 20, 138, 45, 61,
  62, 219, 1, 81, 188, 64, 32, 41, 20, 117, 151, 142, 20, 21, 163, 112, 19, 12, 61, 195, 128, 48, 4,
  24,
]);
