# ADR 0005: Rebuild the app on the verified protocol

**Status:** accepted · **Date:** 2026-10-06 · **Supersedes:** 0004 · **Accepts:** 0002

**Context:** Hardware research (#5, `docs/divoom-protocol.md`) showed that the prototype's core assumptions were wrong:
over BLE the Evo ignores the SPP frame and needs the `FE EF AA 55` envelope with a sequence counter, it has native
scrolling text, a device-side animation command, a readable status (`46`) and no input validation. The prototype's
transport, text renderer, view tracker and diagnostics were built around the missing knowledge.

**Decision:**
- Rebuild the app code from scratch (owner decision 2026-10-06), keeping tooling, CI, scripts and docs (#18).
- Transport: direct BLE GATT from Homey (ADR 0002 accepted), envelope + seq counter, 20-byte writes, notifications
  always drained, liveness via `46` polling.
- State is read from the device (`46`) instead of tracked in the app.
- Text uses the native text command (`6e`/`86`/`6c`); the software font renderer is dropped (ADR 0004 superseded).
- Device-first Homey surface: capabilities and device settings for state, Flow cards for actions and events.
  Device class `other`.
- Only VERIFIED opcodes are used; every argument is validated before sending.

**Consequences:** Work restarts at version 0.2.0 (`docs/versioning.md`); the plan is in `docs/roadmap.md`.
Closed issues #4/#5 stay as history; their code is removed in #18.
