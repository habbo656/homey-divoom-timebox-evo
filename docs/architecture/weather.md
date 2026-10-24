# Weather

_Part of [architecture](../architecture.md); moved from "Weather (#30)" (#120)._

  - Weather (#30; `src/protocol/commands.ts` `setWeather`, `src/device/weather.ts` pure model, `src/device/openMeteo.ts` Open-Meteo client and
    Homey-free `WeatherUpdater`, `TimeboxController` state): the Timebox shows a weather on the clock's weather and temperature pages (the
    flags `clock_weather`/`clock_temperature` of the clock face, which the app never switches on by itself; the hints explain). The weather is
    **state, not a one-shot command**: `5f TT WW` (temperature as one signed byte, type 1 clear, 3 cloudy, 5 thunder, 6 rain, 8 snow, 9 fog; protocol
    section 5.1) is sent whenever the stored value is pending and can be sent. Condition ids (`WEATHER_CONDITION_IDS`, stable, never translated):
    `clear`, `cloudy`, `thunder`, `rain`, `snow`, `fog`. Temperature: whole degrees Celsius within `TEMPERATURE_RANGE` (-99..99, what the display
    shows; the byte allows -128..127); `parseTemperatureArg` (Flow) rounds (`Math.round`, -0 becomes 0) and throws `ArgumentError` (a `RangeError`) outside the range after
    rounding or for a non-number (`parseWeatherConditionId` likewise for an unknown condition); `clampTemperature` (Open-Meteo) rounds and clamps instead, logged. Fahrenheit (`2b`) is not supported (follow-up #7).
    - Sources (#98): the Flow actions `timebox_set_temperature` (`device.setWeather({temperatureC})`) and `timebox_set_weather`
      (`device.setWeather({condition})`) set one part each, the automatic weather (Open-Meteo) always sets both. The last value wins, whoever set it.
      `TimeboxController.setWeather(update: WeatherUpdate, source: 'flow' | 'open-meteo')` first merges the update into the stored weather
      (`mergeWeather(stored, update)`, `WeatherUpdate = Partial<Weather>`): a given part replaces the stored one, a part never set is
      `DEFAULT_TEMPERATURE_C` (0 °C) or `DEFAULT_WEATHER_CONDITION` (`clear`). It throws `RangeError` for an update without a part and for an invalid
      part (the result is validated with `weatherCommand`); then nothing is stored or sent. Otherwise it stores the merged value, marks it pending and
      flushes. So an Open-Meteo update overwrites both parts, a later Flow part keeps the other one, and several held partial updates leave one merged
      frame. It resolves after storing and sending; a Timebox that is offline is never an error (`TimeboxDevice.setWeather` throws `not_connected` only
      when there is no controller). The log label `weatherLabel` is the source, plus ` temperature` / ` condition` when exactly one part was given
      (`flow temperature`, `flow condition`, `open-meteo`, `flow` for a full update); `connect` and `held` replace it for sends of those origins.
    - Hold and flush rules (`flushWeather`): a pending value is sent only when the controller is not stopped, `online`, the session `answered` and the link
      `connected`, the panel is on (`power`), no native text runs or is being sent (`textActive === null` and no `showText` send in flight, `textSending`: the 5f must not be queued behind the text frames) and no weather send is in flight (a value that arrives meanwhile is
      sent behind it, the newest wins; so is the stored value after a new session started during the send, `weatherSession`: a send of an older session never clears the pending flag of the new one). Sending uses `sendBounded` (10 s limit). Success clears `weatherPending`; a failure is logged and the value stays
      pending. Flush points: `setWeather`, the first status of every session (the stored value is marked pending again, because the device forgets the weather at a
      reboot and a reconnect may follow one), and the existing 60 s interval of `start()` (`timeCheck(); flushWeather();`), which is how a value held while
      the panel was off or a text ran gets sent; it is silent unless it sends.
    - `WeatherUpdater` (no Homey import; `fetch`, the location, the receiver `onWeather` and `log` are injected; `TimeboxDevice` passes `globalThis.fetch`,
      `homey.geolocation.getLatitude/getLongitude` and `controller.setWeather(w, 'open-meteo')`): `configure({auto, intervalMin})` starts or reschedules,
      `stop()` ends it for good. Enabled, it fetches at once and then every interval (15, 30 or 60 min); after a failure it retries after `min(interval, 5 min)`
      (`OPEN_METEO_RETRY_MS`). Switching off or `stop()` clears the timer, aborts a request in flight and ignores a late result (generation counter); `stop()` is
      idempotent and nothing is called afterwards. `fetchCurrentWeather` asks `https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,weather_code&temperature_unit=celsius`
      with the coordinates rounded to two decimals (about 1 km), an `AbortController` and a 10 s timeout (`OPEN_METEO_TIMEOUT_MS`), and throws `OpenMeteoError`
      (`timeout after 10 s`, `HTTP <status>`, `invalid response`, the message of a network error). The WMO code maps through `wmoToCondition`: 0, 1 clear; 2, 3 cloudy;
      45, 48 fog; 51-57, 61-67, 80-82 rain; 71-77, 85, 86 snow; 95-99 thunder; any other code is logged and not sent. A missing location (not finite, out of range,
      exactly 0/0, or a getter that throws) is logged, nothing is fetched and the next try is one interval later. Coordinates are never logged.
    - Settings (group "Weather", after "Clock"): `weather_auto` (checkbox, default off, "Automatic weather from Open-Meteo") and `weather_interval` (dropdown `15`, `30`,
      `60`, default `30`). `resolveWeatherSettings(settings)` returns `{settings: {auto, intervalMin}, invalid}` (missing: default silently, invalid: default and the key
      in `invalid`, logged as `[device] invalid <key> setting, using the default`). `TimeboxDevice` configures the updater at the end of `setup()` (after `controller.start()`)
      and `onSettings` reconfigures it when a `weather_*` key changed; `stopController()` (`onDeleted`/`onUninit`) calls `updater.stop()`. The data is Open-Meteo's: the setting hint
      names "Weather data by Open-Meteo.com (CC BY 4.0)".
    - Flow action `timebox_set_temperature` (title "Set temperature" / "Temperatur setzen"; `titleFormatted` "Set temperature to [[temperature]] °C"): number `temperature`
      (min -99, max 99, step 1, rounded to whole degrees). Flow action `timebox_set_weather` ("Set weather" / "Wetter setzen"; "Set weather to [[condition]]"):
      dropdown `condition` (the six ids). Their hints say which clock page shows the value ("Show temperature" / "Show weather"), that it is sent once the
      Timebox is on and connected together with the last weather (clear if never set) / last temperature (0 °C if never set), to turn off "Show weather" /
      "Show temperature" if that part is not set, and that the automatic weather from Open-Meteo overwrites temperature and weather at each update. The
      setting `clock_temperature` has a hint naming the Set temperature card and Open-Meteo (like `clock_weather` for Set weather).
    - Log prefix `[device]`: `weather -> <t> °C <cond> (<label>): 5f TT WW` (the label says what triggered the send: `flow`, `flow temperature`, `flow condition`, `open-meteo`, `connect`, `held`; e.g. `weather -> 23 °C clear (flow temperature): 5f 17 01`), `weather held (<not connected|panel off|text running|image shown|noise meter shown>): <label>`
      (once, when `setWeather` could not send), `weather send failed: <msg>`. Log prefix `[weather]` (WeatherUpdater): `automatic weather on (every N min)`, `automatic weather off`,
      `open-meteo: <t> °C (raw <x>), code <c> -> <cond>`, `open-meteo: temperature <r> °C out of range, clamped to <c> °C`, `open-meteo failed: <msg>; retry in N min`,
      `open-meteo: Homey has no location`, `open-meteo: unknown weather code <c>, not sent`.
