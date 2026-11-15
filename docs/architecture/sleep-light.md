# Sleep light

_Part of [architecture](../architecture.md); added with #6. Scope: only the sleep light; the startup mode and the auto
power-off were dropped from #6 by the owner (2026-11-15), their evidence is in
[protocol/settings.md](../protocol/settings.md)._

- Sleep light (#6; builders in `src/protocol/commands.ts`, decoder in `src/protocol/status.ts`, pure argument model
  `src/device/sleepLight.ts`, `TimeboxController` logic): the Flow action "Start sleep light" / "Starte Schlaflicht"
  (`timebox_start_sleep_light`) lights the whole panel in a colour and plays a sound for some minutes; "Stop sleep light" /
  "Stoppe Schlaflicht" (`timebox_stop_sleep_light`) ends it. The device runs the timer itself and **powers itself off when
  it runs out**: it drops off BLE until its power button is pressed, so the device turns unavailable after the grace
  period (the default unavailable behaviour, owner 2026-11-15). The sleep light is **not a mode**: `46` does not show it
  (protocol section 5.4), the mode tile, the colour tile, the known channel and the triggers stay.
  - Protocol: `startSleepLight({minutes, sound, volume, color, brightness})` is `40 MI MO ff 00 00 VV RR GG BB BR`
    (minutes 1..`SLEEP_MAX_MINUTES` 240, sound 0..`MAX_SLEEP_SOUND` 23, volume and brightness 0..100, colour; `RangeError`
    otherwise; FM is always `00 00`). `stopSleepLight()` is exactly the measured stop `40 05 00 00 00 00 00 00 00 00 00`
    (the device ignores everything but the on/off byte). `querySleepScene()` is `a2`. `decodeSleepScene(reply)` gives
    `{minutes, sound, on, volume, color, brightness}` (`ProtocolError` for another opcode or status, `FrameError` below 10
    data bytes); `isSleepStopReply(reply)` accepts only an `a2` frame with on/off `00` (the answer of the stop).
  - Argument model: `SLEEP_SOUND_IDS` are the stable dropdown ids `phone` (sound 0, "Phone audio" / "Handy-Audio") and
    `sound_1` … `sound_23` ("Sound N" / "Klang N"). `parseSleepLightArgs({color, brightness, minutes, sound, volume})`
    validates a hex colour (`parseHexColor`), whole minutes 1..240, brightness and volume 1..100 % (finite numbers rounded
    like the countdown card) and the sound id; anything else throws `ArgumentError` (fields `color`, `minutes`,
    `brightness` "Brightness" / "Helligkeit", `sound` "Sound" / "Klang", `volume`). Brightness and volume are sent as they
    are (0..100 bytes; the volume scale is inferred from the research, owner UAT checks the sound). `sleepLightCommand`
    builds the payload, `formatSleepLight` the log text.
  - `controller.startSleepLight(light)`: the frame is built first (an invalid value sends nothing), a link that is down
    rejects with `not_connected`. It cancels a pending small-clock re-send, supersedes a text still being sent (`textSeq`,
    as a countdown does) and sets `sleepUntil` = now + minutes before the `40` is queued. After the send a running text,
    image or noise meter is forgotten (`text stopped (sleep light)`, `image ended (sleep light)`, `noise meter ended (sleep
    light)`; conservative, as for power off) and it logs `sleep light started: <minutes> min, #RRGGBB, brightness B, phone
    audio|sound N, volume V: <hex>`. Then `a2` is read (`channelConfirmMs`): equal 10 bytes log `sleep light confirmed`,
    others `sleep light mismatch: device <hex>, requested <hex>` (resolves); no reply in time rejects with `not_confirmed`
    (`sleep light confirm timeout`), a lost link with `not_connected` (#141). A newer start or stop meanwhile
    (`sleepGeneration`) makes it resolve with `sleep light superseded by a newer change`. A new start replaces a running
    one on the device; no stop is sent before it.
  - Start while the panel is off (research #6: the panel lights, `46` d8 flips to `01`, d0 stays `01`): when no power
    change is in flight, the dim held while off (#62) is queued before the `40` (a `74` after it would relight lighting
    under the sleep light; the `40` covers it). After the send `panelLitByDevice('sleep light', …)` sets `onoff` true,
    drops the off shadow, logs `power <- device: on (sleep light)` and reads `46` once, so the tile follows d0 (lighting)
    and the self-wake check (#29) sends no off. With a power change in flight the power is left to it (`sleep light: panel
    lit, power left to the change in flight`). See [power-lighting.md](power-lighting.md).
  - Stop before a display change (owner 2026-11-15: every display change from Homey sends the stop first):
    `sendSleepStopAhead(what)` runs while `sleepUntil` lies in the future. It clears `sleepUntil` at once (only one stop for
    concurrent changes), logs `sleep light stop before <what>: 40 05 00 …` and queues the stop in the same turn, right before
    the first frame of the change. Callers: `switchTo` (mode pick and Flow "Switch mode", "Set lighting", "Show clock",
    "Show custom page", tile colour, power on, applied clock settings, the mode re-send of "Stop countdown" and of an
    expired image; `what` = `lighting` or `mode <id>`), `showText` (`text`), `showImage` / `showImageFrom` (`image`) and
    `startCountdown` (`countdown`). A failed stop is logged (`sleep light stop before <what> failed: <msg>`) and the change
    goes on. Not before power off and its self-wake resend (owner: the off only darkens the panel, the timer keeps running
    and the later power-off is accepted; the tracking stays, so a later power on sends the stop), volume, weather and the
    notification icon. Once the minutes have run out nothing is sent (the unit has powered itself off).
  - `controller.stopSleepLight()`: reads `a2` first. On/off `00` logs `sleep light: none running` and resolves without
    sending anything (the effect of a stop when nothing runs is unmeasured). Otherwise it sends the stop as a request that
    waits for the device's `a2` answer with the accept filter `isSleepStopReply` and logs `sleep light stopped`. So it also
    ends a sleep light started in the Divoom app or before an app restart. `sleepUntil` is cleared before the read (a
    display change meanwhile sends no second stop) and restored if the read fails. The power state is not changed: the
    panel returns to the view under the sleep light (research #6; dark if it was turned off meanwhile, the lit lighting
    colour if it was started from off, and `onoff` is already true then). Errors: no reply in time `not_confirmed` (`sleep
    light read timeout`, `sleep light stop confirm timeout`), a lost link `not_connected`.
  - The unsolicited `09 55 00` that follows a start reaches the volume handling like any `09` report
    ([audio.md](audio.md)); there is no extra read. The `bd 55 13 …` frames are ignored as after a countdown.
  - `TimeboxDevice.startSleepLight` / `stopSleepLight` only call the controller. The Flow listener validates the arguments
    with `parseSleepLightArgs` before the device is called ([flow.md](flow.md)).
  - Known limits: `sleepUntil` lives in memory only (a sleep light started before an app restart is not stopped by a
    display change, only by the stop card); the unit powers off when the timer ends and stays unavailable until its button
    is pressed (owner accepted); the VV scale and the built-in sounds are owner UAT checks; a stop and the change frame are
    sent back to back (the hardware test checks the order on the device).
