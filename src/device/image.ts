// Image decoding and conversion for the Show image actions (docs/architecture/images.md, #31): PNG, JPEG and the first
// GIF frame are decoded in pure JS (ADR 0009) straight to the 16x16 panel (area average) and turned into the `44`
// payload. Memory is bounded per decode (PNG and GIF rows are streamed, large JPEGs read at 1/8 scale) and
// only one image is loaded and decoded at a time (`runImageJob`). Homey-free: bytes in, payload out. The real cause of a
// failure goes to the log, the user sees a localised `ImageError`.
import { IMAGE_MAX_COLOURS, staticImage } from '../protocol/commands';
import type { Rgb } from '../protocol/status';
import { ArgumentError, formatArgValue } from './argumentError';
import { scaleGif } from './imageGif';
import { unsupported } from './imageLimits';
import { scaleJpeg } from './imageJpeg';
import { scalePng } from './imagePng';
import { IMAGE_FIT_IDS, type ImageFit } from './imageScale';

export { IMAGE_ERROR_KINDS, ImageError } from './imageError';
export type { ImageErrorKind } from './imageError';
export {
  IMAGE_LOAD_TIMEOUT_MS,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_SIDE,
  JPEG_FULL_DECODE_MAX_PIXELS,
  JPEG_MAX_MEMORY_MB,
  tooLarge,
} from './imageLimits';
export { AreaScaler, IMAGE_FIT_IDS, PANEL_SIZE, scaleTo16 } from './imageScale';
export type { ImageFit } from './imageScale';

/** Validate the fit id of a Flow card. Throws `ArgumentError` (a `RangeError`). */
export function parseImageFitId(value: unknown): ImageFit {
  const id = IMAGE_FIT_IDS.find((candidate) => candidate === value);
  if (!id) {
    throw new ArgumentError(
      `fit must be one of ${IMAGE_FIT_IDS.join(', ')}, got ${String(value)}`,
      'invalid_choice',
      'fit',
      { value: formatArgValue(value), allowed: IMAGE_FIT_IDS.join(', ') },
    );
  }
  return id;
}

export type ImageFormat = 'png' | 'jpeg' | 'gif';

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

/** The image format by its magic bytes, `undefined` for anything else. */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  )
    return 'gif';
  return undefined;
}

/** A picture scaled to the panel: its format and original size, and the 256 panel colours (row-major). */
export interface ScaledImage {
  format: ImageFormat;
  width: number;
  height: number;
  pixels: Rgb[];
}

/**
 * Decode PNG, JPEG or the first GIF frame and scale it to the panel. The size is checked from the header before the
 * pixels are decoded. Rejects with `ImageError` (`unsupported` for other formats and broken files, `too_large` over
 * `IMAGE_MAX_PIXELS`).
 */
export async function scaleImage(bytes: Uint8Array, fit: ImageFit): Promise<ScaledImage> {
  switch (detectImageFormat(bytes)) {
    case 'png':
      return { format: 'png', ...(await scalePng(bytes, fit)) };
    case 'jpeg':
      return { format: 'jpeg', ...scaleJpeg(bytes, fit) };
    case 'gif':
      return { format: 'gif', ...scaleGif(bytes, fit) };
    default:
      throw unsupported('not a PNG, JPEG or GIF image');
  }
}

/** The exact colours in first-seen order and the palette index of every pixel. 16x16 gives at most 256 colours. */
export function toPalette(pixels: readonly Rgb[]): { palette: Rgb[]; indices: number[] } {
  const seen = new Map<number, number>();
  const palette: Rgb[] = [];
  const indices = pixels.map((c) => {
    const key = (c.r << 16) | (c.g << 8) | c.b;
    let index = seen.get(key);
    if (index === undefined) {
      index = palette.length;
      seen.set(key, index);
      palette.push({ r: c.r, g: c.g, b: c.b });
    }
    return index;
  });
  return { palette, indices };
}

/** The `44` payload of a picture and what was in it (for the log). */
export interface ImageCommand {
  /** 1036 bytes: always 256 palette entries (padded with black), 8 bits per pixel. */
  payload: Uint8Array;
  /** Distinct colours of the 16x16 picture. */
  colours: number;
  format: ImageFormat;
  width: number;
  height: number;
}

/** Decode `bytes`, scale to 16x16 and build the `44` payload (palette padded to 256 entries, protocol section 4). */
export async function buildImageCommand(bytes: Uint8Array, fit: ImageFit): Promise<ImageCommand> {
  const image = await scaleImage(bytes, fit);
  const { palette, indices } = toPalette(image.pixels);
  const colours = palette.length;
  while (palette.length < IMAGE_MAX_COLOURS) palette.push({ r: 0, g: 0, b: 0 });
  return {
    payload: staticImage({ palette, pixels: indices }),
    colours,
    format: image.format,
    width: image.width,
    height: image.height,
  };
}

/**
 * How long the image queue waits for one job before the next may start (a backstop: downloads and token reads have their
 * own 10 s deadline and a decode takes a second or two on Homey). The late job still finishes for its own caller.
 */
export const IMAGE_JOB_MAX_MS = 30_000;

/** Settles (never rejects) when the last queued job has finished or run out of time. */
let imageQueue: Promise<void> = Promise.resolve();

/**
 * Run `job` (load and decode one image) after every job queued before it has finished, for the whole app: two cards
 * that run at once never hold two pictures in memory. The result (or error) of `job` is passed through. A job that
 * takes longer than `IMAGE_JOB_MAX_MS` no longer holds up the jobs behind it.
 */
export function runImageJob<T>(job: () => Promise<T>): Promise<T> {
  const previousDone = imageQueue;
  const run = previousDone.then(job);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = previousDone.then(
    () =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, IMAGE_JOB_MAX_MS);
      }),
  );
  const done = run.then(
    () => undefined,
    () => undefined,
  );
  imageQueue = Promise.race([done, limit]).finally(() => clearTimeout(timer));
  return run;
}
