# ADR 0009: Pure-JS image decoding for the Show image actions

**Status:** accepted, amended by 0010 · **Date:** 2026-10-08 · **Relates to:** 0008 (overlay model), issue #31

**Context:** The "Show image" and "Show image from URL" Flow actions (#31) must turn a PNG, JPEG or GIF into the 16x16
palette image of `44` (protocol section 4). Homey apps run on Node on the Homey itself (no native build toolchain, an
app is installed with its production dependencies), so a decoder must be pure JavaScript, small and without a tree of
transitive packages.

**Decision:** Decode with three small runtime dependencies, each without transitive dependencies:
- `pngjs` ^7 (MIT) for PNG, with `@types/pngjs` (dev),
- `jpeg-js` ^0.4.4 (BSD-3-Clause, ships its own types) for JPEG, using `maxResolutionInMP` and `maxMemoryUsageInMB`,
- `omggif` ^1.0.10 (MIT) for GIF (first frame only), with `@types/omggif` (dev).

Scaling to 16x16 (area average) and palette building are our own code (`src/device/image.ts`); the result is always sent
as a 256-colour 8 bpp image.

**Rejected:**
- `jimp` / `image-js`: large dependency trees for features we do not need.
- `sharp`: native binary, not installable on Homey.
- `fast-png`: ESM only and needs `pako`.
- Decoding on a server or in the cloud: the app must work offline and send nothing but the URL fetch the user asked for.

**Consequences:** About 250 KB of source is added to the app. Decoding is synchronous and blocks the event loop for the
duration of the decode (bounded by the size limits, a few seconds for a large JPEG). Formats beyond PNG, JPEG and GIF
(WebP, AVIF, SVG) fail with the localised "unsupported" error. EXIF rotation and colour profiles are ignored.

**Amended by ADR 0010:** to bound the memory on Homey, PNGs are decoded by our own streaming decoder (pngjs is only a
dev dependency for the tests), JPEGs over 512 x 512 by our own DC-only decoder at 1/8 scale, and the GIF LZW data by our
own row-wise decoder (omggif parses the blocks); decoding runs one image at a time.
