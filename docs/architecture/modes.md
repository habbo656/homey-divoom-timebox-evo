# Modes

_Part of [architecture](../architecture.md); moved from "Mode picker" (#120)._

  - Mode picker (#24, reduced in #68; `src/device/channel.ts` pure, `TimeboxController` logic): capability `timebox_channel`
    (title "Mode" / "Modus"; the id and all code identifiers keep the word "channel"; `.homeycompose/capabilities/timebox_channel.json`: enum + `picker`, en/de, driver capabilities `["onoff", "dim", "light_hue", "light_saturation", "timebox_channel"]`).
    Four stable ids (`CHANNEL_IDS`, never translated); `clock` 00, `lighting` 01, `custom` 05 have `46` d0 codes, `noise_meter` (#3, `72 02 01`) has none. Cloud (`02`),
    visualizer (`04`) and scoreboard (`06`) are not offered since #68; `45 03` is never built. `setChannel(id)` (capability listener and Flow action share it)
    validates the id (`parseChannelId`, `ArgumentError`, a `RangeError`),
    validates and builds the command with `channelCommand(id, lastStatus, knownBrightness, clockFace, override?)` (`override` is a `ChannelOverride` = `{lighting?: {color}}`; the shared private `switchTo(id, face, override?)` (`override` there also carries `customPage?` and `keepTile?`, handled by the controller, not by `channelCommand`), which `setClockSettings`, `showClock`, power on, the tile colour path (`setTileColor`) and the custom page action also use) BEFORE the not-connected check and before it supersedes anything (an invalid request throws `RangeError` and leaves a pending switch alone); then throws `device.error.not_connected` without a live link (nothing queued), sends it bounded (`sendBounded`, 10 s) and
    confirms with `request(46, 0x46, CHANNEL_CONFIRM_TIMEOUT_MS = 5 s)`: `[device] channel confirmed: <id>`,
    `channel mismatch: device <id|cloud|visualizer|code N>, requested <id>`, `channel confirm timeout` / `channel confirm failed: <msg>`. A mode mismatch still resolves; a confirm that never arrives fails the action (#141, below). Commands:
    lighting = `45 01 RR GG BB BB 00 01 00 00 00` with the colour of the last `46` (d3..d5; black becomes white) and the
    currently known brightness (so `dim` does not jump; always plain colour, effect 0); clock = the full form `45 00 HH TT 01 WW EE CC RR GG BB` built from the clock
    face (the clock settings plus the stored clock colour, #25 and #69, see "Clock face"; `channelCommand(id, status, brightness, clockFace)`); custom = the bare `45 05` (the page is chosen by "Show custom page"). Log `[device] channel -> <id>: <hex>`. The listener does not write the capability value (Homey does when
    it resolves). After a successful send the known channel is updated and `onChannelChanged(id)` fires if it differs, so a
    switch from Homey (tile or Flow) also fires the trigger. A mode change also writes the colour of the new mode to the
    colour tile (see "Active-mode colour"). Two quick changes: the newest confirms (`channel <id>
    superseded by a newer change`), reports are ignored while a change is in flight (`channelInFlight`, no echo loop).
    - Unconfirmed change (#141): `switchTo` (the single path of the mode tile, Switch mode, Show clock, Set lighting, Show custom page,
      the colour tile and power on) keeps the optimistic state and the trigger, as the device probably took the command. If
      the `46` confirm fails, the action rejects after the confirm timeout (5 s): with the localised
      `device.error.not_confirmed` (`DeviceMessages.notConfirmed`; en "The TimeBox did not confirm the change. Check the display
      and try again in a moment.", de "Die TimeBox hat die Änderung nicht bestätigt. Prüfe die Anzeige und versuche es gleich noch einmal.")
      for a timeout or any other confirm error, with `not_connected` if the link is lost during the wait. Before it rejects it
      writes the mode tile (`surface.setChannel`; Homey does not store the value of a rejected listener) and, for the paths
      that write the colour tile themselves (`keepTile`: Show clock, Set lighting, the colour tile), the colour tile too, so
      both match `knownChannel`. A custom page is not read back then (`bd 17 ff`); the small-clock re-send is unchanged. Not
      changed: a mismatch resolves; a change superseded during the wait resolves `false` (log `channel <id> superseded by a newer
      change`, no tile write: the newer change owns the tile); after `stop()` nothing reaches the surface and a change still pending at that moment rejects with `not_connected`. `showClock` and `showLighting` return the boolean like `showCustomPage`, so `TimeboxDevice` skips its tile write for a superseded change. Not retried
      (the 5 s wait would double). Internal callers (`setClockSettings`, the countdown stop and image end re-sends) catch
      the error and log it (`clock settings not applied: ...`). The internal power-on of Show text, Start countdown and Show
      image (a panel that is off: `setPower(true)`) passes the error on, so those actions then fail with `not_confirmed` before their own command is sent. Since #151 the same rule holds for the
      confirms of dim (`setDim`), power off (`powerOff`) and the custom page read-back (`bd 17 ff` after a confirmed `45 05`): they
      share `confirmFailure` (link lost or `stop()` = `not_connected`, anything else = `not_confirmed`), write their tile
      (`dim`, `onoff`, `custom` mode) before they reject and resolve when a newer change superseded them; a dim or page mismatch
      still resolves. Exceptions, still optimistic: a dim held while the panel is off (nothing is sent, #62) and the `74` that
      follows a power on (`applyPendingBrightness`, a failure is only logged; the power-on confirm covers the link).
    Sync from the device: every decoded `46` (poll and unsolicited) is checked, d0 is the source (the `45 55 NN` echo is not
    used). The first value of a run only sets the tile (`setChannel(id)`, no trigger), a later change sets the tile and fires
    the trigger; log `[device] channel <- device: <id>`. `TimeboxDevice` writes the tile with `setCapabilityValue('timebox_channel', id)` and fires
    `timebox_channel_changed` through `getDeviceTriggerCard(...).trigger(this, {channel: id})` (`[device] flow trigger
    timebox_channel_changed: <id>`). The Flow action calls `device.switchChannel(id)` = `triggerCapabilityListener(
    'timebox_channel', id)` followed by `setCapabilityValue` (the tile follows after a Flow switch, verified on hardware; the explicit write is harmless), so tile and Flow share one path. The physical buttons of the Evo are only seen at the next poll
    (fixed 60 s poll, `STATUS_POLL_INTERVAL_MS`).
    - Other-mode rule (#68): when d0 is `02` (cloud) or `04` (visualizer) the device shows a mode the app does not offer
      (`otherModeName`). The tile is cleared to `null` (`DeviceSurface.clearChannel`, `setCapabilityValue('timebox_channel', null)`), once per new code,
      with the log line `channel <- device: <cloud|visualizer> (mode not offered), tile cleared`. No trigger fires and the condition
      "Mode is X" is false for every X (`getChannel()` returns null, also in `TimeboxDevice`). The controller keeps the last
      offered mode as `knownChannel` and the code in `otherModeCode`. Returning to an offered mode (device-side or from Homey)
      writes the tile and fires the trigger once, even if it is the mode from before. Power on restores the last offered mode
      (else the stored tile value, else `clock`). Any other unknown d0 (text, games, alarms, the unverified `03`) leaves the tile unchanged and is logged once per new code
      (`channel code 0xNN is not a known channel, tile unchanged`); if a later `46` after a switch reports such a code, the tile keeps the requested mode (no trigger, one log line per code).
    - Removed values: `TimeboxDevice.onInit` clears a stored `timebox_channel` value that is no longer one of the three ids
      (`cloud`, `visualizer`, `scoreboard` from 0.2.x) to `null` (`[device] mode tile: removed mode <id> cleared`; a failure is logged and never stops the setup).
      Flows that use a removed value in the condition or action fail (breaking change, `docs/roadmap.md`).
    - Scoreboard limitation: the app no longer offers the scoreboard (`45 06`), and the scoreboard never changes `46` d0
      (protocol section 5.1), so a scoreboard shown on the device (for example via the Divoom app) is invisible to the app: the tile keeps the previous mode.
      The former scoreboard shadow logic was removed.

  - Noise meter (#3; `startNoiseMeter()` = `72 02 01`, reply `72 55 02`): the id `noise_meter` ("Noise meter" / "Lärmmesser") is in the
    capability enum and in the dropdowns of the mode condition and action. It is not a `45` mode and has no `46` d0 code
    (`channelFromCode` never returns it), so the app tracks it itself, like the static image (B3 in [images](images.md)).
    - Switch: `setChannel('noise_meter')` sends `72 02 01` (no `45`), then confirms with `46`: any d0 confirms
      (`channel confirmed: noise_meter (device reports channel code 0x..)`, never a mismatch) and becomes the "noise shadow"
      (`noiseShadow`); `noiseActive` is set. Any other mode change ends the tracking (`noise meter ended (mode change)`),
      as do power off (`noise meter ended (power off)`; the mode from before off stays, so power on sends `72 02 01` again)
      and a tile colour change (switches to lighting). An unconfirmed switch fails like other modes (#141) but keeps the
      mode; the first later report becomes the shadow (`noise meter shadow: device reports channel code 0x..`).
    - Noise shadow rule (like image B3): while tracked, reports equal to the shadow and codes that are neither a mode nor a
      removed mode are ignored (no tile write, no trigger). A different known code is a mode change at the device: the
      tracking ends (`noise meter ended (device mode change): channel code 0x.. -> 0x..`) and the report is handled normally
      (this also holds for the first status of a new session; an equal first status keeps the noise meter across a reconnect).
    - Weather is held while tracked (`weather held (noise meter shown)`, `weatherHold()` reason `noise meter shown`) and sent
      by the 60 s check after it ended.
    - Limits: if the shadow equals a mode code (for example d0 `00`), a switch back to that mode at the device is not detected
      (d0 does not change); the tracking is in memory only, an app restart forgets it (the tile then follows d0); a text,
      image or countdown shown over the noise meter does not clear the tracking, and the end of an image or "Stop
      countdown" re-sends `72 02 01`. Which d0 the device reports under the noise meter is recorded by the #3 hardware test
      ([status.md](../protocol/status.md)); `5f`, `26` and native text over it are still open
      ([open-questions](../protocol/open-questions.md)).
