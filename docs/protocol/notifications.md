# Notification icons evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) section 5.5 (`50 TT`, #5); opcode rows and status stay there._

## Opcode table notes

- `50 TT` shows the built-in icon of app type `TT` for about 1-2 s; then the previous view returns by itself. Reply
  `50 55`. VERIFIED on the owner's Evo for TT 1 and 3 (Mac probe, 2026-10-06, webcam photos; see
  [native-text.md](native-text.md#55-native-text-evidence) for the session).
- The firmware icon table has **24 entries, codes 0..23** (KB: command 0x50, recipe "notifications"). The firmware does
  not check the range: a code of 24 or more reads past the table, so the app never sends one (`notificationIcon` throws
  `RangeError`, `MAX_NOTIFICATION_ICON` 23).
- The text form `50 TT LL <UTF-8 text>` is acknowledged with `50 55` and shows the icon, but the text was not seen in the
  photos (2026-10-06); the firmware ignores the text bytes (KB). Not used.
- Not used either: `4a` (writes the per-app notification switches to flash), `3c` with a colour (the Evo stores garbage,
  KB), `84` (reset notifications; sent 2026-10-06, no reply).
- The app waits for the `50 55` reply as the confirm (#141 rule); a missing reply rejects with `not_confirmed`.

## Icon codes

Labels are the app names of the firmware icon table (KB: command 0x50); the id is the stable dropdown value of the Flow
action "Show notification icon" (`src/device/notification.ts`). Status per code: VERIFIED = photographed on the owner's
Evo; SOURCE = from the KB only. The photo column is filled by the hardware test of #5 (or its fix round); a code whose
photo does not match its label is removed from the dropdown.

| TT | Id | Label (KB) | Status | Photographed result |
|---|---|---|---|---|
| 0 | `kakaotalk` | KakaoTalk | SOURCE | not yet photographed |
| 1 | `instagram` | Instagram | VERIFIED (2026-10-06) | colourful icon (2026-10-06); not yet photographed through the card |
| 2 | `snapchat` | Snapchat | SOURCE | not yet photographed |
| 3 | `facebook` | Facebook | VERIFIED (2026-10-06) | Facebook "f" (2026-10-06); not yet photographed through the card |
| 4 | `twitter` | Twitter | SOURCE | not yet photographed |
| 5 | `incoming_call` | Incoming call | SOURCE | not yet photographed |
| 6 | `missed_call` | Missed call | SOURCE | not yet photographed |
| 7 | `whatsapp` | WhatsApp | SOURCE | not yet photographed |
| 8 | `sms` | SMS | SOURCE | not yet photographed |
| 9 | `skype` | Skype | SOURCE | not yet photographed |
| 10 | `line` | LINE | SOURCE | not yet photographed |
| 11 | `wechat` | WeChat | SOURCE | not yet photographed |
| 12 | `qq` | QQ | SOURCE | not yet photographed |
| 13 | `divoom` | Divoom | SOURCE (KB hardware check) | not yet photographed |
| 14 | `viber` | Viber | SOURCE | not yet photographed |
| 15 | `messenger` | Messenger | SOURCE | not yet photographed |
| 16 | `ok_ru` | OK.ru | SOURCE | not yet photographed |
| 17 | `vk` | VK | SOURCE | not yet photographed |
| 18 | `telegram` | Telegram | SOURCE (KB hardware check) | not yet photographed |
| 19 | `tiktok` | TikTok | SOURCE | not yet photographed |
| 20 | `discord` | Discord | SOURCE | not yet photographed |
| 21 | `groupme` | GroupMe | SOURCE | not yet photographed |
| 22 | `douyin` | Douyin | SOURCE | not yet photographed |
| 23 | `tamtam` | TamTam | SOURCE | not yet photographed |

## Golden vector

Telegram (`50 12`) in the BLE envelope with seq `0x0101`: `fe ef aa 55 09 00 01 01 00 00 00 50 12 6d 00`
(`scripts/probe/divoom.py` `ble_envelope()`); as SPP frame `01 04 00 50 12 66 00 02` (equal to the KB `raw 0x50 12`
frame). The KB recipe's BLE frame uses another BLE framing and appends the app's text length byte, so it is not
comparable byte for byte (`src/protocol/__fixtures__/golden.ts`).

## Open

- The icon of every code on this firmware, the panel-off behaviour (does `50` light the panel by itself?) and an icon over
  a running text, image or countdown: measured in the hardware test of #5.
