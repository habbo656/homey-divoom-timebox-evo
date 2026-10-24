// Limits of the Show image actions and the errors shared by the decoders (docs/architecture/images.md, #31). Kept apart
// from `image.ts` so that the PNG and JPEG decoders can use them without an import cycle.
import { ImageError } from './imageError';

/** Largest image accepted (download or token stream), in bytes. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Largest image accepted, in pixels (width x height), checked from the header before decoding. The decoders never hold
 * the whole picture (PNG and GIF rows are streamed, large JPEGs are read at 1/8 scale): it bounds the decode time and
 * the small per-block JPEG arrays, not a picture buffer.
 */
export const IMAGE_MAX_PIXELS = 3840 * 2160;
/**
 * Longest side accepted, in pixels, checked with `IMAGE_MAX_PIXELS` before anything is allocated: a row buffer (PNG
 * scanline, GIF frame row) is at most this wide, so an extreme proportion (8294400 x 1) cannot allocate a huge row.
 */
export const IMAGE_MAX_SIDE = 16_384;
/** A download or token read is given up after this long. */
export const IMAGE_LOAD_TIMEOUT_MS = 10_000;
/**
 * JPEGs up to this many pixels are decoded completely (jpeg-js, about 60 bytes per pixel at the peak); larger ones are
 * read at 1/8 scale from the DC coefficients only (`imageJpeg.ts`), which needs a few bytes per 8x8 block.
 */
export const JPEG_FULL_DECODE_MAX_PIXELS = 512 * 512;
/** Memory jpeg-js may use for a full decode (backstop; a 512x512 JPEG needs about 6 MB by its own count). */
export const JPEG_MAX_MEMORY_MB = 16;

/** The localised "too large" error (limits in the message: `max_mb`, `max_mp`, `max_side`). */
export const tooLarge = (message: string): ImageError =>
  new ImageError(message, 'too_large', {
    max_mb: IMAGE_MAX_BYTES / (1024 * 1024),
    max_mp: Math.round((IMAGE_MAX_PIXELS / 1e6) * 10) / 10,
    max_side: IMAGE_MAX_SIDE,
  });

/** The localised "unsupported" error (other formats and broken files). */
export const unsupported = (message: string): ImageError => new ImageError(message, 'unsupported');

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Reject a size that is empty or over `IMAGE_MAX_PIXELS` or `IMAGE_MAX_SIDE` (`unsupported` / `too_large`). */
export function checkSize(width: number, height: number): void {
  if (!(width >= 1 && height >= 1)) throw unsupported(`invalid image size ${width}x${height}`);
  if (width * height > IMAGE_MAX_PIXELS) {
    throw tooLarge(`image ${width}x${height} exceeds ${IMAGE_MAX_PIXELS} pixels`);
  }
  if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) {
    throw tooLarge(`image ${width}x${height} has a side over ${IMAGE_MAX_SIDE} pixels`);
  }
}
