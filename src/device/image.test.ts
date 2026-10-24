import { crc32, deflateSync } from 'node:zlib';
import { GifReader, GifWriter } from 'omggif';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import type { Rgb } from '../protocol/status';
import { translator } from './__fixtures__/translator';
import { localiseError } from './argumentError';
import {
  buildImageCommand,
  detectImageFormat,
  IMAGE_JOB_MAX_MS,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_SIDE,
  AreaScaler,
  ImageError,
  JPEG_FULL_DECODE_MAX_PIXELS,
  parseImageFitId,
  runImageJob,
  scaleImage,
  scaleTo16,
  toPalette,
} from './image';

type Painter = (x: number, y: number) => [number, number, number, number?];

function rgbaOf(width: number, height: number, paint: Painter): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = paint(x, y);
      out.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return out;
}

const png = (width: number, height: number, paint: Painter): Uint8Array =>
  new Uint8Array(
    PNG.sync.write(Object.assign(new PNG({ width, height }), { data: Buffer.from(rgbaOf(width, height, paint)) })),
  );
const jpeg = (width: number, height: number, paint: Painter): Uint8Array =>
  new Uint8Array(encodeJpeg({ width, height, data: rgbaOf(width, height, paint) }, 95).data);
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

/** A PNG with the given colour type, bit depth and interlace method from already filtered raw scanlines. */
function rawPng(
  width: number,
  height: number,
  colorType: number,
  bitDepth: number,
  interlace: number,
  scanlines: Buffer,
  palette?: number[],
  transparency?: number[],
): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([bitDepth, colorType, 0, 0, interlace], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      ...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
      ...(transparency ? [chunk('tRNS', Buffer.from(transparency))] : []),
      chunk('IDAT', deflateSync(scanlines)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** Filtered 16x16 scanlines of a 16-bit RGB image. */
function rowsOf16(pixel: (x: number, y: number) => number[]): Buffer {
  return Buffer.concat(
    Array.from({ length: 16 }, (_, y) =>
      Buffer.from([0, ...Array.from({ length: 16 }, (_, x) => pixel(x, y).flatMap((v) => [v, v])).flat()]),
    ),
  );
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

const image = (width: number, height: number, paint: Painter) => ({
  width,
  height,
  rgba: rgbaOf(width, height, paint),
});

const goldenPaint: Painter = (x, y) => (y === 0 ? [0, 0, 255] : x < 8 ? [255, 0, 0] : [0, 255, 0]);
const at = (pixels: readonly Rgb[], x: number, y: number): Rgb => pixels[y * 16 + x];
const red: Rgb = { r: 255, g: 0, b: 0 };
const black: Rgb = { r: 0, g: 0, b: 0 };

describe('detectImageFormat', () => {
  it('recognises the three formats by their magic bytes', () => {
    expect(detectImageFormat(png(1, 1, () => [0, 0, 0]))).toBe('png');
    expect(detectImageFormat(jpeg(8, 8, () => [0, 0, 0]))).toBe('jpeg');
    expect(detectImageFormat(Buffer.from('GIF87a....'))).toBe('gif');
    expect(detectImageFormat(Buffer.from('GIF89a....'))).toBe('gif');
  });

  it('returns undefined for other data', () => {
    expect(detectImageFormat(new Uint8Array(0))).toBeUndefined();
    expect(detectImageFormat(Buffer.from('<html></html>'))).toBeUndefined();
    expect(detectImageFormat(Buffer.from('RIFF....WEBPVP8 '))).toBeUndefined();
    expect(detectImageFormat(Buffer.from('GIF90a'))).toBeUndefined();
  });
});

describe('parseImageFitId', () => {
  it('accepts cover and contain', () => {
    expect(parseImageFitId('cover')).toBe('cover');
    expect(parseImageFitId('contain')).toBe('contain');
  });

  it('rejects everything else with a localised choice error', () => {
    for (const bad of ['stretch', '', undefined, null, 1]) expect(() => parseImageFitId(bad)).toThrow(RangeError);
    try {
      parseImageFitId('stretch');
    } catch (e) {
      expect((localiseError(e, translator('en')) as Error).message).toBe(
        'Fit: "stretch" is not a valid choice. Allowed are: cover, contain.',
      );
      expect((localiseError(e, translator('de')) as Error).message).toBe(
        'Einpassen: "stretch" ist keine gültige Auswahl. Erlaubt sind: cover, contain.',
      );
    }
  });
});

describe('scaleTo16', () => {
  it('keeps a 16x16 picture as it is', () => {
    const pixels = scaleTo16(image(16, 16, goldenPaint), 'cover');
    expect(at(pixels, 3, 0)).toEqual({ r: 0, g: 0, b: 255 });
    expect(at(pixels, 3, 5)).toEqual(red);
    expect(at(pixels, 12, 5)).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('averages 2x2 blocks of a 32x32 picture', () => {
    const pixels = scaleTo16(
      image(32, 32, (x) => (x % 2 === 0 ? [200, 100, 0] : [100, 50, 0])),
      'cover',
    );
    expect(at(pixels, 0, 0)).toEqual({ r: 150, g: 75, b: 0 });
  });

  it('averages a one-pixel checkerboard to 128 (half rounds up)', () => {
    const pixels = scaleTo16(
      image(32, 32, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0])),
      'cover',
    );
    expect(new Set(pixels.map((c) => `${c.r},${c.g},${c.b}`))).toEqual(new Set(['128,128,128']));
  });

  it('contain: 160x90 fills rows 3..11 and leaves black bars', () => {
    const pixels = scaleTo16(
      image(160, 90, () => [255, 0, 0]),
      'contain',
    );
    for (let y = 0; y < 16; y++) {
      const expected = y >= 3 && y <= 11 ? red : black;
      expect([y, at(pixels, 0, y), at(pixels, 15, y)]).toEqual([y, expected, expected]);
    }
  });

  it('contain: 90x160 fills columns 3..11', () => {
    const pixels = scaleTo16(
      image(90, 160, () => [255, 0, 0]),
      'contain',
    );
    for (let x = 0; x < 16; x++) {
      const expected = x >= 3 && x <= 11 ? red : black;
      expect([x, at(pixels, x, 0), at(pixels, x, 15)]).toEqual([x, expected, expected]);
    }
  });

  it('cover: 160x90 crops a centred square and fills the panel', () => {
    // Left of the square (x < 35) is blue, the square (35..125) red, right of it blue.
    const pixels = scaleTo16(
      image(160, 90, (x) => (x >= 35 && x < 125 ? [255, 0, 0] : [0, 0, 255])),
      'cover',
    );
    expect(pixels.every((c) => c.r === 255 && c.b === 0)).toBe(true);
  });

  it('upscales a single pixel to the whole panel', () => {
    const pixels = scaleTo16(
      image(1, 1, () => [10, 20, 30]),
      'cover',
    );
    expect(new Set(pixels.map((c) => `${c.r},${c.g},${c.b}`))).toEqual(new Set(['10,20,30']));
  });

  it('contain: a very thin picture still gets one row', () => {
    const pixels = scaleTo16(
      image(1000, 2, () => [255, 0, 0]),
      'contain',
    );
    const rows = Array.from({ length: 16 }, (_, y) => at(pixels, 5, y).r === 255);
    expect(rows.filter(Boolean)).toHaveLength(1);
  });

  it('composites transparency onto black', () => {
    const pixels = scaleTo16(
      image(16, 16, (x) => (x < 8 ? [255, 0, 0, 0] : [255, 0, 0, 128])),
      'cover',
    );
    expect(at(pixels, 0, 0)).toEqual(black);
    expect(at(pixels, 15, 0)).toEqual({ r: 128, g: 0, b: 0 });
  });
});

describe('toPalette', () => {
  it('keeps the colours in first-seen order', () => {
    const blue = { r: 0, g: 0, b: 255 };
    const { palette, indices } = toPalette([blue, red, blue, red, black]);
    expect(palette).toEqual([blue, red, black]);
    expect(indices).toEqual([0, 1, 0, 1, 2]);
  });
});

describe('scaleImage', () => {
  it('decodes a PNG', async () => {
    const d = await scaleImage(png(16, 16, goldenPaint), 'cover');
    expect([d.format, d.width, d.height]).toEqual(['png', 16, 16]);
    expect(at(d.pixels, 0, 0)).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('decodes a palette PNG, a 16-bit PNG and an interlaced PNG', async () => {
    const palette = [
      [0, 0, 255],
      [255, 0, 0],
      [0, 255, 0],
    ];
    const indexAt = (x: number, y: number) => (y === 0 ? 0 : x < 8 ? 1 : 2);
    const check = async (bytes: Uint8Array) => {
      const { pixels } = await scaleImage(bytes, 'cover');
      expect(at(pixels, 3, 0)).toEqual({ r: 0, g: 0, b: 255 });
      expect(at(pixels, 3, 5)).toEqual(red);
      expect(at(pixels, 12, 5)).toEqual({ r: 0, g: 255, b: 0 });
    };
    const rows = (ys: number[], xs: number[], pixel: (x: number, y: number) => number[]) =>
      Buffer.concat(ys.map((y) => Buffer.from([0, ...xs.flatMap((x) => pixel(x, y))])));
    const all = Array.from({ length: 16 }, (_, i) => i);
    // Palette PNG, 8 bits per pixel.
    await check(
      rawPng(
        16,
        16,
        3,
        8,
        0,
        rows(all, all, (x, y) => [indexAt(x, y)]),
        palette.flat(),
      ),
    );
    // 16-bit RGB PNG (high byte carries the value).
    await check(
      rawPng(
        16,
        16,
        2,
        16,
        0,
        rowsOf16((x, y) => palette[indexAt(x, y)]),
      ),
    );
    // Adam7 interlaced palette PNG.
    const interlaced = Buffer.concat(
      ADAM7.map(([x0, y0, dx, dy]) => {
        const xs = all.filter((x) => x >= x0 && (x - x0) % dx === 0);
        const ys = all.filter((y) => y >= y0 && (y - y0) % dy === 0);
        return xs.length && ys.length ? rows(ys, xs, (x, y) => [indexAt(x, y)]) : Buffer.alloc(0);
      }),
    );
    await check(rawPng(16, 16, 3, 8, 1, interlaced, palette.flat()));
  });

  it('decodes a JPEG within a small tolerance', async () => {
    const d = await scaleImage(
      jpeg(16, 16, () => [200, 40, 90]),
      'cover',
    );
    expect(d.format).toBe('jpeg');
    const [r, g, b] = [d.pixels[0].r, d.pixels[0].g, d.pixels[0].b];
    for (const [i, v] of [r, g, b].entries()) expect(Math.abs(v - [200, 40, 90][i])).toBeLessThanOrEqual(3);
  });

  it('decodes the first frame of a GIF, honouring the frame offset', async () => {
    const buf = new Uint8Array(1000);
    const gif = new GifWriter(buf, 16, 16, { palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff] });
    gif.addFrame(4, 6, 8, 8, new Array(64).fill(1));
    gif.addFrame(0, 0, 16, 16, new Array(256).fill(2));
    const d = await scaleImage(buf.subarray(0, gif.end()), 'cover');
    expect([d.format, d.width, d.height]).toEqual(['gif', 16, 16]);
    expect(at(d.pixels, 4, 6)).toEqual(red);
    expect(at(d.pixels, 11, 13)).toEqual(red);
    expect(at(d.pixels, 0, 0)).toEqual(black); // outside the frame: transparent
    expect(at(d.pixels, 12, 6)).toEqual(black);
  });

  it('treats a transparent GIF pixel as black after scaling', async () => {
    const buf = new Uint8Array(1000);
    const gif = new GifWriter(buf, 2, 2, { palette: [0x000000, 0xff0000] });
    gif.addFrame(0, 0, 2, 2, [1, 0, 1, 0], { transparent: 0 });
    const { pixels } = await scaleImage(buf.subarray(0, gif.end()), 'cover');
    expect(at(pixels, 0, 0)).toEqual(red);
    expect(at(pixels, 15, 0)).toEqual(black);
  });

  it.each([
    ['empty', new Uint8Array(0)],
    ['HTML', Buffer.from('<!doctype html><html></html>')],
    ['WebP', Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')],
    ['truncated PNG', png(16, 16, goldenPaint).subarray(0, 40)],
    ['PNG magic only', Uint8Array.of(0x89, 0x50, 0x4e, 0x47)],
    ['truncated JPEG', jpeg(16, 16, goldenPaint).subarray(0, 100)],
    ['truncated GIF', Buffer.from('GIF89a')],
  ])('rejects %s as unsupported', async (_name, bytes) => {
    const error = await scaleImage(bytes, 'cover').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageError);
    expect((error as ImageError).kind).toBe('unsupported');
  });

  it('rejects a 5000x5000 PNG header as too_large before decoding', async () => {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12);
    header.writeUInt32BE(5000, 16);
    header.writeUInt32BE(5000, 20);
    expect(5000 * 5000).toBeGreaterThan(IMAGE_MAX_PIXELS);
    const error = await scaleImage(header, 'cover').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageError);
    expect((error as ImageError).kind).toBe('too_large');
    expect((error as ImageError).params).toEqual({ max_mb: 5, max_mp: 8.3, max_side: 16384 });
  });

  it('rejects an extreme proportion (8294400x1, 1x8294400) by the side limit before anything is allocated', async () => {
    for (const [width, height] of [
      [8_294_400, 1],
      [1, 8_294_400],
      [IMAGE_MAX_SIDE + 1, 1],
    ]) {
      const scanlines = Buffer.alloc(height * (1 + Math.ceil(width / 8)));
      const bytes = rawPng(width, height, 0, 1, 0, scanlines);
      expect(width * height).toBeLessThanOrEqual(IMAGE_MAX_PIXELS);
      await expect(scaleImage(bytes, 'contain')).rejects.toThrow(
        expect.objectContaining({ kind: 'too_large', message: expect.stringContaining('side over 16384') }),
      );
    }
    const atLimit = rawPng(IMAGE_MAX_SIDE, 1, 0, 8, 0, Buffer.from([0, ...new Array(IMAGE_MAX_SIDE).fill(255)]));
    const { pixels } = await scaleImage(atLimit, 'contain');
    expect(at(pixels, 0, 7)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('keeps no per-pixel table: a scaler for a huge grid is created and fed in no time', () => {
    const started = Date.now();
    const scaler = new AreaScaler(2 ** 31, 2 ** 20, 'cover');
    scaler.addRow(2 ** 19, Uint8Array.of(255, 0, 0, 255), 2 ** 30);
    expect(scaler.result()).toHaveLength(256);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['interlaced', 1],
    ['non-interlaced', 0],
  ])('rejects a %s PNG that inflates far beyond what its header allows, fast', async (_name, interlace) => {
    const bomb = rawPng(16, 16, 2, 8, interlace, Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100_000);
    const started = Date.now();
    await expect(scaleImage(bomb, 'cover')).rejects.toThrow(
      expect.objectContaining({ kind: 'unsupported', message: expect.stringContaining('larger than its header') }),
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  describe('PNG chunk structure', () => {
    const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = (width: number, height: number): Buffer => {
      const data = Buffer.alloc(13);
      data.writeUInt32BE(width, 0);
      data.writeUInt32BE(height, 4);
      data.set([8, 6, 0, 0, 0], 8);
      return chunk('IHDR', data);
    };
    const scanlines = (width: number, height: number): Buffer => Buffer.alloc(height * (1 + width * 4));
    const idat = (width: number, height: number): Buffer => chunk('IDAT', deflateSync(scanlines(width, height)));
    const iend = chunk('IEND', Buffer.alloc(0));
    const png = (...chunks: Buffer[]): Uint8Array => new Uint8Array(Buffer.concat([SIGNATURE, ...chunks]));
    const expectUnsupported = (bytes: Uint8Array, text: string) =>
      expect(scaleImage(bytes, 'cover')).rejects.toThrow(
        expect.objectContaining({ kind: 'unsupported', message: expect.stringContaining(text) }),
      );

    it('decodes the plain chunk sequence and ignores other chunks and a split IDAT', async () => {
      const data = deflateSync(scanlines(4, 4));
      const half = data.length >> 1;
      const bytes = png(
        ihdr(4, 4),
        chunk('tEXt', Buffer.from('a\0b')),
        chunk('IDAT', data.subarray(0, half)),
        chunk('IDAT', data.subarray(half)),
        iend,
      );
      await expect(scaleImage(bytes, 'cover')).resolves.toMatchObject({ width: 4, height: 4 });
    });

    it('rejects a second IHDR that would change the size after the check, fast', async () => {
      const bytes = png(ihdr(16, 16), ihdr(20000, 20000), idat(16, 16), iend);
      const started = Date.now();
      await expectUnsupported(bytes, 'more than one IHDR');
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('rejects a PNG that does not start with an IHDR (IDAT or another chunk first)', async () => {
      await expectUnsupported(png(idat(16, 16), ihdr(16, 16), iend), 'does not start with an IHDR');
      await expectUnsupported(
        png(chunk('tEXt', Buffer.from('x\0y')), ihdr(16, 16), idat(16, 16), iend),
        'does not start with an IHDR',
      );
    });

    it('rejects a chunk length that reaches past the end of the file', async () => {
      const whole = Buffer.concat([ihdr(16, 16), idat(16, 16), iend]);
      await expectUnsupported(png(whole.subarray(0, whole.length - 20)), 'reaches past the end');
      const lying = Buffer.from(idat(4, 4));
      lying.writeUInt32BE(0x7fffffff, 0);
      await expectUnsupported(png(ihdr(4, 4), lying, iend), 'reaches past the end');
    });

    it('rejects missing image data, data that ends early, broken data and an unknown filter type', async () => {
      await expectUnsupported(png(ihdr(4, 4), iend), 'no image data');
      await expectUnsupported(png(ihdr(4, 4), chunk('IDAT', deflateSync(scanlines(4, 3))), iend), 'ends early');
      await expectUnsupported(png(ihdr(4, 4), chunk('IDAT', Buffer.from('not zlib')), iend), 'broken');
      const badFilter = scanlines(4, 4);
      badFilter[0] = 5;
      await expectUnsupported(png(ihdr(4, 4), chunk('IDAT', deflateSync(badFilter)), iend), 'filter type 5');
    });

    it('rejects an invalid header and a palette PNG without a palette', async () => {
      const header = (bitDepth: number, colourType: number) => {
        const data = Buffer.alloc(13);
        data.writeUInt32BE(4, 0);
        data.writeUInt32BE(4, 4);
        data.set([bitDepth, colourType, 0, 0, 0], 8);
        return chunk('IHDR', data);
      };
      await expectUnsupported(png(header(16, 3), idat(4, 4), iend), 'invalid PNG header');
      await expectUnsupported(png(header(4, 2), idat(4, 4), iend), 'invalid PNG header');
      await expectUnsupported(png(header(8, 3), idat(4, 4), iend), 'PLTE');
    });
  });

  it('rejects a GIF whose first frame is far larger than the screen, before allocating it', async () => {
    const gif = Uint8Array.from([
      ...Buffer.from('GIF89a'),
      16,
      0,
      16,
      0,
      0x80,
      0,
      0, // 16x16 screen, 2-colour global table
      0,
      0,
      0,
      255,
      255,
      255,
      0x2c,
      0,
      0,
      0,
      0,
      0xff,
      0xff,
      0xff,
      0xff,
      0, // frame 0: 65535 x 65535
      2,
      2,
      0x4c,
      0x01,
      0,
      0x3b,
    ]);
    const started = Date.now();
    await expect(scaleImage(gif, 'cover')).rejects.toThrow(
      expect.objectContaining({ kind: 'unsupported', message: expect.stringContaining('outside') }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects a GIF frame that reaches outside the screen', async () => {
    const buf = new Uint8Array(1000);
    const gif = new GifWriter(buf, 8, 8, { palette: [0x000000, 0xff0000] });
    gif.addFrame(4, 4, 8, 8, new Array(64).fill(1));
    await expect(scaleImage(buf.subarray(0, gif.end()), 'cover')).rejects.toThrow(
      expect.objectContaining({ kind: 'unsupported', message: expect.stringContaining('outside') }),
    );
  });

  it('rejects a huge JPEG and a huge GIF as too_large', async () => {
    // SOI + SOF0 for 5000x5000, 3 components: refused from the frame header.
    const sof = Uint8Array.of(
      0xff,
      0xd8,
      0xff,
      0xc0,
      0,
      17,
      8,
      0x13,
      0x88,
      0x13,
      0x88,
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    );
    await expect(scaleImage(sof, 'cover')).rejects.toThrow(expect.objectContaining({ kind: 'too_large' }));
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x88, 0x13, 0x88, 0x13, 0, 0, 0])]);
    await expect(scaleImage(gif, 'cover')).rejects.toThrow(expect.objectContaining({ kind: 'too_large' }));
  });
});

/** RGBA noise (alpha included) from a fixed seed. */
function noise(width: number, height: number, seed: number, opaque = false): Uint8Array {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s >>> 24;
  };
  return rgbaOf(width, height, () => [next(), next(), next(), opaque ? 255 : next()]);
}

describe('PNG decoder', () => {
  it.each([
    [0, 8],
    [0, 16],
    [2, 8],
    [2, 16],
    [4, 8],
    [4, 16],
    [6, 8],
    [6, 16],
  ])(
    'matches pngjs for colour type %i at %i bits (all filter types), cover and contain',
    async (colorType, bitDepth) => {
      const data = Buffer.from(noise(37, 23, colorType * 31 + bitDepth));
      const bytes = new Uint8Array(
        PNG.sync.write(Object.assign(new PNG({ width: 37, height: 23 }), { data }), {
          colorType: colorType as 0 | 2 | 4 | 6,
          bitDepth: bitDepth as 8 | 16,
          inputColorType: 6,
          inputHasAlpha: true,
        }),
      );
      const reference = PNG.sync.read(Buffer.from(bytes));
      for (const fit of ['cover', 'contain'] as const) {
        const { pixels } = await scaleImage(bytes, fit);
        expect(pixels).toEqual(scaleTo16({ width: 37, height: 23, rgba: new Uint8Array(reference.data) }, fit));
      }
    },
  );

  it('applies tRNS to grey, RGB and palette images', async () => {
    const row = (...bytes: number[]) => Buffer.from([0, ...bytes]);
    // 2x1 grey: value 7 is transparent.
    const grey = await scaleImage(rawPng(2, 1, 0, 8, 0, row(7, 200), undefined, [0, 7]), 'contain');
    expect(at(grey.pixels, 0, 8)).toEqual(black);
    expect(at(grey.pixels, 15, 8)).toEqual({ r: 200, g: 200, b: 200 });
    // 2x1 RGB: 1,2,3 is transparent.
    const rgb = await scaleImage(
      rawPng(2, 1, 2, 8, 0, row(1, 2, 3, 9, 8, 7), undefined, [0, 1, 0, 2, 0, 3]),
      'contain',
    );
    expect(at(rgb.pixels, 0, 8)).toEqual(black);
    expect(at(rgb.pixels, 15, 8)).toEqual({ r: 9, g: 8, b: 7 });
    // 2x1 palette: entry 0 half transparent, entry 1 opaque (no tRNS entry).
    const palette = await scaleImage(rawPng(2, 1, 3, 8, 0, row(0, 1), [200, 0, 0, 0, 0, 100], [128]), 'contain');
    expect(at(palette.pixels, 0, 8)).toEqual({ r: 100, g: 0, b: 0 });
    expect(at(palette.pixels, 15, 8)).toEqual({ r: 0, g: 0, b: 100 });
  });

  it('scales 1, 2 and 4-bit grey and packed palette indices', async () => {
    // 4x1 pictures, the leftmost pixel is the brightest value of the bit depth, the others 0.
    for (const [bitDepth, firstByte] of [
      [1, 0b1000_0000],
      [2, 0b1100_0000],
      [4, 0b1111_0000],
    ]) {
      const { pixels } = await scaleImage(rawPng(4, 1, 0, bitDepth, 0, Buffer.from([0, firstByte, 0])), 'contain');
      expect([bitDepth, at(pixels, 0, 8), at(pixels, 15, 8)]).toEqual([bitDepth, { r: 255, g: 255, b: 255 }, black]);
    }
    // 2-bit palette indices 0..3 in one byte.
    const indexed = await scaleImage(
      rawPng(4, 1, 3, 2, 0, Buffer.from([0, 0b00_01_10_11]), [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
      'contain',
    );
    expect([0, 4, 8, 12].map((x) => at(indexed.pixels, x, 8))).toEqual([
      black,
      red,
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ]);
  });

  it('decodes a 4K PNG row by row without holding the picture', async () => {
    const width = 3840;
    const height = 2160;
    const scanlines = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++)
      scanlines.fill(y < height / 2 ? 255 : 0, y * (1 + width * 3) + 1, (y + 1) * (1 + width * 3));
    const { pixels } = await scaleImage(rawPng(width, height, 2, 8, 0, scanlines), 'contain');
    expect(at(pixels, 0, 4)).toEqual({ r: 255, g: 255, b: 255 });
    expect(at(pixels, 0, 11)).toEqual(black);
  });
});

/** Huffman codes (canonical, JPEG Annex C) of a table given by its counts per length and its symbols. */
function huffmanCodes(counts: readonly number[], symbols: readonly number[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) out.set(symbols[k++], [code++, length]);
    code <<= 1;
  }
  return out;
}

/** The standard DC table (JPEG Annex K.3). */
const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_SYMBOLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CODES = huffmanCodes(DC_COUNTS, DC_SYMBOLS);

class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private n = 0;

  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        if (this.acc === 0xff) this.bytes.push(0);
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  /** Pad the last byte with 1 bits. */
  flush(): void {
    while (this.n > 0) this.write(1, 1);
  }

  dc(diff: number): void {
    const size = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
    const [code, length] = DC_CODES.get(size) as [number, number];
    this.write(code, length);
    if (size > 0) this.write(diff > 0 ? diff : diff + (1 << size) - 1, size);
  }
}

interface DcSpec {
  id: number;
  h: number;
  v: number;
  /** The mean (0..255) of the block at block column `bx`, row `by` of this component. */
  mean: (bx: number, by: number) => number;
}

/**
 * A JPEG that carries only DC coefficients (every block is flat): the quantiser of DC is 8, so the coefficient is the
 * block mean - 128. Baseline (one interleaved scan, AC = EOB) or progressive (DC first with Al = 1, an AC scan of
 * arbitrary bytes with a stuffed FF and a restart marker, DC refinement).
 */
function dcJpeg(opts: {
  width: number;
  height: number;
  components: DcSpec[];
  progressive?: boolean;
  restartInterval?: number;
  adobe?: number;
  sofMarker?: number;
  precision?: number;
  /** Baseline: one non-interleaved scan per component instead of one interleaved scan. */
  separate?: boolean;
}): Uint8Array {
  const { width, height, components } = opts;
  const out: number[] = [0xff, 0xd8];
  const segment = (marker: number, data: number[]) =>
    out.push(0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255, ...data);
  if (opts.adobe !== undefined) segment(0xee, [...Buffer.from('Adobe'), 0, 100, 0, 0, 0, 0, opts.adobe]);
  segment(0xdb, [0, 8, ...new Array(63).fill(1)]);
  const count = components.length;
  segment(opts.sofMarker ?? (opts.progressive ? 0xc2 : 0xc0), [
    opts.precision ?? 8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    count,
    ...components.flatMap((c) => [c.id, (c.h << 4) | c.v, 0]),
  ]);
  segment(0xc4, [0x00, ...DC_COUNTS, ...DC_SYMBOLS]);
  segment(0xc4, [0x10, 1, ...new Array(15).fill(0), 0x00]); // AC table 0: only EOB, code "0"
  if (opts.restartInterval) segment(0xdd, [opts.restartInterval >> 8, opts.restartInterval & 255]);
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const coefficient = (c: DcSpec, bx: number, by: number) => Math.round(c.mean(bx, by)) - 128;
  const scan = (
    header: number[],
    block: (w: BitWriter, c: DcSpec, coef: number, pred: number[], i: number) => void,
  ) => {
    segment(0xda, header);
    const w = new BitWriter();
    const pred = components.map(() => 0);
    let restarts = 0;
    for (let mcu = 0; mcu < mcusPerLine * mcusPerColumn; mcu++) {
      if (opts.restartInterval && mcu > 0 && mcu % opts.restartInterval === 0) {
        w.flush();
        w.bytes.push(0xff, 0xd0 + (restarts++ % 8));
        pred.fill(0);
      }
      const row = Math.floor(mcu / mcusPerLine);
      const col = mcu % mcusPerLine;
      components.forEach((c, i) => {
        for (let j = 0; j < c.v; j++) {
          for (let k = 0; k < c.h; k++) block(w, c, coefficient(c, col * c.h + k, row * c.v + j), pred, i);
        }
      });
    }
    w.flush();
    out.push(...w.bytes);
  };
  const separateScan = (c: DcSpec) => {
    segment(0xda, [1, c.id, 0x00, 0, 63, 0]);
    const w = new BitWriter();
    let pred = 0;
    let restarts = 0;
    // A non-interleaved scan codes the blocks of the component: ceil(ceil(X * h / maxH) / 8) per line (JPEG A.1.1).
    const perLine = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
    const perColumn = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
    for (let n = 0; n < perLine * perColumn; n++) {
      if (opts.restartInterval && n > 0 && n % opts.restartInterval === 0) {
        w.flush();
        w.bytes.push(0xff, 0xd0 + (restarts++ % 8));
        pred = 0;
      }
      const coef = coefficient(c, n % perLine, Math.floor(n / perLine));
      w.dc(coef - pred);
      pred = coef;
      w.write(0, 1); // EOB
    }
    w.flush();
    out.push(...w.bytes);
  };
  const ids = components.flatMap((c) => [c.id, 0x00]);
  if (!opts.progressive && opts.separate) {
    components.forEach(separateScan);
  } else if (!opts.progressive) {
    scan([count, ...ids, 0, 63, 0], (w, _c, coef, pred, i) => {
      w.dc(coef - pred[i]);
      pred[i] = coef;
      w.write(0, 1); // EOB
    });
  } else {
    scan([count, ...ids, 0, 0, 0x01], (w, _c, coef, pred, i) => {
      const value = coef >> 1;
      w.dc(value - pred[i]);
      pred[i] = value;
    });
    segment(0xda, [1, components[0].id, 0x00, 1, 63, 0x00]);
    out.push(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78); // skipped: never decoded
    scan([count, ...ids, 0, 0, 0x10], (w, _c, coef) => w.write(coef & 1, 1));
  }
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

/** The panel as the reference sees it: the full picture with every 8x8 block of the luma grid flat. */
function blockPicture(width: number, height: number, mean: (bx: number, by: number) => [number, number, number]) {
  return { width, height, rgba: rgbaOf(width, height, (x, y) => mean(x >> 3, y >> 3)) };
}

describe('JPEG decoder', () => {
  const grey = (value: (bx: number, by: number) => number): DcSpec[] => [
    { id: 1, h: 2, v: 2, mean: (bx, by) => value(bx, by) },
    { id: 2, h: 1, v: 1, mean: () => 128 },
    { id: 3, h: 1, v: 1, mean: () => 128 },
  ];

  it('reads a large progressive 4:2:0 JPEG with restart markers at 1/8 scale (DC only, AC scans skipped)', async () => {
    const bytes = dcJpeg({
      width: 1024,
      height: 600,
      components: grey((bx) => (bx < 64 ? 200 : 50)),
      progressive: true,
      restartInterval: 7,
    });
    expect(1024 * 600).toBeGreaterThan(JPEG_FULL_DECODE_MAX_PIXELS);
    const cover = await scaleImage(bytes, 'cover');
    expect([cover.format, cover.width, cover.height]).toEqual(['jpeg', 1024, 600]);
    for (let x = 0; x < 16; x++) {
      const v = x < 8 ? 200 : 50;
      expect([x, at(cover.pixels, x, 0), at(cover.pixels, x, 15)]).toEqual([
        x,
        { r: v, g: v, b: v },
        { r: v, g: v, b: v },
      ]);
    }
    const contain = await scaleImage(bytes, 'contain');
    const rows = Array.from({ length: 16 }, (_, y) => at(contain.pixels, 0, y).r);
    expect(rows).toEqual([0, 0, 0, ...new Array(9).fill(200), 0, 0, 0, 0]);
  });

  it('converts YCbCr with the JFIF coefficients', async () => {
    const bytes = dcJpeg({
      width: 1024,
      height: 600,
      components: [
        { id: 1, h: 2, v: 1, mean: () => 120 },
        { id: 2, h: 1, v: 1, mean: () => 100 },
        { id: 3, h: 1, v: 1, mean: () => 160 },
      ],
    });
    const { pixels } = await scaleImage(bytes, 'cover');
    expect(new Set(pixels.map((c) => `${c.r},${c.g},${c.b}`))).toEqual(new Set(['165,107,70']));
  });

  it.each([
    [800, 400],
    [801, 403],
  ])('averages a %ix%i baseline grey JPEG like the full picture (last block partly outside)', async (width, height) => {
    const mean = (bx: number, by: number) => (bx * 7 + by * 13) % 256;
    const bytes = dcJpeg({ width, height, components: [{ id: 1, h: 1, v: 1, mean }], restartInterval: 5 });
    for (const fit of ['cover', 'contain'] as const) {
      const { pixels } = await scaleImage(bytes, fit);
      const expected = scaleTo16(
        blockPicture(width, height, (bx, by) => [mean(bx, by), mean(bx, by), mean(bx, by)]),
        fit,
      );
      expect(pixels).toEqual(expected);
    }
  });

  it('honours the Adobe marker: CMYK (inverted, as jpeg-js) and RGB without transform', async () => {
    const flat = (id: number, value: number): DcSpec => ({ id, h: 1, v: 1, mean: () => value });
    const cmyk = dcJpeg({
      width: 800,
      height: 400,
      components: [flat(1, 200), flat(2, 100), flat(3, 50), flat(4, 128)],
      adobe: 0,
    });
    expect(at((await scaleImage(cmyk, 'cover')).pixels, 0, 0)).toEqual({ r: 100, g: 50, b: 25 });
    const rgb = dcJpeg({ width: 800, height: 400, components: [flat(1, 10), flat(2, 20), flat(3, 30)], adobe: 0 });
    expect(at((await scaleImage(rgb, 'cover')).pixels, 0, 0)).toEqual({ r: 10, g: 20, b: 30 });
    const noAdobe = dcJpeg({ width: 800, height: 400, components: [flat(1, 1), flat(2, 2), flat(3, 3), flat(4, 4)] });
    await expect(scaleImage(noAdobe, 'cover')).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('matches a full jpeg-js decode of a large baseline JPEG within a small tolerance', async () => {
    const width = 1024;
    const height = 600;
    const rgba = rgbaOf(width, height, (x, y) => [(x * 255) / width, (y * 255) / height, (x ^ y) & 255]);
    const bytes = new Uint8Array(encodeJpeg({ width, height, data: rgba }, 85).data);
    const reference = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
    for (const fit of ['cover', 'contain'] as const) {
      const { pixels } = await scaleImage(bytes, fit);
      const expected = scaleTo16({ width, height, rgba: reference.data }, fit);
      const worst = Math.max(
        ...pixels.flatMap((c, i) => [c.r - expected[i].r, c.g - expected[i].g, c.b - expected[i].b].map(Math.abs)),
      );
      expect(worst).toBeLessThanOrEqual(6);
    }
  });

  it('counts the blocks of a non-interleaved scan as libjpeg does (unusual sampling 3:2:2)', async () => {
    // 1041 wide, chroma h 2 of 3: ceil(ceil(1041 * 2 / 3) / 8) = 87 blocks per line (ceil(131 * 2 / 3) would give 88).
    const width = 1041;
    const height = 400;
    const cb = (bx: number, by: number) => 60 + ((bx * 5 + by * 11) % 120);
    const bytes = dcJpeg({
      width,
      height,
      separate: true,
      restartInterval: 9,
      components: [
        { id: 1, h: 3, v: 1, mean: () => 128 },
        { id: 2, h: 2, v: 1, mean: cb },
        { id: 3, h: 2, v: 1, mean: () => 128 },
      ],
    });
    const clamp = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
    const colour = (bx: number, by: number): [number, number, number] => {
      const value = cb(Math.floor((bx * 2) / 3), by);
      return [128, clamp(128 - 0.3441363 * (value - 128)), clamp(128 + 1.772 * (value - 128))];
    };
    for (const fit of ['cover', 'contain'] as const) {
      const { pixels } = await scaleImage(bytes, fit);
      expect(pixels).toEqual(scaleTo16(blockPicture(width, height, colour), fit));
    }
  });

  it('converts YCCK (Adobe transform 2) like jpeg-js', async () => {
    const bytes = dcJpeg({
      width: 800,
      height: 400,
      adobe: 2,
      components: [
        { id: 1, h: 1, v: 1, mean: (bx) => 60 + (bx % 140) },
        { id: 2, h: 1, v: 1, mean: () => 100 },
        { id: 3, h: 1, v: 1, mean: (_bx, by) => 90 + (by % 80) },
        { id: 4, h: 1, v: 1, mean: () => 200 },
      ],
    });
    const reference = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
    for (const fit of ['cover', 'contain'] as const) {
      const { pixels } = await scaleImage(bytes, fit);
      const expected = scaleTo16({ width: 800, height: 400, rgba: reference.data }, fit);
      const worst = Math.max(
        ...pixels.flatMap((c, i) => [c.r - expected[i].r, c.g - expected[i].g, c.b - expected[i].b].map(Math.abs)),
      );
      expect(worst).toBeLessThanOrEqual(2);
    }
  });

  it('refuses JPEGs that repeat scans to keep the decoder busy, fast', async () => {
    // 4K frame, a Huffman table with one 1-bit code, scans without data: every scan decodes all blocks.
    const bomb = (scans: number, progressive: boolean, ss = 0) => {
      const out = [0xff, 0xd8];
      const segment = (marker: number, data: number[]) =>
        out.push(0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255, ...data);
      segment(0xdb, [0, 8, ...new Array(63).fill(1)]);
      segment(progressive ? 0xc2 : 0xc0, [
        8,
        2160 >> 8,
        2160 & 255,
        3840 >> 8,
        3840 & 255,
        3,
        1,
        0x11,
        0,
        2,
        0x11,
        0,
        3,
        0x11,
        0,
      ]);
      segment(0xc4, [0x00, 1, ...new Array(15).fill(0), 0]);
      segment(0xc4, [0x10, 1, ...new Array(15).fill(0), 0]);
      for (let i = 0; i < scans; i++) segment(0xda, [3, 1, 0, 2, 0, 3, 0, ss, progressive && ss === 0 ? 0 : 63, 0]);
      out.push(0xff, 0xd9);
      return Uint8Array.from(out);
    };
    for (const [bytes, text] of [
      [bomb(100, false), 'more than 4 times the blocks'],
      [bomb(10, true), 'more than 4 times the blocks'],
      [bomb(101, true, 1), 'more than 100 scans'],
    ] as const) {
      const started = Date.now();
      await expect(scaleImage(bytes, 'cover')).rejects.toThrow(
        expect.objectContaining({ kind: 'unsupported', message: expect.stringContaining(text) }),
      );
      expect(Date.now() - started).toBeLessThan(1500);
    }
    await expect(scaleImage(bomb(4, true), 'cover')).resolves.toMatchObject({ width: 3840 });
  });

  it('tolerates data that ends early (the blocks after the last restart marker stay mid grey)', async () => {
    const bytes = dcJpeg({ width: 1024, height: 600, components: grey(() => 200), restartInterval: 10 });
    const cut = bytes.subarray(0, bytes.length - 3000);
    const { pixels } = await scaleImage(cut, 'cover');
    expect(at(pixels, 0, 0)).toEqual({ r: 200, g: 200, b: 200 });
    expect(at(pixels, 15, 15)).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('rejects broken Huffman data, unsupported codings and invalid headers', async () => {
    const valid = dcJpeg({ width: 1024, height: 600, components: grey(() => 90) });
    const sos = valid.findIndex((b, i) => b === 0xff && valid[i + 1] === 0xda);
    const scanStart = sos + 2 + ((valid[sos + 2] << 8) | valid[sos + 3]);
    const broken = Uint8Array.from(valid);
    for (let i = scanStart; i < scanStart + 40; i += 2) broken.set([0xff, 0x00], i); // all ones: no such code
    await expect(scaleImage(broken, 'cover')).rejects.toThrow(
      expect.objectContaining({ kind: 'unsupported', message: expect.stringContaining('Huffman') }),
    );
    const flat: DcSpec[] = [{ id: 1, h: 1, v: 1, mean: () => 1 }];
    for (const [opts, text] of [
      [{ sofMarker: 0xc3 }, 'not supported'],
      [{ precision: 12 }, 'not 8 bits'],
    ] as const) {
      await expect(scaleImage(dcJpeg({ width: 800, height: 400, components: flat, ...opts }), 'cover')).rejects.toThrow(
        expect.objectContaining({ kind: 'unsupported', message: expect.stringContaining(text) }),
      );
    }
    const twoComponents = dcJpeg({ width: 800, height: 400, components: [...flat, { ...flat[0], id: 2 }] });
    await expect(scaleImage(twoComponents, 'cover')).rejects.toMatchObject({ kind: 'unsupported' });
    const scanFirst = Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9);
    await expect(scaleImage(scanFirst, 'cover')).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining('scan before the frame header') }),
    );
  });
});

describe('GIF decoder', () => {
  const reference = (bytes: Uint8Array, fit: 'cover' | 'contain') => {
    const reader = new GifReader(bytes);
    const rgba = new Uint8Array(reader.width * reader.height * 4);
    reader.decodeAndBlitFrameRGBA(0, rgba);
    return scaleTo16({ width: reader.width, height: reader.height, rgba }, fit);
  };
  const noisyGif = (width: number, height: number, seed: number, interlaced = false) => {
    let s = seed;
    const next = () => {
      s = (s * 1103515245 + 12345) >>> 0;
      return s >>> 24;
    };
    const palette = Array.from({ length: 256 }, () => (next() << 16) | (next() << 8) | next());
    const indices = Array.from({ length: width * height }, () => next());
    const buf = new Uint8Array(width * height * 3 + 10_000);
    const gif = new GifWriter(buf, width, height, { palette });
    if (!interlaced) {
      gif.addFrame(0, 0, width, height, indices, { transparent: 5 });
      return { bytes: buf.slice(0, gif.end()), indices, palette };
    }
    // Store the rows in interlace order and set the interlace flag of the image descriptor.
    const order = [0, 4, 2, 1].flatMap((start, pass) =>
      Array.from({ length: height }, (_, y) => y).filter((y) => y >= start && (y - start) % [8, 8, 4, 2][pass] === 0),
    );
    gif.addFrame(
      0,
      0,
      width,
      height,
      order.flatMap((y) => indices.slice(y * width, (y + 1) * width)),
    );
    const bytes = buf.slice(0, gif.end());
    const descriptor = bytes.indexOf(0x2c, 13 + 768);
    bytes[descriptor + 9] |= 0x40;
    return { bytes, indices, palette };
  };

  it('decodes 256-colour noise (12-bit codes, table resets) exactly like omggif', async () => {
    const { bytes } = noisyGif(300, 200, 3);
    for (const fit of ['cover', 'contain'] as const) {
      expect((await scaleImage(bytes, fit)).pixels).toEqual(reference(bytes, fit));
    }
  });

  it('puts the rows of an interlaced frame in place', async () => {
    const { bytes } = noisyGif(48, 37, 9, true);
    for (const fit of ['cover', 'contain'] as const) {
      expect((await scaleImage(bytes, fit)).pixels).toEqual(reference(bytes, fit));
    }
  });

  it('leaves the rest of the frame transparent when the data ends early', async () => {
    // 4x4 frame, 2 colours; the LZW data is clear, 1, 1 and padding (0, 0) without an end code: one row only.
    const gif = Uint8Array.from([
      ...Buffer.from('GIF89a'),
      ...[4, 0, 4, 0, 0x80, 0, 0],
      ...[0, 0, 0, 255, 0, 0],
      ...[0x2c, 0, 0, 0, 0, 4, 0, 4, 0, 0],
      ...[2, 2, 0x4c, 0x00, 0],
      0x3b,
    ]);
    const { pixels } = await scaleImage(gif, 'cover');
    expect(at(pixels, 0, 0)).toEqual(red);
    expect(at(pixels, 15, 0)).toEqual(black);
    expect(at(pixels, 0, 15)).toEqual(black);
  });
});

describe('buildImageCommand', () => {
  it('builds the golden palette order and a 1036-byte payload with a padded palette', async () => {
    const cmd = await buildImageCommand(png(16, 16, goldenPaint), 'cover');
    expect(cmd.payload.length).toBe(1036);
    expect(cmd.colours).toBe(3);
    expect([cmd.format, cmd.width, cmd.height]).toEqual(['png', 16, 16]);
    expect(Array.from(cmd.payload.subarray(0, 12))).toEqual([0x44, 0, 0x0a, 0x0a, 0x04, 0xaa, 0x07, 0x04, 0, 0, 0, 0]);
    // Palette in first-seen order: blue, red, green, then black padding.
    expect(Array.from(cmd.payload.subarray(12, 12 + 12))).toEqual([0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0]);
    // Row 0 uses index 0, rows 1.. left red (1) and right green (2), 8 bits per pixel.
    const pixels = cmd.payload.subarray(12 + 768);
    expect(Array.from(pixels.subarray(0, 16))).toEqual(new Array(16).fill(0));
    expect(Array.from(pixels.subarray(16, 32))).toEqual([...new Array(8).fill(1), ...new Array(8).fill(2)]);
  });

  it('uses 256 distinct colours as NN 00 without losing any', async () => {
    const noise = png(16, 16, (x, y) => [x * 16, y * 16, (x * 7 + y * 13) % 256]);
    const cmd = await buildImageCommand(noise, 'cover');
    expect(cmd.colours).toBe(256);
    expect(cmd.payload[11]).toBe(0);
    expect(cmd.payload.length).toBe(1036);
  });

  it('shows a JPEG of a solid colour as one colour within tolerance', async () => {
    const cmd = await buildImageCommand(
      jpeg(160, 90, () => [255, 0, 0]),
      'contain',
    );
    expect(cmd.format).toBe('jpeg');
    expect(cmd.colours).toBeLessThanOrEqual(3);
  });

  it('passes decode errors through', async () => {
    await expect(buildImageCommand(Buffer.from('nope'), 'cover')).rejects.toThrow(ImageError);
  });
});

describe('runImageJob', () => {
  it('runs one job at a time in call order and passes results and errors through', async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const first = runImageJob(async () => {
      events.push('first start');
      await new Promise<void>((resolve) => (release = resolve));
      events.push('first end');
      throw new Error('first failed');
    });
    const second = runImageJob(async () => {
      events.push('second start');
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first start']);
    release();
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['first start', 'first end', 'second start']);
  });

  it('lets the next job run when one job hangs longer than IMAGE_JOB_MAX_MS', async () => {
    vi.useFakeTimers();
    try {
      const hanging = runImageJob(() => new Promise<never>(() => undefined));
      void hanging;
      const next = vi.fn(async () => 'next');
      const queued = runImageJob(next);
      await vi.advanceTimersByTimeAsync(IMAGE_JOB_MAX_MS - 1);
      expect(next).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(queued).resolves.toBe('next');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('native 16x16 images (#129)', () => {
  const white: [number, number, number] = [255, 255, 255];
  /** 33 colours: red/blue 1-px checkerboard top-left, white/black 1-px stripes top-right, grey and green ramps below. */
  const nativePaint: Painter = (x, y) => {
    if (y < 8) return x < 8 ? ((x + y) % 2 === 0 ? [255, 0, 0] : [0, 0, 255]) : x % 2 === 0 ? white : [0, 0, 0];
    if (y < 12) return [1 + x * 16, 1 + x * 16, 1 + x * 16]; // 16 greys, none of them black or white
    return [0, 20 + Math.min(x, 12) * 18, 0]; // 13 greens
  };
  const pixelsOf = (paint: Painter): Rgb[] =>
    Array.from({ length: 256 }, (_, i) => {
      const [r, g, b] = paint(i % 16, Math.floor(i / 16));
      return { r, g, b };
    });
  /** The colours in first-seen order (row-major) and every pixel's index into them. */
  const firstSeen = (pixels: readonly Rgb[]) => {
    const colours: Rgb[] = [];
    const indices = pixels.map((c) => {
      let at = colours.findIndex((o) => o.r === c.r && o.g === c.g && o.b === c.b);
      if (at < 0) at = colours.push(c) - 1;
      return at;
    });
    return { colours, indices };
  };
  /** The 256-entry palette and the 256 indices of a `44` payload. */
  const decodePayload = (payload: Uint8Array) => ({
    palette: Array.from({ length: 256 }, (_, i): Rgb => {
      const [r, g, b] = payload.subarray(12 + i * 3, 15 + i * 3);
      return { r, g, b };
    }),
    indices: Array.from(payload.subarray(780, 1036)),
  });
  /** A 16x16 GIF whose global colour table is the first-seen palette padded with black to `tableSize` entries. */
  const gifOf = (paint: Painter, options: { transparent?: number; interlaced?: boolean; tableSize?: number } = {}) => {
    const { colours, indices } = firstSeen(pixelsOf(paint));
    const table = Array.from({ length: options.tableSize ?? 64 }, (_, i) =>
      colours[i] ? (colours[i].r << 16) | (colours[i].g << 8) | colours[i].b : 0,
    );
    const buf = new Uint8Array(16 * 16 * 3 + 10_000);
    const gif = new GifWriter(buf, 16, 16, { palette: table });
    const order = options.interlaced
      ? [0, 4, 2, 1].flatMap((start, pass) =>
          Array.from({ length: 16 }, (_, y) => y).filter((y) => y >= start && (y - start) % [8, 8, 4, 2][pass] === 0),
        )
      : Array.from({ length: 16 }, (_, y) => y);
    gif.addFrame(
      0,
      0,
      16,
      16,
      order.flatMap((y) => indices.slice(y * 16, (y + 1) * 16)),
      options.transparent === undefined ? {} : { transparent: options.transparent },
    );
    const bytes = buf.slice(0, gif.end());
    if (options.interlaced) bytes[bytes.indexOf(0x2c, 13 + table.length * 3) + 9] |= 0x40;
    return { bytes, colours, indices, table };
  };
  const rgbBytes = (colours: readonly Rgb[]) => colours.flatMap((c) => [c.r, c.g, c.b]);
  /** The exact first-seen payload of a picture: its colours, black padding, and the source indices. */
  const expectExact = (payload: Uint8Array, paint: Painter) => {
    const { colours, indices } = firstSeen(pixelsOf(paint));
    const sent = decodePayload(payload);
    expect(payload.length).toBe(1036);
    expect(payload[11]).toBe(0); // NN 00: 256 palette entries, 8 bits per pixel
    expect(sent.palette.slice(0, colours.length)).toEqual(colours);
    expect(sent.palette.slice(colours.length)).toEqual(new Array(256 - colours.length).fill(black));
    expect(sent.indices).toEqual(indices);
    expect(sent.indices.map((i) => sent.palette[i])).toEqual(pixelsOf(paint));
    return colours.length;
  };

  it('has the test pattern with 33 colours', () => {
    expect(firstSeen(pixelsOf(nativePaint)).colours).toHaveLength(33);
  });

  it.each(['cover', 'contain'] as const)('sends an opaque RGBA and an RGB PNG pixel-exactly (%s)', async (fit) => {
    const rgba = await buildImageCommand(png(16, 16, nativePaint), fit);
    expect(rgba.colours).toBe(33);
    expect([rgba.format, rgba.width, rgba.height]).toEqual(['png', 16, 16]);
    expect(expectExact(rgba.payload, nativePaint)).toBe(33);
    const scanlines = Buffer.concat(
      Array.from({ length: 16 }, (_, y) =>
        Buffer.from([0, ...Array.from({ length: 16 }, (_, x) => nativePaint(x, y).slice(0, 3)).flat()]),
      ),
    );
    const rgb = await buildImageCommand(rawPng(16, 16, 2, 8, 0, scanlines), fit);
    expect(rgb.colours).toBe(33);
    expect(rgb.payload).toEqual(rgba.payload);
  });

  it.each(['cover', 'contain'] as const)(
    'sends a GIF with a first-seen palette byte-equal to its colour table and indices (%s)',
    async (fit) => {
      const { bytes, indices, table } = gifOf(nativePaint);
      const cmd = await buildImageCommand(bytes, fit);
      expect([cmd.format, cmd.width, cmd.height, cmd.colours]).toEqual(['gif', 16, 16, 33]);
      expectExact(cmd.payload, nativePaint);
      expect(Array.from(cmd.payload.subarray(12, 12 + 64 * 3))).toEqual(
        table.flatMap((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]),
      );
      expect(Array.from(cmd.payload.subarray(780))).toEqual(indices);
      // An interlaced GIF of the same picture gives the identical payload.
      expect((await buildImageCommand(gifOf(nativePaint, { interlaced: true }).bytes, fit)).payload).toEqual(
        cmd.payload,
      );
    },
  );

  it.each(['cover', 'contain'] as const)('keeps all 256 colours of noise as PNG and as GIF (%s)', async (fit) => {
    const grid = (x: number, y: number) => (y * 16 + x) * 4;
    const data = noise(16, 16, 11, true);
    // Make every one of the 256 pixels a distinct colour.
    const distinct: Painter = (x, y) => [data[grid(x, y)], data[grid(x, y) + 1], (y * 16 + x) & 255];
    const fromPng = await buildImageCommand(png(16, 16, distinct), fit);
    expect(fromPng.colours).toBe(256);
    expectExact(fromPng.payload, distinct);
    const fromGif = await buildImageCommand(gifOf(distinct, { tableSize: 256 }).bytes, fit);
    expect(fromGif.colours).toBe(256);
    expect(fromGif.payload).toEqual(fromPng.payload);
  });

  it.each(['cover', 'contain'] as const)(
    'sends a palette PNG with a reversed PLTE and an Adam7 PNG pixel-exactly (%s)',
    async (fit) => {
      const { colours, indices } = firstSeen(pixelsOf(nativePaint));
      // PLTE in reverse first-seen order: the colours come out in first-seen order all the same.
      const plte = colours.map((_, i) => colours[colours.length - 1 - i]);
      const reversed = rawPng(
        16,
        16,
        3,
        8,
        0,
        Buffer.concat(
          Array.from({ length: 16 }, (_, y) =>
            Buffer.from([0, ...indices.slice(y * 16, (y + 1) * 16).map((i) => colours.length - 1 - i)]),
          ),
        ),
        rgbBytes(plte),
      );
      const cmd = await buildImageCommand(reversed, fit);
      expect(cmd.colours).toBe(33);
      expectExact(cmd.payload, nativePaint);
      // Adam7: seven passes of 8-bit RGB.
      const adam7 = rawPng(
        16,
        16,
        2,
        8,
        1,
        Buffer.concat(
          ADAM7.flatMap(([x0, y0, dx, dy]) =>
            Array.from({ length: Math.ceil((16 - y0) / dy) }, (_, row) =>
              Buffer.from([
                0,
                ...Array.from({ length: Math.ceil((16 - x0) / dx) }, (_, k) =>
                  nativePaint(x0 + k * dx, y0 + row * dy).slice(0, 3),
                ).flat(),
              ]),
            ),
          ),
        ),
      );
      expect((await buildImageCommand(adam7, fit)).payload).toEqual(cmd.payload);
    },
  );

  describe('what changes pixels', () => {
    const rgbaPng = (paint: Painter) => png(16, 16, paint);

    it('composites transparency onto black', async () => {
      const paint: Painter = (x) => (x === 0 ? [200, 100, 50, 0] : x === 1 ? [200, 100, 50, 128] : [200, 100, 50]);
      const { pixels } = await scaleImage(rgbaPng(paint), 'cover');
      expect(at(pixels, 0, 4)).toEqual(black);
      expect(at(pixels, 1, 4)).toEqual({
        r: Math.round((200 * 128) / 255),
        g: Math.round((100 * 128) / 255),
        b: Math.round((50 * 128) / 255),
      });
      expect(at(pixels, 2, 4)).toEqual({ r: 200, g: 100, b: 50 });
    });

    it('turns a tRNS-transparent palette entry black', async () => {
      const scanlines = Buffer.concat(
        Array.from({ length: 16 }, () => Buffer.from([0, ...Array.from({ length: 16 }, (_, x) => x % 2)])),
      );
      const { pixels } = await scaleImage(
        rawPng(16, 16, 3, 8, 0, scanlines, [10, 20, 30, 200, 100, 50], [0]),
        'contain',
      );
      expect(at(pixels, 0, 3)).toEqual(black);
      expect(at(pixels, 1, 3)).toEqual({ r: 200, g: 100, b: 50 });
    });

    it('turns a used GIF transparent index black and ignores an unused one', async () => {
      const plain = await buildImageCommand(gifOf(nativePaint).bytes, 'cover');
      // Index 0 is the top-left red pixel: it and the other red pixels become black.
      const used = await scaleImage(gifOf(nativePaint, { transparent: 0 }).bytes, 'cover');
      expect(at(used.pixels, 0, 0)).toEqual(black);
      expect(at(used.pixels, 2, 0)).toEqual(black);
      expect(at(used.pixels, 1, 0)).toEqual({ r: 0, g: 0, b: 255 });
      // Index 40 is padding of the colour table and not used by any pixel.
      const unused = await buildImageCommand(gifOf(nativePaint, { transparent: 40 }).bytes, 'cover');
      expect(unused.payload).toEqual(plain.payload);
    });

    it('adds nothing to a 16x16 JPEG beyond the jpeg-js decode', async () => {
      const paint: Painter = (x, y) => [x * 16, y * 16, (x * 7 + y * 13) % 256];
      const bytes = jpeg(16, 16, paint);
      const reference = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
      const expected = Array.from({ length: 256 }, (_, i): Rgb => {
        const [r, g, b] = reference.data.subarray(i * 4, i * 4 + 3);
        return { r, g, b };
      });
      for (const fit of ['cover', 'contain'] as const) {
        expect((await scaleImage(bytes, fit)).pixels).toEqual(expected);
      }
    });
  });
});
