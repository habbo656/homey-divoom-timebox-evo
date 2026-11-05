# Status 46 evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) section 3; opcode rows and status stay there._

## 3 Status 46: evidence

d0 stays `00` while the clock view shows animation pages (probe #106, section 5.1 "Animation pages": about 190 queries during the series, one per photo), so `46` does not tell the time page from an animation page and there is no cloud drift to react to.

**Power off (`45 01 … 00`), probe 2026-10-06 (#26).** Mac BLE probe with a webcam photo after each step (`scripts/probe/ble.py`,
`snap:`), nothing else holding the link. Start: clock `45 00` (lit, `46` d0 `00`, d6 `64`).

| Step | Webcam | `46` |
|---|---|---|
| `45 01 ff 00 00 32 00 00 00 00 00` (off) | panel dark (only a stray LED dot) | d0 `01`, d3..d5 `ff 00 00`, d6/d10 `32`; `45 55 01` plus unsolicited `31 55 32`/`46` |
| `46` query while off, twice | still dark | d0 `01`, same bytes as before: **a query does not wake the panel**. **d8 is `00` while off (`01` on)**, see below |
| `74 28` (brightness 40) while off | **lit again**, lighting red | d0 `01`, d6/d10 `28`, **d8 stays `00` although the panel is lit** |
| off, then `45 00 01 00 01 00 00 00 ff ff ff` (clock full form) | clock shown | d0 `00` |
| off, then `45 02` | cloud channel shown | d0 `02` |
| off, then `45 04 00` | visualization shown | d0 `04` |
| off, then `45 05` | custom channel shown | d0 `05` |
| off, then `45 06` | scoreboard shown | d0 stays `01` (scoreboard shadow rule) |
| off, then `45 01 ff 00 00 32 00 01 00 00 00` | lighting red lit | d0 `01` |

**`46` d8 follows the power byte of the last `45` command** (a second probe run, 2026-10-06, `q` between the steps): `00` after
`45 01 … 00`, `01` after every `45 00`/`02`/`04`/`05`/`06`/`45 01 … 01`, and unchanged by `74` (still `00` with the panel
lit by `74 3c`). It was `01` in the clock view before the first off. So d8 reads "off" after the off command, but it is
not a reliable on/off flag: `74` lights the panel without changing it, and what a device-side power button does to it is
untested. The app keeps the power state itself (#26, see below) and uses d8 only to detect the self-wake while off (#29, below).

### Spontaneous power on after off (#29)

Hardware research, 2026-11-05 (CET), Mac BLE probe with webcam photos in `.hwtest/main/` (not in the repository). The unit
lit itself by itself while the app had sent the off command `45 01 ff 00 00 32 00 00 00 00 00 00`; it came back in the
lighting mode with the colour and brightness from before (the owner's observation in #29, measured here).

- **P0 (read only, before the probe):** `ac 55 3c 00` (auto power off 60 min, not the factory 30), `a2 55 01 16 00 00 00 3e ff 00 00 32`,
  `b3 55 00 12`, `42 00`..`42 09` ten empty records (no alarm on). `46`: clock channel, d0 `00`, d8 `00`.
- **P1, `18` while off:** off, then `18` with the current time (reply `18 55 76 00`), then `5f` (weather): photos `p1-off`,
  `p1-after18`, `p1-after5f` all dark. **`18` and `5f` do not wake an off panel; neither does `46`** (above).
- **P2, connected, only `46` every 60 s:** off at 20:46:22. The `46` frame changed only in d8, `00` to `01`, first seen in the
  15th reply (about 14 min after the off, about 21:00). Photos: `p2-10` (20:56) dark, `p2-15` (21:01) and `p2-40` (21:27) solid
  red (the lighting colour `ff 00 00` of the off payload, inferred). d0 stayed `01` (the off shadow) the whole time.
- **P3, disconnected right after the off at 21:27:38** (the owner's test): `p3-0`, `p3-5`, `p3-20`, `p3-30` (21:57) dark,
  `p3-35` (22:02) and `p3-40` (22:07) solid red. The wake fell between 21:57:23 and 22:02:20, about 30 to 35 min after the off.
  **A reconnect does not cause it:** at 22:07:48 the panel was already lit when `46` was sent (`p3-reconnect`).
- **Conclusion (measured):** the firmware lights the panel by itself, with no app command and also without a BLE link. The
  only visible trace in `46` is **d8 `00` to `01` with d0 still `01`**. Both wake windows contain a full hour (21:00, 22:00
  on a device clock set at 20:45). That an hour-aligned firmware event is the cause is **inferred, not tested**; it does not
  follow the stored auto power off of 60 min (wakes at about 14 and 30 to 35 min).
- **P4, `ab 05 00` (auto power off 5 min), 22:08:** read back `ac 55 05 00`. The panel stayed dark in the photos viewed until
  22:22, then the unit stopped advertising and was unreachable (scan at 22:46 and retries until 22:50 found nothing, dark
  panel), so it was probably powered off by the timer (inferred). The restore `ab 3c 00` could not be sent. **Warning: never
  probe with a short `ab` unless the owner is at the device to press the power button afterwards.** Whether `ab 05 00` makes
  the panel wake is unanswered.

App rule (#29, `architecture/power-lighting.md`): while the app considers the panel off and a `46` report carries the shadow
d0 and d8 `01`, the app sends the off again. It only sees the wake while connected, and the panel can stay lit until the
next 60 s poll. What the device power button does to d8 is untested ([open-questions.md](open-questions.md)).

Consequences for the app (#26): the app tracks power itself; after off the device reports d0 `01` although nothing is
shown, so reports with that code are ignored while the app considers the panel off (the "off shadow", like the
scoreboard shadow); every channel command powers the panel on, so the power-on path just sends the channel to restore
and needs no extra lighting command first. A `74` (the `dim` capability, also a "dim" Flow) turns the
panel on (the panel shows the lighting channel again). Resolved in the app by #62: while the app considers the panel off it
holds the `dim` value and sends the `74` right after the next switch on (`architecture/power-lighting.md`).

Real captures (BLE, 2026-10-06, #20) are the golden vectors in `src/protocol/__fixtures__/golden.ts`: clock at brightness
50 and 20, lighting channel (d0 `01`, brightness 100), visualization channel (d0 `04`, d9 `03`) and an unsolicited report.
In all of them d6 equals d10. d9 is `0b` in the lighting capture, so it is the last visualization index only as long as
that index was set via `45 04 NN`; it is not reset by other channel changes.

Noise meter (`72 02 01`, #3): the app does not map any d0 to the noise meter. It tracks the mode itself and treats the first d0
reported after the switch as the "noise shadow" (any code confirms; reports equal to it are ignored, a different known code
ends the tracking). The d0 under the noise meter is still unmeasured (recorded by the #3 hardware test report); see `docs/architecture/modes.md`
"Noise meter (#3)" for the resulting rules and limits.

Use in the app (#24, #68, `docs/architecture.md` "Mode picker"): d0 is the sync source of the `timebox_channel` capability
(poll and unsolicited reports; the `45 55 NN` echo is not used). Codes `00 01 05` map to the modes `clock lighting custom`.
`02` (cloud) and `04` (visualizer) are other modes the app does not offer: the tile is cleared and no trigger fires (the
"other-mode rule"). Any other d0 (`03`, text, games, alarms) is logged and ignored. The commands `45 04` (visualization;
`setVisualization` was removed in #68) and `45 06` (scoreboard) are not used by the app; since `45 06` never changes d0, a
scoreboard on the device is invisible to the app. d3..d5 are an input of `channelCommand`: the lighting switch resends the
stored colour (black becomes white so the panel is visibly lit) with the known brightness. Homey implication: the stored
colour and the brightness are device state that survives mode changes, so a mode switch needs no state of its own.

Length: the plain query answers with 20 data bytes (d0..d19); the unsolicited report after a brightness change has 22
(the two extra trailing bytes were `55 00`, meaning unknown). `decodeStatus` (`src/protocol/status.ts`) therefore requires at least
16 data bytes (d0..d15), ignores the rest, and throws `FrameError` for shorter replies and `ProtocolError` for another
opcode or a status byte other than `55`. It returns channel (d0), lighting colour (d3..d5), brightness (d6), visualization
(d9), clock colour (d12..d14) and clock style (d15). **Brightness is not clamped**: a truncated `74` can leave the device
at 126 (section 2) and the app should show what the device reports.
