# Clock face

_Part of [architecture](../architecture.md); moved from "Clock face" (#120)._

  - Clock face (#25; `src/device/clock.ts` pure, `TimeboxController` logic): the look of the clock channel is a set of device
    settings (group "Clock"): `clock_style` (dropdown, ids `full_screen rainbow boxed analog_square negative analog_round
    small` = device styles 0..6; 7..9 look like 6 and are not offered),
    `clock_weather`, `clock_temperature`, `clock_calendar` (checkboxes: the weather, temperature and calendar pages that are added to the rotation; each has its own hint, the `clock_weather` hint names the weather page only, #37), and
    `clock_animations` (checkbox "Show animation pages", default **off**, #106: the Divoom gallery pictures that the Evo rotates through between the clock pages; with it off only the time and the pages of the flags above are shown).
    The animation pages are a persistent device flag, not part of the `45 00` frame (the fixed byte 5 has no effect; protocol 5.1 "Animation pages"): `switchTo('clock')` queues `26 0X` (`setHot(animations)`, `26 00` off / `26 01` on)
    in the same turn right before every clock frame (switch, "Show clock", power on, tile colour in clock mode, a changed clock setting) and logs `[device] clock animations -> off|on: 26 0X (switch)`.
    A failing send is logged as `[device] clock animations not set: <msg>` and the clock frame is still sent. The first status of a session sends it once more only while the device reports the clock, the panel is on and no switch or native text is in progress
    (`... (connect)`: the device may already show the clock; the effect of `26` was measured in the clock view, lighting and with the panel off only, so in lighting, custom, cloud, visualizer or an unknown mode nothing is sent and the next switch to the clock sets it). Lighting, custom and the small-clock re-send (#88) never send it.
    `resolveClockSettings(settings)` returns `{settings, invalid}` (a `ClockSettings` = the face without its colour and 12/24 h flag, plus `animations`; a legacy `clock_24h` value is ignored): a missing value gives the default silently, an
    invalid one the default and its key in `invalid` (logged as `[device] invalid <key> setting, using the default`).
    The clock colour is not a setting since #69: it is owned by the app (device store `clock_color`, `#RRGGBB`, default white
    `DEFAULT_CLOCK_COLOR`) and follows the tile colour picker while the clock is shown (see "Active-mode colour") or
    "Show clock". The complete face is `{...clockSettings, hour24: CLOCK_HOUR24, color: clockColor}` (`ClockFace` = `ClockOptions` + `animations`; `setClock` ignores `animations`).
    `parseHexColor` accepts `#RRGGBB` or `RRGGBB` in any case, `formatHexColor` writes upper case `#RRGGBB`. The face
    is sent as `setClock(face)` = `45 00 HH TT 01 WW EE CC RR GG BB` (protocol section 5.1) on every switch to the clock channel
    (tile, `timebox_set_channel`, `setClockSettings`, `setTileColor` in clock mode, `showClock`). Order of the three flag bytes: weather, temperature, calendar
    (confirmed on hardware 2026-10-06, #25; mapped in one place, `setClock`). HH is always `01` (`CLOCK_HOUR24 = true`, `src/device/clock.ts`): the 12/24 h flag has no visible effect on the Evo (HH `00` keeps the 24 h display, `46` d11 stays `01`, protocol 5.1; #58), so the setting `clock_24h` was removed in #70 (breaking change 0.3.0) together with its locale-based default and the one-time initialisation; a legacy stored value is ignored.
    - Migration (#69, `TimeboxDevice.migrateClockColor`, once per device in `onInit` before the setup): the device store key
      `clock_color` is the source of truth (`resolveStoredClockColor(store, legacySetting)`: valid store, else a valid legacy
      `clock_color` setting, else white; invalid values are skipped). If the store holds no valid value, the resolved colour is written
      and exactly one line is logged: `[device] clock colour migrated from the setting: #RRGGBB` or `[device] clock colour initialised: #FFFFFF`;
      nothing is logged at later starts. The setting itself is removed from the manifest (breaking change 0.3.0).
    - `onSettings`: if a `clock_*` key changed, the settings are resolved from `newSettings` (invalid keys fall back to the default, logged).
      After the other settings are handled, `void controller.setClockSettings(settings)` stores them and sends them at once, by switching
      to the clock with the new face, when the clock is the target of the newest display change (not stopped, online, link connected): either
      nothing is in flight and the clock is shown with the panel on, or the change in flight is itself a switch to the clock (#60: a
      tile or Flow switch, a power-on restore, "Show clock", a tile colour change in clock mode, or an earlier save; the
      controller remembers the generation and colour of the newest switch to the clock, `inFlightClockColor`). The new switch supersedes the one in flight
      and keeps its colour (a racing "Show clock" or tile colour is not reverted; its shown style is dropped, the newest explicit choice wins). A switch
      away from the clock (lighting, custom, power off) in flight is never superseded: the face is only stored, as it is for
      every other mode and while the panel is off, and the channel never changes. It never rejects and logs `[device] clock settings applied`,
      `clock settings superseded by a newer change`, `clock settings not applied: <msg>` or `clock settings saved, applied when the clock is shown` (the settings then apply
      the next time the clock is selected; not logged when the clock is the target of the newest change). Saving a setting does not wait for the Timebox.
      When the save supersedes such a change (which then resolves `false` and leaves the tiles to the newer change), `setClockSettings` itself
      writes the mode tile (`clock`) and the colour tile (the racing colour, not for black); the save's `switchTo` uses `keepTile` for this, so the same two tiles are written when its own `46` confirm fails (`clock settings not applied: ...`). Edge: if the save's own send fails after a racing
      change restored its shown style, that style stays persisted until the next clock selection or settings change.
    - Flow action `timebox_show_clock` ("Show clock [[style]] in [[color]]"): `controller.showClock(style, color)` =
      switch to the clock with that style and colour, the flags from the settings (HH always `01`). The colour becomes the stored clock colour
      (`saveClockColor`) and is written to the colour tile (not for black, which is stored and sent but has no hue). The style
      is the shown style (#85, below). `TimeboxDevice.showClock` then writes the tile `clock`
      directly (no capability listener, no second command), unless a newer change superseded it (#141).
    - Shown clock style (#85): power on shows what was displayed before power off, so the style of "Show clock" is kept.
      `clockStyleOverride` (device style number, null = the `clock_style` setting) is set after a successful clock send
      from `SwitchOverride.shownStyle` (only `showClock`, power on and `setTileColor` in clock mode pass one) and persisted through
      `DeviceSurface.saveShownClockStyle` only when it changes (device store `clock_shown_style`, a style id from `CLOCK_STYLE_IDS`, or null;
      `TimeboxDevice` passes it as the `shownClockStyle` option at setup, `resolveStoredShownStyle(raw)` in `clock.ts` returns `{style, invalid}`;
      an invalid stored value logs `[device] invalid stored clock style, using the setting`). The face that is shown is
      `shownFace()` = `{...clockFace(), style: clockStyleOverride ?? clockSettings.style}`. Kept through power off/on and the tile
      colour in clock mode; lighting and custom leave it untouched. Reset by a switch to the clock that does not carry it
      (the tile `timebox_channel`, the Flow "Switch mode") and by `setClockSettings` (the newest explicit choice wins, also while
      off). Without a controller (setup failed), saving a `clock_*` setting clears the store key `clock_shown_style` directly
      (`TimeboxDevice.clearShownClockStyle`; a failure logs `[device] could not clear the stored clock style: <msg>`).
      The `clock_style` setting is never changed. If "Show clock" and a mode switch to the clock race, the later send wins.
    - Confirmation (log only): after a confirmed switch to the clock, `46` d15 (style) and d12..d14 (colour) are compared
      with the request (d12..d14 are only used for this log line, the app owns the colour): `[device] clock face confirmed: style <id> colour #RRGGBB` or `clock face mismatch: device style N
      colour #RRGGBB, requested style <id> colour #RRGGBB`.
    - Small clock re-send (#88): the small style (device style 6) entered from lighting, custom, cloud/visualizer, from off or
      with no mode known yet shows the default round dial although `46` d15 reports small (protocol section 5.1). `switchTo`
      therefore schedules one background re-send of the identical `45 00 ...` frame `CLOCK_RESEND_DELAY_MS = 1_500`
      (option `clockResendDelayMs`) after the switch, if it was not superseded (the confirm result does not matter) and the
      controller is not stopped. It is sent when the known mode is not the clock or the panel is off, when an earlier switch
      is still being sent (the known channel may be stale; origin `pending`; an extra re-send in clock mode is harmless), and
      when a re-send is still pending (a newer small-clock switch inside the gap, e.g. a tile colour change, carries its
      origin over and schedules its own). It is not applied when switching from another clock face, for the other styles,
      or when the device itself switches into the clock or left it by itself and no status poll has shown that yet (the
      app sent nothing or the known channel is stale; known limit). The timer (`clockResendTimer`) is cancelled by every newer switch
      (`++channelGeneration` in `switchTo` and `powerOff`) and by `stop()`; Flow cards and `onoff` do not wait for it. Before
      sending it checks that no text or stop was queued since the switch (`textSeq`, #28), the panel is on, the clock is still the known mode and the link is connected. It does no confirm,
      no generation bump and no tile, colour, style or trigger write, and never rejects. Logs
      `clock face re-sent (small from <origin>): <hex>` (origin `off`, `lighting`, `custom`, `cloud`, `visualizer`, `pending` or
      `unknown`), `clock face re-send skipped: a text, countdown or stop was queued`, `clock face re-send skipped: mode changed`, `clock face re-send skipped: not connected`,
      `clock face re-send failed: <msg>`.
