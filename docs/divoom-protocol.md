# Divoom Timebox Evo — protocol notes

_Living document. Add verified findings only, with source, date and how they were verified._

Status labels:
- **VERIFIED**: confirmed on the owner's Evo (device reply and/or webcam photo of the display), 2026-10-06.
- **ACK**: the device acknowledges or reads back the value, but the effect was not observable (e.g. audio).
- **SOURCE**: documented in a reference project (see Sources), not tested here.
- **NEGATIVE**: tested and does **not** work.

## Evidence files

Opcode rows (payload, function, reply, status) live here. Probe logs, photo series and long evidence go to
`docs/protocol/<topic>.md` (new topic file if none fits), linked from the row. Section numbers are stable; code cites them.

Key rules (details in the evidence files):
- BLE: subscribe to notifications; poll `46` for liveness, never rely on `f7` heartbeats ([transports.md](protocol/transports.md)).
- `74 BB` (brightness): `00` turns the panel off; any send while the panel is off lights it again (the app holds `dim` while off since #62) ([display.md](protocol/display.md#opcode-table-notes)).
- The hot flag `26 0X` controls the clock's animation pages; it persists on the device ([clock.md](protocol/clock.md)).

- [protocol/transports.md](protocol/transports.md): sections 1.1 to 1.4, 2 and 10 (GATT, envelope, RFCOMM, SPP frame, replies, diagnostics)
- [protocol/status.md](protocol/status.md): section 3 (status `46`, power-off probe)
- [protocol/images.md](protocol/images.md): section 4 (image and animation encoding)
- [protocol/display.md](protocol/display.md): section 5.1 and 5.4 opcode table notes (brightness, lighting, visualization, scoreboard, time, weather, alarm, memorial, custom pages)
- [protocol/clock.md](protocol/clock.md): section 5.1 clock rows, animation pages (`26 0X`), small clock quirk
- [protocol/native-text.md](protocol/native-text.md): section 5.5 native text row and measurements
- [protocol/countdown.md](protocol/countdown.md): section 5.1 countdown row and section 5.6 measurements
- [protocol/audio.md](protocol/audio.md): sections 5.3 and 6 (audio, A2DP)
- [protocol/homey-implications.md](protocol/homey-implications.md): section 9
- [protocol/open-questions.md](protocol/open-questions.md): section 11

## TL;DR

1. **BLE works**, which is the transport Homey can use. Write the ISSC characteristic `49535343-8841-…` and get replies
   from `49535343-1e4d-…`. Each command payload must be wrapped in the **`FE EF AA 55` envelope** with a sequence
   number whose **high byte is non-zero** and whose **low byte differs from the last accepted command**. No handshake,
   no init sequence, no pairing. VERIFIED.
2. The legacy SPP frame `01 … 02` sent over BLE is **silently ignored** (that is why the first app version showed
   nothing on hardware, #4/#5): over BLE every command needs the envelope instead. NEGATIVE.
3. Bluetooth Classic RFCOMM channel 1 also works, with the SPP frame `01 … 02`. VERIFIED. Homey cannot use it
   (section 9).
4. The command payloads (opcode + args) are **identical on both transports**. Replies always come as SPP frames.
5. Display features are well covered (section 5), including **native scrolling text**, a pixel drawing pad and
   notification icons (5.5). For audio, only volume (`08`/`09`) and the playing status (`0b`)
   are usable from BLE. Audio itself has to come from a phone or computer via A2DP (section 6).

## 1. Transports

### 1.1 BLE GATT: VERIFIED (Mac, bleak)

| Role | UUID | Notes |
|---|---|---|
| Service (ISSC transparent UART) | `49535343-fe7d-4ae5-8fa9-9fafd205e455` | |
| **Write** | `49535343-8841-43f4-a8d4-ecbe34729bb3` | write / writeWithoutResponse, both work |
| **Notify** | `49535343-1e4d-4bd9-ba61-23c647249616` | replies, as SPP frames |
| other | `49535343-aca3-481c-91ec-d85e28a60318` | write+notify, inert (NEGATIVE) |
| other | `49535343-6daa-4d02-abf6-19569aca69fe` | read |
| Device Information | `180a` | read |

- **Homey format:** `homey.ble` reports UUIDs without dashes in lower case (`49535343fe7d4ae58fa99fafd205e455`); `BleTransport` compares
  them normalised (dashes stripped, lower case), so both forms match. The advertised names alternate (see the evidence below).
- No pairing or bonding is needed. It works with the Classic link connected or disconnected.
- **Write size:** 138-byte and **20-byte** writes both work. The Evo reassembles the envelope by its length field.
  Tested with a 96-byte image packet in 20-byte writes, with response.
- Evidence: [transports.md](protocol/transports.md#11-ble-gatt-evidence).

### 1.2 BLE envelope: VERIFIED

```
FE EF AA 55 | LEN (2, LE) | SEQ_hi SEQ_lo | 00 00 00 | PAYLOAD | CRC (2, LE)
LEN = 2 (seq) + 3 (zeros) + len(PAYLOAD) + 2 (crc)
CRC = (LEN_lo + LEN_hi + sum(SEQ_hi, SEQ_lo, 00, 00, 00, PAYLOAD)) & 0xFFFF
```

Example: lighting red with seq `0x0101` →
`fe ef aa 55 0f 00 01 01 00 00 00 45 01 ff 00 00 64 00 01 bb 01`.

**Sequence number rules** (determined from the replies, 2026-10-06):
- `SEQ_hi == 0x00` → ignored (`0x0001`, `0x0080`, `0x00ff` were all ignored). Any other high byte works (`0x01`,
  `0x02`, `0x03`, `0x07`, `0x50` were all accepted).
- `SEQ_lo` equal to the low byte of the **last accepted** command → ignored as a duplicate (`0x0110` then `0x0210`:
  the second was ignored). Ignored packets do not update this state.
- Order does not matter: `0x0150` then `0x0140` were both accepted. The state is per connection: every fresh connection
  accepted its first packet.
- Recommendation: `seq = 0x0100 | (n & 0xFF)` with `n` incremented per command. Matches iOS (`0x0101`, `0x0102`, …).
- Evidence: [transports.md](protocol/transports.md#12-ble-envelope-evidence).

### 1.3 Bluetooth Classic RFCOMM: VERIFIED (Mac, IOBluetooth via PyObjC)

Evidence: [transports.md](protocol/transports.md#13-bluetooth-classic-rfcomm-evidence).

### 1.4 SPP frame (used on RFCOMM, and for all replies): VERIFIED

```
01 | LEN (2, LE) | PAYLOAD | CRC (2, LE) | 02      LEN = len(PAYLOAD) + 2, CRC = sum(LEN bytes + PAYLOAD)
```

No escaping is needed. The app only parses this frame (replies); it never sends it over BLE. Reply decoding lives in
`src/protocol/replies.ts` (#19).

Evidence: [transports.md](protocol/transports.md#14-spp-frame-evidence).

## 2. Replies (both transports): VERIFIED

```
01 | LEN | 04 | CMD | 55 | DATA… | CRC | 02
```

Several frames can arrive in one read or notification, so split them by the length field (`src/protocol/replies.ts`, #19).
`parseReply` returns `{cmd, ok (status byte == 55), data (bytes after it), kind}` with kind `heartbeat` (`f7`),
`seqEcho` (`33`), `brightness` (`31`), `status` (`46`) or `other`. Note: the `04` marker is taken from the frame layout
above; the unsolicited examples below are written without it. If hardware shows a frame without `04`, adjust
`parseReply` (open point for #21).

**No input validation, no NAK** (VERIFIED 2026-10-06): the old Timebox answered malformed commands with `XX AA`
(MarcG046/timebox). The Evo does not. It executes truncated commands with garbage arguments: `74` without an argument set
brightness to 126 (out of range), `45 01 ff` switched lighting on with a random brightness and stored a random colour, and a
truncated `44` was acknowledged with `44 55`. Unknown opcodes (`e5`) get no reply. **The app must validate every
argument before sending.** The device will not reject anything.

Evidence: [transports.md](protocol/transports.md#2-replies-evidence).

Unsolicited frames:
- `f7 55 …`: heartbeat over BLE, roughly every second (e.g. `f7 55 4e 6f 62 02 69 04 00 00`). Seen only after the
  iOS-style init sequence (orionparrott). It never came on a plain connection during the 30-min soak test.
- `33 55 SS 00 00 00`: BLE sequence echo (SS = the seq low byte of an accepted packet), seen during init.
- `31 55 BB`: brightness report, sent after view and brightness changes. The app only decodes it inbound (#22: it updates
  the `dim` capability); it never sends `31`.
- `71 55 03 01 01 00` (and, right after it and about 12 s later, `bd 55 13 01 32 00` / `bd 55 13 01 1e 00`): the countdown has ended (section 5.6, #33). Since #101 the app fires the Flow trigger "Countdown ended" on exactly the `71` frame (no state change; any other `71` frame is only logged). The `bd 55 13` frames (meaning unknown) are ignored, and the custom-page read `bd 17 ff` accepts only a `bd` reply with sub-opcode `17` (`ConnectionManager.request` has an optional `accept` filter), so a `bd 55 13` can no longer answer it.
- `46 55 …`: status dump, sent after brightness changes. Every decodable `46` (unsolicited or the answer to our poll or
  `dim` confirmation query) updates `dim` (#22); the app sends `46` solely as the query (poll and `dim` confirmation).

## 3. Status `46`: decoded fields

`46 55 d0 d1 … d19`:

| Byte | Meaning | Evidence |
|---|---|---|
| d0 | current channel (`00` clock, `01` lighting, `02` cloud, `04` visualization, `05` custom) | matches the `45` replies. **Exception: `45 06` (scoreboard) does not change d0** (it keeps the previous channel's code, observed Homey Pro 2026-10-06, #24) |
| d3..d5 | lighting colour R G B | `ff 00 ff` after magenta, `00 ff 00` after green |
| d6, d10 | brightness 0..100 | change with `74` |
| d12..d14 | clock colour R G B | `00 ff ff` after a cyan clock (the app owns the clock colour since #69 and only compares d12..d14 in a log line) |
| d9 | last visualization index (`45 04 NN`) | `0e` after `45 04 0e` |
| d15 | clock style TT | `09` after `45 00 01 09 …` (the app compares d12..d15 with the requested clock face after a clock switch, #25) |
| others | unknown (d2, d18 = `01` after an alarm fired) | |

Evidence: [status.md](protocol/status.md#3-status-46-evidence).

## 4. Image and animation encoding: VERIFIED

**Static image `44`:** `44 00 0a 0a 04 | aa | LLLL (LE) | 00 00 00 | NN | palette (NN × RGB) | pixels`
- `LLLL` = bytes from `aa` to the end of the pixel data. `NN` = palette size (256 encoded as `00`).
- Palette entries are **8 bits per channel** (`NN` × 3 bytes, VERIFIED with 256 colours). The 4-bit RGB format (`44 00 0a 0a 04` + 182 bytes) belongs to the original 11x11 Timebox only, not to the Evo.
- Pixels are **row-major, top-left first**. Each pixel is a palette index of `ceil(log2(NN))` bits (min 1), packed **LSB-first**.
- Reply `44 55 ZZ`. ZZ varies (`6b`, `25`, `59`, `13`, `1f`), so treat any `44 55` as success.

Evidence: [images.md](protocol/images.md#4-image-and-animation-encoding-evidence).

**Consequences for the app (#31):** the app sends every image as 256 colours at 8 bits per pixel with the palette padded
to 256 entries (NN `00`, 1036 bytes, the only widths verified besides 2 bpp). An image is an overlay, not a mode: it ends
with the next mode command (`45 ..`). Measured on the device (hardware test #31): `44` leaves `46` d0 unchanged (it keeps
reporting the mode from before the image, so the app's "image shadow" is that mode), the image persists across status
polls (> 75 s), `44` ends a running native text (which does not resume), and a text, a mode command and power off end the
image; a mode change made at the device while an image is shown shows up as a different d0 at the next poll (the app then ends the image). One `44` send takes about 5.2-5.6 s over BLE. **Not measured:** what `5f` and `26` do to a shown image (the app
holds them while an image is shown) and `44` over a countdown or with the panel off ([images.md](protocol/images.md#static-image-behaviour-31)).

**Device-side animation `49`** (plays in a loop on the device; no streaming needed):
- frame = `aa | LLLL (LE, incl. aa+LLLL) | TTTT (LE, ms) | 00 | NN | palette | pixels`
- stream = all frames concatenated, sent as chunks of ≤ 200 bytes, each as payload `49 | TOTAL (LE16) | INDEX (u8) | chunk`.
- Evidence: [images.md](protocol/images.md#4-image-and-animation-encoding-evidence).

## 5. Command reference

Payload = opcode + args (wrap per transport). Names from the decompiled Divoom app (`SppProc.CMD_TYPE`).

### 5.1 Display and system: tested

| Payload | Function | Reply | Status |
|---|---|---|---|
| `74 BB` | brightness 0..100 | `32 55 BB`, `46 …` | VERIFIED = acked and stored (read back in `46` d6/d10); visible effect unresolved (#49) — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `32 BB` | `SPP_LIGHT_ADJUST_LEVEL` | `32 55 BB` | ACK, value stored but not as a percentage: sent 5 / 100 / 5 / 100, read 66 / 20 / 0 / 20 (a relative step or level index); the panel went off at the 0 step. Meaning unclear, `dim` stays on `74` (owner decision) |
| `45 00` | clock view (keeps last style) | `45 55 00` | VERIFIED. The app does not send it any more: every clock selection sends the full form below (#25) |
| `45 00 HH TT 01 WW EE CC RR GG BB` | clock: HH 24h/12h flag (`01`/`00`, **no effect**, see [clock.md](protocol/clock.md#opcode-table-notes); the app always sends HH `01`, #70), TT style, `01` fixed, WW weather / EE temperature / CC calendar page flags, colour RR GG BB | `45 55 00` | VERIFIED (Homey Pro 2026-10-06, #25) — notes: [clock.md](protocol/clock.md#opcode-table-notes) |
| `45 01 RR GG BB BB TT PP 00 00 00` | lighting: colour, brightness, TT effect, PP power | `45 55 01` | VERIFIED — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `45 02` | cloud channel | `45 55 02` | VERIFIED (pixel-art gallery) |
| `45 03 NN` | VJ effects (upstream) | none | **NEGATIVE on the Evo**: from lighting red, `45 03 05` changed nothing and `46` still reported channel 01. An earlier "visual" result was the rotating clock channel |
| `45 04 NN` | visualization NN | `45 55 04` | VERIFIED — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `45 05` | custom channel | `45 55 05` | VERIFIED |
| `26 0X` | set the "hot" flag: `26 01` animation pages in the clock rotation (factory state), `26 00` none; read with `26 ff` (section 5.2) | **none** (no reply to the set; the read `26 ff` answers `26 55 0X`) | VERIFIED (Mac probe 2026-10-07, #106, #59) — notes: [clock.md](protocol/clock.md#opcode-table-notes) |
| `45 06` | scoreboard view | `45 55 06` | VERIFIED — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `44 …` | static image | `44 55 ZZ` | VERIFIED (section 4) |
| `49 …` | device-side animation | `49 55` | VERIFIED (section 4) |
| `72 00 SS` | stopwatch: `01` start, `00` stop | `72 55 00` | VERIFIED |
| `72 01 01 RRRR BBBB` | scoreboard red/blue (LE16, ≤ 999) | `72 55 01` | VERIFIED (shows red bottom, blue top) |
| `72 02 01` | noise meter (dB) | `72 55 02` | VERIFIED |
| `72 03 OO MM SS` | countdown: OO `01` start / `00` stop, MM minutes (0..99), SS seconds (0..59) | `72 55 03`; unsolicited `71 55 03 01 01 00` when it ends | VERIFIED (Mac probe 2026-10-07, #33, section 5.6) — notes: [countdown.md](protocol/countdown.md#opcode-table-notes) |
| `18 YL YH MO DD hh mm ss WD` | set date/time (year = YH*100+YL, WD 0=Sun) | `18 55` | VERIFIED — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `5f TT WW` | weather: temperature (signed), type 1 clear, 3 cloudy, 5 thunder, 6 rain, 8 snow, 9 fog | none | VERIFIED — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `2b UU` | temperature unit 0 °C / 1 °F | none | SOURCE (sent, not observed) |
| `2d HH` | 12h/24h (`00`/`01`) | none | SOURCE. No visible change. The HH byte of `45 00` has no visible effect either (see above), so 12 h is not available on this Evo so far |
| `a0 01 GG` / `a0 00 00` | start game GG / exit | `a0 55` | VERIFIED (game 0, game 2 shown; exit returns to the previous view) |
| `88` | game "go"/shake | none | sent, no visible effect in game 2 |
| `46` | status query | section 3 | VERIFIED |

**Animation pages in the clock view (VERIFIED, Mac BLE probe 2026-10-07, #106, resolves #59; photos `.hwtest/agent_issue-106-clock-animations/`, gitignored).**

Evidence: [clock.md](protocol/clock.md#51-animation-pages-in-the-clock-view-evidence).

**Quirk: the small clock (TT `06`) entered from lighting or from off shows the default dial (VERIFIED, probe 2026-10-07, #88, photos `.hwtest/main/298-323` and `.hwtest/agent_uat-v0.3.0-r2/02-15`).**

Evidence: [clock.md](protocol/clock.md#51-small-clock-quirk-evidence).

### 5.2 Queries: tested, reply observed

| Payload | Function | Reply observed |
|---|---|---|
| `09` | get volume | `09 55 VV` (0..15) |
| `0b` | get play status | `0b 55 00` |
| `13` | get standby mode | `13 55 00` |
| `42` | get alarms | 10 alarm records of 10 bytes |
| `53` | get memorials | 10 frames `53 55 SLOT …` |
| `57` | get time-manage ctrl | `57 55 00` |
| `59` | get device temperature info | `59 55 00 00 00` |
| `73` | get net temp display info | `73 55 01 00 26 00 00 00 00` |
| `a2` | get sleep scene (same layout as `40` args) | `a2 55 01 00 00 00 00 05 ff 00 00 32` after `40 01 00 00 00 00 05 ff0000 32` |
| `a8` | get sound ctrl | `a8 55 00` |
| `aa` | get play-voice status | `aa 55 00` |
| `ac` | get auto power off | `ac 55 1e 00` (30, LE16 minutes) |
| `b0` | get connected flag | `b0 55 01 02` |
| `b3` | get energy ctrl | `b3 55 00` |
| `8a 00` | get startup channel | `8a 55 00` (clock) |
| `26 ff` | get "hot" flag (`26 55 01` = animation pages in the clock rotation, `26 55 00` = off; set with `26 01`/`26 00`, section 5.1) | `26 55 01` (factory state), `26 55 00` after `26 00` |
| `76`, `b6 ff`, `bd 13/15/18/27` | unknown queries from the iOS init | replied |
| `15`, `47`, `60`, `64`, `68`, `70`, `71`, `7d`, `97`, `b4`, `ba 01` | various gets | **no reply** |

### 5.3 Audio: tested 2026-10-06 while the Mac streamed audio (Safari) to the Evo via A2DP

Measured with the webcam microphone in front of the Evo (RMS of 2–3 s windows, quiet room ≈ 0.00015).

| Payload | Function | Result |
|---|---|---|
| `08 VV` | set volume 0..15 | **VERIFIED**: RMS 0 → 0.00015 (silent), 1 → 0.001, 4 → 0.008, 8 → 0.013, 15 → 0.075. No reply frame; `09` reads the value back |
| `09` | get volume | `09 55 VV` |
| `0b` | get play status | `0b 55 01` while A2DP audio plays, `00` when idle |
| `0a PP` | play `01` / pause `00` | no audible effect on the A2DP stream; `0b` stays `01`. Probably controls the Evo's own player, not the phone/Mac (no AVRCP) |
| `12 NN` | next `01` / previous `00` track | no audible effect on the A2DP stream |
| `05 MM` | source mode: 0 Bluetooth, 1 FM, 2 line-in, 3 SD | `05 55`. Switching to FM caused at most a ~1 s dropout; the A2DP audio kept playing. FM itself was never audible (the Evo probably has no FM radio) |
| `61 LO HI` / `60` | FM frequency set/get | no reply |
| `a5 OO MM VV` / `a3 OO …` | alarm / sleep-scene sound preview | no audible effect, no reply |
| `a7 OO` / `a8` | sound ctrl | `a7 55 ZZ`; `a8` reads back `OO`. No audible effect |

Evidence: [audio.md](protocol/audio.md#53-audio-evidence).

### 5.4 Persistent settings and extras: tested 2026-10-06 (owner allowed device changes)

All of these were written, read back, and restored afterwards (alarms off, memorial cleared, startup clock,
auto-off 30, current time).

| Payload | Function | Reply / read-back | Status |
|---|---|---|---|
| `43 II OO hh mm WD MM TT FL FH VV` | alarm slot II (0..9): on, time, weekdays bitmask (bit0=Sun, `7f` = every day), mode, trigger, FM, volume | `43 55`; `42` returns the 10-byte record unchanged | VERIFIED — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `54 SS OO MO DD hh mm 01 + 32 B title` | memorial slot SS (0..9): on, date/time, title as 16 UTF-16BE chars (zero-padded) | `54 55`; `53` returns the record including the title | VERIFIED (read-back) — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `40 MI MO OO FL FH VV RR GG BB BR` | sleep: minutes, mode, on/off, FM, volume, colour, brightness | none; `a2` returns the same 11 bytes | VERIFIED: on → full panel in the given colour; off → previous view |
| `8a 01 CC` | startup channel (persistent): 0 clock, 1 lighting, 2 cloud, 3 signal, 4–6 custom | none; `8a 00` → `8a 55 CC` | VERIFIED: after a power cycle the Evo booted into lighting |
| `ab LL HH` | auto power off in minutes (LE16) | none; `ac` → `ac 55 LL HH` | VERIFIED (read-back; survived a power cycle). Actual power-off not waited for |
| `bd 17 PP` / `bd 17 ff` | select custom page 0..2 (after `45 05`) / read it | read → `bd 55 17 PP` | VERIFIED — notes: [display.md](protocol/display.md#opcode-table-notes) |
| `17 KK` + `21 KK` | game key down/up: 1 left, 2 right, 3 up, 4 down, 5 ok | none | inconclusive: no visible effect in game 0 |
| `8b …` | newer animation upload (orionparrott) | – | not tested; `49` is sufficient |

Persistence: alarm, memorial, sleep settings, startup channel and auto-off all survive a power cycle (read back
after reboot). The device clock also survived. Never send firmware/file opcodes (`93`–`9e`), and do not send `75`
(device name) without the owner's consent.

### 5.5 Native text, drawing pad, notifications: tested 2026-10-06

| Payloads | Function | Status |
|---|---|---|
| `6e 01` → `86 01 LL <UTF-16LE text>` → `86 00 SP` → `6c 00 00 LLLL <frame0>` → `6c 01 00 LLLL <frame1>` | **native scrolling text**: the device renders and scrolls the text itself, in its own large font | **VERIFIED** (#28) — notes: [native-text.md](protocol/native-text.md#opcode-table-notes) |
| `6e 00` | stop native text | VERIFIED: reply `6e 55 00` (only when a text was running), the previous channel returns. A stray `6e 00` with no text is harmless (no reply, nothing changes) |
| `86 …` alone (without `6e`/`6c`) | – | NEGATIVE: nothing shown |
| `6f RR GG BB` | enter drawing pad, filled with a background colour | VERIFIED |
| `58 RR GG BB NN <NN pixel offsets>` | set pixels (offset = y·16 + x, ≤ 200 per command) | VERIFIED: red diagonal, green top row |
| `5a` | leave drawing pad | sent; the drawing stays visible until the next channel change |
| `50 TT` | notification icon for app type TT | VERIFIED: `50 55`; an app icon shows for ~2 s, then the previous view returns (1 = colourful icon, 3 = Facebook "f") |
| `50 TT LL <UTF-8 text>` | notification with text | `50 55`; the icon showed, but the text was not seen in the photos |
| `84` | reset notifications | sent, no reply |

Evidence: [native-text.md](protocol/native-text.md#55-native-text-evidence).

### 5.6 Countdown `72 03`: measured 2026-10-07 (#33)

Evidence: [countdown.md](protocol/countdown.md#56-countdown-evidence).

Consequences for the app (`docs/architecture.md`, "Countdown"): the app sends the plain frames, does not track the
countdown and does not wait for the end frame; it fires the Flow trigger "Countdown ended" (#101) on every
`71 55 03 01 01 00` the device sends (also for a hidden countdown or one started outside Homey); with the panel off the end display lights the panel, so the app then sets `onoff` true and re-reads `46` (#125). A stop only works while the countdown is on screen; after a stop the
device would go to the clock, so the app re-sends the known mode right after it (the re-send wins) and **skips the
stop while the panel is off** (it would be ignored and the mode re-send would light the panel). Anything that hides a
countdown (a mode change, a text, power off) does not end it, so its end display reappears later. Starting a countdown
ends a running text, and starting one with the panel off lights it.

## 6. Audio summary

Evidence: [audio.md](protocol/audio.md#6-audio-summary-evidence).

## 7. Text rendering

The Evo has **native scrolling text** (section 5.5): the device renders and scrolls the text itself, supports Unicode
via UTF-16 and needs no frame streaming. The app uses it (#28, ADR 0005, ADR 0008); there is no app-level text renderer
(the earlier 5x7 font renderer and scroll planner were removed in the rebuild, #18). Measured in #28: speed about SP columns
per second, at most 64 UTF-16 units shown, umlauts, euro sign and CJK draw, emoji do not (filled box); details in the
section "Native text measurements" of 5.5. The app maps slow / normal / fast to SP 3 / 5 / 10, rejects texts above 64 units
(#107) and strips non-BMP characters.

The app does not track which view it last set; the current channel can be read from the device: `46` d0 (section 3).

## 8. How to probe (Mac)

Scripts: `scripts/probe/` (`ble.py` for BLE, `rfcomm.py` for Classic, `divoom.py` for the codec and envelope; see its README).
Webcam: `imagesnap`. Microphone: `sox -t coreaudio "<mic name>" out.wav trim 0 3` + `sox out.wav -n stat`.
Always start with `q` (`46`): a reply means the link and the framing are good.

Safety while probing: `18` changes the device clock (restore it with the current time afterwards), and `8a 01`, `43`,
`54`, `40` and `ab` are persistent. Connecting Classic hijacks the Mac's audio devices (restore them with
`SwitchAudioSource`).

## 9. Homey implications

Evidence: [homey-implications.md](protocol/homey-implications.md#9-homey-implications-evidence).

## 10. Diagnostics

Evidence: [transports.md](protocol/transports.md#10-diagnostics-evidence).

## 11. Open questions

Evidence: [open-questions.md](protocol/open-questions.md#11-open-questions-evidence).

## Sources

- Protocol knowledge base (owner, private: `habbo656/divoom-timebox-protocol-rea`): app 3.8.42 and firmware 25024,
  mostly hardware-verified; agents query it as the skill `divoom-evo` ([pipeline](pipeline.md#protocol-knowledge-base)).
- RomRider/node-divoom-timebox-evo, PROTOCOL.md: SPP frame, image format, channels.
- d03n3rfr1tz3/hass-divoom (`devices/divoom.py`): command catalogue and argument layouts (RFCOMM). Also an ESP32
  Classic-BT proxy (d03n3rfr1tz3/esp32-divoom) as a bridge option.
- orionparrott/divoom-protocol: BLE envelope `FE EF AA 55` and the iOS init capture (TimeBox-Evo-audio).
- DavidVentura/divoom (decompiled `SppProc.java`): opcode names (114 commands).
- mert4x4/ditoo-pro-custom-firmware `docs/opcodes.md`: argument details (Ditoo Pro, same command family).
- MarcG046/timebox `doc/protocol.md`: the **original Timebox (11x11)**, mostly not applicable to the Evo. It uses RFCOMM port
  4, mandatory escaping, a `HELLO` greeting, a 4-bit RGB image (`44 00 0a 0a 04` + 182 bytes) and an `XX AA` NAK. Points of
  interest: FM frequency encoding `03 0a` = 100.3 MHz (`[f*10-1000, f*10/100]`, same as hass-divoom), `0a`/`0b` described
  as mute/unmute, `59` sent unsolicited on temperature change (the Evo replied `59 55 00 00 00`, so probably no sensor), and
  "not consuming data from the device eventually crashes it", so always drain notifications.
