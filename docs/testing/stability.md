# Stability test (#36)

Hardware test of the link and the app over a long run on the real Homey with the paired Timebox Evo: reconnect behaviour,
error handling and memory. It is a measurement report: a violated criterion becomes a separate bug issue (milestone
v1.0.0), it does not fail #36. The results are recorded in [Results](#results).

## Purpose
- Prove that the link comes back after every kind of loss the app can cause or detect (single drop, drop burst, dead link).
- Prove that every error the user can see is localised (en/de), and that nothing unhandled reaches the log.
- Measure the app's memory and log volume over about 4 h (110 min active, 110 min idle).

## How to run
Prerequisites: `scripts/hw-preflight.sh` is ready, `.homey-api.env` is set up (`docs/pipeline.md`, Hardware testing) and the
owner has paired the Timebox in the running dev build (the pairing goes away when the run ends).

```sh
scripts/hw-snap.sh baseline
scripts/homey-run.sh start 300
scripts/homey-run.sh wait 'Running .com\.habbo656' 180
D=$(scripts/homey-api.sh devices get-devices --jq '[.[]|select(.driverId|test("timebox";"i"))][0].id' | tr -d '"')
```

Dev commands (`DEBUG=1` is set by `homey app run`; with a paired device they act on the device's own link, see
`docs/architecture/dev-harness.md`). Pass the value without JSON quotes and append `#n`; a write of the same value as before does not fire the setting, so
the suffix keeps counting up per command within the whole run (S0 `mem#1`, S1 `drop#1`, S2 `drop#2` to `drop#7`, S3 `mute#1`, S4b `mute#2`, S4c `mute#3`, S7 `mem#2`):

```sh
dev() { scripts/homey-api.sh apps set-app-setting --id com.habbo656.divoom-timebox --name devLink --value "$1"; }
dev 'mem#1'     # logs "[dev] memory: rss=n/a heapUsed=… heapTotal=… external=n/a" (MB; rss/external are n/a on the Homey); needs no link
dev 'drop#1'    # simulated lost link: "[link] disconnected: link closed by device", then "reconnecting in …s" and "connected (seq reset)"
dev 'mute#1'    # swallows device notifications until the next reconnect: "poll timeout (1/2)", "poll timeout (2/2)", "link dead, reconnecting"
```

Read the log with `scripts/homey-run.sh log [--session] [lines]`; `--session` covers the whole run since the install.

The soak driver `scripts/soak.sh` (`-h` for the options) drives the device for a window and writes
`.hwtest/<branch>/soak-<label>.log`:

```sh
scripts/soak.sh --device "$D" --minutes 110 --every 300 --label active   # S5: rotates dim, text, clock, lighting, countdown, 4K image URL, temperature, mode
scripts/soak.sh --device "$D" --minutes 110 --idle --label idle          # S6: only mem (every 30 min) and a photo (every 60 min)
```

Each step is one `ok` or `FAIL` line in that log. A step fails when its command exits non-zero or hits the 60 s call
timeout; a Flow card step also fails when the JSON result has a non-null `"error"` (`{ …, "error": null, … }` is a
success). Other output text is not inspected.

Expected cadence in steady state: one `[link] poll ok: brightness=… channel=…` per minute (the app polls every 60 s) and
about two log lines per minute in total.

## Scenarios
Run in this order; S8 would be last because it ends the run.

| ID | Scenario | Steps | Expected |
|---|---|---|---|
| S0 | Baseline and memory | Start the run, wait for the device to connect, `dev 'mem#1'`, photo | one `[device] started`, `[link] connected`, a `poll ok`, a `[dev] memory:` line; the tile shows the clock |
| S1 | Single drop | `dev 'drop#1'`, wait for `connected (seq reset)`, then a Show text action works | disconnect and reconnect within the 180 s of C3 (normally a few seconds); the device is back and accepts commands |
| S2 | Drop burst | `dev 'drop#2'`, `dev 'drop#3'`, `dev 'drop#4'` in quick succession, then a second round `dev 'drop#5'`, `dev 'drop#6'`, `dev 'drop#7'` 10 s apart | exactly one link at the end, no stuck reconnect loop, no unhandled rejection; reconnect within 180 s |
| S3 | Mute, link dead, reconnect | `dev 'mute#1'` | two missed polls (about 2 min), `link dead, reconnecting`, then `connected (seq reset)` within 180 s of the first missed poll; the device becomes available again |
| S4 | Localised errors only | With the link up and then (S4b) right after `dev 'mute#2'` once the link is dead: run Show text with 100 characters (`text_too_long`), Start countdown 0 min 0 s (`countdown_zero`), Show image from URL `https://does-not-exist.invalid/a.png` (`image_unreachable`), and any action while the link is down (`not_connected`) | every error the user sees is the en/de text of `device.error.<kind>`, never a raw `Error`, stack or key; the log shows no `Unhandled` or `TypeError` |
| S4b (#141) | Unconfirmed change fails | Link up: Show clock (green) gives `error: null` and `channel confirmed: clock`. `dev 'mute#N'`, then Show clock (red) within about 10 s: after about 5 s the error is exactly the `not_confirmed` text, the log shows `channel confirm timeout`, the tile reads `clock`. Still muted: set `timebox_channel=lighting`: it fails with `not_confirmed`, the tile reads `lighting`. After `link dead` and the reconnect: Show clock gives `error: null` and `channel confirmed: clock`. While the link is dead: actions give `not_connected` | never `error: null` together with `channel confirm timeout` for the same call; no raw timeout text or `device.error.` key in a result; no `Unhandled` or `TypeError` in the log |
| S4c (#151) | Unconfirmed dim, power off and custom page fail | Baseline with the link up: dim 40 %, Show custom page 2 and Turn off give `error: null` and the logs `dim confirmed: 40`, `custom page confirmed: 2`, `power off: device reports lighting` (then Turn on). `dev 'mute#3'`, then within about 10 s: set `dim` to 30 %, run Show custom page 1 and set `onoff` false, one after the other. The dim and the off fail after about 5 s, Show custom page after about 10 s (it first waits up to 5 s for the `45 55 05` ack, the log shows `custom page: no 45 ack, sending the page anyway`, then 5 s for the `46`), each with exactly the `not_confirmed` text; the log shows `dim confirm timeout`, `channel confirm timeout` (the page switch fails at its `46`, so the `bd 17 ff` read-back is not reached while muted; it is covered by unit tests) and `power off confirm timeout`; the tiles read the requested values (`dim` 30 %, `custom`, `onoff` off). After `link dead` and the reconnect the same three actions give `error: null` again. While the link is dead: they give `not_connected` | never `error: null` together with a `... confirm timeout` for the same call; no raw timeout text or `device.error.` key; no `Unhandled` or `TypeError` in the log |
| S5 | 110 min active soak | `scripts/soak.sh … --minutes 110 --label active` (about 22 actions at 300 s) | criteria C1 to C4; photo every 60 min shows the clock/last action; `[dev] memory:` every 30 min |
| S6 | 110 min idle hold | `scripts/soak.sh … --minutes 110 --idle --label idle`; sends nothing to the device | criteria C1 to C6 |
| S7 | End check | Dim, Show text and Show clock still work; `dev 'mem#2'`; photo | the device is available and answers; final memory line recorded |
| S8 | App restart (last) | Not automatable: `scripts/homey-run.sh stop` followed by `start` reuses the installed build and does not restart the app process (still one `TimeBox Evo app initialized`, polls continue). A real restart needs `stop --uninstall`, which removes the paired device | covered by the owner manual cases M4 and M6 in the v1.0.0 UAT |

The formal scenarios S0 to S4 run before the soaks, so the soak windows stay free of induced faults (C3 and C4 are then
measured on undisturbed runs).

## Criteria
| ID | Criterion | How to measure |
|---|---|---|
| C1 | No `Unhandled`, `TypeError` or memory warnings in the log | `scripts/homey-run.sh log --session 100000 \| grep -v '\[dev\] memory:' \| grep -Ei 'unhandled\|typeerror\|memory warning\|heap'` is empty (the expected `[dev] memory:` lines are excluded first) |
| C2 | One app init | exactly one `TimeBox Evo app initialized` line per run window in the session log: the app did not restart by itself (runs before #133 logged `Divoom Timebox app initialized`) |
| C3 | Every disconnect reconnects within 180 s | for every `disconnected:` or `link dead` line, the next `connected (seq reset)` is at most 180 s later |
| C4 | `poll ok` at least 0.9 per minute | number of `poll ok` lines divided by the minutes of the window, outside the induced drops |
| C5 | Idle log at most 300 lines per hour | line count of the S6 window divided by its hours |
| C6 | `heapUsed` growth at most 10 MB over the idle hold | last minus first `[dev] memory:` `heapUsed` of S6 (V8 heap; `rss` is `n/a` in the Homey sandbox, so the heap is the measure) |

## Owner manual cases
Cannot be automated; they go into the v1.0.0 UAT (`docs/uat/`).

| ID | Case | Expected |
|---|---|---|
| M1 | Power-cycle the Evo (unplug 10 s, replug) | the device is unavailable, then available again and shows the app's state within about 3 min |
| M2 | Take the Evo out of range, then back | unavailable after the grace period, available again after returning; no stuck state |
| M3 | Restart the Homey | the app starts, the device reconnects without repairing |
| M4 | Update the app on the Homey (install a newer version) | the device stays paired and reconnects |
| M5 | Connect a phone to the Evo's audio (A2DP) while the app is connected | the app link recovers or reports unavailable with the localised text; after disconnecting the phone the device is available again |
| M6 | Restart the app in the Homey app (App settings, Restart) | the device stays paired, the app initialises once and the device reconnects within about 3 min; the state (clock, brightness) is shown again |

## Results
Hardware run of 2026-10-16 on a Homey Pro with the Timebox Evo paired in a `homey app run` dev build. Verdict:
all scenarios and criteria pass, S8 is not automatable (see below), one app finding (open follow-up). The first run, for S1 to S4,
used build `6089ae4df1ed`; the rest used build `a0f30897c68f`.

### Tooling defects found by the first run (fixed before the retest)
- `mem` failed with `ENOENT: no such file or directory, uv_resident_set_memory`: `process.memoryUsage()` does not work in the Homey
  app sandbox. `mem` now reads the heap through `v8.getHeapStatistics()` and prints `rss=n/a` and `external=n/a`
  (`docs/architecture/dev-harness.md`).
- The soak driver marked a Flow card result containing `"error": null` as FAIL; it now judges a card step by the JSON `error` field.
After the fixes a dry run (8 actions plus `mem`) was all ok.

### Scenarios
| ID | Verdict | Evidence |
|---|---|---|
| S0 | pass | one app init, device connected, `poll ok`; `[dev] memory: rss=n/a heapUsed=9.6 heapTotal=12.0 external=n/a` |
| S1 | pass | `drop#1`: reconnected after 3 s, commands accepted afterwards |
| S2 | pass | burst `drop#2` to `drop#4`: one reconnect cycle, 5 s; second round `drop#5` to `drop#7`: 4.6, 5.5 and 5.7 s; no reconnect loop, one link at the end |
| S3 | pass | `mute#1`: `poll timeout (1/2)`, `(2/2)`, `link dead, reconnecting`, reconnected 64 s after the first missed poll; device available again |
| S4 | pass | `text_too_long`, `countdown_zero`, `image_unreachable` (the call took 70.9 s end to end) and `not_connected` all showed the localised (de) text; no `Unhandled` or `TypeError` in the log |
| S5 | pass | 110 min active (08:09 to 09:59 UTC), 30 actions ok, 0 FAIL; `heapUsed` 11.0 / 11.0 / 11.4 / 11.8 / 11.3 MB at the five `mem` points |
| S6 | pass | 110 min idle (09:59 to 11:49 UTC), 0 FAIL; `heapUsed` 11.4 MB at all five points |
| S7 | pass | dim confirmed 50, Show text and Show clock shown (photo 12:51: full-screen white clock); `heapUsed` 11.6 MB |
| S8 | not automatable | `homey-run.sh stop` plus `start` reuses the installed build and does not restart the app process; a real restart needs `stop --uninstall`, which removes the paired device. Owner cases M4 and M6 cover it in the v1.0.0 UAT |

### Criteria
| ID | Result | Measured |
|---|---|---|
| C1 | pass | no `Unhandled`, `TypeError` or memory warning in the log |
| C2 | pass | one `Divoom Timebox app initialized` in the session |
| C3 | pass | no disconnect during the soak windows; the induced ones in S1 to S3 reconnected within 64 s at most |
| C4 | pass | 1.00 `poll ok` per minute in S5 and S6 |
| C5 | pass | idle 361 lines in 110 min, about 197 lines per hour, including about 3 `rx` lines per poll (active: 554 lines in 110 min) |
| C6 | pass | idle `heapUsed` growth 0.0 MB (11.4 MB at all five points) |

### Findings
- Muted but not yet dead link (app, out of scope of #36, GitHub issue #141, **fixed in #141**, v1.1.0; scenario S4b): during the up to about 2 min between `mute` and the
  link-dead detection, a Show clock action took about 5.3 s and returned success, although the log shows
  `channel confirm timeout` and `channel confirm failed: poll timeout`. By design a missing confirmation still resolves the action (`docs/architecture/modes.md`), so the user is not told that the
  device did not confirm. Since #141 an unconfirmed change fails with `not_confirmed`, since #151 so do dim, power off and the custom page read-back (scenario S4c). The earlier text is kept as the finding of the v1.0.0 run.
- `image_unreachable` for an unresolvable host took 70.9 s until the user saw the error (S4); long, but localised and bounded.
