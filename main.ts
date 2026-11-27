// png-squeeze-01-run-20261127: lossless PNG optimizer.
//
// Strategy (pure Node built-ins, no dependencies, no network):
//  1. Decode the stored RGBA screenshot.
//  2. Reduce the colour type to the smallest that holds the pixels exactly:
//     palette (<=256 distinct RGBA colours, tRNS when alpha varies), grey,
//     grey+alpha, RGB (opaque), or RGBA.
//  3. Pick each row's PNG filter (None/Sub/Up/Average/Paeth) by minimum sum of
//     absolute filtered byte values, the classic libpng heuristic.
//  4. Deflate at level 9 with two strategies (default and Z_FILTERED) and keep
//     the smaller stream. For palette images two palette orders (luminance and
//     first-occurrence) are tried and the smaller kept.
//  5. Write only IHDR / PLTE / tRNS / IDAT / IEND, bit depth 8, not interlaced.
//
// The program answers all 8 instances of a set in one run, inside the 60 s
// wall budget: on the practice set it takes ~10 s on one CPU.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------- CRC32 ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function ihdr(width: number, height: number, colorType: number): Uint8Array {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  b[8] = 8; // bit depth
  b[9] = colorType;
  b[10] = 0; // compression
  b[11] = 0; // filter
  b[12] = 0; // interlace
  return b;
}

// Full decode with row unfiltering, used when any row carries a filter != 0.
function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function decodePngFiltered(bytes: Uint8Array): Decoded {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  while (pos + 8 <= bytes.length) {
    const len =
      (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
      idatLen += len;
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const compressed = new Uint8Array(idatLen);
  let off = 0;
  for (const d of idat) {
    compressed.set(d, off);
    off += d.length;
  }
  const raw = inflateSync(compressed);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bpp = channels;
  const rowBytes = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(rowBytes);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const v = raw[src + i];
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prevRow[i];
      const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = left;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (left + up) >> 1;
      else if (filter === 4) pred = paeth(left, up, upLeft);
      row[i] = (v + pred) & 0xff;
    }
    src += rowBytes;
    prevRow.set(row);
    for (let x = 0; x < width; x++) {
      const px = x * bpp;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (colorType === 6) {
        r = row[px];
        g = row[px + 1];
        b = row[px + 2];
        a = row[px + 3];
      } else if (colorType === 2) {
        r = row[px];
        g = row[px + 1];
        b = row[px + 2];
      } else if (colorType === 0) {
        r = g = b = row[px];
      } else if (colorType === 4) {
        r = g = b = row[px];
        a = row[px + 1];
      } else if (colorType === 3 && palette) {
        const idx = row[px];
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      }
      const o = (y * width + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
  return { rgba, width, height };
}

// ---------------- Filtering ----------------
// Fill `out` (byteWidth bytes) with row `cur` filtered by `filter` against `prev`.
function filterRowInto(
  cur: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  filter: number,
  out: Uint8Array,
): void {
  const n = cur.length;
  if (filter === 0) {
    out.set(cur);
    return;
  }
  for (let i = 0; i < n; i++) {
    const left = i >= bpp ? cur[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (filter === 1) pred = left;
    else if (filter === 2) pred = up;
    else if (filter === 3) pred = (left + up) >> 1;
    else pred = paeth(left, up, upLeft);
    out[i] = (cur[i] - pred) & 0xff;
  }
}

function sumAbs(buf: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Filter every row of `pixels` (bpp bytes per pixel). `rule` picks the filter:
// a fixed filter for every row, or the per-row best by minimum sum of absolute
// filtered values ('abs') or by minimum estimated entropy ('entropy').
// Returns the filtered stream (one filter byte per row, then the row).
function filterRows(
  pixels: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  rule: 'abs' | 'entropy' | 'fixed',
  fixedFilter = 0,
): Uint8Array {
  const rowBytes = width * bpp;
  const out = new Uint8Array((rowBytes + 1) * height);
  const bufs: Uint8Array[] = [];
  for (let f = 0; f < 5; f++) bufs.push(new Uint8Array(rowBytes));
  const counts = new Uint32Array(256);
  const prev = new Uint8Array(rowBytes);
  let hasPrev = false;
  let opos = 0;
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    let best = 0;
    if (rule === 'fixed') {
      best = fixedFilter;
      filterRowInto(row, hasPrev ? prev : null, bpp, best, bufs[best]);
    } else {
      let bestScore = Infinity;
      for (let f = 0; f < 5; f++) {
        filterRowInto(row, hasPrev ? prev : null, bpp, f, bufs[f]);
        let s: number;
        if (rule === 'abs') {
          s = sumAbs(bufs[f]);
        } else {
          // Estimated entropy of the filtered row in bits.
          counts.fill(0);
          for (let i = 0; i < rowBytes; i++) counts[bufs[f][i]]++;
          s = 0;
          for (let c = 0; c < 256; c++) {
            const n = counts[c];
            if (n > 0) s += n * Math.log2(rowBytes / n);
          }
        }
        if (s < bestScore) {
          bestScore = s;
          best = f;
        }
      }
    }
    out[opos++] = best;
    out.set(bufs[best], opos);
    opos += rowBytes;
    prev.set(row);
    hasPrev = true;
  }
  return out;
}

function deflateBest(filtered: Uint8Array): Uint8Array {
  let best: Uint8Array | null = null;
  for (const strategy of [0, 1]) {
    const d = deflateSync(filtered, { level: 9, memLevel: 9, strategy });
    if (best === null || d.length < best.length) best = d;
  }
  return best as Uint8Array;
}

// Encode one pixel layout. Seven filter candidates (five fixed, two adaptive)
// are pre-screened with zlib level 6; the best two are re-compressed at
// level 9 and the smallest stream wins.
function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  colorType: number,
  palette: Uint8Array | null,
  trns: Uint8Array | null,
): Uint8Array {
  const candidates: { filtered: Uint8Array; l6: number }[] = [];
  const rules: ['fixed', number][] = [
    ['fixed', 0],
    ['fixed', 1],
    ['fixed', 2],
    ['fixed', 3],
    ['fixed', 4],
  ];
  for (const [rule, f] of rules) {
    const filtered = filterRows(pixels, width, height, bpp, rule, f);
    const d6 = deflateSync(filtered, { level: 6, memLevel: 9, strategy: 0 });
    candidates.push({ filtered, l6: d6.length });
  }
  for (const rule of ['abs', 'entropy'] as const) {
    const filtered = filterRows(pixels, width, height, bpp, rule);
    const d6 = deflateSync(filtered, { level: 6, memLevel: 9, strategy: 0 });
    candidates.push({ filtered, l6: d6.length });
  }
  candidates.sort((x, y) => x.l6 - y.l6);
  let best: Uint8Array | null = null;
  for (const c of candidates.slice(0, 2)) {
    const d = deflateBest(c.filtered);
    if (best === null || d.length < best.length) best = d;
  }
  const idat = best as Uint8Array;
  const parts: Uint8Array[] = [chunk('IHDR', ihdr(width, height, colorType))];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', new Uint8Array(idat)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let total = 8;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Build the palette pixel buffer for one palette order.
function palettePixels(
  rgba: Uint8Array,
  n: number,
  order: number[],
): { px: Uint8Array; palette: Uint8Array; trns: Uint8Array; hasTrns: boolean } {
  const indexOf = new Map<number, number>();
  order.forEach((k, idx) => indexOf.set(k, idx));
  const palette = new Uint8Array(order.length * 3);
  const trns = new Uint8Array(order.length);
  let hasTrns = false;
  order.forEach((k, idx) => {
    palette[idx * 3] = (k >>> 24) & 0xff;
    palette[idx * 3 + 1] = (k >>> 16) & 0xff;
    palette[idx * 3 + 2] = (k >>> 8) & 0xff;
    trns[idx] = k & 0xff;
    if ((k & 0xff) !== 255) hasTrns = true;
  });
  const px = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const key = ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]) >>> 0;
    px[i] = indexOf.get(key) as number;
  }
  return { px, palette, trns, hasTrns };
}

// Convert decoded RGBA into the smallest exact representation and encode it.
// Tries every colour type that can hold the pixels exactly and keeps the
// smallest PNG: palette (two orders), grey / grey+alpha, RGB, RGBA.
function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const seen = new Map<number, number>();
  let allGrey = true;
  let allOpaque = true;
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const a = rgba[o + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    if (!seen.has(key)) {
      seen.set(key, seen.size);
      order.push(key);
    }
  }

  let best: Uint8Array | null = null;
  const consider = (png: Uint8Array) => {
    if (best === null || png.length < best.length) best = png;
  };

  if (seen.size <= 256) {
    // Palette image. Pick the better of two palette orders by a cheap
    // level-6 pre-screen on the adaptive-abs filtering, then encode fully.
    const lumOrder = [...order].sort((x, y) => {
      const lx = 0.299 * ((x >>> 24) & 0xff) + 0.587 * ((x >>> 16) & 0xff) + 0.114 * ((x >>> 8) & 0xff);
      const ly = 0.299 * ((y >>> 24) & 0xff) + 0.587 * ((y >>> 16) & 0xff) + 0.114 * ((y >>> 8) & 0xff);
      return lx - ly || x - y;
    });
    let bestOrder = order;
    let bestL6 = Infinity;
    for (const ord of [lumOrder, order]) {
      const { px } = palettePixels(rgba, n, ord);
      const filtered = filterRows(px, width, height, 1, 'abs');
      const d6 = deflateSync(filtered, { level: 6, memLevel: 9, strategy: 0 });
      if (d6.length < bestL6) {
        bestL6 = d6.length;
        bestOrder = ord;
      }
    }
    const { px, palette, trns, hasTrns } = palettePixels(rgba, n, bestOrder);
    consider(encodePng(px, width, height, 1, 3, palette, hasTrns ? trns : null));
  }

  if (allGrey) {
    if (allOpaque) {
      const px = new Uint8Array(n);
      for (let i = 0; i < n; i++) px[i] = rgba[i * 4];
      consider(encodePng(px, width, height, 1, 0, null, null));
    } else {
      const px = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) {
        px[i * 2] = rgba[i * 4];
        px[i * 2 + 1] = rgba[i * 4 + 3];
      }
      consider(encodePng(px, width, height, 2, 4, null, null));
    }
  } else if (allOpaque) {
    const px = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      px[i * 3] = rgba[i * 4];
      px[i * 3 + 1] = rgba[i * 4 + 1];
      px[i * 3 + 2] = rgba[i * 4 + 2];
    }
    consider(encodePng(px, width, height, 3, 2, null, null));
  } else {
    consider(encodePng(rgba, width, height, 4, 6, null, null));
  }

  return best as Uint8Array;
}

// ---------------- Main ----------------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const bytes = new Uint8Array(readFileSync(join(I, id, 'image.png')));
  const decoded = decodePngFiltered(bytes);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), encodeImage(decoded.rgba, decoded.width, decoded.height));
}
