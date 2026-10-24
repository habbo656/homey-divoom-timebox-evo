# 0002 — Transport: direct BLE first, gateway as fallback

Status: **Accepted** (2026-10-06): BLE GATT verified on hardware with the `FE EF AA 55` envelope (`docs/divoom-protocol.md` 1.2, ADR 0005).

## Context
The Timebox Evo may speak classic Bluetooth (SPP) only, which Homey's BLE API (`homey.ble`)
cannot reach. Agents have no hardware, so this cannot be verified in CI.

## Decision
Implement `BleTransport` (behind the `Transport` interface) on `homey.ble` first. The device is reachable over
BLE GATT (advertised as `TimeBox-Evo-audio`, ISSC transparent UART service
`49535343-fe7d-4ae5-8fa9-9fafd205e455`); verified UUIDs are in `docs/divoom-protocol.md`.
Owner decision: stay on BLE GATT, no transport change.

## Consequences
- The owner paired the Evo and changed brightness on a real Homey Pro (2026-10-06): this ADR is *Accepted*; the verified
  UUIDs are in `docs/divoom-protocol.md`. Hardware results of #21/#22: reconnect after a drop in ~4 s, a 10 min hold with
  10 polls and 0 disconnects, unavailable after the 30 s grace when the Evo is off, back within ~1 min.
- If the device is not discoverable via BLE: record the no-go here and re-plan around a gateway
  (the `Transport` interface keeps the rest of the app unchanged).
