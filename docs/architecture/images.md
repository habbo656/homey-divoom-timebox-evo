# Static images

_Part of [architecture](../architecture.md); written for #31 (milestone 0.5.0)._

- **Show image (#31)** (`src/protocol/commands.ts` builder, `src/device/image.ts`, `imageError.ts`, `imageSource.ts` pure and
  Homey-free, `TimeboxController` logic): the Flow actions "Show image" (`timebox_show_image`, droptoken `image`, `fit`
  dropdown `cover` / `contain`, `duration` 0..3600 s) and "Show image from URL" (`timebox_show_image_url`, text `url`, the
  same `fit` and `duration`). The picture is decoded in pure JS (ADR 0009), scaled to 16x16 and sent as the VERIFIED `44`
  static image (protocol section 4). **The image is an overlay, not a mode** (like the text, ADR 0008): there is no tile
  entry, the known channel, the tile and the triggers do not change.
  - Protocol: `staticImage({palette, pixels})` builds `44 00 0a 0a 04 aa LLLL 00 00 00 NN palette pixels` for 1..256 colours
    (`NN` 256 as `00`, `max(1, ceil(log2 NN))` bits per pixel, LSB-first, row-major, top-left first) and throws `RangeError` for a
    palette of 0 or more than 256 colours, other than 256 pixels, an index outside the palette or a colour byte outside 0..255.
  - Decoding (`image.ts` `scaleImage`, ADR 0010): `detectImageFormat` by magic bytes (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF
    `GIF87a`/`GIF89a`), then a decoder that feeds the `AreaScaler` (`imageScale.ts`) directly and **never holds the whole
    picture**, because a Homey app has little memory (the first hardware test hit `Memory Warning Limit Reached` and an app restart
    after two or three 3840x2160 photo JPEGs decoded with jpeg-js; measured locally that decode grew the RSS by about 480 MB):
    - PNG (`imagePng.ts`, own code): the IDAT data is inflated as a stream (`zlib.createInflate`, 16 KiB chunks) and unfiltered
      row by row (filters 0..4); colour types 0, 2, 3, 4, 6 at every allowed bit depth (1/2/4-bit samples scaled, 16-bit rounded to
      8), `PLTE`, `tRNS` (grey and RGB key, palette alpha; palette indices past the palette are opaque black) and Adam7 interlacing
      (pixels placed per pass). More inflated data than the IHDR allows (+ 1 KiB) is refused while streaming (decompression bomb),
      less is `unsupported` (`PNG data ends early`), as are a broken zlib stream and an unknown filter type.
    - JPEG (`imageJpeg.ts`): the frame header is read first (`readJpegInfo`: size checked before anything else; SOF0/1/2 only,
      8-bit only; colour model as libjpeg: JFIF = YCbCr, else the Adobe transform flag, else component ids `R G B` = RGB; 4
      components need the Adobe marker). Up to `JPEG_FULL_DECODE_MAX_PIXELS` = 512 x 512 the picture is decoded completely by
      `jpeg-js` (`JPEG_MAX_MEMORY_MB` = 16 as a backstop); larger ones are read at **1/8 scale from the DC coefficients only**:
      the Huffman data of every block is decoded, the AC coefficients are dropped (baseline) or their scans skipped (progressive
      AC scans), progressive DC first/refinement scans, restart intervals and chroma subsampling are handled (blocks of a
      non-interleaved scan counted as JPEG A.1.1 / libjpeg: ceil(ceil(X * h / maxH) / 8) per line), and every 8x8 block becomes
      one pixel (mean = DC x quantiser / 8 + 128; YCbCr with the JFIF coefficients; Adobe CMYK as stored ink x black / 255, YCCK
      converted and inverted first, as jpeg-js). The 1/8 grid stands for the full size (`AreaScaler` logical size W/8 x H/8), so
      the result is the area average of the full picture up to the error of treating each block as flat. Measured against a full
      jpeg-js decode (reviewer corpus of 108 JPEGs over 512 x 512 from macOS, both fits): median 1 level, 75 % of the cases at most 2
      levels, worst 19 levels on mid-size graphics with sharp edges (800x600 / 1040x480 in `cover`), worst mean per picture 2.8
      levels; photos and generated noise 1-4 levels. A crafted file cannot keep the decoder busy: at most `JPEG_MAX_SCANS` = 100
      scans and `JPEG_MAX_DECODE_PASSES` = 4 times the blocks of the frame are decoded, more is `unsupported` (a baseline JPEG
      needs 1, a progressive DC first + refinement 2). Data that ends early leaves the blocks after the last restart marker mid grey.
    - GIF (`imageGif.ts`): `omggif` only parses the blocks (frame position, palette, transparency); the LZW data of the first
      frame is decoded here and handed over row by row (interlaced rows put in place; pixels outside the frame and transparent ones
      are black; a stream that ends early leaves the rest transparent).
    The size is checked before the pixels are decoded (PNG IHDR, JPEG frame header, GIF logical screen): over `IMAGE_MAX_PIXELS`
    (3840 x 2160 = 8.3 MP) or a side over `IMAGE_MAX_SIDE` = 16384 gives `ImageError` `too_large`. The side limit bounds the
    row buffers (PNG scanline, GIF frame row, at most 128 KiB), so an extreme proportion such as a 1 KB 8294400x1 PNG is refused
    before anything is allocated. The first GIF frame must lie inside the logical screen. Any other format, an
    empty, broken or oversized-for-its-header file gives `unsupported`.
  - Memory and time (measured locally on Node 24, peak RSS growth per decode, first decode and after three in a row without a
    forced garbage collection): 3840x2160 JPEG 11 -> 15 MB (jpeg-js before: about 480 MB), 1920x1080 JPEG 9 -> 12 MB (before:
    112-125 MB), 4K GIF about 8 MB, 4K PNG 13-17 MB -> 17-21 MB (the inflated chunks are garbage until the next collection; pngjs
    before: about 410 MB). Decode time locally: 4K JPEG about 150 ms (jpeg-js: about 350 ms; on Homey jpeg-js took about 4 s),
    4K PNG 55-170 ms, 4K GIF about 75 ms.
  - Memory and time on Homey (hardware re-test #31): 5 successive 3840x2160 photo JPEGs (0.7-1.8 MB) were prepared in 121-312 ms each
    (jpeg-js took about 4 s on Homey), 6 concurrent 4K loads were serialised by the queue (the superseded ones ended with `image superseded
    by a newer image`), a 4K PNG took 675 ms; no `Memory Warning Limit Reached`, no app restart.
  - One image at a time (`runImageJob`): loading and decoding of all image cards of the app run one after the other (a second
    card waits for the first; an error does not block the queue), so two cards practically never hold two pictures in memory. A job that runs
    longer than `IMAGE_JOB_MAX_MS` = 30 s no longer holds up the queue (a backstop: the download and the token read have their own
    10 s deadline); the late job still finishes for its own card.
  - Scaling (`AreaScaler`, `scaleTo16` for an RGBA buffer): the panel cells a source pixel covers are computed from the
    placement (no per-pixel weight tables, so the memory depends only on the 16x16 output); transparency is composited onto black; the area average of the covered source pixels with fractional
    weights (so enlarging works too) in sRGB, rounded half up; pixels may be added in any order (rows, interlace passes, blocks). `cover` crops a centred square of side min(W, H); `contain` makes the
    long side 16 and the short side round(16 * short / long) (at least 1) at offset floor((16 - n) / 2), the rest black (160x90:
    rows 3..11; 90x160: columns 3..11). No EXIF rotation, no gamma correction.
  - Palette (`toPalette`): no lossy quantisation, because 16x16 = 256 pixels give at most 256 distinct colours; the palette is the
    exact colours in first-seen order. `buildImageCommand(bytes, fit)` pads the palette with black to **256 entries and always
    sends 8 bits per pixel** (`NN` `00`, a 1036-byte payload): only 2 bpp (golden vector) and 256 colours are hardware-verified.
  - Native 16x16 images (#129): a 16x16 PNG (8-bit, every colour type) or GIF without transparency is sent **unchanged** in both fits:
    the scale is 1, `AreaScaler` gives each pixel the weight 1 (`floor(v + 0.5 + 1e-6)` returns `v`), `place()` leaves no bars for a
    square picture, and the app does no quantisation, gamma or brightness change. The app sends 8 bits per channel on the wire (protocol
    section 4; the 4-bit RGB format belongs to the original Timebox); what the panel renders of them is not measured (webcam ramp
    observation only). The palette is in first-seen order, so a GIF or palette PNG with a
    first-seen colour table is sent byte-equal (palette and indices); any other palette order is sent as the same colours in first-seen
    order (invisible on the device). What does change pixels: transparency (composited onto black, round(c * alpha / 255)), a JPEG (only
    what its codec loses, the app adds nothing to the `jpeg-js` decode), 16-bit PNG samples (rounded to 8 bits), 1/2/4-bit greyscale samples
    (scaled exactly to 0..255; palette PNGs of any bit depth index an 8-bit PLTE and stay exact), and every picture of another size (resampled). Pinned by `image.test.ts` "native 16x16 images (#129)" and confirmed on hardware (PNG cover, GIF contain, 32x32 control: [protocol/images.md](../protocol/images.md#native-16x16-image-129)).
  - Sources (`imageSource.ts`): `parseImageUrl` (text of 1..2048 characters, `http:`/`https:`, a host, no user name or password;
    `ArgumentError` `invalid_url`, field `url`; LAN addresses are allowed), `downloadImage(fetch, url)` (the whole load, request
    and body, is given up after `IMAGE_LOAD_TIMEOUT_MS` = 10 s; a `content-length` or streamed body over `IMAGE_MAX_BYTES` =
    5 MiB is refused and cancelled; `fetch` is injected, `FetchLike` pattern of `openMeteo.ts`), `readImageStream` /
    `loadImageToken(token)` (the `getStream()` of the Flow image token with the same limits; opening and reading share one 10 s
    deadline, so a `getStream()` that never settles gives `unreadable` and a stream opened later is destroyed; no image gives `missing`),
    `urlForLog(url)` (host and port only).
  - `controller.showImageFrom({origin, load}, fit, durationS)` validates the duration, checks the connection **before** anything
    is loaded, then loads, decodes and converts inside `runImageJob` (JPEG and GIF decode synchronously, PNG yields between inflate
    chunks; logged as `prepared in <n> ms`), then `showImage`. One `44` send takes about 5.2-5.6 s over BLE (hardware test). A failure is logged with the real cause
    (`image failed (<kind>) from <origin>: <message>`) and rethrown as an `ImageError`; the display, a shown image, text or
    countdown stay as they are.
  - `controller.showImage({payload, colours, fit, durationS})`: validates, rejects with the readable `not_connected` error while
    the link is down, turns a panel that is off on first (`setPower(true)`: `image: panel is off, turning it on first`), writes a
    pending small-clock re-send ahead of the image (`takeClockResendAhead('image')`), queues the `44` payload (`sendAllBounded`,
    `TEXT_SEND_TIMEOUT_MS`) and tracks it (`imageActive`, `imageSeq`). A newer image replaces the older one (the older duration
    timer is cancelled). For a duration above 0 a timer sends the command of the known mode again when it is over
    (`expireImage` -> `sendMode`, like the countdown stop; `image ended (duration): mode <id> re-sent`); with the link down or no
    known mode (or the device in cloud or the visualizer) nothing is sent (`image duration over: not connected` /
    `no known mode to restore`). If a mode change, text or countdown is still being sent when the duration is over (`channelInFlight`, `textSending`
    or a moved `displaySeq`, which counts queued texts, countdowns and images but not a "Stop text"), the image is only forgotten and nothing is sent (`image duration over: another display command is in
    flight, nothing re-sent`), so the re-send cannot undo the newer action. There is no "Stop image" action: a mode change ends the image. Log: `image loaded: <host|token>,
    <png|jpeg|gif> <W>x<H>, <bytes> bytes, prepared in <n> ms`, `image shown: <n> colours, <cover|contain>, <D s|until a mode change>`.
    The URL path and query are never logged.
  - Known limit (measured, protocol countdown.md P11 F): an image shown over a running countdown is replaced on the device by the clock when the countdown ends, but the device reports channel code 0x00 (unchanged), so the app keeps tracking the image and holds weather and the clock flag until the next display command.
  - What ends the image: a mode command (`switchTo`), power off, a text and a countdown end it on the device; the controller only
    forgets it (`imageEndedByCommand(reason, imageAtSend)`: `image ended (mode change|power off|text|countdown)`, timer cancelled,
    nothing is sent). Only an image queued before the command is ended; `imageEndedSeq` also catches a command queued after the
    image but finished before the image send was confirmed.
  - **Device behaviour of `44` (hardware test #31, round 1;** [images.md](../protocol/images.md#static-image-behaviour-31)**):**
    `44` leaves `46` d0 unchanged (it keeps reporting the mode from before the image), the image persists across status polls
    (more than 75 s), and a text, a mode command (`45`) and power off end the image on the device. A mode change made at the device while an
    image is shown is measured too (B3). Not measured: what `5f` (weather) and `26` (hot flag) do to a shown image. The
    controller's branches:
    - B1 (**confirmed**): `44` ends a running native text and the text does not come back. `showImage` bumps `textSeq` and
      forgets the text and its timer (`text stopped (image)`), as the countdown does. A text started later ends the image
      (`image ended (text)`).
    - B2 (**not measured**, conservative): `5f` (weather) and `26` (hot flag) are assumed to remove the image. While an image is
      shown or being sent, `weatherHold()` returns `image shown` (the weather is held and sent by the 60 s check after the image
      ended) and `sendHotAtConnect` sends nothing. "Stop countdown" is skipped like with a text (`countdown stop skipped: image shown`).
    - B3 (**consistent with the measurement**: d0 stays the mode before the image, so the shadow is that mode): the controller keeps
      an "image shadow" (`imageShadow`): the first d0 reported after the image send completed (`image shadow: device reports
      channel code 0x..`; reports while the image is still being sent are ignored, they may predate it). While the image is
      tracked, reports equal to the shadow, and codes that are neither a mode nor a removed mode, are ignored (no tile write, no
      trigger, no other-mode state). A later different known code is a mode change made at the device (or a reboot): the tracking
      ends (`image ended (device mode change): channel code 0x.. -> 0x..`) and the report is handled like any other (tile, trigger,
      other-mode rule). This also applies to the first status of a new session, so a reconnect with a different d0 forgets the
      image. With duration 0 the tracking therefore no longer lasts forever after a change at the device; weather hold and the
      hot-flag skip end with the tracking. A change made at the device within the first poll interval (before the shadow is
      adopted) is adopted as the shadow and missed. (Measured on the device, re-test: `channel:2` + `poll:15` with an image shown logged `image ended (device mode change): channel code 0x00 -> 0x02` and `channel <- device: cloud (mode not offered), tile cleared`; `channel:0` brought back the clock with `timebox_channel_changed: clock`.)
  - `TimeboxDevice.showImageFromUrl` / `showImageToken` only pick the source and call the controller. The Flow listeners
    (`src/flow/index.ts`) validate `fit` (`parseImageFitId`, `ArgumentError` field `fit`), `duration` (`parseTextDurationArg`) and the
    URL (`parseImageUrl`) before the device is called. The droptoken is passed as `args.droptoken` (an object with `getStream()`;
    the Web API cannot pass one: this Homey has no image Flow tokens and the API rejects a `droptoken` value with `Missing token value`, so
    **the "Show image" token card is checked in the v0.5.0 owner acceptance test** (UAT), not by the hardware test).
  - Errors (`device.error.image_unreachable|unreadable|too_large|unsupported|missing`, placeholders `{max_mb}`, `{max_mp}`, `{max_side}`) are `ImageError`s,
    `unreachable` is a failed download (address, HTTP error, timeout), `unreadable` a failed read of the image tag (own en/de text,
    `loadImageToken` / `readImageStream`); the log message of a failed request keeps the system error code of the cause (for example
    `request failed: fetch failed (ENOTFOUND)`). Localised by `localiseError` like argument errors; `invalid_url` is a normal argument error kind (see "User-facing errors").
  - PNG chunk structure: the first chunk must be a 13-byte IHDR, a later IHDR is refused, and a chunk reaching past the end of the
    file is `unsupported` (checked before anything is inflated).
  - Known limits: a GIF whose first frame reaches outside the logical screen is refused as `unsupported` (omggif cannot blit it
    safely; such files are rare and invalid); a timed or duration 0 image stays tracked after a power cycle of the Evo as long as
    its d0 equals the shadow, so weather and the hot flag stay held until the next mode command; no EXIF rotation, no colour profiles or gamma; only the first GIF frame; an image that still shows after an app
    restart is not known to the app (any mode change ends it); at expiry with the link down the image stays until the next mode
    command; large JPEGs and GIFs block the app for the decode time (bounded by the 5 MiB, 8.3 MP (3840 x 2160) and 16384 px per side limits; about
    150 ms locally for a 4K JPEG); a JPEG over 512 x 512 is averaged from its 8x8 blocks (fine detail below a block is lost, which
    a 16x16 panel cannot show anyway; a very thin panorama may look blocky); 12-bit, lossless, hierarchical and arithmetic-coded
    JPEGs are `unsupported`.
