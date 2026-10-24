# Native text

_Part of [architecture](../architecture.md); moved from "Native text (#28)" (#120)._

  - Native text (#28; `src/protocol/commands.ts` builder, `src/device/scrollText.ts` pure input mapping, `TimeboxController`
    logic): the Flow actions "Show text" (`timebox_show_text`: `text` with tags, `color`, `background`, `speed` dropdown
    slow / normal / fast, `duration` 0..3600 s) and "Stop text" (`timebox_stop_text`). The device scrolls the text itself in
    its own font and loops it (protocol section 5.5); there is no software renderer. **The text is not a mode:** there is no
    tile entry, `46` d0 keeps reporting the channel under it, the known channel, the tile and the triggers do not change.
    - Protocol: `nativeText({text, color, background, speed})` returns the five payloads (`6e 01`, `86 01 LL text`,
      `86 00 SP`, `6c 00 00 LLLL frame0`, `6c 01 00 LLLL frame1`; palette 127 x background, 127 x text colour, 2 x
      background) and throws `RangeError` for an empty text, more than `MAX_TEXT_UNITS` (64, the most the Evo shows) UTF-16
      units, a lone surrogate, a speed outside `TEXT_SPEED_RANGE` (1..50) or a colour byte outside 0..255. `stopNativeText()`
      is `6e 00`.
    - Input mapping (`scrollText.ts`): `parseTextSpeedId` maps `slow` / `normal` / `fast` to SP 3 / 5 / 10 (the device scrolls
      about SP columns per second, pass time 1.7x / 1x / 0.5x), `parseTextDurationArg` accepts a number 0..3600 (a blank field is
      0, rounded to whole seconds, `ArgumentError` (a `RangeError`) otherwise), `prepareText` (an `ArgumentError` for a non-string) does NFC, strips what the font cannot draw (emoji and
      other non-BMP characters, lone surrogates, variation selectors, zero-width characters), turns control characters into a
      space and trims. It never cuts: it returns the cleaned `text` and its `units`, and `showText` rejects more than 64 units (#107).
    - `controller.showText(request)`: validates and builds first (an `ArgumentError`, the localised `text_empty` error or the
      localised `text_too_long` error ("The text is too long: N characters. The TimeBox shows at most 64 characters (emoji are not
      counted)."; more than `MAX_TEXT_UNITS` units after cleaning, logged as `text rejected: <n> units (at most 64)`, never cut,
      #107) sends nothing and supersedes nothing, so a running text stays; the text of the Flow card is cleaned here),
      rejects with `not_connected` while the link is down (checked after the text validation),
      turns a panel that is off on first with `setPower(true)` (the mode from before off returns; the panel stays on after the
      text), then queues the five frames in one go (`sendAllBounded`: the link queue keeps their order, so a `46` poll cannot
      slip between them) within `TEXT_SEND_TIMEOUT_MS` (20 s, option `textSendTimeoutMs`: about 66 BLE writes, twice the 10 s limit of a single command). A pending small-clock re-send (#88) is written ahead of the text in the same queue and cancelled (private helper `takeClockResendAhead('text' | 'countdown')`, shared with the countdown; `clock face re-sent before the text (small from <origin>)`), only while the panel is on and the clock is still the known mode (else `clock face re-send dropped before the text: mode changed`): a `45` command arriving 1.5 s later would end the text. A switch to the small clock that is still being confirmed when a text or stop is queued (two Flows at once) schedules no re-send (`clock face re-send dropped: a text, countdown or stop was queued after the switch`; `resendClock` re-checks with `textSeq` and skips), so the cosmetic default dial may stay after the text. A text that is already running is replaced by the new sequence, no `6e 00`
      first. For a duration above 0 a timer (`textActive.timer`) sends `6e 00` when it is over (`text stopped (duration)`); 0 runs
      until "Stop text", a mode change or power off. The text content is never logged: `text shown: <n> units,
      speed <SP>, #RRGGBB on #RRGGBB, <D s|until stopped>`.
    - A channel command ends the text on the device itself (it answers `6e 55 00`, protocol section 5.5), so a mode change,
      or power off sends no `6e 00` first; the controller only forgets the text and cancels its
      timer (`text stopped (mode change|power off)`). A mode change made at the device (button, Divoom app) or the device entering cloud or the visualizer is NOT measured and does not end the tracking: the duration timer still sends its `6e 00`, which is harmless if the text already ended (stray stop, protocol section 5.5). `textSeq` counts queued text sequences and stops: a
      command ends only a text that was queued before it (`textEndedByCommand(reason, textAtSend)`), so a switch and a text started
      in the same moment keep their on-device order in the state.
    - `controller.stopText()` always sends `6e 00` (harmless without a text, and it ends a text the app lost track of, e.g. after
      an app restart; `text stopped (action)` or `text stop sent (no text was running)`). While the link is down both it and an
      expiring duration set `textStopPending`; the stop is sent after the first status reply of the next session (`text stopped
      (pending stop after reconnect)`; a failed text send (link lost, or `TEXT_SEND_TIMEOUT_MS` reached while connected) also sets it and, if the link is still up, queues the `6e 00` at once behind the frames (`text stopped (pending stop after a failed send)`), so a late or partial text is ended (a failed text send, a failed stop action or a queued stop that fails after a newer text or stop was queued does not set the flag or queue a stop, because it would end that newer text; the newer one handles its own failure, and `text superseded by a newer text, a countdown or a stop` is logged when a text finished sending after a newer text or stop was queued: it then starts no timer and is not tracked); failures log `text duration over, stop pending (not connected)`, `text stop failed, pending: <msg>`, `pending text stop failed: <msg>` and keep the stop pending), and a new text cancels it. Known limit: after an app restart the app does not know about a
      text that still runs on the device and does not end it by itself.
    - `TimeboxDevice.showText` / `stopText` only call the controller (no tile write). The error texts are `device.error.text_empty`,
      `device.error.text_too_long` (placeholders `{length}`, `{max}`, filled by `fillPlaceholders`; `DeviceMessages.textTooLong`),
      `device.error.invalid_text` (see "User-facing errors")
      and `device.error.not_connected`.
