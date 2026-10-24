# Native text evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) section 5.5; opcode rows and status stay there._

## Opcode table notes

### 5.5 Native text row

| Payloads | Function | Status |
|---|---|---|
| `6e 01` → `86 01 LL <UTF-16LE text>` → `86 00 SP` → `6c 00 00 LLLL <frame0>` → `6c 01 00 LLLL <frame1>` | **native scrolling text**: the device renders and scrolls the text itself, in its own large font | **VERIFIED** (#28, section "Native text measurements" below): LL = number of UTF-16 code units, SP = speed (about SP columns per second), LLLL = LE16 length of that frame (1031 / 263 bytes), the device shows at most 64 units |

## 5.5 Native text: evidence

The native-text frames (from mert4x4/ditoo-pro-custom-firmware `show_native_text`): `frame0` = `aa 07 04 3c 00 00 00` + 256-colour
palette (127 × background, 127 × text colour, 2 × background) + 256 zero bytes; `frame1` = `aa 07 01 3c 00 01 00` + 256 zero bytes.
The firmware draws the glyph pixels as palette index + 127. The text runs over the current channel until `6e 00` or until a channel command / power off ends it (measurements below).

#### Native text measurements (#28, Mac BLE probe, 2026-10-07)

Method: `scripts/probe/ble.py` (step `text:`), one fresh connection per experiment, no Homey run active; webcam photos
(`scripts/hw-snap.sh`) and `imagesnap` timelapse (0.1 to 0.5 s interval). Scroll speed was derived by tracking the
16x16 lit-pixel grid between frames (shift in columns divided by the frame interval), long text by stitching the frames
into one strip. Evidence photos are not kept in the repo.

**Golden vector** ("Hallo Homey 123", SP 5, text `ff ff 00`, background `00 00 80`), shown on the Evo, scrolling in the
device font. Five payloads, each its own envelope:

| # | Payload |
|---|---|
| 1 | `6e 01` |
| 2 | `86 01 0f 48 00 61 00 6c 00 6c 00 6f 00 20 00 48 00 6f 00 6d 00 65 00 79 00 20 00 31 00 32 00 33 00` |
| 3 | `86 00 05` |
| 4 | `6c 00 00 07 04` + frame0 (1031 bytes), 1036 bytes in total, SHA-256 `a0a587877ec1c0bf4a8223ec13f56f5d54af5342b133e5c3f0f445dda5eae17d` |
| 5 | `6c 01 00 07 01` + frame1 (263 bytes), 268 bytes in total, SHA-256 `1084c78519b412d9b7ae54f2bbb94b15ec98fb0107f1238f5a9b4eb1d29a99cd` |

- **`6c` header = `6c FI 00 LLLL`** (FI = frame index 0 / 1, LLLL = LE16 byte length of that frame, `07 04` = 1031 and
  `07 01` = 263). The same LLLL is the length field inside the frame (`aa LLLL ...`). Other header variants (for
  example LLLL = total of both frames) were not tried. frame0 = `aa 07 04 3c 00 00 00` + 768 palette bytes (127 x
  background RGB, 127 x text RGB, 2 x background RGB) + 256 zero bytes, frame1 = `aa 07 01 3c 00 01 00` + 256 zero
  bytes, exactly as in the reference above. The colours are plain RGB (yellow on blue, green on dark red, magenta on
  dark green all correct).
- **Replies:** none of the five payloads is answered except by the usual `33 55 SEQ` envelope echo (no `6e 55`, `86`
  or `6c` reply). `6e 55 00` arrives only when a running text ends.
- **Timing:** payloads sent with 1.0 s, 0.05 s and 0 s between them (written back to back without waiting for the
  echoes) all work. The five payloads can be written in one go. The `33` echoes lag a little behind but all arrive.
- **Speed SP:** measured scroll speed in columns per second: SP 1 = 0.9 (coarse, 1.7 in a 0.57 s frame series), 2 = 2.0,
  3 = 3.1 to 3.5, 4 = 3.9, 5 = 4.3 to 5.2, 10 = 10.4, 20 = 18.6, 50 = 51.8. So **speed in columns per second is about SP**
  (pass time proportional to 1/SP, +-10 %). The text loops continuously, the loop of "Hallo Homey 123" (15 units) takes
  about 100 / SP seconds (SP 10: 9.9 s, SP 5: 20 s, measured). One glyph is about 6 to 7 columns wide on average. SP 5 is
  clearly readable. **App mapping (#28): slow 3, normal 5, fast 10** (pass time 1.7x / 1x / 0.5x). SP 0 and values above
  50 were not tried.
- **Maximum length: 64 UTF-16 code units.** 32 and 64 units show completely (marker "END" at the end is visible).
  65 to 255 units are accepted without error but the device silently shows only the first 64 units and loops (seen with
  91, 128 and 255 units, with narrow "i" tokens and with digit tokens, so it is a count limit and not a pixel width
  limit). No crash, the link and later commands keep working. The app does not cut: a cleaned text above **`MAX_TEXT_UNITS` = 64** units is rejected with an error and nothing is sent (#107, ADR 0008).
- **Characters:** ä ö ü Ä Ö Ü ß, € and é ñ render correctly in the built-in font, and so do CJK ideographs (日本).
  **Non-BMP characters (emoji, surrogate pair) show as one filled rectangle (missing glyph), not as the emoji** (2 units,
  one box). The app therefore strips non-BMP code points; lone surrogates are always stripped (not tried on the device,
  they would be invalid UTF-16). A line feed and a tab inside the text render as blank/no glyph, so the app replaces control
  characters with a space.
- **Replacing a running text:** a second full sequence (`6e 01` first) while text A runs replaces it immediately
  (new text and colours, only B visible). No `6e 00` is needed first.
- **`6e 00`:** with no text running it is harmless (sent twice, no reply, display and link unchanged). With a text running
  it replies `6e 55 00` and the underlying channel is shown again (clock, custom and lighting seen).
- **`46` during text:** answered normally and d0 is **unchanged**, it keeps reporting the channel under the text (`00`
  clock, `05` custom seen); text cannot be detected through `46`. 12 polls over 60 s (every 5 s) did not disturb the
  scrolling (constant 4.5 to 5.7 columns/s) and the link stayed up.
- **Channel commands end the text:** a `45 00` (clock) or `45 01` (lighting) sent while a text runs makes the device
  show the new channel at once and emit `6e 55 00` itself; the power-off command (`45 01 ... 00`) does the same and
  leaves a dark panel. An explicit `6e 00` before a mode change or power off is therefore not needed, the app only has
  to forget its running text. Not measured (assumption, the app does not rely on it): whether a mode change made at the
  device or in the official app, or entering cloud or the visualizer, ends a text as well.
- **Power:** with the panel off (`45 01 ... 00` = lighting power byte 0) a text lights the panel (`46` d8 reports `01`
  while the text runs). After `6e 00` the panel stays on (it showed the lighting colour, red). So "Show text" on an
  off device turns it on and the app must set `onoff` true.
- **Unexplained link loss (open point):** in the first session on 2026-10-07 the Evo dropped the BLE link a few seconds
  after a `6e 00` and then did not advertise at all until the owner power-cycled it. The identical sequence (text 8 s,
  `6e 00`, new text, with the same 1.0 s gaps) did not reproduce it in two later runs, and 16 further text sequences,
  stray stops, replaces and 255-unit texts were harmless. That session also had a Homey dev run on the same Evo shortly
  before, so it may have been a concurrent connection attempt. Not reproducible, keep it in mind for the hardware test.
