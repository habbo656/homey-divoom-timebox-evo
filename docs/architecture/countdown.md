# Countdown

_Part of [architecture](../architecture.md); moved from "Countdown (#33)" (#120)._

  - Countdown (#33; `src/protocol/commands.ts` builders, `src/device/countdown.ts` pure input mapping, `TimeboxController`
    logic): the Flow actions "Start countdown" (`timebox_start_countdown`: number `minutes` 0..99, number `seconds` 0..59) and
    "Stop countdown" (`timebox_stop_countdown`). Like the native text it is an **overlay, not a mode** (protocol section 5.6):
    the device draws an hourglass with minutes and seconds itself and counts down; `46` keeps reporting the channel under it
    (d0, d8 unchanged), so the known channel, the tile and the triggers do not change and the app cannot see it. The app keeps no
    countdown state and runs no end timer; the end is reported by the device (see "Countdown ended" below).
    - Protocol: `startCountdown({minutes, seconds})` is `72 03 01 MM SS` (`COUNTDOWN_MAX_MINUTES` 99, seconds 0..59, `RangeError`
      for anything else and for 0:00, `intInRange` checks), `stopCountdown()` is `72 03 00 00 00`. `parseCountdownArgs(minutes,
      seconds)` (Flow) accepts finite numbers, rounds them (`Math.round`, -0 becomes 0, a decimal token is rounded) and throws
      `ArgumentError` (a `RangeError`; fields `minutes` / `seconds`) outside the ranges; it lets 0:00 through. `formatCountdown(m, s)` gives `05:00` for the log.
    - `controller.startCountdown(time)`: 0:00 rejects with the localised `device.error.countdown_zero` and sends nothing
      (`DeviceMessages.countdownZero`), an invalid value with an `ArgumentError`, a link that is down with `not_connected`. A panel
      that is off is turned on first with `setPower(true)` (`countdown: panel is off, turning it on first`; the mode from before
      off returns). A pending small-clock re-send is written ahead of the frame in the same queue (`takeClockResendAhead('countdown')`,
      `clock face re-sent before the countdown (small from <origin>)`), else the `45` command would arrive 1.5 s later and, like
      any channel command, hide the countdown. The frame is sent with `sendAllBounded` and the action resolves without waiting
      for `72 55 03` or the end. A running native text is replaced by the countdown on the device: `textSeq` is bumped before the
      send (a text still being sent is "superseded") and `textEndedByCommand('countdown', textAtSend)` forgets a shown one and
      cancels its timer (`text stopped (countdown)`), so no `6e 00` is sent later. Log: `countdown started: MM:SS`. Starting again
      replaces a running countdown (the device restarts with the new time and ends only once). The weather is not held back
      (`5f` does not disturb a countdown, measured).
    - `controller.stopCountdown()`: rejects with `not_connected` while the link is down. **With the panel off nothing is sent**
      (`countdown stop skipped: panel off`): the device ignores a stop unless the countdown is on screen, and the mode re-send
      would light the panel. Otherwise it sends `72 03 00 00 00` (`countdown stopped (action)`; harmless without a countdown) and
      then the command of the known mode again through the same path as "power on" (`sendMode`: the clock with the style of the
      last "Show clock", else lighting or custom as before), because the device switches to the clock by itself 6..9 s after a
      stop and does not restore the previous view (the re-send wins). While the mode is not known yet or the device shows
      another mode (cloud, visualizer) only the stop is sent; **with a native text shown or being sent nothing is sent**
      (`countdown stop skipped: text shown`): the text hides the countdown so the device would ignore the stop, and the mode re-send
      would end the text (a `45` command does, protocol section 5.5); a failed re-send is logged (`countdown stop: mode re-send failed`),
      not an error.
    - Limits (protocol section 5.6, documented in the card hints): a mode change, a text or power off only **hide** a countdown
      that keeps running, a stop cannot end a hidden one, and its end display (`00:00`, a few seconds) appears later and lights a
      panel that is off. The natural end returns to the previous view; the device sends `71 55 03 01 01 00` (and `bd 55 13 …`)
      itself, see "Countdown ended".
    - **Countdown ended (#101):** `TimeboxController.onReply` hands every `71` frame to `countdownReport`. Exactly
      `71 55 03 01 01 00` (`isCountdownEnd`, `src/protocol/status.ts`: cmd `71`, status `55`, data `03 01 01 00`, nothing else)
      logs `countdown ended (device)` and calls `DeviceSurface.onCountdownEnded()`; `TimeboxDevice` then fires the device trigger
      `timebox_countdown_ended` (log `[device] flow trigger timebox_countdown_ended`, no tokens). It fires **once per end frame**
      on every end the device reports: also for a countdown that a mode change, a text or power off had hidden (protocol 5.6 P6,
      P6b, P8b) and one that was started outside Homey. The app does not track the countdown, so it cannot tell these apart and
      the end changes no state (channel, tile, text or image tracking are untouched, nothing is written), with one exception:
      **while the app thinks the panel is off** the end display lights it and it stays lit (P6, P7, P11 E), so `onoff` follows
      (#125, `panelLitByCountdownEnd`): power on, off shadow dropped, log `power <- device: on (countdown end display)`,
      `setOnOff(true)`, then one `46` query (`syncAfterCountdownEnd`; a timeout or failure is only logged as
      `countdown end: status sync timeout` / `failed: <reason>`) whose reply the normal status path uses to align the mode tile,
      the colour tile and the "mode changed" trigger with d0 (a Flow on `onoff` turned on / mode changed fires, intended). The trigger
      `timebox_countdown_ended` fires after this correction, so a Flow "ended, turn off" really turns the panel off. With a
      power change in flight (`channelInFlight > 0`, e.g. the off confirm) nothing is changed
      (`countdown end: panel lit, power left to the change in flight`); with the panel on nothing is sent. Any other `71`
      frame is only logged (`countdown: unknown 71 frame <hex>`) and fires nothing. The unsolicited `bd 55 13 …` frames that follow
      the end (right away and about 12 s later) are not handled; they are kept away from the custom-page read, see
      [custom-pages.md](custom-pages.md). Known limits: an end frame during a power change in flight is not applied (logged);
      "Stop countdown" sends no end frame and fires no trigger (P11 C). An image shown over a running countdown is replaced by the clock at the end but stays tracked by the app (P11 F, [images.md](images.md)).
    - `TimeboxDevice.startCountdown` / `stopCountdown` only call the controller (no tile write). Error texts:
      `device.error.countdown_zero` and `device.error.not_connected`.
