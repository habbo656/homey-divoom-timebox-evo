# Notification icon

_Part of [architecture](../architecture.md); added with #5._

  - Notification icon (#5; `src/protocol/commands.ts` builder, `src/device/notification.ts` pure icon model,
    `TimeboxController` logic): the Flow action "Show notification icon" (`timebox_show_notification_icon`, dropdown `icon`)
    shows the built-in icon of an app for about 2 s as a short attention signal; then the device returns to the previous
    view by itself (protocol section 5.5, [protocol/notifications.md](../protocol/notifications.md)). Like the native text
    and the countdown it is an **overlay, not a mode**: the known channel, the mode tile, the colour tile, `dim`, the
    triggers and the text, image and countdown tracking do not change.
    - Protocol: `notificationIcon(code)` is `50 TT` (`MAX_NOTIFICATION_ICON` 23, `intInRange` check, `RangeError` for
      anything else, also for codes ≥ 24, which read past the firmware icon table). The text form `50 TT LL <text>` is never
      built (the firmware ignores the text).
    - Icon model: `NOTIFICATION_ICONS` maps the 24 stable ids (never translated, the dropdown values) to the firmware codes
      0..23 in code order: `kakaotalk` 0, `instagram` 1, `snapchat` 2, `facebook` 3, `twitter` 4, `incoming_call` 5,
      `missed_call` 6, `whatsapp` 7, `sms` 8, `skype` 9, `line` 10, `wechat` 11, `qq` 12, `divoom` 13, `viber` 14,
      `messenger` 15, `ok_ru` 16, `vk` 17, `telegram` 18, `tiktok` 19, `discord` 20, `groupme` 21, `douyin` 22,
      `tamtam` 23. String ids were chosen over numbers: they read well in Flows, and removing a code does not shift the
      others. `parseNotificationIconId(value)` throws `ArgumentError` (`invalid_choice`, field `icon`, the allowed ids);
      `notificationIconCode(id)` and `notificationIconCommand(id)` give the code and the `50 TT` payload. The dropdown labels
      are the app names of the firmware table (owner, 2026-10-25: the KB is the source); brand names are the same in en and
      de, only "Incoming call" / "Eingehender Anruf" and "Missed call" / "Verpasster Anruf" are translated. Codes other than
      1 and 3 are SOURCE until the hardware test of #5 photographs them; a code whose photo does not match is removed.
    - `controller.showNotificationIcon(id)`: the id is validated and the frame built first (an invalid id rejects with the
      `ArgumentError` and sends nothing), a link that is down or a stopped controller rejects with `not_connected`. A panel
      that is off is turned on first with `setPower(true)` (`notification: panel is off, turning it on first`; the mode from
      before off returns, `onoff` turns true; an unconfirmed power on rejects with `not_confirmed` and the icon is not
      sent), the same rule as Show text, Start countdown and Show image (#141). Then `link.request(50 TT, 0x50,
      confirmTimeoutMs)` waits for the `50 55` reply: a timeout rejects with `not_confirmed` (log
      `notification icon confirm timeout: <id> (code N)`), a link lost during the wait with `not_connected`
      (`notification icon confirm failed: <reason>`). Success logs `notification icon shown: <id> (code N)`. No pending
      small-clock re-send is taken ahead and no text, image or countdown state is touched: the device returns to the view
      it showed.
    - `TimeboxDevice.showNotificationIcon(id)` only calls the controller (no tile write). The Flow listener validates the
      dropdown id with `parseNotificationIconId` before the device is called (see [flow.md](flow.md)).
    - Not in scope: a combined "Notify with text" card (a Flow can chain the icon and "Show text"). Known limits until the
      hardware test: the effect of an icon over a running text, image or countdown is not measured, and so is whether the
      `50 55` reply arrives on every run (if it does not, the fallback is sending without a confirm, as the countdown does).
