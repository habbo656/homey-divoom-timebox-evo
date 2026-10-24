# Open questions evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) section 11; opcode rows and status stay there._

## 11 Open questions: evidence

- Long-run link stability on the Homey is no longer open (#36, `docs/testing/stability.md`: 220 min without a disconnect). Still unmeasured: the BLE MTU on the Homey (20-byte writes work) and what happens to the link when the Evo is power-cycled or leaves the range during a long run (owner cases M1, M2).

- Audio: what `0a`/`12` control (the Evo's own player? an AVRCP variant?); whether `a5`/`a3` previews need other args.
- `46` bytes d1, d2, d7..d9, d11, d15+; the ZZ byte in `44 55 ZZ`.
- `26 0X` (#106): whether it also affects other Divoom gallery behaviour (cloud channel `45 02`) is untested; the source of the opcode name ("hot") is unverified; the factory value after a device reset is assumed `01` (it was `01` before the first probe). The photo series do not tell whether the `channel <- device: cloud` drift seen in the UAT log is a separate effect: `46` d0 stayed `00` throughout on the Mac.
- **Brightness has no visible effect (#49).** Owner hardware test, 2026-10-06 (Mac BLE probe, owner watching the panel):
  `74 BB` is acked with `32 55 BB` plus an unsolicited `46` and the value is stored (d6/d10), but 1..100 showed no
  visible difference; only 0 turned the panel off. Same in the clock view, in the lighting channel (white) and with the
  brightness byte of `45 01 RRGGBB BB 00 01 000000`. `32 BB` stored 66 / 20 / 0 / 20 for 5 / 100 / 5 / 100, so it is not a
  percentage (relative step or level index) and the panel went off at the 0 step. Key clue: the official Divoom app dims
  continuously, but only after a device reboot; after our app is installed and pairs, dimming stops working. Our
  commands match RomRider's node-divoom-timebox-evo PROTOCOL.md. Update 2026-10-06: after an Evo reboot the dim through `74` became visible on the owner's Evo, consistent with the clue above (the Evo needs a reboot after the official app/another client touched it). Owner decision: keep `dim` on `74`; the investigation
  (init state after pairing, `32` semantics) is tracked in #49.
- `2b`/`2d` effects; game keys `17`/`21` (no effect seen in game 0; try other games); the memorial's own display (separate
  from the alarm); `46` d2/d18; the `50` notification text display; `5b`/`5c` encoded pictures. Native text SP 0 and above 50, other `6c` header variants and the cause of the one-off link loss (section 5.5) are untested.
- Resolved by #48: a stale connection left by an earlier connect attempt is handed to the newer attempt and
  disconnected when that attempt's link ends, so it no longer matters whether Homey keeps one connection per peripheral
  UUID (still unmeasured). A `stale connect finished late` or `disconnecting a stale connection` log line in a hardware
  run is not a failure; record its context here if it ever shows up.
  Design note: an orphan handed to a live attempt stays connected for the life of that link. If Homey ever hands out a
  truly separate second connection, it is freed only when that link ends (`close()` or the next `open`). Watch for this
  in hardware runs, together with the log lines above.
- Accepted by design (#48): after a BLE call that hung for more than `openWaitMs`, a late stale release with no started
  newer attempt can overlap the next connect for at most `disconnectTimeoutMs`; backoff and polling recover it (see
  architecture/transport.md).
- Countdown (#33, section 5.6): the meaning of the unsolicited `bd 55 13 01 32 00` / `01 1e 00` frames after the end; whether the end plays a sound; whether a stop takes effect after the `46` poll shows the countdown again (the app cannot know that it is hidden); what the official app's stopwatch/scoreboard modes (`72 00`, `72 01`) do to a running countdown (out of scope; the noise meter `72 02` is probed in #3).
- Does the link stay up for hours on Homey's BLE stack? (The Mac held 30 min without keep-alives, see 1.1.)
- Static image `44` (#31): persistence (> 75 s), `46` d0 unchanged after `44`, the end of a native text by `44` and the end of the image by a text, a mode command, power off and a mode change made at the device are measured (hardware test #31). Still open: the effect of `5f`, `26 0X`, `74 32` and `18` on a shown image, `44` over a countdown or with the panel off (M3, M5, M6 in [images.md](images.md#static-image-behaviour-31)); branch B2 stays the conservative assumption.
- Milestone 1.2.0 (planned 2026-10-18, answered by the issues' hardware probes): noise meter `72 02 01` (#3): whether `46`
  d0 changes (the scoreboard `45 06` does not), how the view ends, power off/on and dim in that view, what it does to a running countdown; unsolicited `09`
  frames on a volume change at the phone (#4); the full `50 TT` icon list beyond TT 1 and 3 (#5); whether the Evo stays reachable over BLE after
  the auto power-off `ab` fires (owner-attended test), what `46` reports then and during a sleep light `40`, and what a sleep-light stop returns to; whether the sleep light's mode, FM and volume bytes (MO, FL FH, VV) change the speaker
  volume or play sound (interacts with #4); whether startup channel values 4–6 of `8a 01 CC` are custom pages 0–2 (#6).
