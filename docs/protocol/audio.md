# Audio evidence

_Evidence for [divoom-protocol.md](../divoom-protocol.md) sections 5.3 and 6; opcode rows and status stay there._

## 5.3 Audio: evidence

Earlier "no sound at all" results came from the Mac not actually streaming (HFP/default-device mix-up, section 1.3), not
from a broken speaker. When the owner paired the Evo and played audio, the speaker worked and the volume command
controlled it.

## 6 Audio summary: evidence

### 6.1 A2DP streaming (Mac → Evo): VERIFIED 2026-10-06

Measured with test tones from the Mac (`play`/sox) and the webcam microphone in front of the Evo (FFT peak and RMS).

| Aspect | Result |
|---|---|
| Profile | A2DP sink, 2 channels, 44.1 kHz on the Mac side (macOS also offers the Evo as a 16 kHz HFP input. Avoid it, see section 1.3) |
| Frequency range | Every test tone from 100 Hz to 14 kHz is reproduced at the right frequency (tone/noise 85–108 dB). Loudest around 0.5–2 kHz; weak below 250 Hz and above 8 kHz (small speaker plus webcam mic) |
| Stereo | Left-only and right-only both play at the same level, about half of both together: **mono speaker, L+R mixed** |
| Latency | Warm stream: ≈ 0.25–0.35 s later than the Mac's built-in speaker. Idle stream: ≈ 0.5–0.57 s, **and the first ~50 ms are cut off** (a 50 ms click was inaudible). Start a stream with silence before short sounds |
| Volume sync | **Bidirectional absolute volume (AVRCP):** Mac 100/50/25 % → Evo `09` = 15/8/4. BLE `08 0c` → Mac slider 76 %, `08 08` → 50 % |
| Display | Stays on the current channel while audio plays. The visualization channel `45 04 00` reacts to the streamed audio (spectrum bars) |
| BLE during streaming | `46`, `09` and `0b` keep working while A2DP plays (`0b` = `01`) |

### 6.2 What Homey can do

The Evo is an A2DP speaker. Audio comes from a phone or computer over Classic Bluetooth, which Homey cannot provide.
Over BLE, Homey can **set and read the volume** (`08`/`09`, 0..15, verified by measurement) and read whether audio is playing
(`0b`). Play/pause and next/previous (`0a`, `12`) do not control the A2DP source. Source modes, FM and the sound previews
had no audible effect. Useful Homey audio features are therefore limited to a volume capability (plus a "playing"
indicator). Because of the AVRCP sync, a volume set from Homey also moves the volume slider of the connected phone or
computer, and the other way round. Poll `09` or watch for unsolicited `09` frames to keep the capability in sync.
