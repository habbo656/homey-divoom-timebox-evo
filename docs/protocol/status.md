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
untested. The app does not use d8 in #26 (it keeps the power state itself, see below); a follow-up could.

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
