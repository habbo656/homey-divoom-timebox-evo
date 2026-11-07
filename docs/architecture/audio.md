# Audio: volume and play status

_Part of [architecture](../architecture.md); issue #4. Protocol: [divoom-protocol.md](../divoom-protocol.md) 5.3, evidence in [protocol/audio.md](../protocol/audio.md) 6.3._

The Evo is an A2DP speaker; the audio comes from a phone or computer, not from Homey. Homey can set and read the speaker
volume (`08 VV` / `09`, VV 0..15) and read whether audio plays (`0b`).

## Capabilities

| Capability | Type | Meaning |
|---|---|---|
| `volume_set` | Homey standard, 0..1 | device volume VV / 15 (`volumeToLevel` = `Math.round(v * 15)`, `levelToVolume` = level / 15) |
| `volume_mute` | Homey standard, boolean | true exactly while the device volume is 0 |
| `timebox_audio_playing` | custom, boolean, read-only sensor (`.homeycompose/capabilities/timebox_audio_playing.json`; en "Audio playing", de "Audio läuft") | the last `0b` play status |

Devices paired earlier get the three capabilities in `onInit` (`MIGRATED_CAPABILITIES` in `TimeboxDevice`, each
`addCapability` in its own try/catch, see [device.md](device.md)).

## Model (`src/device/volume.ts`, pure)

- The device volume is the only truth: mute = (VV 0). There is no separate mute state.
- `restoreVolume` = the last non-zero VV seen or sent, kept in the device store key `volume_restore` (so a restart while
  muted still restores it). Unmute sends it (`restoreLevel`: a stored integer 1..15, otherwise `DEFAULT_UNMUTE_LEVEL` = 8,
  tile about 0.53).
- `volumeToLevel` throws `ArgumentError` (`invalid_number`/`invalid_range`, field `volume`) for a non-number or a value
  outside 0..1.

## Behaviour (`TimeboxController`, `setVolume`, `setMute`, `readAudio`)

- **Set** (`volume_set`, `volume_mute`): like `dim` (#151): validate, `not_connected` error without a live link (nothing
  is queued), `08 VV` via the bounded send, then the confirm: a `09` read-back (`request`, 5 s,
  `AUDIO_REQUEST_TIMEOUT_MS`). `08` has no reply, so the read-back is the only confirm. Logs `volume confirmed: V` or
  `volume mismatch: device V, requested R` (a mismatch resolves; the next read shows the device value). A timeout rejects
  with `not_confirmed` (a lost link with `not_connected`) and both tiles are written to the requested volume. The newest
  change wins: an older one resolves and writes nothing (`volume N superseded by a newer change`).
- **Mute rules** (owner decisions): a Homey volume change while muted unmutes and sends it; volume 0 (from Homey or the
  phone) sets `volume_mute`; a non-zero volume reported by the device clears it; mute sends `08 00` and shows 0 on
  `volume_set` while the stored non-zero volume stays for unmute; the `volume_set` tile shows 0 while muted.
- **While the panel is off** (owner option b): `08` is sent anyway. It lights the panel (measured), `onoff` stays false,
  and the self-wake check of the next status poll (#29, [power-lighting.md](power-lighting.md)) sends the off again, so the
  panel can stay lit for up to 60 s. `09` and `0b` do not light it.
- **Reads** (`readAudio`): after the first status of a session and after every later status at least
  `AUDIO_READ_INTERVAL_MS` (55 s) after the last read, the controller requests `09`, then `0b` (5 s each, one after the
  other). So the tiles follow the device on the 60 s poll; nothing else polls. A failed read only logs
  `audio read failed: <volume|play status>: <msg>` and never counts as a missed poll; a lost link skips the second read.
- **Reports**: every `09 55 VV` and `0b 55 PP` frame (poll read, unsolicited push) goes through `onReply`. A volume
  report is ignored while a set is in flight (no echo loop). The research saw no push after `08`, so there is no echo
  filter. Tiles are written only when the value changed.
  - Invalid values: a `09` above 15 or without a data byte logs `volume report ignored: <msg>`; a `0b` byte other than
    `00`/`01` logs `play status XX is not known, tile unchanged`. The tile stays unchanged. As the poll repeats every 60 s,
    a device that keeps reporting such a value repeats the log line each poll.
- **Triggers and condition**: `timebox_audio_started` / `timebox_audio_stopped` (no tokens) fire only on a change after a
  play status was already read in the same session (`playKnown`, reset on `connected` and `disconnected`): the first
  read after an app start or reconnect only updates the tile and fires nothing. The condition `timebox_audio_is_playing`
  returns `isAudioPlaying()`: the last `0b` of this run, **false until the first read** (also while no controller exists).
  The play status is held in memory only and is not stored. Hint texts say the device is checked every 60 s, so a trigger
  can be up to a minute late.
- A2DP volume sync (AVRCP) is bidirectional: a volume set from Homey also moves the slider of the connected phone or
  computer and the other way round. A volume change at the phone shows on the tile at the next poll (unsolicited `09`
  frames for it are unmeasured, [open-questions.md](../protocol/open-questions.md)).

## Logs

`[device]` prefix: `volume -> V: 08 VV`, `mute -> on|off: 08 VV`, `volume confirmed: V`, `volume mismatch: device V, requested R`,
`volume confirm timeout`, `volume confirm failed: <msg>`, `volume V superseded by a newer change`,
`volume <- device: V`, `volume report ignored: <msg>`, `audio playing <- device: yes|no`,
`play status XX is not known, tile unchanged`, `play status report ignored: <msg>`, `audio read failed: <what>: <msg>`,
`flow trigger timebox_audio_started|stopped`.

## Tests

`volume.test.ts` (mapping, restore), `TimeboxController.volume.test.ts` (wire frames, mute/unmute/restore, set while
muted, outside changes, first read without a trigger, reconnect, throttled reads, in-flight suppression, confirm timeout,
`08` while off and the self-wake off), `protocol/status.test.ts` and `commands.test.ts` (codec), `manifest.test.ts`
(capabilities, cards en/de).
