// PNG decoding for the Show image actions (docs/architecture/images.md, #31). The IDAT data is inflated as a stream
// and unfiltered row by row straight into the `AreaScaler`: only two scanlines and one zlib window are held, never the
// whole picture (pngjs needed about 30 bytes per pixel at the peak, which a Homey app cannot afford).
import { createInflate } from 'node:zlib';
import type { Rgb } from '../protocol/status';
import { ImageError } from './imageError';
import { checkSize, messageOf, unsupported } from './imageLimits';
import { AreaScaler, type ImageFit } from './imageScale';

/** Bits per sample allowed for each colour type (PNG spec, table 11.1). */
const BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
/** Inflated data beyond what the header allows that is still tolerated (some encoders pad). */
const PNG_SLACK_BYTES = 1024;

interface Pass {
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  width: number;
  height: number;
}

function passesOf(width: number, height: number, interlaced: boolean): Pass[] {
  if (!interlaced) return [{ x0: 0, y0: 0, dx: 1, dy: 1, width, height }];
  return ADAM7.map(([x0, y0, dx, dy]) => ({
    x0,
    y0,
    dx,
    dy,
    width: Math.max(0, Math.ceil((width - x0) / dx)),
    height: Math.max(0, Math.ceil((height - y0) / dy)),
  })).filter((pass) => pass.width > 0 && pass.height > 0);
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlaced: boolean;
}

interface PngChunks {
  idat: Uint8Array[];
  palette?: Uint8Array;
  transparency?: Uint8Array;
}

/** Read and check the IHDR (the first chunk, 13 bytes); the size is checked before anything else is read. */
function readHeader(bytes: Uint8Array): PngHeader {
  if (bytes.length < 33) throw unsupported('truncated PNG header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
    throw unsupported('PNG does not start with an IHDR chunk');
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  checkSize(width, height);
  const [bitDepth, colourType, compression, filter, interlace] = bytes.subarray(24, 29);
  if (!BIT_DEPTHS[colourType]?.includes(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) {
    throw unsupported('invalid PNG header');
  }
  return { width, height, bitDepth, colourType, interlaced: interlace === 1 };
}

/**
 * Walk the chunks up to IEND. The first chunk is the 13-byte IHDR that was checked (`readHeader`), no other IHDR may
 * follow and no chunk may reach past the end of the file.
 */
function readChunks(bytes: Uint8Array): PngChunks {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: PngChunks = { idat: [] };
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (at + 12 + length > bytes.length) throw unsupported(`PNG chunk ${type} reaches past the end of the file`);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IEND') break;
    if (type === 'IHDR' && at !== 8) throw unsupported('PNG has more than one IHDR chunk');
    if (type === 'IDAT') out.idat.push(data);
    if (type === 'PLTE') out.palette = data;
    if (type === 'tRNS') out.transparency = data;
    at += 12 + length;
  }
  if (out.idat.length === 0) throw unsupported('PNG has no image data');
  return out;
}

/** Turns one unfiltered scanline into 8-bit RGBA. */
type RowConverter = (line: Uint8Array, count: number, rgba: Uint8Array) => void;

function rowConverter(header: PngHeader, chunks: PngChunks): RowConverter {
  const { bitDepth, colourType } = header;
  const trns = chunks.transparency;
  const u16 = (data: Uint8Array, at: number): number => (data[at] << 8) | data[at + 1];
  if (colourType === 3) {
    const plte = chunks.palette;
    if (!plte || plte.length < 3 || plte.length % 3 !== 0) throw unsupported('palette PNG without a valid PLTE chunk');
    const entries = plte.length / 3;
    const table = new Uint8Array(256 * 4); // indices past the palette stay opaque black
    for (let i = 0; i < 256; i++) {
      if (i < entries) table.set(plte.subarray(i * 3, i * 3 + 3), i * 4);
      table[i * 4 + 3] = trns && i < trns.length ? trns[i] : 255;
    }
    const mask = (1 << bitDepth) - 1;
    return (line, count, rgba) => {
      for (let i = 0; i < count; i++) {
        const bit = i * bitDepth;
        const index = bitDepth === 8 ? line[i] : (line[bit >> 3] >> (8 - bitDepth - (bit & 7))) & mask;
        const o = i * 4;
        const t = index * 4;
        rgba[o] = table[t];
        rgba[o + 1] = table[t + 1];
        rgba[o + 2] = table[t + 2];
        rgba[o + 3] = table[t + 3];
      }
    };
  }
  // Raw samples (at the bit depth) are compared with tRNS; the 8-bit value is scaled.
  const sample =
    bitDepth === 16
      ? (line: Uint8Array, index: number): number => u16(line, index * 2)
      : bitDepth === 8
        ? (line: Uint8Array, index: number): number => line[index]
        : (line: Uint8Array, index: number): number => {
            const bit = index * bitDepth;
            return (line[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
          };
  const maxValue = 2 ** bitDepth - 1;
  const to8 = (v: number): number => (bitDepth === 8 ? v : Math.round((v * 255) / maxValue));
  const channels = CHANNELS[colourType];
  const key =
    trns && colourType === 0 && trns.length >= 2
      ? [u16(trns, 0) & maxValue]
      : trns && colourType === 2 && trns.length >= 6
        ? [u16(trns, 0) & maxValue, u16(trns, 2) & maxValue, u16(trns, 4) & maxValue]
        : undefined;
  return (line, count, rgba) => {
    for (let i = 0; i < count; i++) {
      const base = i * channels;
      const o = i * 4;
      if (colourType === 0 || colourType === 4) {
        const grey = sample(line, base);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = to8(grey);
        rgba[o + 3] = colourType === 4 ? to8(sample(line, base + 1)) : key && grey === key[0] ? 0 : 255;
      } else {
        const r = sample(line, base);
        const g = sample(line, base + 1);
        const b = sample(line, base + 2);
        rgba[o] = to8(r);
        rgba[o + 1] = to8(g);
        rgba[o + 2] = to8(b);
        rgba[o + 3] =
          colourType === 6
            ? to8(sample(line, base + 3))
            : key && r === key[0] && g === key[1] && b === key[2]
              ? 0
              : 255;
      }
    }
  };
}

/** Undo the filter of `line` (filter byte in front) in place, against the previous unfiltered line `prev`. */
function unfilter(line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const type = line[0];
  const n = line.length;
  // Index 0 is the filter byte: pixel bytes are 1..n-1, `prev` uses the same layout.
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = 1 + bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 1; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff;
      return;
    case 3:
      for (let i = 1; i < n; i++) {
        const left = i > bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 1; i < n; i++) {
        const a = i > bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i > bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      return;
    default:
      throw unsupported(`invalid PNG filter type ${type}`);
  }
}

/** The bytes the IDAT stream of a PNG inflates to (filter bytes included). */
function rawSize(passes: readonly Pass[], bitsPerPixel: number): number {
  return passes.reduce((sum, pass) => sum + pass.height * (1 + Math.ceil((pass.width * bitsPerPixel) / 8)), 0);
}

/**
 * Decode a PNG straight to the 16x16 panel. The IDAT data is inflated as a stream; more data than the header allows
 * (a decompression bomb) or less is refused. Throws `ImageError` (`unsupported`, `too_large`).
 */
export async function scalePng(
  bytes: Uint8Array,
  fit: ImageFit,
): Promise<{ width: number; height: number; pixels: Rgb[] }> {
  const header = readHeader(bytes);
  const chunks = readChunks(bytes);
  const convert = rowConverter(header, chunks);
  const { width, height } = header;
  const bitsPerPixel = CHANNELS[header.colourType] * header.bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = passesOf(width, height, header.interlaced);
  const expected = rawSize(passes, bitsPerPixel);
  const scaler = new AreaScaler(width, height, fit);
  const lineBytes = 1 + Math.ceil((width * bitsPerPixel) / 8);
  let line = new Uint8Array(lineBytes);
  let prev = new Uint8Array(lineBytes);
  const rgba = new Uint8Array(width * 4);

  let passIndex = 0;
  let row = 0;
  let filled = 0;
  let total = 0;
  const done = (): boolean => passIndex >= passes.length;
  const take = (data: Uint8Array): void => {
    for (let at = 0; at < data.length && !done();) {
      const pass = passes[passIndex];
      const length = 1 + Math.ceil((pass.width * bitsPerPixel) / 8);
      const n = Math.min(length - filled, data.length - at);
      line.set(data.subarray(at, at + n), filled);
      filled += n;
      at += n;
      if (filled < length) return;
      const current = line.subarray(0, length);
      unfilter(current, prev, bpp);
      const y = pass.y0 + row * pass.dy;
      if (scaler.wantsRow(y)) {
        convert(current.subarray(1), pass.width, rgba);
        scaler.addRow(y, rgba.subarray(0, pass.width * 4), pass.x0, pass.dx);
      }
      [line, prev] = [prev, line];
      filled = 0;
      if (++row >= pass.height) {
        passIndex++;
        row = 0;
        prev.fill(0);
      }
    }
  };

  const inflate = createInflate(); // 16 KiB output chunks: the garbage stays small between collections
  inflate.on('error', () => undefined); // reported through the iterator; never an unhandled 'error' event
  for (const part of chunks.idat) inflate.write(part);
  inflate.end();
  try {
    for await (const data of inflate as AsyncIterable<Buffer>) {
      total += data.length;
      if (total > expected + PNG_SLACK_BYTES) {
        throw unsupported(`PNG data is larger than its header allows (${expected} bytes)`);
      }
      take(data);
    }
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw unsupported(`PNG data is broken: ${messageOf(e)}`);
  } finally {
    inflate.destroy();
  }
  if (!done()) throw unsupported(`PNG data ends early (${total} of ${expected} bytes)`);
  return { width, height, pixels: scaler.result() };
}
