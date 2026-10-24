# Homey implications evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) section 9; opcode rows and status stay there._

## 9 Homey implications: evidence

- Homey's SDK only offers BLE (`ManagerBLE`; permission `homey:wireless:ble`; no Classic/RFCOMM API; Homey Pro
  hardware is "Bluetooth Low Energy 5.0"). Checked 2026-10-06 (apps-sdk-v3.developer.homey.app,
  apps.developer.homey.app/wireless/bluetooth, …/the-basics/app/permissions, homey.app/homey-pro).
- BLE is sufficient. The GATT UUIDs (#4, ADR 0002) are correct. Payloads are wrapped with the BLE envelope and seq
  counter (section 1.2) and notifications are parsed as SPP frames (section 1.4). Codec: done in #19 (`src/protocol`);
  the BLE transport and link supervision: done in #21 (`src/transport`, defaults: poll `46` every 60 s, request timeout
  5 s, connect timeout 30 s, backoff 2 s..60 s with equal jitter, permanent error retry 5 min, link dead after 2
  missed polls; waits for a previous close bounded by 10 s, BLE disconnect bounded by 5 s). Command builders with argument validation and the `46` status decoder: done in #20.
- Pairing: implemented in #46 (pairing part of #22): `src/device/pairing.ts`, view `drivers/timebox/pair/scan.html`. A
  60 s scan, candidates by name (`/timebox|divoom|evo/i`, "Show all devices" for renamed units), verified on Add by connecting and getting a
  `46` reply; the device id is the peripheral UUID. Pairing confirmed on hardware (owner, 2026-10-06).
- Device (#22): `dim` (0..1) is sent as `74 round(dim*100)` and confirmed with a `46` query; `31 55 BB` and unsolicited `46`
  reports are decoded inbound only and keep `dim` in sync. The device layer itself sends only `74` and `46`; the other VERIFIED opcodes are sent by the mode, clock, text, weather and countdown features (section 5). The value
  is stored on the device; the visible effect appeared after an Evo reboot (owner, 2026-10-06; #49, section 11).
- Power and lighting (#26): `onoff` off sends `45 01 RR GG BB BB 00 00 00 00 00` (the lighting colour and brightness unchanged, power byte
  `00`), and the panel goes dark. The app tracks power itself (section 3: d8 is not reliable); after off `46` d0 is `01`, so
  reports with that code are ignored until another known d0 appears. Every channel command powers the panel on, so "on"
  re-sends the mode from before off. The colour tile sends `45 01 RR GG BB BB 00 01 00 00 00` (effect 0, known
  brightness), the Flow action "Set lighting" the same plain colour (effect 0 since #69; the effects 1..4 exist on the device but are not offered). `46` d3..d5 syncs the colour tile. `74` also wakes the panel
  (section 3); the app therefore holds `dim` while off and sends it at the next power on (#62).
- Custom pages (#27; the action "Show visualization" was removed in #68): "Show custom page" sends `45 05`,
  waits for `45 55 05`, then `bd 17 PP` (PP 0..2, section 5.4; the page is only accepted while the custom channel is shown).
  `46` has no custom-page field (d0 `05` only confirms the channel), so the page is
  confirmed with the read `bd 17 ff` -> `bd 55 17 PP`. Never send PP `ff` as a page or 3..254.
- Homey's BLE write size is unknown, but 20-byte writes work (section 1.1).
