# Persistent settings evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) section 5.4 (sleep light `40`/`a2`, startup mode `8a`, auto
power-off `ab`/`ac`); opcode rows and status stay there. The app uses only the sleep light (#6); the startup mode and the
auto power-off were dropped from #6 by the owner (2026-11-15: auto power-off does not work, the startup mode adds little
value)._

## Owner-attended run #36 (2026-11-15)

Mac BLE probe `scripts/probe/ble.py`, webcam photos, owner at the device (power button). Baseline before the run:
`8a 55 00`, `ac 55 00 00` (auto power-off off), `79 55 00`, `a2 55 01 16 00 00 00 3e ff 00 00 32`.

### Startup mode `8a` (#36)

`8a 01 CC`, read back with `8a 00` (`8a 55 CC`, every value as written), then a power cycle with the button. Before each
power cycle the panel showed a different view, so the boot shows the setting, not the last view.

| CC | Boots into | `46` d0 after the boot | `bd 17 ff` |
|---|---|---|---|
| `00` | clock (from orange lighting) | `00` | – |
| `01` | lighting (proved earlier, 2026-10-06) | `01` | – |
| `02` | cloud | `02` | – |
| `03` | "VJ effects": coloured blinking LEDs (`45 03` is NEGATIVE, so the app cannot select this view otherwise) | `03` | – |
| `04` | clock: the value is stored, but the unit falls back to the clock (no visualization/equalizer start) | `00` | no reply |
| `05` | custom, page 1 (device page 0) | `05` | `bd 55 17 00` |
| `06` | custom, page 2 (device page 1; page 0 was active before) | `05` | `bd 55 17 01` |
| `07` | custom, page 3 (device page 2) | `05` | `bd 55 17 02` |

So the custom pages are the values **5–7**, not 4–6 as the 2026-10-06 notes said. The noise meter was not tested (it has
no mode code). Restored with `8a 01 00`.

### Auto power-off `ab` (#36)

`ab 01 00` (1 min), read back `ac 55 01 00`, also after a power cycle. **The unit never powered off with it:**

- panel on, BLE link held with `46` every 30 s: 3.5 min, stays on;
- panel on, no link: 3.5 min, stays on;
- right after a power cycle, no link: 3 min, stays on;
- panel off (`45 01 … PP 00`), no link: 27 min, keeps advertising and stays connectable. In this window `46` d8 went
  from `00` to `01` while the panel stayed dark (photo): the d8 flip of #29
  ([status.md](status.md#spontaneous-power-on-after-off-29)).

In #29 `ab 05 00` with the panel off did power the unit off after 14 to 38 min, and it stayed unreachable until the
button. Whether and when `ab` fires is still open. Restored with `ab 00 00`.

## Sleep light `40` (research #6)

Payload `40 MI MO OO FL FH VV RR GG BB BR`: minutes, sound (0 = phone audio over Bluetooth, 1..23 built-in sleep
sounds), on `ff` / off `00`, FM low/high, volume, colour, brightness. `a2` reads the 10 bytes back.

### Owner-attended run #36 (panel on, `79 55 00`)

- `40 01 00 ff 00 00 32 ff 00 00 32`: no direct reply (unsolicited `bd 55 13 01 32 00` and `09 55 08` came right
  after it), full red panel; `a2` reads the new scene back.
- **`46` does not show the sleep light:** d0, d8 and the colour bytes stay exactly as before (tested from lighting, d0
  `01`, and from the clock, d0 `00`).
- **End of the timer: the unit powers itself off** with its power-off sound, about 50 s after the start (not a full
  60 s). The BLE link drops and the unit stops advertising (scan: not found). Only the power button brings it back.
  After the boot `a2` shows on/off `00`; the unit booted into its startup mode (clock).
- **Stop `40 01 00 00 00 00 00 00 00 00 00`** (on a 5-minute sleep light started from the clock): the panel goes back to
  the previous view (clock, `46` d0 `00`). The stop is **answered with an `a2` frame** (`a2 55 05 00 00 00 00 32 ff 00 00
  32`). It only clears on/off; the other bytes of the stop are ignored (minutes and colour stay from the start). A `40`
  with on/off `00` therefore cannot write a scene without starting it.
- Not restored: the stored sleep scene can only be written by starting a sleep light.

### Unattended research 2026-11-15 (hardware runner, BLE probe, webcam)

Every sleep light used 5 minutes and the stop `40 05 00 00 00 00 00 00 00 00 00` followed within about 2 min of the
first start (the end of the timer would have taken the unit off BLE). Off = `45 01 ff 88 00 64 00 00 00 00 00`.

- Baseline: `46` d0 `00` (clock), d3..d5 `ff 88 00`, d6 `32`, d8 `01`, d12..d14 `12 ff 7f`; `a2` =
  `a2 55 02 00 00 00 00 32 ff 00 00 32`; `09` = `08`; `79 ff` = `79 55 00`.
- **Q1, start while the panel is off.** After the off: dark, d0 `01`, d8 `00`. Start `40 05 00 ff 00 00 00 ff 00 00 32`:
  no direct reply; unsolicited `bd 55 13 01 32 00` and `09 55 00`. `46` d0 stays `01`, **d8 flips to `01`**; `a2` =
  `a2 55 05 00 ff 00 00 00 ff 00 00 32` (on `ff`). The panel showed a blue-white pixel graphic at 3 s and full red about
  65 s later. After 65 s d8 stays `01`. Sending the off again (the app's off or self-wake resend) darkens the panel and
  d8 goes back to `00`, but `a2` on/off stays `ff`: **the timer keeps running** and the power-off would still follow.
  The stop after that off is answered with `a2 55 05 00 00 00 00 00 ff 00 00 32`; the panel stays dark (d0 `01`, d8
  `00`). A start from off followed by the stop without an off in between (10 s) **lights the previous lighting colour**
  (orange full panel, d8 `01`).
- **Q2, mode change during a sleep light (panel on).** From the clock, a green sleep light (`46` unchanged: d0 `00`, d8
  `01`; `a2` on `ff`). `45 01 00 00 ff 64 00 01 00 00 00` (blue lighting) **replaces the sleep light on the panel, but
  `a2` on/off stays `ff`** (the timer still runs). The stop then clears on/off and the panel **stays on blue lighting**
  (no jump back).
- **Q3, volume byte.** `09` (speaker volume) does **not** follow VV: it stayed `00` with VV `0f`/`32`/`64`. The first
  start (VV `00`) set the speaker volume from `08` to `00`, and the stop did not reset it (restored with `08 08`); during
  the first run unsolicited `09` frames stepped `0c`, `0b`, … `05` over about 65 s (cause unknown). The webcam audio
  (5 s RMS) was too noisy for a scale: silence -44.9 dB; sound 1 with VV `00` -53.4 dB (inaudible), VV `0f` -33.2/-38.4,
  `32` -37.7/-22.7, `64` -25.6/-12.8 dB. Inferred only: audible from `0f` up, no sign of saturation at `0f`; the Divoom
  app's `3e` fits a 0..100 scale. The stop after the sound tests kept sound `01`, VV `64` and minutes `05`
  (`a2 55 05 01 00 00 00 64 00 00 ff 32`).
- Restored afterwards: speaker volume `08`, the baseline view (lighting `ff 88 00`, brightness `32`, clock colour
  `12 ff 7f`). Not restorable: the stored sleep scene. Auto power-off was not touched.

### Consequences for the app (#6)

- The sleep light is not a mode: the app does not change the mode tile; a start from off sets `onoff` true and re-reads
  `46` (the device reports d0 `01` and d8 `01`), so the self-wake check sends no off.
- Every display change from Homey sends the stop first while a sleep light started from Homey may still run (owner,
  2026-11-15); power off does not (the owner accepted the power-off at the end of the timer).
- "Stop sleep light" reads `a2` first and sends the stop only with on/off `ff`; the effect of a stop when nothing runs is
  unmeasured. It waits for the `a2` answer of the stop (on/off `00`).
- The volume byte is sent as the card's 1..100 % unchanged (inferred scale; owner UAT checks the sound).
- Inferred: an `a2` read does not light an off panel (step Q1: the panel stayed dark through `a2` reads after the off).
  The `09 55 00` push after a start reaches the app's volume handling like any `09` report.

Details of the app behaviour: [architecture/sleep-light.md](../architecture/sleep-light.md).
