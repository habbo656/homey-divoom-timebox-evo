# Power and lighting

_Part of [architecture](../architecture.md); moved from "Power and lighting" (#120)._

  - Power and lighting (#26; `src/device/lighting.ts` pure, `TimeboxController` logic): capabilities `onoff`, `light_hue`,
    `light_saturation` (Homey's own, no custom cards). The manifest class stays `other`: class `light` would put the
    TimeBox into "all lights off" and voice light commands, which is wrong for a display by default. Opt-in (#19): the device
    setting `use_as_light` (group "Light", checkbox, default off; `src/device/lightClass.ts`: `resolveUseAsLight`, only the
    boolean `true` is on; `targetDeviceClass`) switches the class at runtime with `setClass('light'|'other')`, see "Use as a light". `capabilitiesOptions.onoff.setOnDim`
    is `false`, so setting `dim` does not switch `onoff` on (`dim` keeps its `74` behaviour, #22). While the panel is off the app
    holds the `dim` value and sends it at the next power on, because a `74` would light the panel (#62, below).
    - Power is app state: no `46` field is a reliable power flag (d8 follows the last `45` command but not `74`, protocol
      section 3). `onoff` off sends `powerOffCommand(lastStatus, knownBrightness, knownColor)` = `45 01 RR GG BB BB 00 00 00 00 00` (the
      colour the app knows, e.g. one whose confirm timed out; black from "Set lighting" is not stored, so the last non-black colour is kept, else the status colour as it is, else white; brightness known ?? status ?? 100, effect 0, power byte `00`; `setPower(false)`), confirms
      with `46` and logs `[device] power -> off: <hex>` and `power off: device reports <id|code N>`. The known channel is
      kept (the channel tile keeps the channel from before off; no `timebox_channel_changed` fires).
    - Unconfirmed off (#151): if the `46` confirm fails (`power off confirm timeout|failed`) the optimistic off and the shadow
      `01` stay (the device probably took the command; not retried), the `onoff` tile is written to off (Homey does not store the
      value of a rejected listener; not after `stop()`) and `setPower(false)` rejects with `not_confirmed` (`not_connected` if the
      link is lost or `stop()` runs during the wait). An off superseded by a newer power change during the wait resolves
      (`power off superseded by a newer change`) and writes no tile. A dim during the wait is still held (#62) and applied by
      the next power on; a countdown end during the wait leaves the power to the off (#125).
    - Off shadow: after the off command the device reports d0 `01` (lighting) although nothing is shown. `offShadow` is the
      d0 code of the confirm reply, and `01` if the confirm times out or fails (never the pre-off d0: the Evo always reports `01`, so
      the next poll would look like a switch on at the device; at a startup from stored off the first report is
      adopted). While off, reports with that code are ignored. Any other known d0 means the panel was switched on at the
      device: `onoff` is set true (`power <- device: on`, `DeviceSurface.setOnOff(true)`) and the channel sync continues as
      usual; an unknown code (text, games) leaves the state alone. A hidden countdown's end frame while off also sets `onoff`
      true and drops the shadow, because the end display lights the panel (#125, [countdown.md](countdown.md)).
    - Power on (`setPower(true)`) always sends the channel to return to, even if the app thinks the panel is on: the known
      channel, else the stored `timebox_channel` value (`storedChannel` option, `TimeboxDevice` passes it), else `clock`; it uses
      the normal `channelCommand` (clock face `shownFace()`: the stored clock colour and the shown style of "Show clock" if one is kept, else the style of
      the settings; lighting as plain colour with the stored colour). Every
      command of `switchTo` powers the panel on (probe, protocol section 3), so a channel pick, "Show clock", a colour and
      the Flow "Set lighting" while off set `onoff` true (`setOnOff(true)` only if it was off). `setClockSettings` while off
      only stores the settings (`clock settings saved, ...`), unless a power-on restore to the clock is in flight (#60: the save then applies its face). The initial value comes from the stored `onoff`
      (`powerOn` option, default on); the first status of a run writes `onoff` to the tile (`setOnOff(power)`).
      Off and on share `channelGeneration`/`channelInFlight` with channel switches: the newest change wins, reports are
      ignored while one is in flight (no echo loop).
    - Active-mode colour (#69): the tile `light_hue`/`light_saturation` is the colour of the mode that is shown. The tile
      writes both capabilities separately; `TimeboxDevice` registers one
      `registerMultipleCapabilityListener(['light_hue', 'light_saturation'], ..., 300)` (the debounce delivers both values
      of one gesture in one call; a missing value is read from the capability, hue 0 / saturation 1 if never set) which
      calls `controller.setTileColor(hue, saturation)`. `hueSatToRgb` is HSV with value 1 (`Math.round`, `ArgumentError`
      outside 0..1, so `(0.5, 0.5)` is `#80FFFF`); the brightness stays `dim`'s. Rule: the target is `clock` if `getChannel()` is
      `clock`, otherwise `lighting` (custom, cloud, visualizer, no mode known yet; a panel that is off uses the mode from before
      off and is switched on, like every display change). Log `[device] colour for <clock|lighting>: #RRGGBB`.
      - Clock target: `switchTo('clock', {...shownFace(), color}, {keepTile: true, shownStyle})` sends the full form
        `45 00 HH TT 01 WW EE CC RR GG BB` with the style that is shown (the kept one of "Show clock", else the setting) and the page flags, stores the colour (`saveClockColor` -> device
        store `clock_color`), no mode change, no trigger, no tile write (Homey writes the capabilities when the listener resolves).
        Logs `channel -> clock: <hex>`, `clock face confirmed: style <id> colour #RRGGBB`.
      - Lighting target: `switchTo('lighting', ..., {lighting: {color}, keepTile: true})` sends `45 01 RR GG BB BB 00 01 00 00 00`
        (effect 0, known brightness), makes lighting the known mode (trigger if it changed, e.g. from custom) and powers on.
        Logs `lighting -> #RRGGBB: <hex>`, then `lighting confirmed: #RRGGBB` or `lighting mismatch: device #..., requested #...` (`46` d3..d5).
      - The method resolves with the mode it applied to (null if a newer change superseded it); `TimeboxDevice` writes that mode
        to `timebox_channel` directly (no capability listener, no second command).
      - The target is the mode known at call time, so a colour change that arrives during an in-flight mode switch goes to the previous mode (narrow window, the 300 ms debounce makes it rare).
      - One colour per mode: the clock colour is app state (store `clock_color`), the lighting colour is device-synced (`knownColor`,
        from `46` d3..d5 and from what was sent; never black). `custom` has no colour.
      - Mode change: whenever the mode changes (switch from Homey incl. power on and the Flow actions, `46` d0 reported by the
        device, first status of a run) the colour of the new mode is written to the tile: clock -> clock colour, lighting ->
        `knownColor`, custom -> nothing; black or unknown -> nothing (no hue). At most one tile write per status (`onStatus`:
        the lighting colour is remembered first, then the mode; a changed lighting colour is only written to the tile while lighting is
        shown and no mode-change write happened). `keepTile` suppresses the mode-change write for callers that write the tile
        themselves (`setTileColor`, `showClock`, `showLighting`).
      - A changed lighting colour reported while another mode is shown is remembered only (`colour <- device: #RRGGBB` is still
        logged) and shows with the next switch to lighting. The first status of a run writes the colour of the reported mode.
        Our own colour is never echoed back (`knownColor` is set at the send, reports are ignored while a change is in flight).
    - Flow action `timebox_set_lighting` ("Set lighting to [[color]]"; the effect argument was removed in #69, a stale
      `effect` value of an existing Flow is ignored): `device.setLighting(parseHexColor(color))` -> `controller.showLighting(color)`
      (the colour as given, black included) -> `switchTo('lighting', ..., {lighting: {color}, keepTile: true})` (plain colour, effect byte
      `00`; the protocol layer `setLighting` keeps its verified effect byte, the app never sends another), then the controller
      writes the hue/saturation tile (not for black) and `TimeboxDevice` writes `timebox_channel` = `lighting` (skipped when a newer change superseded it, #141).
    - "Turn everything off" (expected behaviour, the hardware test checks what it can): any Homey action that sets the device's
      `onoff` capability (the tile, the Flow card "Turn off", zone-wide or voice actions that address `onoff`) turns the panel off;
      "all lights off" actions that address light-class devices do not include it while the class is `other` and do include it
      when "Use as a light" is on (#19). Turning on returns to the last channel.
    - Use as a light (#19): `TimeboxDevice.applyDeviceClass(useAsLight, 'init'|'setting')` compares `getClass()` with the target and
      calls `setClass` only on a difference, logging `[device] device class -> <light|other> (<init|setting>)`. `onInit` runs it
      after the capability migrations and before `setup()`; a failure only logs `[device] could not set the device class: <msg>`
      and never stops the setup. `onSettings` awaits it when `use_as_light` changed; on failure it logs the same line and throws
      the localised `device.error.class_not_changed`, so Homey shows the error and keeps the old setting. Moods: a mood sets
      `onoff`, `dim`, `light_hue` and `light_saturation` through the normal listeners, so the colour follows the #69 rule
      (it applies to the active mode: clock or lighting; another mode is switched to lighting by `setTileColor`). Limits: a mood
      cannot set the mode tile, the clock style or any card-only feature; a mood applied while the TimeBox is unreachable fails
      like any capability write (`not_connected`).
    - Dim while off (#62): `74` lights an off panel, so `setDim` sends nothing while `onoff` is false or an off is being
      sent: the value is held (`dim held while off: P (sent at power on)`), the `dim` tile shows it, and it is sent as `74 P`
      right after the next switch on (power on, any mode pick or Flow display action, a switch on at the device, the
      countdown end display), logged `dim sent at power on: P`. A lighting command built meanwhile already carries the held
      brightness. A held dim 0 is sent as `74 00` at power on like any dim 0 (the existing dim 0 behaviour, which turns the
      panel dark). The held value is in memory only: an app restart while off forgets it, and the tile then shows the value
      the device reports. Details: [device](device.md). A held dim resolves at once, so it cannot report an unconfirmed
      change (#151); the `74` sent at power on is not confirmed separately and a failure is only logged
      (`dim not sent at power on`, the tile goes back to the known brightness); the power-on confirm covers the link.
    - Known limitations: a device-side change from the off state back to exactly the shadow channel (lighting) is
      not detectable; if the Evo boots into lighting after a power cycle while `onoff` is off, `onoff` can stay off.
