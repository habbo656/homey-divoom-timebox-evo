// JPEG decoding for the Show image actions (docs/architecture/images.md, #31). A small JPEG is decoded completely by
// jpeg-js. A larger one is read at 1/8 scale: only the DC coefficient of every 8x8 block (the block average) is kept,
// the AC coefficients are Huffman-decoded and dropped (baseline) or their scans skipped (progressive). That needs a few
// bytes per block instead of about 60 bytes per pixel, which a Homey app cannot afford for a photo (hardware test of #31).
import { decode as decodeJpeg } from 'jpeg-js';
import type { Rgb } from '../protocol/status';
import { ImageError } from './imageError';
import { checkSize, JPEG_FULL_DECODE_MAX_PIXELS, JPEG_MAX_MEMORY_MB, messageOf, unsupported } from './imageLimits';

/** Most scans (SOS segments) a JPEG may have; progressive files use about 10 (libjpeg-turbo suggests a limit too). */
export const JPEG_MAX_SCANS = 100;
/** The DC-only decoder decodes at most this many times the blocks of the frame over all scans. */
export const JPEG_MAX_DECODE_PASSES = 4;
import { AreaScaler, scaleTo16, type ImageFit } from './imageScale';

interface FrameComponent {
  id: number;
  h: number;
  v: number;
  tq: number;
}

/** What the segments before the first scan tell. */
export interface JpegInfo {
  width: number;
  height: number;
  progressive: boolean;
  components: FrameComponent[];
  /** Whether the three or four components are YCbCr (YCCK) and need the colour transform. */
  transform: boolean;
}

const u16 = (d: Uint8Array, at: number): number => (d[at] << 8) | d[at + 1];
const isRst = (marker: number): boolean => marker >= 0xd0 && marker <= 0xd7;
const hex = (marker: number): string => `FF${marker.toString(16).toUpperCase()}`;

/**
 * The position of the next marker (its `FF`) at or after `pos`: entropy-coded data, stuffed `FF 00`, fill bytes and,
 * with `skipRst`, restart markers are passed over. `d.length` if there is none.
 */
function nextMarker(d: Uint8Array, pos: number, skipRst: boolean): number {
  for (; pos + 1 < d.length; pos++) {
    if (d[pos] !== 0xff) continue;
    const marker = d[pos + 1];
    if (marker === 0x00 || marker === 0xff) continue;
    if (skipRst && isRst(marker)) {
      pos++;
      continue;
    }
    return pos;
  }
  return d.length;
}

/**
 * Walk the marker segments from SOI. `handle` gets each segment with a length (its data and the position after it) and
 * returns where to go on (a scan returns the position after its entropy-coded data) or `stop`. Ends at EOI or the end
 * of the data (a missing EOI is tolerated).
 */
function forEachSegment(
  d: Uint8Array,
  handle: (marker: number, data: Uint8Array, next: number) => number | 'stop',
): void {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) throw unsupported('JPEG does not start with SOI');
  let pos = 2;
  for (;;) {
    pos = nextMarker(d, pos, true);
    if (pos + 1 >= d.length) return;
    const marker = d[pos + 1];
    pos += 2;
    if (marker === 0xd9) return;
    if (marker === 0x01 || marker === 0xd8) continue;
    if (pos + 2 > d.length) throw unsupported(`JPEG segment ${hex(marker)} reaches past the end of the file`);
    const length = u16(d, pos);
    if (length < 2 || pos + length > d.length) {
      throw unsupported(`JPEG segment ${hex(marker)} reaches past the end of the file`);
    }
    const next = handle(marker, d.subarray(pos + 2, pos + length), pos + length);
    if (next === 'stop') return;
    pos = next;
  }
}

const SOF_SUPPORTED = new Set([0xc0, 0xc1, 0xc2]);
const SOF_UNSUPPORTED = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Read the frame header (size checked here, before anything is decoded) and the colour model. */
export function readJpegInfo(d: Uint8Array): JpegInfo {
  let info: JpegInfo | undefined;
  let jfif = false;
  let adobe: number | undefined;
  forEachSegment(d, (marker, data, next) => {
    if (marker === 0xe0 && data.length >= 5 && String.fromCharCode(...data.subarray(0, 5)) === 'JFIF\0') jfif = true;
    if (marker === 0xee && data.length >= 12 && String.fromCharCode(...data.subarray(0, 5)) === 'Adobe') {
      adobe = data[11];
    }
    if (marker === 0xda) throw unsupported('JPEG scan before the frame header');
    if (SOF_UNSUPPORTED.has(marker)) throw unsupported(`JPEG coding ${hex(marker)} is not supported`);
    if (!SOF_SUPPORTED.has(marker)) return next;
    if (data.length < 6 || data[0] !== 8) throw unsupported('JPEG frame header is invalid or not 8 bits');
    const height = u16(data, 1);
    const width = u16(data, 3);
    const count = data[5];
    if (height === 0) throw unsupported('JPEG height is defined later (DNL), not supported');
    checkSize(width, height);
    if (count < 1 || count > 4 || data.length < 6 + count * 3) throw unsupported('JPEG frame header is invalid');
    const components = Array.from({ length: count }, (_, i) => ({
      id: data[6 + i * 3],
      h: data[7 + i * 3] >> 4,
      v: data[7 + i * 3] & 15,
      tq: data[8 + i * 3],
    }));
    if (components.some((c) => c.h < 1 || c.h > 4 || c.v < 1 || c.v > 4 || c.tq > 3)) {
      throw unsupported('JPEG frame header is invalid');
    }
    // As libjpeg: JFIF is YCbCr, else the Adobe transform flag, else component ids R, G, B mean RGB.
    const rgbIds = count === 3 && components[0].id === 0x52 && components[1].id === 0x47 && components[2].id === 0x42;
    const transform =
      count === 3 ? jfif || (adobe !== undefined ? adobe !== 0 : !rgbIds) : count === 4 ? (adobe ?? 0) !== 0 : false;
    info = { width, height, progressive: marker === 0xc2, components, transform };
    return 'stop';
  });
  if (!info) throw unsupported('JPEG has no frame header');
  if (info.components.length === 4 && adobe === undefined)
    throw unsupported('JPEG with 4 components but no Adobe marker');
  return info;
}

/** A Huffman table (JPEG Annex C): the codes of each length and their symbols. */
interface Huffman {
  maxCode: Int32Array;
  valPtr: Int32Array;
  minCode: Int32Array;
  symbols: Uint8Array;
}

function buildHuffman(counts: Uint8Array, symbols: Uint8Array): Huffman {
  const maxCode = new Int32Array(17).fill(-1);
  const valPtr = new Int32Array(17);
  const minCode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1];
    valPtr[length] = k;
    minCode[length] = code;
    code += n;
    k += n;
    if (code > 1 << length) throw unsupported('JPEG Huffman table is invalid');
    if (n > 0) maxCode[length] = code - 1;
    code <<= 1;
  }
  return { maxCode, valPtr, minCode, symbols };
}

/** Reads the entropy-coded data bit by bit; at a marker (or the end) it delivers zeros. */
class BitReader {
  pos: number;
  private bits = 0;
  private count = 0;

  constructor(
    private readonly d: Uint8Array,
    pos: number,
  ) {
    this.pos = pos;
  }

  /** Start again at a byte boundary at `pos` (scan start, restart). */
  reset(pos: number): void {
    this.pos = pos;
    this.bits = 0;
    this.count = 0;
  }

  bit(): number {
    if (this.count === 0) {
      const d = this.d;
      const b = this.pos < d.length ? d[this.pos] : 0;
      if (b === 0xff && this.pos + 1 < d.length && d[this.pos + 1] !== 0x00) {
        this.bits = 0; // a marker: the data of this interval ends, stay in front of it
      } else {
        this.bits = b;
        this.pos += b === 0xff ? 2 : this.pos < d.length ? 1 : 0;
      }
      this.count = 8;
    }
    this.count--;
    return (this.bits >> this.count) & 1;
  }

  receive(length: number): number {
    let v = 0;
    for (let i = 0; i < length; i++) v = (v << 1) | this.bit();
    return v;
  }

  /** A received value of `length` bits as a signed coefficient (F.2.2.1 EXTEND). */
  receiveExtend(length: number): number {
    if (length === 0) return 0;
    const v = this.receive(length);
    return v < 1 << (length - 1) ? v - (1 << length) + 1 : v;
  }

  decode(table: Huffman): number {
    let code = 0;
    for (let length = 1; length <= 16; length++) {
      code = (code << 1) | this.bit();
      if (code <= table.maxCode[length]) return table.symbols[table.valPtr[length] + code - table.minCode[length]];
    }
    throw unsupported('JPEG data is broken (invalid Huffman code)');
  }
}

interface DcComponent extends FrameComponent {
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Blocks per row of `dc` (whole MCUs). */
  stride: number;
  /** The DC coefficient of every block, row-major. */
  dc: Int32Array;
  pred: number;
  dcTable?: Huffman;
  acTable?: Huffman;
}

/** Decode only the DC coefficients of a JPEG and scale the 1/8-size picture to the panel. */
function scaleJpegDc(d: Uint8Array, info: JpegInfo, fit: ImageFit): Rgb[] {
  const { width, height, progressive } = info;
  if (info.components.length === 2) throw unsupported('JPEG with 2 components is not supported');
  const maxH = Math.max(...info.components.map((c) => c.h));
  const maxV = Math.max(...info.components.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const components: DcComponent[] = info.components.map((c) => ({
    ...c,
    // The component is ceil(X * h / maxH) samples wide (JPEG A.1.1, as libjpeg); a non-interleaved scan codes its blocks.
    blocksPerLine: Math.ceil(Math.ceil((width * c.h) / maxH) / 8),
    blocksPerColumn: Math.ceil(Math.ceil((height * c.v) / maxV) / 8),
    stride: mcusPerLine * c.h,
    dc: new Int32Array(mcusPerLine * c.h * mcusPerColumn * c.v),
    pred: 0,
  }));
  const dcQuant: (number | undefined)[] = [];
  const dcTables: (Huffman | undefined)[] = [];
  const acTables: (Huffman | undefined)[] = [];
  let restartInterval = 0;
  let scans = 0;
  let segments = 0;
  // A crafted file can repeat scans to keep the decoder busy: decode at most JPEG_MAX_DECODE_PASSES times the blocks of
  // the frame (a baseline JPEG needs 1, a progressive DC first + refinement 2).
  const frameBlocks = components.reduce((sum, c) => sum + c.dc.length, 0);
  let decodedBlocks = 0;

  const decodeScan = (data: Uint8Array, pos: number): number => {
    const count = data[0];
    if (count < 1 || count > 4 || data.length < 4 + count * 2) throw unsupported('JPEG scan header is invalid');
    const scan = Array.from({ length: count }, (_, i) => {
      const c = components.find((candidate) => candidate.id === data[1 + i * 2]);
      if (!c) throw unsupported('JPEG scan names an unknown component');
      c.dcTable = dcTables[data[2 + i * 2] >> 4];
      c.acTable = acTables[data[2 + i * 2] & 15];
      return c;
    });
    if (++segments > JPEG_MAX_SCANS) throw unsupported(`JPEG has more than ${JPEG_MAX_SCANS} scans`);
    const ss = data[1 + count * 2];
    const se = data[2 + count * 2];
    const ah = data[3 + count * 2] >> 4;
    const al = data[3 + count * 2] & 15;
    // AC scans of a progressive JPEG only refine the detail inside the blocks: skip them.
    if (progressive && ss !== 0) return nextMarker(d, pos, true);
    if (progressive && se !== 0) throw unsupported('JPEG progressive DC scan is invalid');
    const refine = progressive && ah > 0;
    if (scan.some((c) => (!refine && !c.dcTable) || (!progressive && !c.acTable))) {
      throw unsupported('JPEG scan uses an undefined Huffman table');
    }
    const scanBlocks =
      scan.length === 1
        ? scan[0].blocksPerLine * scan[0].blocksPerColumn
        : mcusPerLine * mcusPerColumn * scan.reduce((sum, c) => sum + c.h * c.v, 0);
    decodedBlocks += scanBlocks;
    if (decodedBlocks > JPEG_MAX_DECODE_PASSES * frameBlocks) {
      throw unsupported(`JPEG scans decode more than ${JPEG_MAX_DECODE_PASSES} times the blocks of the frame`);
    }
    scans++;
    const reader = new BitReader(d, pos);
    const block = (c: DcComponent, index: number): void => {
      if (refine) {
        if (reader.bit()) c.dc[index] |= 1 << al;
        return;
      }
      const length = reader.decode(c.dcTable as Huffman);
      if (length > 16) throw unsupported('JPEG data is broken (DC length)');
      c.pred += reader.receiveExtend(length);
      c.dc[index] = progressive ? c.pred * (1 << al) : c.pred;
      if (progressive) return;
      // Sequential: decode the AC coefficients only to get past them.
      const ac = c.acTable as Huffman;
      for (let k = 1; k < 64;) {
        const rs = reader.decode(ac);
        const s = rs & 15;
        const r = rs >> 4;
        if (s === 0) {
          if (r !== 15) break;
          k += 16;
          continue;
        }
        k += r;
        reader.receive(s);
        k++;
      }
    };
    const single = scan.length === 1;
    const total = single ? scan[0].blocksPerLine * scan[0].blocksPerColumn : mcusPerLine * mcusPerColumn;
    const interval = restartInterval > 0 ? restartInterval : total;
    let unit = 0;
    let at = pos;
    while (unit < total) {
      reader.reset(at);
      for (const c of scan) c.pred = 0;
      const end = Math.min(total, unit + interval);
      for (; unit < end; unit++) {
        if (single) {
          const c = scan[0];
          block(c, Math.floor(unit / c.blocksPerLine) * c.stride + (unit % c.blocksPerLine));
          continue;
        }
        const mcuRow = Math.floor(unit / mcusPerLine);
        const mcuCol = unit % mcusPerLine;
        for (const c of scan) {
          for (let j = 0; j < c.v; j++) {
            for (let k = 0; k < c.h; k++) block(c, (mcuRow * c.v + j) * c.stride + mcuCol * c.h + k);
          }
        }
      }
      at = nextMarker(d, reader.pos, false);
      if (unit < total) {
        if (at + 1 < d.length && isRst(d[at + 1])) at += 2;
        else break; // the data ends early: the remaining blocks stay at 0 (mid grey)
      }
    }
    return nextMarker(d, at, true);
  };

  forEachSegment(d, (marker, data, next) => {
    switch (marker) {
      case 0xdb: // DQT: only the DC entry (index 0) of each table is needed
        for (let at = 0; at < data.length;) {
          const precision = data[at] >> 4;
          const id = data[at] & 15;
          const size = 1 + 64 * (precision ? 2 : 1);
          if (id > 3 || at + size > data.length) throw unsupported('JPEG quantisation table is invalid');
          dcQuant[id] = precision ? u16(data, at + 1) : data[at + 1];
          at += size;
        }
        return next;
      case 0xc4: // DHT
        for (let at = 0; at < data.length;) {
          const tableClass = data[at] >> 4;
          const id = data[at] & 15;
          if (at + 17 > data.length || tableClass > 1 || id > 3) throw unsupported('JPEG Huffman table is invalid');
          const counts = data.subarray(at + 1, at + 17);
          const n = counts.reduce((sum, c) => sum + c, 0);
          if (n > 256 || at + 17 + n > data.length) throw unsupported('JPEG Huffman table is invalid');
          const table = buildHuffman(counts, data.subarray(at + 17, at + 17 + n));
          (tableClass === 0 ? dcTables : acTables)[id] = table;
          at += 17 + n;
        }
        return next;
      case 0xdd: // DRI
        if (data.length < 2) throw unsupported('JPEG restart interval is invalid');
        restartInterval = u16(data, 0);
        return next;
      case 0xda:
        return decodeScan(data, next);
      default:
        if (SOF_SUPPORTED.has(marker) && (u16(data, 1) !== height || u16(data, 3) !== width)) {
          throw unsupported('JPEG has more than one frame');
        }
        return next;
    }
  });
  if (scans === 0) throw unsupported('JPEG has no image data');

  // The 1/8 picture: one pixel per 8x8 block of the full picture, the chroma block taken by position (subsampling).
  const gridWidth = Math.ceil(width / 8);
  const gridHeight = Math.ceil(height / 8);
  const means = components.map((c) => {
    const q = dcQuant[c.tq];
    if (q === undefined) throw unsupported('JPEG uses an undefined quantisation table');
    return (index: number): number => (c.dc[index] * q) / 8 + 128;
  });
  const scaler = new AreaScaler(gridWidth, gridHeight, fit, width / 8, height / 8);
  const rgba = new Uint8Array(gridWidth * 4).fill(255);
  const clamp = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : v);
  const sample = new Float64Array(4);
  for (let gy = 0; gy < gridHeight; gy++) {
    if (!scaler.wantsRow(gy)) continue;
    for (let gx = 0; gx < gridWidth; gx++) {
      components.forEach((c, i) => {
        const row = Math.floor((gy * c.v) / maxV);
        const col = Math.floor((gx * c.h) / maxH);
        sample[i] = means[i](row * c.stride + col);
      });
      let r = sample[0];
      let g = sample[0];
      let b = sample[0];
      if (components.length >= 3) {
        [r, g, b] = info.transform ? ycc(sample[0], sample[1], sample[2]) : [sample[0], sample[1], sample[2]];
      }
      if (components.length === 4) {
        // Adobe CMYK is stored inverted: the colour is the stored ink times the stored black / 255. YCCK converts to the
        // (not inverted) ink first, so it is inverted before (as jpeg-js).
        const k = clamp(sample[3]) / 255;
        if (info.transform) [r, g, b] = [255 - clamp(r), 255 - clamp(g), 255 - clamp(b)];
        [r, g, b] = [clamp(r) * k, clamp(g) * k, clamp(b) * k];
      }
      rgba[gx * 4] = Math.round(clamp(r));
      rgba[gx * 4 + 1] = Math.round(clamp(g));
      rgba[gx * 4 + 2] = Math.round(clamp(b));
    }
    scaler.addRow(gy, rgba);
  }
  return scaler.result();
}

/** YCbCr to RGB (JFIF, the coefficients jpeg-js uses). */
const ycc = (y: number, cb: number, cr: number): [number, number, number] => [
  y + 1.402 * (cr - 128),
  y - 0.3441363 * (cb - 128) - 0.71413636 * (cr - 128),
  y + 1.772 * (cb - 128),
];

/** Decode a small JPEG completely with jpeg-js and scale it. */
function scaleJpegFull(d: Uint8Array, info: JpegInfo, fit: ImageFit): Rgb[] {
  try {
    const jpeg = decodeJpeg(d, {
      useTArray: true,
      formatAsRGBA: true,
      colorTransform: info.transform,
      maxResolutionInMP: JPEG_FULL_DECODE_MAX_PIXELS / 1e6,
      maxMemoryUsageInMB: JPEG_MAX_MEMORY_MB,
    });
    if (jpeg.width !== info.width || jpeg.height !== info.height)
      throw unsupported('JPEG size differs from its header');
    return scaleTo16({ width: jpeg.width, height: jpeg.height, rgba: jpeg.data }, fit);
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw unsupported(`JPEG decode failed: ${messageOf(e)}`);
  }
}

/**
 * Decode a JPEG straight to the 16x16 panel: completely (jpeg-js) up to `JPEG_FULL_DECODE_MAX_PIXELS`, else at 1/8
 * scale from the DC coefficients. Throws `ImageError` (`unsupported`, `too_large`).
 */
export function scaleJpeg(d: Uint8Array, fit: ImageFit): { width: number; height: number; pixels: Rgb[] } {
  const info = readJpegInfo(d);
  const full = info.width * info.height <= JPEG_FULL_DECODE_MAX_PIXELS;
  let pixels: Rgb[];
  try {
    pixels = full ? scaleJpegFull(d, info, fit) : scaleJpegDc(d, info, fit);
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw unsupported(`JPEG decode failed: ${messageOf(e)}`);
  }
  return { width: info.width, height: info.height, pixels };
}
