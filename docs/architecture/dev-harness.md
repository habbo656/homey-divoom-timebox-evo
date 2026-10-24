# Dev harness

_Part of [architecture](../architecture.md); moved from "Dev harness" (#120)._

Dev harness (`src/dev/`, registered in `src/app.ts` only when `process.env.DEBUG === '1'`, i.e. under `homey app run`):
`FaultTransport` wraps a transport and can `mute()` (swallow notifications until the next reconnect) or `drop()` (close
and report a lost link). `registerDevHarness` listens to the app setting `devLink` (`set` event; the value stored at
startup is not executed) and understands `connect`, `drop`, `mute`, `brightness:N`, `channel:N`, `poll:S`, `time:YYYYMMDDhhmm`, `calendar`, `mem`, `stop`
(`parseDevCommand` ignores a `#suffix` so the same command can be written again). `channel:N` (N in 0, 2, 5, 6) sends `45 N`
directly on the link, bypassing the controller, so the hardware test can simulate a device-side mode change (`channel:2` = cloud exercises the other-mode rule, `channel:0` returns to the clock; log
`[dev] channel command sent: 45 NN`; the tile and trigger follow at the next poll). `time:` sets the device clock with
`18` (seconds 0; the date is validated through `setDateTime`, an invalid one is `ignored invalid command`; log
`[dev] time set to <date> <hh:mm>:00`) and `calendar` sends the clock view `45 00 01 00 01 01 01 01 ff ff ff` built with `setClock` (24 h,
full screen, weather/temperature/calendar flags on, white; log `[dev] calendar clock view sent`) so the hardware test can
photograph the date. `mem` (#36) logs `[dev] memory: rss=… heapUsed=… heapTotal=… external=…` (MB; `heapUsed`/`heapTotal` from `v8.getHeapStatistics()`, `rss`/`external` from `process.memoryUsage()` or `n/a`, see the gotcha below; `readMemory` takes an injectable `MemorySource` for tests) and needs no link; `scripts/soak.sh` runs it every 30 min (`docs/testing/stability.md`). It builds its own BleTransport -> FaultTransport ->
ConnectionManager for the strongest Timebox as long as no paired device owns the link. `connect` scans for up to 60 s and logs
`[dev] discovery: no Timebox found after 60 s` when nothing was found, or `[dev] discovery: scan failed after N s: <msg>`
when a scan threw. Commands run one after another; `stop` is bounded (see `closeTimeoutMs`) and cannot hang. Other
commands can still wait: `connect` awaits `discoverTimeboxes` (the underlying `ble.discover` is not bounded) and
`brightness` awaits `manager.send` (a hung write blocks until two missed polls, about 2 min). See `docs/pipeline.md`.

Device link (#22): under `DEBUG=1` each `TimeboxDevice` registers its link with `attachDevLink({manager, fault, label})`
(label = peripheral UUID) before it starts it and `detachDevLink` when it stops. The Timebox accepts only one BLE
connection, so attaching first stops the harness's own link (`[dev] harness link stopped: device took over`). While a
device link is attached, `connect` is refused (`[dev] connect refused: device <uuid> owns the BLE link`, also when the
scan that was already running finishes later), `stop` is refused (`[dev] stop refused: ...`), and `drop`, `mute`, `poll:S`,
`brightness:N`, `channel:N`, `time:...` and `calendar` act on the device's manager and `FaultTransport` (with several devices, the first attached one). The
device (controller) reacts as in production: `drop` shows reconnects and the grace period, `mute` the dead-link detection
(`brightness:N` writes `74` directly, so the controller then follows the device report into `dim`).

Gotcha (#36, hardware test): in the Homey app sandbox `process.memoryUsage()` throws
`ENOENT: no such file or directory, uv_resident_set_memory` (rss is read through libuv; `process.memoryUsage.rss()` uses
the same call), so a dev command that calls it fails with `[dev] command mem failed: …`. Read the heap through
`v8.getHeapStatistics()` (`used_heap_size`, `total_heap_size`), which works there, and treat rss/external as optional:
on the Homey the line reads `rss=n/a … external=n/a`, so heap growth (`heapUsed`) is the memory measure of the stability
test.
