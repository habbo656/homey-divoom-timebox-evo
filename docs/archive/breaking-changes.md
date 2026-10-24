# Breaking changes of released versions

_Moved from [roadmap](../roadmap.md) (#120; 0.5.0 and 1.0.0 after their release). `.homeychangelog.json` has no 0.3.0 entry; its 0.4.0 entry is the user-facing summary of the 0.3.0 and 0.4.0 lists._

## Breaking changes in 1.0.0 (for the changelog)
None for existing Flows or paired devices: no id, capability, setting, Flow card or argument is removed or renamed, and no re-pairing is needed. User-visible changes:
- #92: the app is renamed to "TimeBox Evo" (en and de), has the new description "The pixel heart of your smart home.", a pixel fox app icon, a new driver icon and driver images (photo of the Evo), and a store readme (`README.txt`, `README.de.txt`). The app id `com.habbo656.divoom-timebox` is unchanged. Details: [architecture/store-assets.md](architecture/store-assets.md).
- #142 (UAT round 1): the driver icon from #92 is redrawn as stroke line art with the line weights 40 / 20 / 10 px of the Homey guideline (the traced lines were 3-7 px). Same motif (Evo facing right, side panel on the left); no behaviour change. Details: [architecture/store-assets.md](architecture/store-assets.md#driver-icon).
- #37 (store readiness): hints (en + de) for the conditions "TimeBox is connected" and "Mode is", and for the settings `clock_calendar` and `weather_interval`; the `clock_weather` hint no longer claims to add the temperature and calendar pages; manifest links (source, support, bugs); development files are kept out of the app bundle. No behaviour change.
- #36: the pairing error texts `scan_failed` and `add_failed` now add what to do (switch on the TimeBox, keep it within 1-2 m, close the Divoom app, search again); the raw cause stays in parentheses. A debug-only `mem` dev command was added (not in release use).
- #133: user-facing texts (en + de) spell the device "TimeBox" and "TimeBox Evo" where the product or app is named: driver name "TimeBox Evo" (shown when adding a device), pairing texts, Flow card titles and hints (e.g. "TimeBox connected", "TimeBox is connected"), device settings hints, error messages and the store readme. Ids are unchanged, so Flows keep working and no re-pairing is needed; the names of already paired devices are not changed. Log line now `TimeBox Evo app initialized`.
- #38: none user-visible (release tooling: `npm run release:check` / `release:bump`, CI version check).

## Breaking changes in 0.5.0 (for the changelog)
None against 0.4.0. Additions only (#31): Flow actions `timebox_show_image` (image tag) and `timebox_show_image_url` (URL), each with a fit option (`cover`/`contain`) and an optional duration; plus the device Flow trigger "Countdown ended" (`timebox_countdown_ended`, #101, no tokens); no new capability, device setting or permission.

## Breaking changes in 0.4.0 (for the changelog)
No capability, setting or card was changed or removed against 0.3.0. Additions only, with one default that changes what the clock shows (#106):
- #28: Flow actions `timebox_show_text`, `timebox_stop_text`.
- #30 / #98: Flow actions `timebox_set_temperature` (temperature only) and `timebox_set_weather` (condition only), the device settings `weather_auto` and `weather_interval` and the permission `homey:manager:geolocation`. (#98 split the combined two-argument `timebox_set_weather` of the unreleased #30 build; a Flow created with such a dev build loses its temperature value and has to use the new card. Not breaking against 0.3.0.)
- #33: Flow actions `timebox_start_countdown`, `timebox_stop_countdown`.
- #106 (UAT-1, resolves #59): new device setting `clock_animations` ("Show animation pages", default **off**). Behaviour change against 0.3.0: the clock no longer rotates through the Divoom animation pages (heart, duck, ghost, cat, ...) by default; it shows only the time and the pages switched on by the flags. The app writes the persistent device flag `26 0X` before every clock frame (the Divoom phone app shares it). Turn the setting on to get the animation pages back.

## Breaking changes in 0.3.0 (for the changelog)
Collected here because they are known before the release (`docs/versioning.md`); the app is pre-1.0, so no migration is offered.
- The mode values `cloud`, `visualizer` and `scoreboard` were removed from the capability `timebox_channel`, the condition
  "Mode is" and the action "Switch mode". Flows that use them fail. A device that shows cloud or visualizer leaves the tile empty.
- The Flow action `timebox_show_visualization` ("Show visualization") was removed. Flows that use it are broken.
- Texts renamed Channel -> Mode (de: Kanal -> Modus) in the capability, Flow cards and settings; the IDs are unchanged.
- #69: the device setting "Clock colour" (`clock_color`) was removed; the clock colour is set with the tile colour picker while
  the clock is shown, or with "Show clock". An existing value is taken over once (device store, logged).
- #69: the tile colour picker changes the clock colour in clock mode; it switches to lighting only from custom (or when the
  device shows cloud or a visualizer).
- #69: "Set lighting" lost its effect argument; old Flows run with the plain colour.
- #69: the "Show clock" colour is kept as the clock colour.
- #85: the "Show clock" style is kept too (it was one-shot): turning the Timebox off and on shows the same clock. It stays until the
  clock is selected again (tile or Flow "Switch mode") or the clock settings are changed; the `clock_style` setting itself is not changed.
- #70: the device setting "24-hour clock" (`clock_24h`) was removed; the clock is always sent as 24 h (the Evo ignored the flag, #58).
- #70: the device setting "Status check interval" (`poll_interval`, group "Advanced") was removed; the status poll is fixed at 60 s.
- #70: the Flow action "Sync time now" (`timebox_sync_time`) was removed. Flows that use it break; the time is still set
  automatically (setting "Set the time automatically").
