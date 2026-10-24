# Transports evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) sections 1 and 2 and 10; opcode rows and status stay there._

## 1.1 BLE GATT: evidence

- **Advertisement: VERIFIED (Mac, `scripts/probe/ble.py --scan 20`, 2026-10-06):** the Evo advertises **only its local
  name**, which alternates between `TimeBox-Evo-audio` and `TimeBox-Evo-light`. It advertises **no service UUIDs** (so
  the ISSC service above is never in the advertisement and a service filter cannot match) and **no manufacturer data**.
  25 devices were around during the scan, most of them unnamed Apple devices (manufacturer id 76). Whether Homey's
  `serviceUuids` ever contains the ISSC service is therefore moot for the Evo.
- **Pairing filter (#46, owner decision 2026-10-06):** the name is the primary filter. The pair list shows devices whose
  name matches `/timebox|divoom|evo/i` (case-insensitive); a peripheral that does advertise the ISSC service also counts
  as a match (extra positive signal). "Show all devices" in the view adds the other **named** devices (a renamed unit).
  Unnamed devices are never listed. Already paired ids are excluded. A name only suggests a Timebox: the real check is the
  verification on Add (a read-only `46` query to the picked device, which needs the ISSC characteristics and a status
  reply). ISSC is a generic Microchip UART service, so an unrelated device picked via "Show all devices" can still fail
  that check as `not_timebox` or `timeout`. The dev harness matches case-insensitively on `timebox` only
  (docs/architecture.md, Pairing).

- **Throughput:** 30 images (`44`, 96 bytes each) at 50 ms intervals were all acknowledged (≈ 20 fps). The ceiling was not
  probed further.
- Subscribe to notifications. The reference library reports that the Evo may drop the link if nobody listens.
  This was not tested here.
- **Long-running link (soak test, 2026-10-06):** one BLE connection held for 30 min, with notifications subscribed and a
  `46` query every 30 s. Result: 60/60 replies, 0 disconnects, no keep-alive or re-init needed (the Classic A2DP link to
  the Mac was connected at the same time). No `f7` heartbeats arrived on this plain connection. They seem to appear only
  after the iOS init sequence, so do not use them as a liveness signal; poll `46` instead.
- **Long-running link on the Homey (#36, 2026-10-16):** the app on the test Homey polled `46` every 60 s for 110 min while
  driven (30 actions) and for 110 min idle: no disconnect, 1.00 `poll ok` per minute. A simulated drop reconnected in 3 to
  6 s, a muted link was declared dead after two missed polls and reconnected 64 s after the first missed one. Details:
  `docs/testing/stability.md`.

## 1.2 BLE envelope: evidence

- **App implementation** (`SequenceCounter`, #19; design choice, not a device requirement): the first value is `0x0101`,
  the sequence cycles `0x0101..0x01FF` and **skips low byte `00`** (so `0x01FF` is followed by `0x0101`). This keeps the
  high byte non-zero and guarantees that two consecutive packets never share a low byte, including at the wrap.
  The counter is reset for every connection. `envelope()` rejects a `seq` outside `0x0100..0xFFFF` and payloads of
  0 or more than 65528 bytes (LEN is 16 bit).
- Golden vectors (unit tests): lighting red `45 01 ff 00 00 64 00 01` with seq `0x0101` ends with CRC `bb 01`;
  the 85-byte golden image payload (section 4) with seq `0x0101` has LEN `0x5c` and CRC `96 22` (its SPP frame has
  CRC `8f 22`).

What the reference library (orionparrott/divoom-protocol) does, and what is **not** required: the JSON
`Device/SetUTC` handshake, the ~30-command iOS init sequence, the `bd 2f 02`/`31` "unlock", and the `bd 31`/`9f`
preamble before images. The only part that matters is the seq high byte. The library bumps it to `0x01` after SetUTC,
which is why it believes SetUTC is the "keystone". Sending SetUTC but keeping `SEQ_hi = 0x00` did **not** work.

## 1.3 Bluetooth Classic RFCOMM: evidence

- Classic name `TimeBox-Evo-audio` (the unit's MAC address: `blueutil --paired`). SDP "Serial Port" on **RFCOMM channel 1**,
  MTU 666. Plain SPP frames work right after the channel opens, with no escaping.
- Gotcha: the macOS tty `/dev/cu.TimeBox-Evo-audio` worked once and then stayed silent. A direct RFCOMM channel works.
- Gotcha: connecting Classic makes macOS switch its default audio input **and** output to the Evo (A2DP/HFP).
- While the Mac was streaming audio to the Evo, neither RFCOMM nor BLE got replies.
- **Gotcha (device "hangs"):** once paired, macOS silently reconnects the Classic link and selects the Evo as audio input
  and output (HFP). In that state the Evo did not react to its buttons, and over BLE there was no reply at all, not even the `f7`
  heartbeat. Disconnecting Classic fixed it immediately. For BLE work, do not keep the Evo paired with the Mac.
  It was unpaired on 2026-10-06.

## 1.4 SPP frame: evidence

Parsing rules in the app (design choices, #19): `splitFrames` drops one byte and resynchronises on the next `01` when the
LEN is implausible (`< 2` or `> MAX_SPP_LEN = 1024`), the end byte is not `02` or the CRC does not match; an incomplete
tail is returned as `rest` and must be cleared by the transport on reconnect or timeout. A bogus start byte with a
plausible LEN can therefore delay later frames until that many bytes arrived (bounded by 1024). `decodeSppFrame` is strict
and throws `FrameError`; `parseReply` throws `FrameError` only for payloads shorter than 3 bytes or without the leading
`04`, never for unknown opcodes.

## 2 Replies: evidence

Builders in the app (`src/protocol/commands.ts`, `validate.ts`, #20): every argument is checked first and a `RangeError`
naming the argument is thrown before any bytes are built (integers only; `NaN`, fractions and out-of-range values are
rejected). Verified builders so far: `setBrightness` (`74`, 0..100), `queryStatus` (`46`), `setChannel` (`45 NN`, only
`00`, `02`, `05`, `06`; since #68 the app uses it for `05` (custom); `02`/`06` only from the dev harness; lighting `01` and visualization `04` need arguments, `03` is NEGATIVE, `07` is ignored),
`setLighting` (`45 01 RR GG BB BB TT PP 00 00 00`, always the full 11-byte form: colour 0..255 each, brightness 0..100, effect
0..4 (`LIGHTING_EFFECTS`; the app always sends 0 since #69), power on/off), `setCustomPage` (`bd 17 PP`, PP 0..2 =
`MAX_CUSTOM_PAGE`, 3..254 and `ff` rejected; section 5.4) with `queryCustomPage` (`bd 17 ff`, answered `bd 55 17 PP`, decoded by
`decodeCustomPage`) and
`setDateTime` (`18`, year 2000..2099, the date must exist, weekday computed from the date, 0 = Sunday, independent of the
host time zone). `setDateTime` is used by the time sync (#23, `docs/architecture.md` "Time sync"): the controller
converts the instant to Homey's local time (`timeSync.ts`) and sends `18` with `request(…, 0x18)`, expecting `18 55`.

## 10 Diagnostics: evidence

The first app version had raw-hex and write-mode diagnostics (#5). They were removed in the rebuild (#18); the probe
scripts (`scripts/probe/`, section 8) replace them. Findings from that work: the "nothing displayed" cause was the
missing envelope (section 1.2), and both single and 20-byte writes work once the envelope is used.

Implemented in the transport (#21): a missing GATT service or characteristic is a permanent error (`[ble] services:`
lists everything that was discovered; the manager retries every 5 min), and each notification is logged as
`[link] rx <hex>`. The device layer (#22) marks the device unavailable after a 30 s grace period without an answered
session, or at once on a permanent error (docs/architecture.md, "Device layer"). A `homey.ble` call (`find`, `connect`,
`disconnect`) is not guaranteed to settle, so the transport never waits on one without a limit: the next open waits at
most 10 s for the previous connect/close, a disconnect at most 5 s, and the ConnectionManager waits at most 10 s for a
close (docs/architecture.md, Transport).

Duplicate notifications (#21 hardware run, 2026-10-06): Homey invoked the notification callback 5 times for a single
`subscribeToNotifications` call, so every notification was logged 5 times. The app side registers once per link (checked in
the code), so this comes from Homey. Dispatching every copy would corrupt chunked replies, so `BleTransport` drops a
notification that equals the previous one and is the same Buffer object (within 1 s) or arrives within 20 ms
(`BLE_DUPLICATE_NOTIFY_WINDOW_MS`), and logs `[ble] duplicate notification dropped (Homey delivered it more than once)` once
per link. Verify on hardware that every `[link] rx` line now appears exactly once. `[ble] services: ...` is logged once per
successful connect.

Discovery: the Evo alternates its advertised name (`TimeBox-Evo-audio` / `-light`) and `homey.ble.discover` resolves only
after its timeout (default 10 s), so one default scan can miss it. The dev harness therefore repeats 10 s scans for up to
60 s (`TIMEBOX_DISCOVERY_TIMEOUT_MS`) and stops at the first scan that sees a name containing `timebox` (acceptable in
the dev-only harness). A scan that returns early is padded to at least 1 s, so the loop never spins. Pairing (#46) reuses the 60 s budget and
filters on the name (section 1.1).
