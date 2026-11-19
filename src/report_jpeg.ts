/**
 * Lossless JPEG re-optimisation: a sequential Huffman-coded JPEG written again with Huffman tables
 * built for its own data, every DCT coefficient -- and so every pixel -- unchanged (owner,
 * 2026-11-11: the PDF "minimized"; "I agree with the recommendation on the JPEG re-optimisation
 * build"). What `jpegtran -optimize` does, in TypeScript, so it runs wherever the package does
 * (owner, 2026-11-11: "this will need to work on all platforms, linux, mac, windows, web, ios and
 * android").
 *
 * Measured before it was built (2026-11-11, the 36ft model report's four screenshots, all written
 * with the standard tables of the JPEG standard's Annex K): libjpeg-turbo's `jpegtran -optimize`
 * saved 21.4 % of their bytes, the pixels identical through libjpeg-turbo and through pdf.js.
 *
 * How: each scan's entropy-coded data is read to its symbols -- a Huffman code and the extra bits
 * after it -- the symbols are counted per table, a table optimal for those counts is built by the
 * standard's own procedure (Annex K.2, as libjpeg does it: 16-bit code lengths at most, no code
 * of all ones), and the same symbols with the same extra bits are written again with the new
 * codes, restart markers where they were. The coefficients are never computed: nothing but the
 * codes changes. Before it is returned the result is read back, and every symbol must be the
 * original's.
 *
 * Read: baseline and extended sequential Huffman frames (SOF0, SOF1) of 8-bit samples, any
 * sampling, interleaved or not, any number of scans, restart intervals, tables redefined between
 * scans. Anything else -- progressive, lossless, arithmetic-coded, hierarchical, 12-bit, a DNL
 * marker, data that does not decode -- is left exactly as it is (`null`). Every marker but the
 * Huffman tables is kept, in its place, byte for byte (JFIF, Exif and its orientation, ICC
 * profiles, Adobe's colour transform, comments).
 *
 * Pure: no I/O.
 *
 * @module
 */

/** One Huffman table: its code lengths (`bits[1..16]`) and symbols (`vals`), as a DHT holds it. */
type Table = { bits: number[]; vals: number[] };

/** A Huffman table for decoding: per code length, the codes it holds and where they start. */
type Decoder = { maxcode: number[]; valptr: number[]; mincode: number[]; vals: number[] };

function decoderOf(t: Table): Decoder | null {
  const maxcode = new Array<number>(18).fill(-1);
  const valptr = new Array<number>(17).fill(0);
  const mincode = new Array<number>(17).fill(0);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += t.bits[l];
    k += t.bits[l];
    maxcode[l] = t.bits[l] ? code - 1 : -1;
    // A table whose codes overflow their length is not a prefix code.
    if (code > 1 << l) return null;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, vals: t.vals };
}

/** Each symbol's code and length (Annex C), for encoding. */
function encoderOf(t: Table): { code: number[]; len: number[] } {
  const code = new Array<number>(256).fill(0);
  const len = new Array<number>(256).fill(0);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < t.bits[l]; i++) {
      code[t.vals[k]] = c++;
      len[t.vals[k]] = l;
      k++;
    }
    c <<= 1;
  }
  return { code, len };
}

/**
 * The optimal table for symbol counts `freq` (256 entries): Annex K.2's procedure as libjpeg's
 * `jpeg_gen_optimal_table` runs it -- a reserved symbol 256 of count 1 so no code is all ones, the
 * two least frequent merged until one is left (ties to the higher symbol), lengths over 16 cut
 * back by the standard's adjustment, the reserved code removed.
 */
function optimalTable(counts: number[]): Table {
  const freq = [...counts, 1];
  const codesize = new Array<number>(257).fill(0);
  const others = new Array<number>(257).fill(-1);
  for (;;) {
    let c1 = -1;
    let v = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 256; i++) {
      if (freq[i] && freq[i] <= v) {
        v = freq[i];
        c1 = i;
      }
    }
    let c2 = -1;
    v = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 256; i++) {
      if (freq[i] && freq[i] <= v && i !== c1) {
        v = freq[i];
        c2 = i;
      }
    }
    if (c2 < 0) break;
    freq[c1] += freq[c2];
    freq[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) {
      c1 = others[c1];
      codesize[c1]++;
    }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) {
      c2 = others[c2];
      codesize[c2]++;
    }
  }
  const bits = new Array<number>(33).fill(0);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  for (let i = 32; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  let i = 16;
  while (bits[i] === 0) i--;
  bits[i]--; // the reserved symbol's code
  const vals: number[] = [];
  for (let l = 1; l <= 32; l++) for (let j = 0; j < 256; j++) if (codesize[j] === l) vals.push(j);
  return { bits: bits.slice(0, 17), vals };
}

/** Raised for anything outside what is read: the JPEG is then left as it is. */
class NotHandled extends Error {}

/** A scan's symbols: per symbol, its table (0–3 DC, 4–7 AC), symbol, extra bits and their count. */
type Symbols = {
  table: Uint8Array;
  sym: Uint8Array;
  extra: Uint16Array;
  size: Uint8Array;
  n: number;
};

function growSymbols(s: Symbols): Symbols {
  const cap = s.table.length * 2;
  const grow = <T extends Uint8Array | Uint16Array>(a: T, make: (n: number) => T): T => {
    const b = make(cap);
    b.set(a);
    return b;
  };
  return {
    table: grow(s.table, (n) => new Uint8Array(n)),
    sym: grow(s.sym, (n) => new Uint8Array(n)),
    extra: grow(s.extra, (n) => new Uint16Array(n)),
    size: grow(s.size, (n) => new Uint8Array(n)),
    n: s.n,
  };
}

type Frame = {
  width: number;
  height: number;
  comps: { id: number; h: number; v: number }[];
  hmax: number;
  vmax: number;
};

type Scan = {
  /** Each component of the scan: its index in the frame, its DC and AC table numbers. */
  comps: { index: number; td: number; ta: number }[];
  /** The restart interval in MCUs (0: none). */
  restart: number;
  symbols: Symbols;
  /** How many symbols each restart interval ends after (restart markers go there). */
  restartsAfter: number[];
};

/**
 * Read a scan's entropy-coded data at `at` into its symbols. Returns where the data ends (the next
 * marker that is not a restart).
 */
function readScan(
  data: Uint8Array,
  at: number,
  frame: Frame,
  scan: Pick<Scan, "comps" | "restart">,
  tables: (Table | undefined)[],
): { end: number; symbols: Symbols; restartsAfter: number[] } {
  const dec: (Decoder | null)[] = tables.map((t) => (t ? decoderOf(t) : null));
  let pos = at;
  let bitBuf = 0;
  let bitCount = 0;
  let hitMarker = false;
  const fill = () => {
    while (bitCount <= 24) {
      let byte = 0;
      if (!hitMarker && pos < data.length) {
        byte = data[pos];
        if (byte === 0xff) {
          const next = data[pos + 1];
          if (next === 0x00) pos += 2;
          else {
            hitMarker = true; // a marker: the data ends; pad with zeros (a decoder past it is wrong)
            byte = 0;
          }
        } else pos++;
      }
      if (hitMarker || pos > data.length) byte = 0;
      bitBuf = (bitBuf << 8) | byte;
      bitCount += 8;
    }
  };
  const bits = (n: number): number => {
    if (n === 0) return 0;
    if (bitCount < n) fill();
    bitCount -= n;
    return (bitBuf >>> bitCount) & ((1 << n) - 1);
  };
  const decode = (d: Decoder): number => {
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | bits(1);
      if (code <= d.maxcode[l]) return d.vals[d.valptr[l] + code - d.mincode[l]];
    }
    throw new NotHandled("a Huffman code no table holds");
  };
  let symbols: Symbols = {
    table: new Uint8Array(4096),
    sym: new Uint8Array(4096),
    extra: new Uint16Array(4096),
    size: new Uint8Array(4096),
    n: 0,
  };
  const push = (table: number, sym: number, size: number, extra: number) => {
    if (symbols.n === symbols.table.length) symbols = growSymbols(symbols);
    const k = symbols.n++;
    symbols.table[k] = table;
    symbols.sym[k] = sym;
    symbols.size[k] = size;
    symbols.extra[k] = extra;
  };
  const block = (td: number, ta: number) => {
    const dcd = dec[td];
    const acd = dec[4 + ta];
    if (!dcd || !acd) throw new NotHandled("a scan uses a table never defined");
    const s = decode(dcd);
    if (s > 11) throw new NotHandled("a DC difference too large for 8-bit samples");
    push(td, s, s, bits(s));
    for (let k = 1; k < 64;) {
      const rs = decode(acd);
      const r = rs >> 4;
      const size = rs & 15;
      if (size > 10) throw new NotHandled("an AC coefficient too large for 8-bit samples");
      push(4 + ta, rs, size, bits(size));
      if (size === 0) {
        if (r !== 15) break; // end of block
        k += 16;
      } else k += r + 1;
      if (k > 64) throw new NotHandled("a block past 64 coefficients");
    }
  };
  // The MCUs: interleaved, each component's h × v blocks; alone, one block, over its own grid.
  const single = scan.comps.length === 1;
  let mcus: number;
  if (single) {
    const c = frame.comps[scan.comps[0].index];
    const w = Math.ceil(Math.ceil((frame.width * c.h) / frame.hmax) / 8);
    const h = Math.ceil(Math.ceil((frame.height * c.v) / frame.vmax) / 8);
    mcus = w * h;
  } else {
    mcus = Math.ceil(frame.width / (8 * frame.hmax)) * Math.ceil(frame.height / (8 * frame.vmax));
  }
  const restartsAfter: number[] = [];
  let expectRst = 0;
  for (let m = 0; m < mcus; m++) {
    if (scan.restart && m > 0 && m % scan.restart === 0) {
      // The interval ends: what is left of its last byte is padding, then RSTn. The reader never
      // reads past a marker, so the marker is where it stopped.
      restartsAfter.push(symbols.n);
      bitCount = 0;
      bitBuf = 0;
      if (data[pos] !== 0xff || data[pos + 1] !== 0xd0 + (expectRst & 7)) {
        throw new NotHandled("a restart marker out of order");
      }
      pos += 2;
      expectRst++;
      hitMarker = false;
    }
    for (const sc of scan.comps) {
      const c = frame.comps[sc.index];
      const n = single ? 1 : c.h * c.v;
      for (let b = 0; b < n; b++) block(sc.td, sc.ta);
    }
  }
  // The data ends at the next marker that is not a restart (padding bits before it).
  let end = pos;
  while (end < data.length) {
    if (
      data[end] === 0xff &&
      data[end + 1] !== 0x00 &&
      !(data[end + 1] >= 0xd0 && data[end + 1] <= 0xd7)
    )
      break;
    end++;
  }
  return { end, symbols, restartsAfter };
}

/** Write a scan's symbols with `enc` (per table 0–7), restart markers after `restartsAfter`. */
function writeScan(
  s: Symbols,
  restartsAfter: number[],
  enc: ({ code: number[]; len: number[] } | null)[],
): Uint8Array {
  let out = new Uint8Array(Math.max(1024, s.n * 2));
  let at = 0;
  let acc = 0;
  let accBits = 0;
  const byte = (b: number) => {
    if (at + 2 > out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[at++] = b;
    if (b === 0xff) out[at++] = 0x00; // byte stuffing
  };
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++accBits === 8) {
        byte(acc);
        acc = 0;
        accBits = 0;
      }
    }
  };
  const pad = () => {
    if (accBits > 0) put(0x7f, 8 - accBits); // ones to the byte boundary
  };
  let r = 0;
  for (let k = 0; k < s.n; k++) {
    while (r < restartsAfter.length && restartsAfter[r] === k) {
      pad();
      if (at + 2 > out.length) {
        const bigger = new Uint8Array(out.length * 2);
        bigger.set(out);
        out = bigger;
      }
      out[at++] = 0xff;
      out[at++] = 0xd0 + (r & 7);
      r++;
    }
    const e = enc[s.table[k]];
    if (!e) throw new NotHandled("no table to write a symbol with");
    const len = e.len[s.sym[k]];
    if (len === 0) throw new NotHandled("a symbol its new table cannot code");
    put(e.code[s.sym[k]], len);
    put(s.extra[k], s.size[k]);
  }
  pad();
  return out.subarray(0, at);
}

const u16 = (d: Uint8Array, at: number) => (d[at] << 8) | d[at + 1];

/**
 * The JPEG re-coded with Huffman tables optimal for its own data, every coefficient and every
 * other marker unchanged -- or `null` when it is left as it is: not a sequential Huffman JPEG of
 * 8-bit samples, or anything in it this does not read, or no smaller for it.
 *
 * @param jpeg the JPEG file's bytes
 * @example
 * ```ts
 * // An internal module: the CLI's packing step re-codes each JPEG stream of the PDF with it.
 * declare const jpegBytes: Uint8Array; // a JPEG file's bytes
 * const smaller = optimizeJpeg(jpegBytes) ?? jpegBytes; // the same pixels, fewer bytes
 * ```
 */
export function optimizeJpeg(jpeg: Uint8Array): Uint8Array | null {
  try {
    return optimize(jpeg);
  } catch (err) {
    if (err instanceof NotHandled || err instanceof RangeError) return null;
    throw err;
  }
}

function optimize(data: Uint8Array): Uint8Array | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  const tables: (Table | undefined)[] = new Array(8);
  let frame: Frame | null = null;
  let restart = 0;
  /** The file in pieces: kept bytes, and each scan to re-write (its DHT and SOS and data). */
  const pieces: ({ keep: [number, number] } | { scan: Scan; sos: [number, number] })[] = [];
  let keepFrom = 0;
  let at = 2;
  let ended = false;
  while (at < data.length) {
    if (data[at] !== 0xff) throw new NotHandled("bytes between segments");
    let m = data[at + 1];
    while (m === 0xff) {
      at++; // fill bytes before a marker
      m = data[at + 1];
    }
    if (m === 0xd9) {
      ended = true;
      break; // EOI
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) throw new NotHandled("a stray marker");
    const len = u16(data, at + 2);
    const seg = at + 4;
    const next = at + 2 + len;
    if (next > data.length) throw new NotHandled("a segment past the end");
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      // A frame: only sequential Huffman (SOF0, SOF1) of 8-bit samples is read.
      if (m !== 0xc0 && m !== 0xc1) return null;
      if (frame) throw new NotHandled("two frames");
      if (data[seg] !== 8) return null;
      const n = data[seg + 5];
      const comps: Frame["comps"] = [];
      for (let i = 0; i < n; i++) {
        const b = seg + 6 + i * 3;
        comps.push({ id: data[b], h: data[b + 1] >> 4, v: data[b + 1] & 15 });
      }
      frame = {
        height: u16(data, seg + 1),
        width: u16(data, seg + 3),
        comps,
        hmax: Math.max(...comps.map((c) => c.h)),
        vmax: Math.max(...comps.map((c) => c.v)),
      };
      if (frame.height === 0) throw new NotHandled("a height given by DNL");
      if (comps.some((c) => c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4))
        throw new NotHandled("sampling");
    } else if (m === 0xc4) {
      // DHT: one or more tables. Dropped from the output; the scans get their own.
      if (at > keepFrom) pieces.push({ keep: [keepFrom, at] });
      let p = seg;
      while (p < next) {
        const tc = data[p] >> 4;
        const th = data[p] & 15;
        if (tc > 1 || th > 3) throw new NotHandled("a table class or number");
        const bits = [0, ...data.subarray(p + 1, p + 17)];
        const count = bits.reduce((a, b) => a + b, 0);
        tables[tc * 4 + th] = { bits, vals: [...data.subarray(p + 17, p + 17 + count)] };
        p += 17 + count;
      }
      keepFrom = next;
    } else if (m === 0xcc) {
      throw new NotHandled("arithmetic coding conditioning");
    } else if (m === 0xdd) {
      restart = u16(data, seg);
    } else if (m === 0xdc) {
      throw new NotHandled("a DNL marker");
    } else if (m === 0xda) {
      if (!frame) throw new NotHandled("a scan before its frame");
      const n = data[seg];
      const comps: Scan["comps"] = [];
      for (let i = 0; i < n; i++) {
        const id = data[seg + 1 + i * 2];
        const t = data[seg + 2 + i * 2];
        const index = frame.comps.findIndex((c) => c.id === id);
        if (index < 0) throw new NotHandled("a scan component the frame lacks");
        comps.push({ index, td: t >> 4, ta: t & 15 });
      }
      const ss = data[seg + 1 + n * 2];
      const se = data[seg + 2 + n * 2];
      const a = data[seg + 3 + n * 2];
      if (ss !== 0 || se !== 63 || a !== 0) throw new NotHandled("a scan that is not sequential");
      if (at > keepFrom) pieces.push({ keep: [keepFrom, at] });
      const read = readScan(data, next, frame, { comps, restart }, tables);
      pieces.push({
        scan: { comps, restart, symbols: read.symbols, restartsAfter: read.restartsAfter },
        sos: [at, next],
      });
      at = read.end;
      keepFrom = at;
      continue;
    }
    at = next;
  }
  if (!ended || !frame || !pieces.some((p) => "scan" in p))
    throw new NotHandled("no complete image");
  pieces.push({ keep: [keepFrom, data.length] });

  // Each scan: its own optimal tables, a DHT before its SOS, the symbols re-written.
  const chunks: Uint8Array[] = [];
  for (const p of pieces) {
    if ("keep" in p) {
      chunks.push(data.subarray(p.keep[0], p.keep[1]));
      continue;
    }
    const s = p.scan.symbols;
    const counts = Array.from({ length: 8 }, () => new Array<number>(256).fill(0));
    for (let k = 0; k < s.n; k++) counts[s.table[k]][s.sym[k]]++;
    const used = counts.map((c) => c.some((x) => x > 0));
    const newTables: (Table | null)[] = counts.map((c, i) => (used[i] ? optimalTable(c) : null));
    const dht: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t = newTables[i];
      if (!t) continue;
      dht.push(((i >> 2) << 4) | (i & 3), ...t.bits.slice(1, 17), ...t.vals);
    }
    const dhtLen = dht.length + 2;
    chunks.push(Uint8Array.of(0xff, 0xc4, dhtLen >> 8, dhtLen & 0xff, ...dht));
    chunks.push(data.subarray(p.sos[0], p.sos[1]));
    const enc = newTables.map((t) => (t ? encoderOf(t) : null));
    const written = writeScan(s, p.scan.restartsAfter, enc);
    // Read back with the new tables: every symbol and every extra bit must be the original's.
    const back = readScan(
      concatWithEnd(written),
      0,
      frame,
      { comps: p.scan.comps, restart: p.scan.restart },
      newTables.map((t) => t ?? undefined),
    );
    if (back.symbols.n !== s.n) throw new NotHandled("read back: a different count");
    for (let k = 0; k < s.n; k++) {
      if (
        back.symbols.table[k] !== s.table[k] ||
        back.symbols.sym[k] !== s.sym[k] ||
        back.symbols.extra[k] !== s.extra[k]
      ) {
        throw new NotHandled("read back: a different symbol");
      }
    }
    chunks.push(written);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  if (total >= data.length) return null;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Scan data followed by an end marker, for reading it back alone. */
function concatWithEnd(scan: Uint8Array): Uint8Array {
  const out = new Uint8Array(scan.length + 2);
  out.set(scan);
  out[scan.length] = 0xff;
  out[scan.length + 1] = 0xd9;
  return out;
}
