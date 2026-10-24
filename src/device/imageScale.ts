// Scaling to the 16x16 panel for the Show image actions (docs/architecture/images.md, #31). The area average is
// accumulated pixel by pixel (`AreaScaler`), so a decoder can feed it row by row and never hold the whole picture.
import { IMAGE_PIXELS } from '../protocol/commands';
import type { Rgb } from '../protocol/status';

/** Side of the panel. */
export const PANEL_SIZE = 16;

/** How an image that is not square is fitted to the panel. */
export const IMAGE_FIT_IDS = ['cover', 'contain'] as const;
export type ImageFit = (typeof IMAGE_FIT_IDS)[number];

interface Weight {
  index: number;
  weight: number;
}

/** One axis of the placement: `count` panel cells of `step` source pixels each, from source position `start`. */
interface Axis {
  start: number;
  step: number;
  count: number;
}

const EPS = 1e-9;

/**
 * The panel cells that source pixel `p` covers on one axis and the share of each cell it covers, computed from the
 * placement (no per-pixel table, so the memory does not depend on the source size). Cell i spans
 * `start + i * step .. + step`; pixel p belongs to it when they overlap by more than a rounding error.
 */
function cellsOf(axis: Axis, p: number): Weight[] {
  const { start, step, count } = axis;
  const out: Weight[] = [];
  const first = Math.max(0, Math.floor((p - start) / step) - 1);
  const last = Math.min(count - 1, Math.floor((p + 1 - start) / step) + 1);
  for (let i = first; i <= last; i++) {
    const from = start + i * step;
    const to = from + step;
    if (p < Math.floor(from + EPS) || p >= to - EPS) continue;
    const overlap = Math.min(to, p + 1) - Math.max(from, p);
    if (overlap > EPS) out.push({ index: i, weight: overlap / step });
  }
  return out;
}

interface Placement {
  /** Source rectangle (in source pixels). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination rectangle on the panel. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

function place(width: number, height: number, fit: ImageFit): Placement {
  if (fit === 'cover') {
    const side = Math.min(width, height);
    return { sx: (width - side) / 2, sy: (height - side) / 2, sw: side, sh: side, dx: 0, dy: 0, dw: 16, dh: 16 };
  }
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const n = Math.max(1, Math.round((PANEL_SIZE * short) / long));
  const dw = width >= height ? PANEL_SIZE : n;
  const dh = width >= height ? n : PANEL_SIZE;
  return {
    sx: 0,
    sy: 0,
    sw: width,
    sh: height,
    dx: Math.floor((PANEL_SIZE - dw) / 2),
    dy: Math.floor((PANEL_SIZE - dh) / 2),
    dw,
    dh,
  };
}

/**
 * Area average onto the 16x16 panel (fractional coverage weights, so enlarging works too) in sRGB, rounded half up.
 * Transparency is composited onto black. `cover` crops a centred square, `contain` keeps the whole picture with black
 * bars. The source is a grid of `gridWidth` x `gridHeight` pixels; `logicalWidth` x `logicalHeight` (default: the
 * grid) is the size it stands for, so a grid of 8x8 block averages can stand for the full picture (the last block of a
 * row or column may be partly outside it). Pixels may be added in any order.
 */
export class AreaScaler {
  private readonly placement: Placement;
  private readonly columns: Axis;
  private readonly rows: Axis;
  private readonly sums: Float64Array;

  constructor(
    readonly gridWidth: number,
    readonly gridHeight: number,
    fit: ImageFit,
    logicalWidth = gridWidth,
    logicalHeight = gridHeight,
  ) {
    const p = place(logicalWidth, logicalHeight, fit);
    this.placement = p;
    this.columns = { start: p.sx, step: p.sw / p.dw, count: p.dw };
    this.rows = { start: p.sy, step: p.sh / p.dh, count: p.dh };
    this.sums = new Float64Array(p.dw * p.dh * 3);
  }

  /** Whether row `y` covers any panel cell (a decoder may skip the conversion of the others). */
  wantsRow(y: number): boolean {
    return y >= 0 && y < this.gridHeight && cellsOf(this.rows, y).length > 0;
  }

  /** Add the RGBA pixels of row `y`; the i-th pixel is at x = `x0 + i * dx` (Adam7 passes use a step). */
  addRow(y: number, rgba: Uint8Array, x0 = 0, dx = 1): void {
    if (y < 0 || y >= this.gridHeight) return;
    const rows = cellsOf(this.rows, y);
    if (rows.length === 0) return;
    const { start, step, count: cells } = this.columns;
    const { dw } = this.placement;
    const count = rgba.length >> 2;
    for (let cx = 0; cx < cells; cx++) {
      const from = start + cx * step;
      const to = from + step;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let x = Math.max(Math.floor(from + EPS), x0); x < to - EPS && x < this.gridWidth; x++) {
        const k = x - x0;
        if (k % dx !== 0) continue;
        const i = k / dx;
        if (i >= count) break;
        const at = i * 4;
        const alpha = rgba[at + 3];
        const overlap = Math.min(to, x + 1) - Math.max(from, x);
        if (alpha === 0 || overlap <= EPS) continue;
        const w = (overlap / step) * (alpha / 255);
        r += rgba[at] * w;
        g += rgba[at + 1] * w;
        b += rgba[at + 2] * w;
      }
      if (r === 0 && g === 0 && b === 0) continue;
      for (const row of rows) {
        const s = (row.index * dw + cx) * 3;
        this.sums[s] += r * row.weight;
        this.sums[s + 1] += g * row.weight;
        this.sums[s + 2] += b * row.weight;
      }
    }
  }

  /** The 256 panel colours, row-major, top-left first. */
  result(): Rgb[] {
    const p = this.placement;
    const out: Rgb[] = Array.from({ length: IMAGE_PIXELS }, () => ({ r: 0, g: 0, b: 0 }));
    const round = (v: number): number => Math.min(255, Math.floor(v + 0.5 + 1e-6));
    for (let cy = 0; cy < p.dh; cy++) {
      for (let cx = 0; cx < p.dw; cx++) {
        const s = (cy * p.dw + cx) * 3;
        out[(p.dy + cy) * PANEL_SIZE + p.dx + cx] = {
          r: round(this.sums[s]),
          g: round(this.sums[s + 1]),
          b: round(this.sums[s + 2]),
        };
      }
    }
    return out;
  }
}

/** Scale a decoded RGBA picture (8 bits, row-major) to the panel (`AreaScaler`). Returns 256 colours. */
export function scaleTo16(image: { width: number; height: number; rgba: Uint8Array }, fit: ImageFit): Rgb[] {
  const { width, height, rgba } = image;
  const scaler = new AreaScaler(width, height, fit);
  for (let y = 0; y < height; y++) {
    if (scaler.wantsRow(y)) scaler.addRow(y, rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  return scaler.result();
}
