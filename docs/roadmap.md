# Roadmap: rebuild on the verified protocol

_Re-planned 2026-10-06 after the hardware research in #5 (`docs/divoom-protocol.md`). Replaces the M0–M3 plan._

The app is rebuilt from scratch (ADR 0005). The old code assumed the SPP frame works over BLE and rendered text in
software; both are obsolete: BLE needs the `FE EF AA 55` envelope, and the Evo has native scrolling text.

Earlier owner decisions still apply: target Homey Pro; direct BLE from Homey (now verified, no gateway);
weather via Open-Meteo (no API key); locales en + de; public App Store release; one Evo; sequential development.

## Design principles
1. **Device first.** Everything that is device state is a capability on the device tile (`onoff`, `dim`, mode
   picker, one colour picker for the active mode) or a **device setting** (clock style, clock pages, time sync).
   No app-level settings page.
2. **Flow cards for actions and events.** One-shot content (text, weather, countdown, image) is a Flow action; device
   events (connected, mode changed) are triggers/conditions.
3. **Less is more (owner, 2026-10-06).** Only what matters for a smart-home integration. No setting without a
   visible effect, no colour as hex text (Homey settings have no colour type; colour lives on the tile and in Flow
   `color` arguments), one term for the same thing ("mode", not "channel").
4. **Verified commands only.** Only opcodes marked VERIFIED in the protocol doc are used. The Evo has no NAK, so every
   argument is validated before sending.
5. **Pure protocol core.** `src/protocol` has no Homey imports and is fully unit tested with golden vectors.

## Homey SDK fit (checked 2026-10-06)
- BLE: `homey.ble` discover/connect/write/`subscribeToNotifications`; no idle disconnect since Homey 6; no Classic.
- Custom capabilities: enum + `picker` (channel), boolean/number; system `dim`, `onoff`, `light_hue`,
  `light_saturation`, `volume_set`, `volume_mute`.
- Flow argument types used: text (tags), number, range, dropdown, autocomplete, `color` (hex), droptoken `image`.

## Milestones (one minor release each, see `docs/versioning.md`)

| Version | Milestone | Issues |
|---|---|---|
| 0.2.0 ✅ accepted 2026-10-06 | Core rebuild | #18 skeleton ✅, #19 envelope/replies ✅, #20 command builders + status ✅, #21 BLE transport ✅, #22 driver (pairing, availability, `dim`) ✅ (+ #46 custom pairing view ✅), #23 time sync ✅ |
| 0.3.0 ✅ accepted 2026-10-07 | Display & modes | #24 channel picker ✅, #25 clock ✅, #26 power + mood lighting ✅, #27 visualizations + custom pages ✅; rework (owner, 2026-10-06): #68 modes clock / lighting / custom + "mode" wording ✅, #69 one colour picker for the active mode (no clock colour setting, no lighting effects) ✅, #70 trim settings and Flows ✅ |
| 0.4.0 ✅ accepted 2026-10-07 | Text, weather & countdown | #28 native text ✅, #30 weather/temperature ✅, #98 separate temperature and weather Flow actions ✅ (owner, 2026-10-07), #33 countdown ✅ (owner scope 2026-10-06: countdown only, no stopwatch/scoreboard/noise meter), #106 clock animation pages setting ✅ (UAT-1 finding, resolves #59), #107 too long text rejected with an error ✅ (UAT-6 finding), #108 localised validation errors ✅ (UAT-14 finding) |
| 0.5.0 ✅ accepted 2026-10-08 | Images | #31 image (token/URL) ✅ (hardware test round 1 failed on memory with 4K photo JPEGs, fixed with bounded-memory decoders, ADR 0010; re-test passed; the token card is checked in the v0.5.0 UAT), #101 "Countdown ended" Flow trigger ✅ (hardware test passed 2026-10-08; owner, 2026-10-08; UAT case: Flow "When Countdown ended" sends a push notification) |
| 1.0.0 ✅ accepted 2026-10-16 | App Store release | #92 icons, images, name & readme ✅, #36 stability ✅, #37 store readiness ✅ ([release checklist](release-checklist.md)), #38 release process ✅ (`npm run release:check` / `release:bump`, [procedure](versioning.md#release-procedure)), #133 "TimeBox" spelling ✅ (owner, 2026-10-16), #142 driver icon redrawn with 40/20/10 px strokes ✅ (UAT-1 finding, round 1, 2026-10-16) |
| 1.1.0 ✅ accepted 2026-10-18 | Bugfix after Release 1.0 | #147 app icon missing in "Add new device" and in the App Store (owner, 2026-10-16: first) ✅, #141 mode change reports success without a confirm ✅ (owner, 2026-10-16: fail with `not_confirmed`; dim, power off and custom-page confirm timeouts: #151), #125 `onoff` after a hidden countdown end ✅, #48 stale BLE connection and timing options ✅, #62 dim while off is held until power on ✅, #60 clock settings save during a switch ✅, #129 native 16x16 image unchanged ✅, #94 `homey-run.sh` without arguments ✅, #151 dim, power off and custom page confirm timeouts still report success ✅ (owner, 2026-10-17: in 1.1.0) |
| 1.2.0 | Additional features (planned 2026-10-18, GitHub milestone `v1.2.0 Additional Features`) | #158 ESLint ignores `.hwtest/`, #168 Equalizer mode (`45 04 00`, owner, 2026-10-18), #169 Noise meter mode (`72 02 01`; hardware probe first: `46` d0 likely not updated), #34 volume + playing state, #29 notification icons (TT sweep first), #35 persistent settings + sleep light |

The GitHub milestones still carry their old names (`v0.3.0 Display & channels`, `v0.4.0 Text, notifications &
weather`, `v0.5.0 Images & animations`); the owner renames them. `v0.6.0 Tools & audio` is no longer used.

Execution is sequential in the listed order. The `agent-pipeline` workflow takes the first open issue from this table
that the owner approved (`agent:approved`) and runs it end to end (plan → develop → docs → gate + review → hardware
test → merge, see `docs/pipeline.md`). Merged issues are
marked ✅ in the table by the doc-keeper. Each milestone ends with an owner acceptance test (`docs/uat/README.md`);
the next milestone starts only after acceptance, and the owner releases a milestone once it is accepted.

## Breaking changes
Released versions: the user-facing summary is in `.homeychangelog.json`, the full lists of 0.3.0 to 1.0.0 are in
`docs/archive/breaking-changes.md`. Changes known before the next release are collected here as "Breaking changes in <version>"
(`docs/versioning.md`); after the release the list moves to `docs/archive/breaking-changes.md`.

### Breaking changes in 1.1.0 (for the changelog)
None for existing Flows or paired devices: no id, capability, setting, Flow card or argument is removed or renamed, and no re-pairing is needed. User-visible changes:
- #141 / #151: an action the TimeBox does not confirm now fails instead of reporting success. A mode change (Flow actions that switch the display, mode picker, Show clock/lighting/custom page), a power on (`onoff` true), the colour tile, Show text, Start countdown and Show image on a panel that is off (their power on), a `dim` change, a power off (`onoff` false) and a custom page whose read-back does not arrive fail with `not_confirmed` ("The TimeBox did not confirm the change. Check the display and try again in a moment.", en + de). A Flow that ran "green" while the link was muted now shows an error; a link lost during the wait still gives `not_connected`. Details: [architecture/modes.md](architecture/modes.md), [architecture/errors.md](architecture/errors.md).
- #62: a `dim` change while the panel is off is held and sent right after the next switch on (display command, switch on at the device, countdown end) instead of lighting the panel.
- #125: when a countdown end lights a panel that was off, `onoff` turns true and the mode tile follows the device.
- #60: saving the clock settings during a switch to the clock is applied.
- #48: no user-visible change except fewer stale BLE connections after a reconnect (an orphaned connection is disconnected; invalid timing options are rejected).
- #147: the app icon path is rewritten in a defensive canonical form (same shape); whether this fixes the missing icon in "Add new device" and the App Store is checked in UAT v1.1.0.
- App name (owner, 2026-10-18): the app is renamed from "TimeBox Evo" to "Divoom TimeBox Evo" (en and de); the app and driver icons are declared explicitly in the manifest. The app id `com.habbo656.divoom-timebox`, the driver name "TimeBox Evo" and device names are unchanged. Details: [architecture/store-assets.md](architecture/store-assets.md).
- #129, #94: none user-visible (native 16x16 images were already sent unchanged, now pinned by tests; `scripts/homey-run.sh` prints the usage without arguments).

## Not planned (backlog, only on request)
Alarms/memorials (`43`/`54`, Homey Flows schedule better), games (`a0`), drawing pad (`6f`/`58`), FM/source modes
(no audible effect), device rename (`75`), firmware opcodes (never). Removed in the 2026-10-06 rework: cloud channel,
visualization styles other than the spectrum bars (#27), scoreboard, stopwatch, lighting effects, GIF animations (#32), 12/24-hour setting
(#58), status interval setting, Flow "Sync time now".

## Milestone 1.2.0 plan (2026-10-18)
Evaluation per issue is posted on each issue (protocol status, derived acceptance, open points). The equalizer (spectrum
bars `45 04 00`) and the noise meter, removed in the 2026-10-06 rework, come back on owner request (2026-10-18). Order and reasons:
1. #158: pipeline hygiene; protects the gate during the many hardware tests of this milestone.
2. #168 Equalizer: all VERIFIED (`45 04 00`, `46` d0 `04`); extends the mode set (new id `equalizer`; the old `visualizer`
   value stays cleared). Reaction to audio needs an A2DP stream: owner UAT case.
3. #169 Noise meter: builds on the mode extension. Blocking unknown: whether `46` reports it (the scoreboard `45 06` does
   not); if not, the app tracks the mode itself (like an image) and a device-side switch is not detected.
4. #34 Volume: `08`/`09`/`0b` VERIFIED; `08` has no reply, so the `09` read-back is the confirm (#141/#151 rule);
   unsolicited `09` frames not verified (else the tile follows on the poll). Audible checks are owner UAT cases.
5. #29 Notification icons: `50 TT` verified for TT 1 and 3 only; a photographed TT sweep comes first, only verified icons
   are offered. "Notify with text" is not in scope (a Flow can chain icon and text).
6. #35 Persistent settings and sleep light: most unknowns (auto power-off and sleep light vs the power/mode tracking,
   startup channel values 4–6, sleep-light volume/sound bytes vs #34); persistent writes are restored after each hardware
   test; the power cycle is an owner case. **The auto power-off wait is owner-attended:** it is not known whether the
   Evo stays reachable over BLE after it switches itself off; if not, the tester could not restore `ab` and the Evo would
   keep switching off. The owner powers it back on and the original value is restored right after the reconnect.

Owner defaults (change on the issue if wanted): Equalizer shows only the spectrum bars, no style setting; a device-side
visualization maps to Equalizer only when `46` d9 (last visualization index) is `00`, the other 11 stay an "other mode"
(tile cleared, as today); the noise meter is app-tracked if `46` cannot report it; no combined "Notify with text"
card. Hardware: A2DP audio (#168, #34), the power cycle and the auto power-off wait (#35) need the owner; the tester
covers the rest.

## Known limitations and open follow-ups (v1.1.0)
- Flow arguments are validated when the card runs, not when the Flow is saved (Homey text arguments have no length limit; tags/variables resolve at run time). Owner accepted this in UAT v0.4.0 round 2.
- #96: temperature in °F (`2b`): the weather is Celsius only (#30).
- Weather (#30) known limits: the clock page flags `clock_weather`/`clock_temperature` are not switched on automatically; a value held while the panel is off or a text runs is sent by the 60 s check, not at once.
- Weather (#98) known limits: the Flow actions set one part each; a part that was never set is sent as 0 °C / clear until it is set (or Open-Meteo sets both), so turn off the clock page of the part you do not feed.
- Images (#31) known limits: a GIF whose first frame reaches outside the logical screen is refused; after a power cycle of the Evo an image may stay tracked while the reported mode is unchanged (weather and the clock flag stay held until the next mode command); no EXIF rotation and no colour management; only the first frame of a GIF; JPEG and GIF decode synchronously (about 150 ms locally for 4K; limits: 5 MiB, 3840 x 2160, 16384 px per side) and a JPEG over 512 x 512 is averaged from its 8x8 blocks (1-2 levels off a full decode on most pictures, up to about 19 on sharp graphics); an image shown before an app restart is not known to the app (any mode change ends it); when the link is down at the end of the duration the image stays until the next mode command; what weather (`5f`) and the clock flag (`26`) do to a shown image are not measured (conservative handling, see architecture/images.md); an image shown over a running countdown is replaced by the clock at the countdown end but the app keeps tracking it (weather and clock flag stay held until the next display command; measured in #101); the token card cannot be driven through the Web API and is checked in the v0.5.0 UAT.
- Native text (#28) known limits: a text that still runs on the device after an app restart is not known to the app (use the Stop text action or any mode change); texts over 64 characters fail the action (after removing emoji, which the Timebox cannot show).
- Countdown (#33) known limits: a mode change, a text or power off only hide a running countdown; a stop cannot end it while hidden and its end display (`00:00`, a few seconds) appears later (and lights a panel that is off); the "Countdown ended" trigger (#101) fires on every end frame the device reports, also for a hidden countdown or one started outside Homey, and sets `onoff` true when the end display lights a panel that was off (#125; skipped when a power change is in flight); the app does not track the countdown (protocol section 5.6).
- Muted but not yet dead link (found in #36): fixed in #141 and #151 (v1.1.0). A mode change the TimeBox does not confirm now fails with `device.error.not_confirmed` (`architecture/modes.md`). Fixed for dim, power off and the custom page read-back in #151 (v1.1.0) as well; still optimistic by design: a dim held while the panel is off (nothing is sent, #62) and the dim sent at power on, which the power-on confirm covers.
- A real app restart cannot be driven by `scripts/homey-run.sh` (stop/start reuses the build); it is an owner case (M4, M6 in `docs/testing/stability.md`) in the v1.0.0 UAT.

## Risks
- Homey BLE long-run link stability: measured in #36 (2026-10-16, `docs/testing/stability.md`): 110 min active and
  110 min idle without a disconnect, 1.00 `poll ok` per minute, induced drops reconnect in 3 to 6 s, a muted link in 64 s, no
  `Unhandled` or memory warning. The Homey BLE MTU is still not measured (20-byte writes work; mitigations: `46` polling and
  reconnect with backoff in `ConnectionManager`, #21). A physical power cycle of the Evo
  cannot be automated; it is a manual case in the v0.2.0 UAT (`docs/uat/archive/v0.2.0.md`):
  unplug the Evo 10 s, replug; expect `connected` within ~3 min.
- Image decoding on Homey (#31): the app has little memory; the decoders never hold the whole picture and run one at a time (ADR 0010; about 8-21 MB per decode measured locally; on Homey the re-test prepared 4K photo JPEGs in 121-312 ms and a 4K PNG in 675 ms, 6 concurrent 4K loads were serialised, no memory warning or restart: risk mitigated; the #36 soak (110 min active with a 4K image URL step every 40 min, then 110 min idle) kept the V8 `heapUsed` at 11.0 to 11.8 MB and 11.4 MB idle with no growth, no warning); crafted inputs are bounded by the side limit, the JPEG scan caps and the token/queue deadlines. Large inputs are still bounded by the download and size limits.
- Native text (#28): measured on 2026-10-07 (speed about SP columns per second, 64 units maximum, emoji do not draw, see `docs/divoom-protocol.md` 5.5). One unexplained loss of the BLE link (the Evo stopped advertising until power-cycled) happened once around a native text test and did not reproduce; the hardware test watches for it.
