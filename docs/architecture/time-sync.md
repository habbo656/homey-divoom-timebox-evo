# Time sync

_Part of [architecture](../architecture.md); moved from "Time sync" (#120)._

  - Time sync (#23; `timeSync.ts` pure, `TimeboxController` logic): sends `18` with Homey's local time. The zone comes from
    `DeviceSurface.timeZone()` (= `homey.clock.getTimezone()`, an IANA name such as `Europe/Berlin`), the conversion is
    `localDateTimeParts(instant, zone)` (`Intl.DateTimeFormat(...).formatToParts`, `hourCycle: 'h23'`, DST handled by Intl, no
    dependency; `RangeError` for an unknown zone) feeding the existing `setDateTime` (weekday computed from the local date).
    Automatic syncs (device setting `time_sync`, default on, `resolveTimeSyncSetting`: on unless `false`): on the first `46`
    status reply of every session (`connect`, incl. reconnects inside the grace period), 24 h after the last successful sync
    (`daily`), and when the time zone or UTC offset differs from the last sync (`zone change`, `offset change`; DST). The
    last two are found by a check every 60 s (`TIME_CHECK_INTERVAL_MS`, comparison only, no BLE traffic unless a sync is
    due; skipped while offline or the setting is off); `autoSyncReason(last, now, zone, offset, lastFailureAt)` decides.
    `setTimeSyncEnabled(on)` applies the setting (switching on while online syncs at once, reason `setting`; off only stops
    the automatic syncs). There is no manual sync (the Flow action "Sync time now" was removed in #70); an unknown zone (`TimeZoneError`, a `RangeError` subclass) is only logged and retried. The command is sent with
    `link.request(18, 0x18, 5 s)`, expecting `18 55`; concurrent syncs share one command. A missing acknowledgement logs
    `time sync not confirmed` and counts as synced (the timeout cannot tell a Timebox that does not acknowledge from a write that did not complete; if the link is really gone, the liveness poll drops the session and the reconnect syncs again, reason `connect`); any other failure logs `time sync failed: <msg>` and is retried by the
    60 s check after 15 min (`SYNC_RETRY_MS`, reason `retry`; the check does nothing else, and logs nothing, before that delay is over, also when the zone has become invalid). A sync interrupted by `stop()` logs nothing. The check timer starts in `start()` and is cleared in `stop()`.
    Only `18` is sent (VERIFIED, protocol section 5.1).
