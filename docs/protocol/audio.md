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
computer, and the other way round. Poll `09` to keep the capability in sync; unsolicited `09` frames after `08` were not observed (section 6.3). Unsolicited `09` frames on a volume change at the phone are still unmeasured.

### 6.3 Volume and play status with the panel lit and off: VERIFIED 2026-11-07 (#4)

Hardware research for #4 (Mac BLE probe, webcam photos, nothing else holding the link). Baseline: lighting mode, red
`ff0000`, brightness `32`, panel on, volume `05`, play status `00`. All changed values were restored (volume `05`, lighting
as before).

| Probe | Result |
|---|---|
| `09` and `0b` while the panel is off (twice each, 1 s apart) | replies `09 55 03`, `0b 55 00`, no other frame. **They do not light the panel**: photo dark, `46` d8 stays `00`. The status poll can read both while the panel is off |
| `08 03` on the lit panel | no reply, no unsolicited frame within 3.5 s, also none for a repeated `08 03`. **No overlay or visible change** on the panel (photos 0.5 s and 3.5 s). `46` unchanged (d0 `01`, d8 `01`) |
| `08 05` while the panel is off | no reply, no unsolicited frame within 6 s. **The panel lights within 1 s** with the previous lighting (red, whole panel; first photo at 1 s, so it may be earlier). `46` d8 reads `01`, d0 `01`, colour and brightness unchanged |
| `09` sent right after `08` (no wait) | returns the new value (`08 03` then `09` gave `03`, `08 05` then `09` gave `05`): the read-back delay is below about 0.1 s |
| `45 01 … 00` / `45 01 … 01` (lighting off / on) | three unsolicited frames after each, see [status.md](status.md#unsolicited-frames-after-a-lighting-power-change-4) |

So there is no echo or push after `08`: the `09` read-back is the only confirm, and no echo filter is needed. `08` cannot
change the volume without lighting a panel that is off. App behaviour (owner decision, option b): the app sends `08`
anyway and the self-wake check of the next poll switches the panel off again (up to 60 s lit), see
[architecture/audio.md](../architecture/audio.md).
