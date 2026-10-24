// GIF decoding for the Show image actions (docs/architecture/images.md, #31): the first frame only. omggif parses the
// blocks (frame position, palette, transparency); the LZW data is decoded here and handed to the `AreaScaler` row by
// row, so only one frame row is held, never the whole picture (omggif's own blit needs 5 bytes per pixel).
import { GifReader } from 'omggif';
import type { Rgb } from '../protocol/status';
import { ImageError } from './imageError';
import { checkSize, messageOf, unsupported } from './imageLimits';
import { AreaScaler, type ImageFit } from './imageScale';

/** The rows of an interlaced GIF frame in the order they are stored (passes 0/8, 4/8, 2/4, 1/2). */
function rowOrder(height: number, interlaced: boolean): (stored: number) => number {
  if (!interlaced) return (stored) => stored;
  const order: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ]) {
    for (let y = start; y < height; y += step) order.push(y);
  }
  return (stored) => order[stored];
}

/**
 * Decode the LZW data at `offset` (minimum code size, then sub-blocks) and pass every index to `emit`, at most `count`.
 * A stream that ends early leaves the rest of the frame transparent, as browsers do.
 */
function decodeLzw(d: Uint8Array, offset: number, count: number, emit: (index: number) => void): void {
  let p = offset;
  const minCodeSize = d[p++];
  if (!(minCodeSize >= 1 && minCodeSize <= 8)) throw unsupported(`GIF LZW code size ${minCodeSize} is invalid`);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let first = 0;
  let block = p < d.length ? d[p++] : 0;
  let bits = 0;
  let held = 0;
  let written = 0;
  for (;;) {
    while (held < codeSize && block > 0) {
      bits |= (p < d.length ? d[p++] : 0) << held;
      held += 8;
      if (--block === 0) block = p < d.length ? d[p++] : 0;
    }
    if (held < codeSize) return;
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    held -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) return;
    let top = 0;
    if (prev < 0) {
      if (code >= clear) throw unsupported('GIF data is broken (invalid first LZW code)');
      stack[top++] = code;
    } else {
      if (code > next) throw unsupported('GIF data is broken (invalid LZW code)');
      let walk = code;
      if (code === next) {
        stack[top++] = first; // the KwKwK case: the previous string and its own first byte
        walk = prev;
      }
      while (walk >= clear) {
        stack[top++] = suffix[walk];
        walk = prefix[walk];
      }
      stack[top++] = walk;
    }
    first = stack[top - 1];
    while (top > 0) {
      if (written >= count) return;
      emit(stack[--top]);
      written++;
    }
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
}

/** Decode the first GIF frame straight to the panel. Throws `ImageError` (`unsupported`, `too_large`). */
export function scaleGif(bytes: Uint8Array, fit: ImageFit): { width: number; height: number; pixels: Rgb[] } {
  let reader: GifReader;
  try {
    reader = new GifReader(bytes);
  } catch (e) {
    throw unsupported(`GIF decode failed: ${messageOf(e)}`);
  }
  const { width, height } = reader;
  checkSize(width, height);
  try {
    const frame = reader.frameInfo(0);
    if (frame.x + frame.width > width || frame.y + frame.height > height) {
      throw unsupported(
        `GIF frame ${frame.width}x${frame.height} at ${frame.x},${frame.y} is outside the ${width}x${height} screen`,
      );
    }
    // Pixels outside the frame and transparent ones stay alpha 0 and become black when the alpha is composited.
    const scaler = new AreaScaler(width, height, fit);
    const table = new Uint8Array(256 * 4);
    const paletteSize = frame.palette_offset === null ? 0 : Math.min(256, frame.palette_size ?? 0);
    for (let i = 0; i < paletteSize; i++) {
      const at = (frame.palette_offset as number) + i * 3;
      table.set([bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, 255], i * 4);
    }
    if (frame.transparent_index !== null && frame.transparent_index !== undefined) {
      table[frame.transparent_index * 4 + 3] = 0;
    }
    const rowAt = rowOrder(frame.height, frame.interlaced);
    const row = new Uint8Array(frame.width * 4);
    let x = 0;
    let stored = 0;
    decodeLzw(bytes, frame.data_offset, frame.width * frame.height, (index) => {
      const o = x * 4;
      const t = index * 4;
      row[o] = table[t];
      row[o + 1] = table[t + 1];
      row[o + 2] = table[t + 2];
      row[o + 3] = table[t + 3];
      if (++x < frame.width) return;
      const y = frame.y + rowAt(stored++);
      if (scaler.wantsRow(y)) scaler.addRow(y, row, frame.x);
      x = 0;
    });
    if (x > 0) {
      row.fill(0, x * 4); // a stream that ends inside a row: the rest of the row is transparent
      const y = frame.y + rowAt(stored);
      if (scaler.wantsRow(y)) scaler.addRow(y, row, frame.x);
    }
    return { width, height, pixels: scaler.result() };
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw unsupported(`GIF decode failed: ${messageOf(e)}`);
  }
}
