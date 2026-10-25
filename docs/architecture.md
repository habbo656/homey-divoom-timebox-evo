# Architecture

Homey app (SDK v3, TypeScript strict, Homey Compose) for the Divoom Timebox Evo. The app is being rebuilt on the
verified protocol (ADR 0005, `docs/roadmap.md`). Milestone 0.2.0 (core: skeleton, protocol, BLE transport, pairing,
device layer with `dim`, availability, Flow cards and automatic time sync, #18-#23, #46) is implemented; milestone 0.3.0
(display and modes: mode picker #24 (reduced to clock, lighting, custom in #68), clock face #25, power and lighting #26, custom pages #27)
is accepted (2026-10-07); milestone 0.4.0 (native text #28, weather and temperature #30/#98, countdown #33) is accepted (2026-10-07); milestone 0.5.0
(images: static image from a token or URL #31 is implemented; the "Countdown ended" Flow trigger #101, added by the owner on 2026-10-08, is implemented and hardware-tested, 2026-10-08) is accepted (2026-10-08; follow-up #129); milestone 1.0.0 (App Store release: store assets #92/#142, stability #36, store readiness #37, release process #38, "TimeBox" spelling #133) is accepted (2026-10-16); milestone 1.1.0 (bugfixes after the release: #147, #141/#151, #125, #48, #62, #60, #129, #94) is accepted (2026-10-18) (module status table below).

## Layers

```
App (src/app.ts)                       lifecycle and logging only
 ├─ flow/        Flow card listeners   (src/flow)
 ├─ device/      Driver + Device       (src/device)  pairing (pairing.ts), TimeboxController (dim, power, colour, mode, custom page, availability), settings
 │   ├─ protocol/  pure codec          (src/protocol) envelope, replies, command builders, status decoding
 │   └─ transport/ link + hardware     (src/transport) ConnectionManager -> Transport (BleTransport | MockTransport)
 └─ dev/         DEBUG=1 test harness  (src/dev) FaultTransport, devLink commands; never active in a release
```

- **App** — `DivoomApp extends Homey.App`; logs `TimeBox Evo app initialized`. No settings page (device first,
  see roadmap design principles).
- **Device layer** (`src/device/`) — `TimeboxDriver` (`onPair` wires `registerPairHandlers` from `pairing.ts`, see
  "Pairing" below) and `TimeboxDevice` (see "Device layer" below).
- **Protocol** (`src/protocol/`) — no I/O, no Homey imports, unit tested with golden vectors. All inputs and outputs
  are `Uint8Array`; invalid input is rejected before anything is sent (the Evo has no NAK): command builders throw `RangeError`, encoders and decoders throw `ProtocolError`/`FrameError`. See
  `docs/divoom-protocol.md`. An ESLint `no-restricted-imports` rule (`eslint.config.mjs`) enforces that files in
  `src/protocol/**` import their own siblings (`./…`; no `homey`, no `../…`). Golden vectors live in
  `src/protocol/__fixtures__/` (excluded from the build).
- **Transport** (`src/transport/`) — `Transport` interface (`BleTransport`, `MockTransport`) and `ConnectionManager` (link supervision, reconnect): [architecture/transport.md](architecture/transport.md).
- **Pairing** (`src/device/pairing.ts`, `drivers/timebox/pair/scan.html`) — scan, filter, verify on Add: [architecture/pairing.md](architecture/pairing.md).

Data flow (outbound): Flow card / capability -> Device -> protocol builder -> `ConnectionManager.send/request` (envelope + chunks) -> `Transport.write`.
Inbound: `Transport.onData` -> `splitFrames` (keeps a `rest` buffer per connection; the ConnectionManager clears it on
reconnect or request timeout) -> `decodeSppFrame` -> `parseReply` -> Device updates capabilities. Malformed frames are
dropped by `splitFrames` (counted in `skipped`) or raise `FrameError` (caller logs and ignores); unknown opcodes are
returned with kind `other`, never thrown.

Log prefixes `[link]` `[ble]`: transport.md; `[pair]`: pairing.md; `[device]`: device.md; `[dev]`: dev-harness.md

## Areas

Each area file holds the verbatim text of its former section; code comments cite the old section names.

| File | Old section names | Purpose |
|---|---|---|
| [architecture/transport.md](architecture/transport.md) | Transport; Log prefixes (`[link]`, `[ble]`); `Transport`, `BleTransport`, `ConnectionManager` | Transport interface, BLE transport, discovery scan, link supervision (envelope, chunking, reconnect) |
| [architecture/pairing.md](architecture/pairing.md) | Pairing | Pairing handlers, scan, verify on Add, pair view |
| [architecture/device.md](architecture/device.md) | Device layer; Status sync; Availability; Hardware 2026-10-06; Settings; Log prefix `[device]`; `dim` | `TimeboxController` and `TimeboxDevice`, brightness, status sync, availability, device settings |
| [architecture/modes.md](architecture/modes.md) | Mode picker (also "Channel picker"); Other-mode rule | The `timebox_channel` capability: modes, sync source, tile behaviour |
| [architecture/clock.md](architecture/clock.md) | Clock face; Shown clock style; Small clock re-send | Clock styles and face settings, clock re-sends |
| [architecture/custom-pages.md](architecture/custom-pages.md) | Custom pages | Custom page slots and Flow actions |
| [architecture/text.md](architecture/text.md) | Native text (#28) | Scrolling text overlay: input mapping, speed, limits |
| [architecture/countdown.md](architecture/countdown.md) | Countdown (#33) | Countdown display and Flow actions |
| [architecture/images.md](architecture/images.md) | Show image (#31) | Static image overlay: decoding, 16x16 scaling, sources, limits, branches |
| [architecture/weather.md](architecture/weather.md) | Weather (#30) | Weather and temperature: Flow card, Open-Meteo client, caching |
| [architecture/power-lighting.md](architecture/power-lighting.md) | Power and lighting; Active-mode colour | `onoff`, colour and lighting handling |
| [architecture/time-sync.md](architecture/time-sync.md) | Time sync | Automatic time sync with Homey's local time |
| [architecture/errors.md](architecture/errors.md) | User-facing errors | Localised errors, `ArgumentError` |
| [architecture/flow.md](architecture/flow.md) | Flow cards; Flow | Flow card registration and listeners |
| [architecture/store-assets.md](architecture/store-assets.md) | Store assets and listing (#92, #37) | Icons, images, app name, slogan, store readme, manifest links, brand colour, i18n completeness, app bundle: sources, transforms, owner decisions |
| [architecture/dev-harness.md](architecture/dev-harness.md) | Dev harness; Device link; Log prefix `[dev]` | `DEBUG=1` test harness (fault injection, dev commands) |


Protocol modules built so far: `errors.ts` (`ProtocolError`, `FrameError`), `hex.ts` (`fromHex`, `toHex`),
`envelope.ts` (`envelope(payload, seq)`, `SequenceCounter` — one instance per connection, `reset()` on connect),
`replies.ts` (`splitFrames`, `decodeSppFrame`, `parseReply`), `validate.ts` (argument checks: `intInRange`, `u8`, `le16`,
`rgb`, `oneOf`, all throw `RangeError`), `commands.ts` (`setBrightness`, `queryStatus`, `setChannel`, `setLighting`, `setCustomPage`, `queryCustomPage`, `setClock`, `setHot`, `setDateTime`, `nativeText`, `stopNativeText`, `setWeather`, `startCountdown`, `stopCountdown`, `staticImage`, `startNoiseMeter`; return
the payload, wrap with `envelope()`), `status.ts` (`decodeStatus(reply)` -> `DeviceStatus`, `decodeCustomPage(reply)` -> raw page byte of `bd 55 17 PP`, `isCountdownEnd(reply)` for the unsolicited `71 55 03 01 01 00`, `isCustomPageReply(reply)` as the `accept` filter of the `bd 17 ff` read).

## Module status

| Module | Purpose | Filled by | Status |
|---|---|---|---|
| `src/app.ts` | App class, log only | #18 | done |
| `src/device/TimeboxDriver.ts` | `onPair` wiring | #46 | done (pairing part of #22) |
| `src/device/pairing.ts` | candidate selection, verify, pair session events | #46 | done (pairing part of #22) |
| `src/device/TimeboxController.ts` | Homey-free device logic: `dim` (held while the panel is off and sent at power on, #62), power (`onoff`) and lighting colour, channel switching and sync, noise meter tracking (#3, noise shadow), clock face (incl. the small clock re-send, `CLOCK_RESEND_DELAY_MS`), native text (`showText`, `stopText`), countdown (`startCountdown`, `stopCountdown`, the "countdown ended" report `countdownReport`, which also sets `onoff` true when the end display lights a panel that was off, #125), static image (`showImage`, `showImageFrom`), weather state (`setWeather`, hold/flush), status sync, availability with grace, fixed status poll, time sync | #22, #23, #24, #25, #26, #27, #28, #30, #31, #33, #62, #88, #101, #125, #141, #151 | done |
| `src/device/channel.ts` | pure channel model: ids, `46` d0 codes (the noise meter has none), `channelCommand`, custom page ids, `otherModeName` | #24, #27, #68, #3 | done |
| `src/device/lightClass.ts` | pure device class model: `use_as_light` setting id, `resolveUseAsLight`, `targetDeviceClass` | #19 | done |
| `src/device/lighting.ts` | pure lighting model: hue/saturation <-> RGB, `powerOffCommand` | #26 | done |
| `src/device/clock.ts` | pure clock face model: style ids, hex colour parsing, `resolveClockSettings` (incl. `clock_animations`), `resolveStoredClockColor`, `resolveStoredShownStyle`, `CLOCK_HOUR24` | #25, #85 | done |
| `src/device/timeSync.ts` | pure time sync helpers: local time in an IANA zone, UTC offset, `autoSyncReason` | #23 | done |
| `src/device/argumentError.ts` | Homey-free `ArgumentError` (kind, field, params), `formatArgValue`, `localiseError` (user-facing validation errors) | #108 | done |
| `src/device/scrollText.ts` | pure native text input: speed ids and levels, `prepareText` (NFC, strip, controls; reports the length, never cuts), duration parsing | #28, #107 | done |
| `src/device/countdown.ts` | pure countdown input: `parseCountdownArgs` (round, range check), `formatCountdown` | #33 | done |
| `src/device/image.ts`, `imageError.ts`, `imageLimits.ts`, `imageScale.ts`, `imagePng.ts`, `imageJpeg.ts`, `imageGif.ts` | pure image model: `detectImageFormat`, `scaleImage` (bounded-memory decoders straight to 16x16: streamed PNG, DC-only JPEG over 512x512 else jpeg-js, row-wise GIF LZW with omggif parsing; ADR 0010), `AreaScaler` / `scaleTo16` (cover/contain, area average), `toPalette`, `buildImageCommand` (256-entry 8 bpp `44` payload), `runImageJob` (one image at a time), `parseImageFitId`, limits, `ImageError` | #31 | done |
| `src/device/imageSource.ts` | image sources: `parseImageUrl`, `downloadImage` (10 s, 5 MiB), `readImageStream` / `loadImageToken` (Flow image token), `urlForLog` | #31 | done |
| `src/device/weather.ts` | pure weather model: condition ids, `parseTemperatureArg`, `clampTemperature`, `weatherCommand`, `WeatherUpdate` / `mergeWeather` (partial updates with defaults), `wmoToCondition`, `resolveWeatherSettings` | #30, #98 | done |
| `src/device/openMeteo.ts` | Open-Meteo client (`fetchCurrentWeather`, `OpenMeteoError`) and the Homey-free `WeatherUpdater` (schedule, retry, abort) | #30 | done |
| `src/device/text.ts` | Homey-free `fillPlaceholders` for `{name}` tokens in locale strings; used for `text_too_long` and the argument errors (#108) | #21, #108 | done |
| `src/device/TimeboxDevice.ts` | glue: capability listeners (`dim`, `onoff`, colour, channel), link setup, settings, triggers (connected, disconnected, mode changed, countdown ended), `DEBUG` device link | #22, #24, #25, #26, #27, #101 | done |
| `src/protocol/envelope.ts` | `FE EF AA 55` envelope + sequence counter | #19 | done |
| `src/protocol/replies.ts` | SPP frame splitting, reply/notification parsing | #19 | done |
| `src/protocol/errors.ts`, `hex.ts` | error types, hex helpers | #19 | done |
| `src/protocol/commands.ts`, `validate.ts` | verified command builders (incl. `nativeText`, `stopNativeText`, `setWeather`, `startCountdown`, `stopCountdown`, `staticImage`, `setHot`, `startNoiseMeter`), argument validation | #20, #28, #30, #31, #33, #106, #3 | done |
| `src/protocol/status.ts` | status `46` decoding, `bd 17` custom page decoding, `isCountdownEnd` (`71 55 03 01 01 00`) and `isCustomPageReply` | #20, #101 | done |
| `src/transport/Transport.ts`, `errors.ts`, `chunk.ts` | transport interface + `TransportError`, manager errors, 20-byte chunking | #21 | done |
| `src/transport/ConnectionManager.ts` | queue, request/reply (optional `accept` filter), polling, reconnect backoff, `connectFailed` event, timing option validation | #21, #22, #101, #48 | done |
| `src/transport/BleTransport.ts` | `homey.ble` transport, `scanPeripherals`, `discoverTimeboxes`, notification de-duplication, stale-connection hand-over, timing option validation | #21, #46, #48 | done |
| `src/transport/settle.ts` | `settleWithin` (bounded wait), `assertTimerMs` (timer option validation) | #21, #48 | done |
| `src/transport/MockTransport.ts` | test transport | #21 | done |
| `src/dev/FaultTransport.ts`, `devHarness.ts` | DEBUG-only fault injection and `devLink` commands, device link | #21, #22, #23 | done |
| `src/flow/index.ts` | Flow listeners and trigger ids (incl. `FLOW_TRIGGER_COUNTDOWN_ENDED`): conditions `timebox_is_connected`, `timebox_channel_is`, actions `timebox_set_channel`, `timebox_show_clock`, `timebox_set_lighting`, `timebox_show_custom_page`, `timebox_show_text`, `timebox_stop_text`, `timebox_show_image`, `timebox_show_image_url`, `timebox_start_countdown`, `timebox_stop_countdown`, `timebox_set_weather`, `timebox_set_temperature` | #22, #23, #24, #25, #26, #27, #28, #30, #31, #33, #98, #101 | done |

Update this table when an issue fills a module.

## Entry files

Homey loads only `.homeybuild/drivers/timebox/{driver,device}.js` (tsconfig `rootDir` is `src`, output goes to
`.homeybuild/`). `src/drivers/timebox/driver.ts` and `device.ts` are therefore two-line re-export files
(`import { X } from '../../device/X'; export = X;`) and must stay that way. All logic lives in `src/device/`.

## Directory layout

- `src/` — TypeScript sources, compiled by `tsc` to `.homeybuild/` (`main` = `.homeybuild/app.js`)
- `src/**/*.test.ts` — Vitest unit tests (excluded from the build, as is `src/**/__fixtures__/**`);
  `src/skeleton.test.ts` checks that every skeleton module loads. Tests must not import `homey` at runtime (it only exists on the Homey), so `src/device/*`
  is covered by the build and hardware tests, pure modules by unit tests.
- `.homeycompose/` — app manifest sources (`app.json`, `capabilities/timebox_channel.json`); root `app.json` is committed because `homey app validate` (CI) requires
  it without a prior build; keep it in sync with the compose sources (`homey app build` regenerates it).
- `drivers/timebox/` — driver manifest (`driver.compose.json`: capabilities `onoff`, `dim`, `light_hue`, `light_saturation`, `timebox_channel`, `capabilitiesOptions.onoff.setOnDim: false`, BLE, pairing views `start` -> `scan`),
  `driver.settings.compose.json` (group "Clock": `clock_style`, `clock_weather`, `clock_temperature`, `clock_calendar`, `clock_animations`, `time_sync`; group "Weather": `weather_auto`, `weather_interval`; group "Light": `use_as_light`, #19; no other group), `driver.flow.compose.json` (Flow cards), assets, `pair/start.html` (pairing instructions) and `pair/scan.html` (scan, list, verify)
- `.homeyignore` — development files kept out of the app bundle (`docs/`, `scripts/`, `CLAUDE.md`, `README.md`, `eslint.config.mjs`, `.github/`, `.claude/`, `.hwtest/`, `.venv/`); the store readmes `README*.txt`, `assets/`, `locales/`, `drivers/`, `src/dev` output and source maps stay (guarded by `src/storeAssets.test.ts`, #37)
- `locales/` — i18n strings (`app.name`, `pair.*`, `pair.scan.*`, `device.*`; German texts use real umlauts); `assets/` — app icon (pixel fox) and store images; the driver has its own icon and images (see [architecture/store-assets.md](architecture/store-assets.md))

## Permissions

- `homey:wireless:ble` is required (kept).
- `homey:manager:geolocation` (#30): Homey's latitude and longitude for the automatic weather (`homey.geolocation`). The coordinates leave the app only rounded to two decimals in the Open-Meteo request and are never logged.
- Outbound HTTPS to `api.open-meteo.com` (#30), only while `weather_auto` is on; no account or API key. Weather data by Open-Meteo.com (CC BY 4.0).
- Outbound HTTP(S) to the address the user gives in the Flow action "Show image from URL" (#31), only when that card runs (any host, including the local network; at most 5 MiB, 10 s; only the host is logged). Homey apps need no manifest permission for outbound HTTP.

## Testing

`scripts/gate.sh` = `npm ci`, `npm run lint`, `npm run format:check` (Prettier, code only, see `docs/conventions.md`), `npm run build`, `npm test`, `npm run release:check` (all versions agree, changelog entry present; also a CI step), `homey app validate`. Node 22+ (`.nvmrc`).
Release tooling (#38): `scripts/release.mjs` (`check`, `bump`) on top of `scripts/release/version.mjs`, tested by `scripts/release/version.test.mjs` (collected by `npm test`, as is `scripts/homey-run.test.mjs` for the argument handling of `scripts/homey-run.sh`); procedure in `docs/versioning.md`.
No native dependencies (the app must build on any runner architecture). Hardware tests: `docs/pipeline.md`.
