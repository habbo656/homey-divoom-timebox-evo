# ADR 0008: Native text is an overlay, not a mode

**Status:** accepted · **Date:** 2026-10-07 · **Relates to:** 0005 (native text instead of a software renderer)

**Context:** The Evo scrolls text itself (`6e` / `86` / `6c`, protocol section 5.5). Measured in #28: the text runs on top of
whatever channel is shown, `46` d0 keeps reporting that channel, a channel command or power off ends the text on the
device, `6e 00` ends it and brings the underlying channel back, a new sequence replaces a running text, and a text
lights a panel that was off. The device shows at most 64 UTF-16 units and draws emoji as a filled box.

**Decision:**
- Text is a Flow action ("Show text" with colours, speed slow / normal / fast and a duration, "Stop text"), not a mode: no
  tile entry, no `timebox_channel` value, no trigger. The mode tile keeps showing the mode under the text.
- The app does not track the text on the device beyond a timer: a duration ends it with `6e 00`, a mode change or power off
  only makes the app forget it (the device ends it itself). "Stop text" always sends `6e 00`.
- Showing text on a panel that is off turns it on first (the previous mode returns) and the panel stays on afterwards.
- Input is cleaned in the app (`prepareText`: NFC, strip emoji and other non-BMP characters, controls to a space); a text
  that is empty after cleaning or longer than 64 units fails the Flow (see the amendment below).
- Rejected: a text mode on the tile (the device cannot report it), software rendering (ADR 0004, superseded), a `6e 00`
  before every mode change (the device does it).

**Consequences:** A text that still runs after an app restart is unknown to the app and ends with "Stop text" or any
mode change. Speed is the three measured levels, not a free number. The device font decides how text looks (umlauts,
euro sign and CJK are fine).

**Amended 2026-10-07 (#107, UAT v0.4.0):** the first version cut a text longer than 64 units silently. The owner rejected
that in UAT (UAT-6): a Flow that gets more text than the Timebox can show should fail visibly, not show a different text.
Now a text with more than 64 UTF-16 units after cleaning (emoji are removed first and do not count) fails the action with
the localised error `device.error.text_too_long` ("The text is too long: N characters. The TimeBox shows at most 64
characters ..."); nothing is sent, a running text stays and the display is unchanged.
