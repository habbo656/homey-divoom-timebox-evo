// Shared test rig for the controller tests: a real ConnectionManager on a MockTransport that simulates the Evo.
import { ConnectionManager } from '../../transport/ConnectionManager';
import type { ConnectionManagerOptions } from '../../transport/ConnectionManager';
import { MockTransport } from '../../transport/MockTransport';
import { opcodeOf, replyFrame, statusFrame } from '../../transport/__fixtures__/frames';
import { TimeboxController } from '../TimeboxController';
import type { Rgb } from '../../protocol/status';
import type { ChannelId } from '../channel';
import type { DeviceMessages, DeviceSurface, TimeboxControllerOptions } from '../TimeboxController';

export const MESSAGES: DeviceMessages = {
  unreachable: 'unreachable text',
  notTimebox: 'not a timebox text',
  notConnected: 'not connected text',
  notConfirmed: 'not confirmed text',
  textEmpty: 'text empty text',
  textTooLong: 'text too long {length}/{max}',
  countdownZero: 'countdown zero text',
};

export class FakeSurface implements DeviceSurface {
  dims: number[] = [];
  /** Every `setOnOff` call (tile write of `onoff`). */
  onoffs: boolean[] = [];
  /** Every `setLightColor` call (tile write of hue and saturation). */
  colors: { hue: number; saturation: number }[] = [];
  /** Every `saveClockColor` call (the persisted clock colour). */
  savedClockColors: Rgb[] = [];
  /** Every `saveShownClockStyle` call (the persisted style of "Show clock"; null = cleared). */
  savedShownStyles: (number | null)[] = [];
  /** Every `setChannel` (tile write) and `onChannelChanged` (trigger) call. */
  channels: ChannelId[] = [];
  channelChanges: ChannelId[] = [];
  /** Number of `onCountdownEnded` calls (the "countdown ended" trigger). */
  countdownEnds = 0;
  /** Number of `clearChannel` calls (tile write of null: the device shows cloud or visualizer). */
  channelClears = 0;
  /** Every availability/trigger call in order, e.g. `available`, `unavailable:<message>`, `online:true`. */
  calls: string[] = [];
  logs: string[] = [];
  /** The Homey time zone reported to the controller (change it to simulate a zone change). */
  zone = 'Europe/Berlin';
  errors: string[] = [];
  setDimImpl: (dim: number) => void | Promise<void> = () => undefined;
  setDim(dim: number) {
    this.dims.push(dim);
    return this.setDimImpl(dim);
  }
  setOnOff(on: boolean) {
    this.onoffs.push(on);
  }
  setLightColor(hue: number, saturation: number) {
    this.colors.push({ hue, saturation });
  }
  saveClockColor(color: Rgb) {
    this.savedClockColors.push(color);
  }
  saveShownClockStyle(style: number | null) {
    this.savedShownStyles.push(style);
  }
  setChannel(id: ChannelId) {
    this.channels.push(id);
  }
  clearChannel() {
    this.channelClears++;
  }
  onChannelChanged(id: ChannelId) {
    this.channelChanges.push(id);
  }
  onCountdownEnded() {
    this.countdownEnds++;
  }
  setAvailable() {
    this.calls.push('available');
  }
  setUnavailable(message: string) {
    this.calls.push(`unavailable:${message}`);
  }
  onOnlineChanged(online: boolean) {
    this.calls.push(`online:${online}`);
  }
  timeZone() {
    return this.zone;
  }
  log(message: string) {
    this.logs.push(message);
  }
  error(message: string) {
    this.errors.push(message);
  }
}

/**
 * Simulates the Evo: `74 BB` sets the brightness and reports it unsolicited (`46` and `31`), `45` switches the channel
 * and powers the panel on, except `45 01 … 00`, which is the off command (d0 `01`, power false; `power` is reported in d8)
 * (`45 01 RRGGBB …` also stores the colour, the full `45 00 …` the clock style and colour) and is answered with `45 55 NN`, `46` is
 * answered with the channel and colour of the state (d9, the last visualization, is a constant), `18` (time) is recorded in `times` (the 9-byte
 * payload) and acknowledged with `18 55` unless `ackTime` is false. `bd 17 PP` selects the custom page (stored in
 * `customPage`, no reply, as on the Evo) and `bd 17 ff` is answered with `bd 55 17 PP` unless `answerPage` is false.
 */
export function evo(t: MockTransport, initial = 50) {
  const state = {
    brightness: initial,
    channel: 0,
    /** The power byte of the last `45` command (d8 of `46`). */
    power: true,
    color: [0, 0, 0],
    /** Clock style (d15) and colour (d12..d14), set by `45 00 HH TT 01 WW EE CC RR GG BB`. */
    clockStyle: 0,
    clockColor: [0, 0, 0],
    /** The clock command is split into two BLE chunks: its green and blue bytes arrive in the next write. */
    clockPending: false,
    answer: true,
    ackTime: true,
    /** The custom page (0..2) set by `bd 17 PP`. */
    customPage: 0,
    answerPage: true,
    times: [] as number[][],
  };
  const status = () =>
    statusFrame(state.brightness, state.channel, {
      3: state.color[0],
      4: state.color[1],
      5: state.color[2],
      8: state.power ? 1 : 0,
      9: 3,
      12: state.clockColor[0],
      13: state.clockColor[1],
      14: state.clockColor[2],
      15: state.clockStyle,
    });
  t.autoReply = (w) => {
    const op = opcodeOf(w);
    if (state.clockPending && op === -1) {
      state.clockPending = false;
      state.clockColor[1] = w[0];
      state.clockColor[2] = w[1];
      return undefined;
    }
    if (op === 0x74) {
      state.brightness = w[12];
      return [status(), replyFrame(0x31, state.brightness)];
    }
    if (op === 0x45) {
      state.channel = w[12];
      state.power = !(w[12] === 0x01 && w[18] === 0x00);
      if (w[12] === 0x01) state.color = [w[13], w[14], w[15]];
      if (w[12] === 0x00 && w.length > 19) {
        state.clockStyle = w[14];
        state.clockColor = [w[19], 0, 0];
        state.clockPending = true;
      }
      return [replyFrame(0x45, state.channel)];
    }
    if (op === 0x18) {
      state.times.push(Array.from(w.subarray(11, 20)));
      return state.ackTime ? [replyFrame(0x18)] : undefined;
    }
    if (op === 0xbd && w[12] === 0x17) {
      if (w[13] !== 0xff) {
        state.customPage = w[13];
        return undefined;
      }
      return state.answerPage ? [replyFrame(0xbd, 0x17, state.customPage)] : undefined;
    }
    if (op === 0x46 && state.answer) return [status()];
    return undefined;
  };
  return state;
}

export interface Rig {
  t: MockTransport;
  m: ConnectionManager;
  surface: FakeSurface;
  c: TimeboxController;
  device: ReturnType<typeof evo>;
}

export function rig(
  link: ConnectionManagerOptions = {},
  opts: TimeboxControllerOptions = {},
  initialBrightness = 50,
): Rig {
  const t = new MockTransport();
  const device = evo(t, initialBrightness);
  const surface = new FakeSurface();
  const m = new ConnectionManager(t, { random: () => 0, ...link });
  const c = new TimeboxController(m, surface, MESSAGES, opts);
  return { t, m, surface, c, device };
}
