# Custom pages

_Part of [architecture](../architecture.md); moved from "Custom pages" (#120)._

  - Custom pages (#27, reduced in #68; ids and parsers in `src/device/channel.ts`, logic in `TimeboxController`): the device
    Flow action "Show custom page" runs on the shared `switchTo` path, so it powers the panel on, updates the mode tile and known channel, fires
    `timebox_channel_changed` when the mode changes and confirms with `46`. The dropdown ids are the 1-based strings
    `"1".."3"` (`CUSTOM_PAGE_IDS`, label "Page N");
    `parseCustomPageId` maps them to the device index id-1 (0..2) and throws `ArgumentError` (a `RangeError`)
    (naming the allowed ids) for anything else, before the device is called. Logs use the same 1-based numbers. The action "Show visualization" was removed in #68.
    - "Show custom page" (`timebox_show_custom_page`): `controller.showCustomPage(page)` = `switchTo('custom', face,
      {customPage: page})`. Sequence: `45 05` (written bounded and logged `channel -> custom: 45 05`), then wait up to
      `CHANNEL_CONFIRM_TIMEOUT_MS` for its acknowledgement (`waitForReply` on the link's `reply` events), then `bd 17 PP`
      (`setCustomPage`, 0..2, `sendBounded`, no documented reply), then the usual `46` confirm and a `bd 17 ff` read
      (`queryCustomPage` / `decodeCustomPage`, answer `bd 55 17 PP`). The read passes `isCustomPageReply` (`src/protocol/status.ts`:
      opcode `bd` and sub-opcode `17`) as the `accept` filter of `ConnectionManager.request`, because the device sends unsolicited
      `bd 55 13 …` frames after a countdown ended (protocol 5.6); without the filter such a frame would answer the read and
      `decodeCustomPage` would fail with "sub-opcode 13" (#101). The page is only accepted once the custom channel is
      shown, so only a successful `45` reply with data `05` (`45 55 05`) counts as the acknowledgement: a late `45 55 02` of
      another channel switch or a `45` reply without status `55` does not (`ConnectionManager.request` matches the opcode
      only, hence the explicit wait). Without the acknowledgement within the timeout the page is sent anyway
      (`custom page: no 45 ack, sending the page anyway`). `46` has no custom-page field (d0 `05` only confirms the
      channel), so the page is confirmed by the read. **Superseded:** if a newer change started while waiting, the page is NOT
      sent (it would override the newer channel) and `switchTo` returns before any state update: the known channel, the
      `onoff` state and the `timebox_channel_changed` trigger are left to the newer change, `channel custom superseded by a
      newer change` is logged and `showCustomPage` resolves `false`, so `TimeboxDevice.showCustomPage` does not write the
      tile `custom` (same pattern as the colour write of "Set lighting"). One-shot: the app does not store the page.
      A lost link or `stop()` during the wait rejects at once with the readable `not_connected` error (as `request` does): no page is sent on a new session and no state is updated. `PP = ff` is the read form and is never sent as a page. Other display actions need no such guard: their one
      write is serialised on the link queue, so their state update and tile write run in call order.
    - Validation order as for the other display actions: payloads are built and validated before the not-connected check and
      before anything is superseded, so a `RangeError` sends nothing and leaves a pending switch alone.
    - Unconfirmed channel (#141): if the `46` confirm of the switch to the custom channel fails, the page is not read back and the
      action rejects with `not_confirmed` (`not_connected` if the link is lost during the wait), after the tile is set to `custom`.
    - Confirmation of the page read-back (#151): after a confirmed `46` (channel `custom`) the app asks `bd 17 ff`. A reply with
      the requested page logs `custom page confirmed: N`; another page logs `custom page mismatch: device <N|code 0xNN>,
      requested N` and still resolves (like a mode mismatch). No reply in time (`custom page confirm timeout`) or an unusable one
      (`custom page confirm failed: <msg>`) fails the action with `not_confirmed` (`not_connected` if the link is lost or
      `stop()` runs during the read), through the same block of `switchTo` as the `46` confirm (#141): the optimistic state and
      the trigger stay, the tile is set to `custom` first, a change superseded meanwhile resolves `false`. Not retried.
      `TimeboxDevice.showCustomPage` writes the tile (`custom`) directly, without the capability listener.
