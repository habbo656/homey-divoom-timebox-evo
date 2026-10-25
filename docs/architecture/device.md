# Device layer

_Part of [architecture](../architecture.md); moved from "Device layer" (#120)._

- **Device layer** (#22; `src/device/TimeboxController.ts`, `TimeboxDevice.ts`) — each device owns one `ConnectionManager`
  on a `BleTransport` for the peripheral UUID in `getData().id`. The logic is in the Homey-free `TimeboxController`
  (same pattern as `pairing.ts`): the link is injected as `LinkLike` (a subset of `ConnectionManager`), everything Homey
  does through `DeviceSurface` (`setDim`, `setOnOff(on)`, `setLightColor(hue, saturation)`, `saveClockColor(color)`, `setChannel(id)`, `onChannelChanged(id)`, `setAvailable`, `setUnavailable(msg)`, `onOnlineChanged(online)`, `log`,
  `error`; a throwing or rejecting surface call is logged, never propagated into the link logic). `TimeboxDevice` is
  glue: `onInit` registers the `dim` capability listener FIRST (a change before it exists fails with `Missing Capability
  Listener: dim`; the listener answers readably if the controller is not built yet), then migrates devices paired before
  #24 and #26 (`addCapability` of `timebox_channel`, `onoff`, `light_hue` and `light_saturation` if missing, each in its own try/catch: a
  failure is logged and does not stop the setup; `setCapabilityOptions('onoff', {setOnDim: false})` if the stored options differ, because the manifest option only applies to newly paired devices)
  migrates the removed `clock_color` setting to the device store (`migrateClockColor`, see "Clock face"),
  and registers the `onoff`, `light_hue`/`light_saturation` and `timebox_channel` listeners, builds `BleTransport` (wrapped
  in `FaultTransport` only when `DEBUG === '1'`), the `ConnectionManager` with the fixed `STATUS_POLL_INTERVAL_MS` (60 s, no setting since #70) and the
  controller (messages from `homey.__('device.*')`), then calls `start()` on a local reference (`onUninit`/`onDeleted`
  may clear the field while the dev link is attached; `start()` after `stop()` is a no-op). The setup is wrapped in
  try/catch: if it throws, the error is logged (`[device] setup failed: <msg>`) and the device is set unavailable with
  `device.unavailable.setup_failed` instead of looking available. After `onUninit`/`onDeleted` (`deinitialised` flag)
  a finishing or failing setup only logs a setup error (no `started` log, no `setUnavailable`). `onInit` migrates the stored device class of earlier devices to `light` (#19, see "Power and lighting"); `onSettings` applies the clock settings, `time_sync` and the weather settings (see "Clock face", "Time sync", "Weather"). `onDeleted`/`onUninit` call `stop()` (idempotent:
  timers cleared, listeners removed, link stopped, no log or surface call afterwards).
  - `dim`: Homey 0..1 maps to brightness 0..100 (`dimToBrightness`, `Math.round`, `ArgumentError` (a `RangeError`) for anything but a number in
    0..1). `setDim` validates first, throws `Error(device.error.not_connected)` without a live link while the panel is on (nothing is queued,
    the listener never hangs), sends `74 BB` (bounded by `DIM_SEND_TIMEOUT_MS`, 10 s: a hung write rejects with the same
    readable `not_connected` error and `inFlight` is released, so device reports update `dim` again; a late result of
    the abandoned write is ignored. Known limit: the write stays in the session queue, so the next `setDim` queues
    behind it and also fails after 10 s until two missed polls drop the session and the queue is released) and then confirms with a `46` query (`request(46)`, `DIM_CONFIRM_TIMEOUT_MS` 5 s):
    `[device] dim confirmed: B` or `[device] dim mismatch: device B, requested P` (a mismatch still resolves). If the confirm fails (#151) the log has
    `[device] dim confirm timeout` (or `dim confirm failed: <msg>`), the optimistic brightness stays (the device probably took
    the command, `74` is not retried), the `dim` tile is written to the requested value (Homey does not store the value of a
    rejected listener; not after `stop()`) and the change rejects with `not_confirmed` (timeout or any other confirm error) or
    `not_connected` (link lost or `stop()` during the wait; the same classification as `switchTo`, `confirmFailure`). A change
    superseded by a newer one during the wait resolves and writes nothing. A link lost during the send is the readable
    `not_connected` error. The listener does not call `setCapabilityValue`: Homey stores the value when the listener
    resolves. Two quick changes: the newest wins (the older one skips its confirm, `dim P superseded by a newer change`).
    Only the VERIFIED opcodes `74` and `46` are sent.
    - Held while off (#62; exception to the confirm rule of #151, nothing is sent, so nothing can fail): a `74` lights an off panel (protocol section 3), so while `onoff` is false (or a power-off
      command is being sent, `offInFlight`) `setDim` sends nothing: it stores the value in `pendingBrightness`, bumps the
      generation (an older `setDim` in flight skips its confirm), logs `[device] dim held while off: P (sent at power on)`
      and resolves at once, with no link required (also from a stored off at startup); the newest held value wins, and a dim sent
      directly while the panel is on (an off in flight replaced by a power on) drops a held value. A
      stopped controller still rejects with `not_connected`. `applyPendingBrightness` sends it as `74 P` right after every
      off to on flip, queued so it follows the command that lit the panel and precedes the `46` confirm of that command:
      a display command (`switchTo`: power on, mode pick, Show lighting/clock/custom page, tile colour), a switch on at
      the device (`power <- device: on`), the countdown end display (`panelLitByCountdownEnd`) and an off that failed
      before it was sent. A lighting command built while a value is held carries the held brightness. Logs:
      `[device] dim sent at power on: P`, or `[device] dim not sent at power on: <msg>` (the `dim` tile is then written
      back to the brightness the device is known to have). A held `0` is sent as `74 00` like any dim 0 (existing
      behaviour). The held value lives in memory only: an app restart while off forgets it.

  - Hardware 2026-10-06: the dim effect is visible after an Evo reboot; before that the panel did not visibly dim although
    the value was stored (#49, `docs/divoom-protocol.md` section 11).
  - Status sync: a decoded `46` (`status` event) or a `31 55 BB` report (`reply` kind `brightness`, ok, >= 1 data byte)
    updates `dim` with `brightnessToDim` (clamped to 0..100, the raw value is logged when it was clamped). Reports are
    ignored while a change is in flight (no echo loop, no stale value during a set) and an unchanged brightness makes no
    call (compared in the device domain, so 0.555 -> 56 -> 0.56 does not bounce). Log: `[device] dim <- device: B`.
    While a value is held (off, #62) a reported brightness is only remembered (`knownBrightness`): no tile write and no
    `dim <- device` log, so the tile keeps showing the held value until it is sent.
  - Availability: `online` is `null` at startup. The device becomes available with the first `46` status reply of a
    session (not on the bare `connected` event: a connected but silent device never becomes available):
    `[device] available`, `setAvailable()`. It becomes unavailable only after `UNAVAILABLE_GRACE_MS` (30 s) without a live,
    answered session: the grace timer is armed by `start()` and by `disconnected`/transient `connectFailed`, cleared by
    the first status; on expiry `setUnavailable(device.unavailable.unreachable)` and `[device] unavailable: <reason>`, so
    reconnects inside the grace period do not flap. A permanent connect error (`connectFailed.permanent`: wrong device,
    no ISSC service) is unavailable at once with `device.unavailable.not_timebox` (`... (permanent)` in the log), once per
    episode. `onOnlineChanged(true|false)` (the Flow triggers) fires only on a change: not for the first decision after
    startup (previous `null`), `false` only if the device was online before.

  - Settings: the clock face settings (see "Clock face"), `time_sync` (group "Clock", checkbox, default on; `onSettings` calls `setTimeSyncEnabled`), the weather settings (see "Weather"), in `drivers/timebox/driver.settings.compose.json`: group "Clock" has exactly `clock_style`, `clock_weather`, `clock_temperature`, `clock_calendar`, `clock_animations`, `time_sync`, followed by group "Weather" with `weather_auto` and `weather_interval` (see "Weather"), and no other group (the "Light" group with `use_as_light` was removed in #19: the device class is always `light`; guarded by `src/manifest.test.ts`). There is no status interval setting: the status poll is fixed at 60 s (`STATUS_POLL_INTERVAL_MS`, #70), `ConnectionManager.setPollInterval` remains for the dev harness.
    Reconnect backoff keeps the `ConnectionManager` defaults.
  - `ConnectionManager` emits `connectFailed {reason, permanent, retryInMs}` for every failed connect attempt (not for a
    lost link of an established session, not after `stop()`), which the controller uses for the permanent case.
  - Log prefix `[device]`: `started (<uuid>), poll interval 60 s`, `available`, `unavailable: <reason>`, `dim confirmed: B`,
    `dim mismatch: ...`, `dim confirm timeout` and `dim confirm failed: <msg>` (the change then fails with `not_confirmed`, #151), `dim <- device: B`,
    `dim held while off: P (sent at power on)`, `dim sent at power on: P`, `dim not sent at power on: <msg>`,
    `power -> off: <hex>`, `power off: device reports <id|code N>`, `power off confirm timeout` and `power off confirm failed: <msg>` (the off then fails with `not_confirmed`, #151), `power off superseded by a newer change`, `power <- device: on`,
    `colour for <clock|lighting>: #RRGGBB`, `clock colour migrated from the setting: #RRGGBB`, `clock colour initialised: #FFFFFF`, `invalid stored clock style, using the setting`, `lighting -> #RRGGBB: <hex>`, `lighting confirmed: #RRGGBB`, `lighting mismatch: device #..., requested #...`, `colour <- device: #RRGGBB`, `channel -> custom: 45 05`, `custom page -> N: <hex>`, `custom page: no 45 ack, sending the page anyway`, `custom page confirmed: N`, `custom page mismatch: ...`, `custom page confirm timeout` and `custom page confirm failed: <msg>` (the action then fails with `not_confirmed`, #151), `channel -> <id>: <hex>`, `channel confirmed: <id>`, `channel mismatch: ...`,
    `channel confirm timeout` (the action then fails with `not_confirmed`, #141), `channel confirm failed: <msg>`, `channel <id> superseded by a newer change`, `channel <- device: <id>`,
    `channel code 0xNN is not a known channel, tile unchanged`, `clock face confirmed: style <id> colour #RRGGBB`,
    `clock face mismatch: ...`, `clock face re-sent (small from <origin>): <hex>`, `clock face re-send skipped: a text, countdown or stop was queued`, `clock face re-send skipped: mode changed`,
    `clock face re-send skipped: not connected`, `clock face re-send failed: <msg>`, `clock animations -> off|on: 26 0X (switch|connect)`, `clock animations not set: <msg>`, `clock settings applied`, `clock settings superseded by a newer change`, `clock settings not applied: <msg>`,
    `clock settings saved, applied when the clock is shown`, `invalid clock_* setting, using the default`,
    `device class -> light (migrated)`, `could not set the device class: <msg>`, `time synced (<connect|setting|daily|zone change|offset change|retry>): <YYYY-MM-DD hh:mm:ss> <zone> UTC+hh:mm`
    (zone and offset are logged on purpose: Homey's Node might lack full time zone data), `time sync not confirmed`,
    `time sync failed: <msg>`, `device brightness N out of
    range, clamped`, `flow trigger <id>`; errors `surface call failed: <msg>`,
    `stop failed: <msg>`, `setup failed: <msg>`.
