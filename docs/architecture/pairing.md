# Pairing

_Part of [architecture](../architecture.md); moved from "Pairing" (#120)._

- **Pairing** (`src/device/pairing.ts` + `drivers/timebox/pair/scan.html`) — no Homey imports in `pairing.ts`: the BLE
  manager and the pair session are injected (`BleManagerLike`, `PairSessionLike`).
  - Flow of views: `start` (instructions) -> `scan` (custom view). `TimeboxDriver.onPair(session)` calls
    `registerPairHandlers(session, { ble: homey.ble, pairedIds: () => getDevices().map(d => d.getData().id), log })`.
    `onPairListDevices` is gone, because Homey calls it once and expects the list at once, which cannot wait 60 s for a
    scan and cannot offer "Search again".
  - Event driven: the view sends `scan`, `verify {id}` (via `Homey.emit`, which returns a promise) and Homey sends
    `disconnect` when the pair session closes. `scan` and `verify` return at once (`{durationMs}` / `{started:true}`) and
    the results are pushed with `session.emit`, so no handler runs for the whole scan (no handler timeout) and every
    emit that is rejected (view gone) is swallowed. `scan_update {state: 'scanning'|'done'|'failed', elapsedMs,
    durationMs, candidates, error?}` follows every 10 s slice and the end of the scan; `verify_result
    {ok, device?: {name, data: {id}}, reason?: 'not_timebox'|'timeout'}` ends a verification. A new `scan` first cancels
    and awaits the running one (so "Search again" never overlaps two scans); `verify` cancels the scan and awaits its
    in-flight slice before it connects; `disconnect` cancels the scan and a running verification. Every handler takes a
    generation number before it awaits: afterwards only the newest may start work and nothing starts once the session is
    closed, so overlapping `scan`/`verify` calls cancel each other and a scan and a verification never run at the same
    time (a `scan` also waits until the aborted verification has closed its link).
  - Scan: `scanPeripherals` for `PAIR_SCAN_TIMEOUT_MS` (= `TIMEBOX_DISCOVERY_TIMEOUT_MS`, 60 s), always the full
    budget (the list may grow while the countdown runs). Finding nothing is a normal `done` with an empty list; only a
    throwing slice is `failed`.
  - Filter (`selectCandidates`): the Evo advertises only its name (protocol section 1.1), so the name is the primary
    filter. Peripherals are de-duplicated by UUID (latest RSSI, last non-empty name, merged service UUIDs); **unnamed
    devices are dropped**, as are already paired ids. Each remaining candidate has `match = name matches
    /timebox|divoom|evo/i (PAIR_NAME_PATTERN) || advertises the ISSC service`. Order: matching devices first (strongest
    RSSI first), then the others alphabetically (case-insensitive), at most 30 in total (matching ones come first, so they
    are never cut off). All named candidates are sent with the `match` flag; the view decides what is shown. The RSSI is
    only used for sorting and the log. `data.id` is the peripheral UUID.
  - Verify on Add (`verifyTimebox`, up to `PAIR_VERIFY_TIMEOUT_MS` = 45 s): a `ConnectionManager` on a `BleTransport`
    connects, discovers the ISSC characteristics and polls `46` on connect (and every 10 s); the first `status` event
    is `ok`. A permanent `TransportError` (no ISSC service or characteristics) fails fast as `not_timebox`; no answer in time
    is `timeout`. The manager is always stopped, so the peripheral is disconnected again before the device is created
    (the real link starts with the device, #22). The view then calls `Homey.createDevice(device)` and `Homey.done()`.
  - View (`scan.html`): countdown, radio list (name and, when it differs, address; no signal strength). Only
    `match` candidates are listed until the "Show all devices" link is pressed (it then reads "Show only TimeBox
    devices"; shown only when other named devices exist). "Search again" when the scan is done or failed. Names come from
    Bluetooth advertisements and are untrusted: they are only set with `textContent`. Texts: `locales/*.json`, `pair.scan.*`.
  - Add feedback: on "Add" the view sets its state to `verifying` synchronously (a second click returns early, so two
    verifies are never sent), disables Add, the list, "Search again" and the show-all link, shows an inline spinner with
    "Checking the device..." and calls `Homey.showLoadingOverlay()` until `verify_result`. On failure it calls
    `Homey.hideLoadingOverlay()`, re-enables the controls and shows the reason; on success the overlay stays until
    `Homey.createDevice()` and `Homey.done()` close the window (it is hidden if `createDevice` fails).
  - Close: the view calls `Homey.setNavigationClose()` ("remove all navigation buttons and show a single Close button").
    The Homey SDK documents no option to switch off the confirmation that Homey's client shows when the pairing window
    is closed (apps.developer.homey.app, custom pairing views). **Known limitation (owner hardware round 2 on #46):**
    `Homey.setNavigationClose()` does NOT remove the Close confirmation. The dialog is Homey client behaviour and no SDK
    mechanism exists to avoid it. Closing (with or without confirmation) makes Homey call the `disconnect` handler, which
    cancels the scan and a running verification (see above).
  - Log prefix `[pair]`: `scan started (60 s)`, `slice: N peripherals, K advertise ISSC`, `scan finished after 60 s: N
    matching, M other named device(s)`, `candidate uuid=... name=... match=... rssi=... issc=... serviceUuids=...` (top 5),
    `scan failed: <msg>`, `verified <uuid>: brightness=B channel=C`, `verify failed <uuid>: not_timebox|timeout`. The
    `[link]` and `[ble]` lines of the verification connection appear between them.
