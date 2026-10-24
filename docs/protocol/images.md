# Image and animation evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) section 4; opcode rows and status stay there._

## 4 Image and animation encoding: evidence

Golden vector (verified on screen; use it as a unit-test fixture): top row blue, rows 1–15 left half red and right half green.
Palette: blue, red, green, so 2 bits per pixel. Row 0 = `00 00 00 00`; rows 1–15 = `55 55 aa aa`.

```
SPP frame: 01 57 00 44 00 0a 0a 04 aa 50 00 00 00 00 03 00 00 ff ff 00 00 00 ff 00
           00 00 00 00 (55 55 aa aa ×15) 8f 22 02
```

- Reply `49 55` after the last chunk. Tested with 3 solid frames at 400 ms and 16 frames at 100 ms (a moving bar). Both
  looped correctly.
- This suits scrolling text: upload once, and the device animates it.
- Limits (VERIFIED): 60 frames (11 KB, 55 chunks) and 200 frames (36.6 KB, 183 chunks, ≈ 18 s upload over BLE) were
  accepted and played. The format caps the upload at 256 chunks (u8 index) and 65535 bytes (LE16 total).
- A static image with **256 colours** (palette count encoded as `00`, 8 bits per pixel) is accepted and shown.

## Static image behaviour (#31)

**Status: PARTLY MEASURED (hardware test #31 round 1 and re-test, 2026-10-08, app build on Homey via `scripts/homey-run.sh`, cards
driven through the Web API, webcam).** The planned Mac probe could not run: the Evo did not advertise (a scan found no
`TimeBox` device and `ble.py q` ended with `no BLE device found`), because a dev build on the owner's Homey held the single
BLE link. The hardware test then measured the app's `44` (256 colours, 8 bpp, 1036 bytes) on the device:

- `44` leaves `46` d0 unchanged: the status keeps reporting the mode from before the image (clock, tile stays clock).
- The image persists across status polls (unchanged after more than 75 s).
- `44` ends a running native text, and the text does not resume (no `6e 00` was needed; B1 confirmed).
- A text, a mode command (`45 ..`, also the mode re-send at the end of a duration) and power off end the image on the device.
- One `44` send (1036 bytes in chunks over BLE) takes about 5.2-5.6 s.
- The pictures were shown as expected (cover and contain of PNG, JPEG and GIF; 256-colour 8 bpp, M7).

Probe step for a later Mac measurement: `img8` in `scripts/probe/divoom.py` (golden picture as 256-colour 8 bpp image, NN
`00`, 1036 bytes; send with `--chunk 20`).

| ID | Question | Procedure (Mac, Homey run stopped, webcam) | Result |
| --- | --- | --- | --- |
| M1 | Does the image persist (> 65 s) and what does `46` d0 report after `44`? | `45 00`, `44`, wait 70 s with `q` and `snap:`; repeat from lighting (`45 01`) and custom (`45 04`) | from clock: persists > 75 s, d0 unchanged (still clock) (hardware test #31). From lighting / custom: not measured |
| M2 | Does `45 00` replace the image? | `img8`, `clock` | yes: a mode command ends the image (lighting, and the clock re-send at the end of a duration) (hardware test #31) |
| M3 | Does `44` with the panel off (`74 00`) show the image or light the panel? | `b0`, `img8`, `q`, `snap:` | not measured (the app turns the panel on before it sends `44`); power off ends a shown image |
| M4 | Text and image: does `44` end a running native text, does `6e 00` bring the image back? | `text:...`, `img8`; `img8`, `text:...`, `textoff` | `44` ends the text, the text does not resume; a text ends the image (hardware test #31). `6e 00` after a text over an image: not measured |
| M5 | Image over a running countdown (`72 03`) | `hex:7203...`, `img8`, `q` | **measured (re-test, dev harness):** with an image shown (duration 0), `channel:2` + `poll:15` -> the next poll logged `image ended (device mode change): channel code 0x00 -> 0x02` and `channel <- device: cloud (mode not offered), tile cleared`; `channel:0` returned the clock with `timebox_channel_changed: clock` **`44` over a running countdown measured (#101 P11 F, 2026-10-08):** the countdown keeps running under the image; its end frame `71 55 03 01 01 00` (and the trigger) still arrive at the end, afterwards the panel shows the clock, not the image. The app still tracks the image (`image shadow: device reports channel code 0x00`, the mode is unchanged), so weather and the clock flag stay held until the next display command. |
| M6 | Do `5f`, `74 32`, `26 01`, `18 ...` remove or change a shown image? | `img8`, then each opcode, `snap:` | not measured |
| M7 | Is `img8` displayed correctly? | `img8`, `snap:` | yes, as the app's 256-colour 8 bpp images (hardware test #31) |
| M8 | A mode change made at the device while an image is shown: what does d0 report? | `img8`, change the mode with the Divoom app or a button, `q` | the device reports the new mode in d0 and the app ends the image: with an image shown (duration 0), dev harness `channel:2` + `poll:15` -> next poll logged `image ended (device mode change): channel code 0x00 -> 0x02` and `channel <- device: cloud (mode not offered), tile cleared`; `channel:0` returned the clock with `timebox_channel_changed: clock` (hardware re-test #31) |

### Branches

- **B1** (does `44` end a running native text): **confirmed** (M4). The app treats an image like a countdown start: it
  marks the text as ended by the image.
- **B2** (do `5f` weather and `26` hot-flag sends remove the image): not measured (M6), assume yes. The app does not send `5f` or `26` while an
  image is tracked and a weather hold returns `image shown` instead of sending.
- **B3** (does `46` d0 change after `44`, which would trip the "other mode" detection): measured from clock, d0 does not
  change (M1), which is consistent with the shadow (the shadow is the mode before the image). The app remembers the
  first d0 reported after the image (the "image shadow") and ignores reports equal to it; a later different known code ends the
  image tracking and is handled normally (M8: measured, the device mode change ends the image as described).

## Native 16x16 image (#129)

Hardware test, 2026-10-17, Homey Pro, TimeBox Evo, dev build 8d614194a75b (branch sources). Images generated with
pngjs/omggif, served over HTTP on the LAN and sent with the Flow action `timebox_show_image_url` (duration 0):
`native16.png` (RGBA 16x16, 33 colours: 1-px red/blue checkerboard top-left with red at 0,0; white at even / black at odd
columns top-right; grey ramp rows 8..11; green ramp rows 12..15, x*255/15), `native16.gif` (same pattern, 64-entry
first-seen palette), `control32.png` (32x32 1-px red/blue checkerboard).

| Case | Log | Webcam photo |
| --- | --- | --- |
| PNG 16x16, cover | `image loaded: <host>:8129, png 16x16, 208 bytes, prepared in 19 ms`; `image shown: 33 colours, cover, until a mode change` | full 16x16, no bars; distinct red/blue 1-px checkerboard (red at the corner, not purple); single white columns separated by black columns (not grey); grey ramp dark to white; green ramp dark to bright |
| GIF 16x16, contain | `gif 16x16, 326 bytes, prepared in 7 ms`; `image shown: 33 colours, contain, until a mode change` | visually identical to the PNG |
| Control PNG 32x32, cover | `png 32x32, 848 bytes, prepared in 18 ms`; `image shown: 1 colours, cover, ...` | evenly magenta/purple, no pattern: resampling would be visible, so the 16x16 steps above were not resampled |

- The panel was off at the start: `image: panel is off, turning it on first` (expected). Cleanup: mode clock gave
  `image ended (mode change)` and `clock face confirmed`.
- The log has no `image failed`, `RangeError`, `TypeError`, `Unhandled`, `Memory Warning`, `channel_changed`, URL path or
  app restart; the app logs host:port only.
- Ramp observation (webcam, uncalibrated exposure; an observation, not a measurement): the grey ramp's 16 columns show the
  first 2-3 nearly black, steps visible one by one from about column 4, and the brightest 4-5 merge in camera
  overexposure; of the green ramp about 12-13 of 16 steps are clearly distinguishable, the first 2-3 very dim. No coarse
  banding was visible. The panel's real colour depth cannot be measured with the webcam; the app only sends 8 bits per channel.
