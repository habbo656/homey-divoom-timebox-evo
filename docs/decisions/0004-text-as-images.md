# ADR 0004: Text is rendered in software and sent as images

**Status:** superseded by 0005 (native text, #28) · **Date:** 2026-10-06 · **Issue:** #5

**Context:** The upstream protocol notes document no text opcode for the Timebox Evo, and no opcode is guessed.
The device does document a 16x16 image command (`0x44`, `setImage`).

**Decision:**
- Text is rendered with a built-in 5x7 bitmap font into 16x16 RGB frames and sent as images (`setImage`).
  Longer text is scrolled as successive image frames (not the animation command `0x49`, that is #8).
  Frame interval is a named constant (cap ~5 fps), BLE throughput is unverified.
- Previous-view tracking: the app cannot read the device's current view. The app remembers the last view it set
  (`setView`/`setClockView`) in `src/protocol/viewState.ts` and re-sends it after the text. The flow arg `after`
  is `previous` (default), `clock` or `stay`. If the app never set a view, `previous` falls back to the clock.
  Views changed by the physical device or the Divoom app are not known. Nothing feeds the tracker yet, so `previous`
  falls back to the clock until view actions (#6/#7) land.
- Font: the classic 5x7 column-major ASCII table (0x20-0x7E), a widely reproduced table of the
  HD44780/"font5x7" family, transcribed into `src/protocol/font.ts`. Origin/licence not independently verified; replace if
  needed. No third-party code or font file is included. Non-ASCII input is transliterated through a small table (ae/oe/ue/ss etc.), anything else becomes `?`.

**Consequences:** Works without an unknown opcode; text quality is limited to the 5x7 ASCII font; scrolling smoothness
depends on BLE write latency (real duration drifts longer than requested). A ~56-byte frame exceeds the default
20-byte ATT payload; single-write delivery is unverified, chunked writes are the first suspect if nothing shows. If a real text opcode is found, it can replace the renderer behind `showText`.

_Note: the files named above (`viewState.ts`, `font.ts`) were removed in the rebuild (#18); this ADR is kept for history only._
