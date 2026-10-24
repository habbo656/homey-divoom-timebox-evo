# ADR 0010: Bounded-memory image decoding

**Status:** accepted · **Date:** 2026-10-08 · **Amends:** 0009 · **Relates to:** issue #31

**Context:** In the first hardware test of #31 two or three 3840x2160 photo JPEGs (0.7-1.25 MB) shown about 30 s apart made
Homey report `Memory Warning Limit Reached` and restart the app; one alone worked. A Homey app has a small memory budget.
Measured locally (Node 24, peak RSS growth of one decode): jpeg-js needs about 480 MB for a 4K JPEG and 112-125 MB even for a
1920x1080 JPEG (an `Int32Array(64)` per 8x8 block, then component lines, an RGB copy and the RGBA output); pngjs needs about
410 MB for a 16-bit 4K PNG and 70 MB for an 8-bit 1080p RGBA PNG. Lowering the pixel limit to 1920x1080 (the plan's fallback)
would still leave more than 100 MB per JPEG, and only 1280x720 would come near 60 MB, which rejects most photos and album art.
The panel shows 16x16 pixels, so the full-resolution picture is never needed.

**Decision:** Decode straight to the 16x16 area average and never hold the whole picture:
- `AreaScaler` accumulates the area average pixel by pixel, in any order; decoders feed it rows (or blocks).
- PNG: own decoder, IDAT inflated as a stream by Node's zlib and unfiltered row by row. pngjs becomes a dev dependency
  (reference in the tests).
- JPEG: up to 512 x 512 pixels jpeg-js as before (small, exact); above that an own DC-only decoder reads the picture at 1/8
  scale (block averages; baseline and progressive, restart intervals, subsampling, Adobe RGB/CMYK/YCCK), the same idea as
  libjpeg's DCT scaling. The result differs from a full decode by 1-2 levels on most pictures and up to about 19 levels on
  mid-size graphics with sharp edges in `cover` (measured on 108 JPEGs).
- GIF: omggif parses the blocks; the LZW data of the first frame is decoded row by row (omggif's blit needs 5 bytes per pixel).
- One image load and decode at a time for the whole app (`runImageJob`).
- `IMAGE_MAX_PIXELS` stays 3840 x 2160 and `IMAGE_MAX_BYTES` 5 MiB; `IMAGE_MAX_SIDE` = 16384 bounds every row buffer, and
  the scaler computes the cells of a source pixel instead of keeping per-pixel tables.
- Inputs that cost time are bounded too: the DC-only decoder stops after 100 scans or 4 times the blocks of the frame, a token
  stream is opened and read within one 10 s deadline, and a queued job that takes longer than 30 s no longer holds up the next.

**Rejected:**
- Only lowering `IMAGE_MAX_PIXELS` (and `JPEG_MAX_MEMORY_MB`): not enough memory saved at an acceptable size (see above).
- `formatAsRGBA: false` for jpeg-js: saves 25 % of the output buffer only, the block storage dominates.
- A pure-JS inflate with a reusable output buffer: slower than Node's zlib on Homey; the garbage of the zlib chunks is bounded by
  the raw size and collected by V8.
- Decoding in a worker thread: the memory is used all the same.

**Consequences:** About 1000 lines of own decoder code (`imagePng.ts`, `imageJpeg.ts`, `imageGif.ts`, `imageScale.ts`) with tests
against pngjs, jpeg-js and omggif as references and hand-made progressive/CMYK/grey JPEGs. Peak RSS growth per decode measured
locally: about 11 MB for a 4K JPEG, 8 MB for a 4K GIF, 13-17 MB for a 4K PNG (garbage of the inflated chunks until the next
collection). A 4K JPEG decodes in about 150 ms locally (jpeg-js: about 350 ms). On Homey (hardware re-test #31): 5 successive 4K photo JPEGs (0.7-1.8 MB) in 121-312 ms each (jpeg-js: about 4 s), 6 concurrent 4K loads serialised by the queue, a 4K PNG in 675 ms; no `Memory Warning Limit Reached`, no restart. 12-bit, lossless, hierarchical and
arithmetic-coded JPEGs stay unsupported (as with jpeg-js); fine detail below an 8x8 block of a large JPEG is averaged.
