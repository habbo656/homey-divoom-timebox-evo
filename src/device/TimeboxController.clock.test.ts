import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { opcodeOf, statusFrame } from '../transport/__fixtures__/frames';
import { DEFAULT_CLOCK_COLOR, DEFAULT_CLOCK_SETTINGS } from './clock';
import type { ClockSettings } from './clock';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { CHANNEL_CONFIRM_TIMEOUT_MS, CLOCK_RESEND_DELAY_MS } from './TimeboxController';
import type { TimeboxControllerOptions } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);

/** A started controller whose first status reply (channel `initialChannel`) has been processed. */
async function online(initialChannel = 0, opts: TimeboxControllerOptions = {}): Promise<Rig> {
  const r = rig({}, opts);
  r.device.channel = initialChannel;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  return r;
}

/** The payloads (hex) written since the last reset: chunks are joined back into envelopes. */
function payloads(r: Rig): string[] {
  const all = Uint8Array.from(r.t.writes.flatMap((w) => [...w]));
  const out: string[] = [];
  for (let at = 0; at < all.length;) {
    const len = all[at + 4] | (all[at + 5] << 8);
    out.push(toHex(all.subarray(at + 11, at + 6 + len - 2)));
    at += 6 + len;
  }
  return out;
}

const BOXED: ClockSettings = { style: 2, weather: false, temperature: true, calendar: false, animations: false };
const GREEN = { r: 0, g: 255, b: 0 };
/** Options of a controller with the boxed settings and a green stored clock colour. */
const GREEN_BOXED = { clockSettings: BOXED, clockColor: GREEN };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clock face on the channel switch', () => {
  it('sends the default face when none was given and confirms style and colour', async () => {
    const r = await online(5);
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    expect(payloads(r)).toEqual(['26 00', '45 00 01 00 01 00 00 00 ff ff ff', '46']);
    expect(r.surface.logs).toContain('[device] channel confirmed: clock');
    expect(r.surface.logs).toContain('[device] clock face confirmed: style full_screen colour #FFFFFF');
  });

  it('sends the face of the option', async () => {
    const r = await online(4, GREEN_BOXED);
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 02 01 00 01 00 00 ff 00']);
    expect(r.surface.logs).toContain('[device] channel -> clock: 45 00 01 02 01 00 01 00 00 ff 00');
    expect(r.surface.logs).toContain('[device] clock face confirmed: style boxed colour #00FF00');
  });

  it('logs a mismatch of style and colour (log only, no error)', async () => {
    const r = await online(4, GREEN_BOXED);
    // The device keeps style 9 and white: it answers the query with that state.
    r.t.autoReply = (w) =>
      opcodeOf(w) === 0x46 ? [statusFrame(50, 0, { 12: 255, 13: 255, 14: 255, 15: 9 })] : undefined;
    await r.c.setChannel('clock');
    expect(r.surface.logs).toContain(
      '[device] clock face mismatch: device style 9 colour #FFFFFF, requested style boxed colour #00FF00',
    );
    expect(r.surface.errors).toEqual([]);
  });

  it('logs no clock face result for the other channels', async () => {
    const r = await online(0);
    await r.c.setChannel('custom');
    expect(r.surface.logs.filter((l) => l.includes('clock face'))).toEqual([]);
  });
});

describe('setClockSettings', () => {
  it('#70: the clock frame always carries HH 01 (24 h), whatever the settings', async () => {
    const r = await online(0, { clockColor: GREEN });
    r.t.writes.length = 0;
    await r.c.setClockSettings(BOXED);
    expect(
      payloads(r)
        .find((p) => p.startsWith('45 00'))
        ?.startsWith('45 00 01 '),
    ).toBe(true);
  });

  it('while the clock is shown: sends the new face at once, no trigger, no tile write', async () => {
    const r = await online(0, { clockColor: GREEN });
    r.surface.channels.length = 0;
    r.t.writes.length = 0;
    await r.c.setClockSettings(BOXED);
    expect(payloads(r)).toEqual(['26 00', '45 00 01 02 01 00 01 00 00 ff 00', '46']);
    expect(r.surface.logs).toContain('[device] clock settings applied');
    expect(r.surface.logs).toContain('[device] clock face confirmed: style boxed colour #00FF00');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.c.getChannel()).toBe('clock');
  });

  it('on another channel: sends nothing, keeps the channel and applies the face on the next clock selection', async () => {
    const r = await online(1, { clockColor: GREEN });
    r.t.writes.length = 0;
    await r.c.setClockSettings(BOXED);
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toContain('[device] clock settings saved, applied when the clock is shown');
    expect(r.c.getChannel()).toBe('lighting');
    await r.c.setChannel('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 02 01 00 01 00 00 ff 00']);
  });

  it('while a switch away from the clock is in flight: only stores the face, the switch is not superseded', async () => {
    const r = await online(0, { clockColor: GREEN });
    r.t.writes.length = 0;
    const away = r.c.setChannel('lighting');
    await r.c.setClockSettings(BOXED);
    await away;
    expect(r.surface.logs).toContain('[device] clock settings saved, applied when the clock is shown');
    expect(r.surface.logs).not.toContain('[device] channel lighting superseded by a newer change');
    expect(payloads(r).filter((p) => p.startsWith('45 00'))).toEqual([]);
    expect(r.surface.logs).toContain('[device] channel confirmed: lighting');
    await r.c.setChannel('clock');
    expect(payloads(r).at(-2)).toBe('45 00 01 02 01 00 01 00 00 ff 00');
  });

  describe('while a switch to the clock is in flight (#60)', () => {
    const BOXED_FRAME = '45 00 01 02 01 00 01 00 00 ff 00';
    const DOTS: ClockSettings = { ...BOXED, style: 3 };
    const clockFrames = (r: Rig) => payloads(r).filter((p) => p.startsWith('45 00'));
    const notStored = '[device] clock settings saved, applied when the clock is shown';

    it('two quick saves with the clock shown: the second face is the one on the device', async () => {
      const r = await online(0, { clockColor: GREEN });
      r.t.writes.length = 0;
      const first = r.c.setClockSettings(BOXED);
      const second = r.c.setClockSettings(DOTS);
      await Promise.all([first, second]);
      expect(clockFrames(r)).toEqual([BOXED_FRAME, '45 00 01 03 01 00 01 00 00 ff 00']);
      expect(r.device.clockStyle).toBe(3);
      expect(r.surface.logs).toContain('[device] clock settings superseded by a newer change');
      expect(r.surface.logs).toContain('[device] clock settings applied');
      expect(r.surface.logs).not.toContain(notStored);
    });

    it('a save in the same tick as a switch to the clock applies the new face', async () => {
      const r = await online(1, { clockColor: GREEN });
      r.t.writes.length = 0;
      const sw = r.c.setChannel('clock');
      const save = r.c.setClockSettings(BOXED);
      await Promise.all([sw, save]);
      expect(clockFrames(r).at(-1)).toBe(BOXED_FRAME);
      expect(r.device.clockStyle).toBe(2);
      expect(r.surface.channelChanges).toEqual(['clock']);
      expect(r.surface.logs).toContain('[device] clock settings applied');
      expect(r.surface.logs).not.toContain(notStored);
      expect(r.surface.errors).toEqual([]);
    });

    it('a save during the confirm wait of the switch applies the new face', async () => {
      const r = await online(1, { clockColor: GREEN });
      r.device.answer = false;
      r.t.writes.length = 0;
      const sw = r.c.setChannel('clock');
      await flush(); // the clock frame is out, the `46` confirm is awaited
      expect(clockFrames(r)).toHaveLength(1);
      const save = r.c.setClockSettings(BOXED);
      await flush(); // the new frame is out, both `46` confirms are awaited (the first reply goes to the older one)
      expect(clockFrames(r)).toHaveLength(2);
      for (let i = 0; i < 2; i++) r.t.emitData(statusFrame(50, 0, { 12: 0, 13: 255, 14: 0, 15: 2 }));
      await expect(sw).resolves.toBeUndefined();
      await save;
      expect(clockFrames(r)).toHaveLength(2);
      expect(clockFrames(r).at(-1)).toBe(BOXED_FRAME);
      expect(r.device.clockStyle).toBe(2);
      expect(r.surface.logs).toContain('[device] clock settings applied');
      expect(r.surface.logs).not.toContain(notStored);
    });

    it('a save during "Show clock" keeps its colour and drops its style', async () => {
      const r = await online(1);
      r.t.writes.length = 0;
      r.surface.channels.length = 0;
      r.surface.colors.length = 0;
      const show = r.c.showClock(3, GREEN);
      const save = r.c.setClockSettings(BOXED);
      await save;
      await expect(show).resolves.toBe(false); // superseded by the save
      expect(clockFrames(r)).toEqual(['45 00 01 03 01 00 00 00 00 ff 00', BOXED_FRAME]);
      expect(r.device.clockStyle).toBe(2);
      expect(r.surface.savedClockColors).toEqual([GREEN]);
      expect(r.surface.savedShownStyles.at(-1)).toBeNull();
      // the superseded "Show clock" wrote no tile: the save owns the mode tile and the colour tile
      expect(r.surface.channels).toEqual(['clock']);
      expect(r.surface.colors).toHaveLength(1);
      expect(r.surface.colors[0].hue).toBeCloseTo(1 / 3, 10);
      expect(r.surface.colors[0].saturation).toBe(1);
      await r.c.setChannel('lighting');
      r.t.writes.length = 0;
      await r.c.setChannel('clock');
      expect(clockFrames(r)).toEqual([BOXED_FRAME]); // the settings style, no shown style left
    });

    it('a save that supersedes "Show clock" and is not confirmed still writes the mode and colour tile', async () => {
      const r = await online(1);
      r.device.answer = false;
      r.t.writes.length = 0;
      r.surface.channels.length = 0;
      r.surface.colors.length = 0;
      const show = r.c.showClock(3, GREEN);
      const save = r.c.setClockSettings(BOXED);
      await vi.advanceTimersByTimeAsync(CHANNEL_CONFIRM_TIMEOUT_MS);
      await expect(show).resolves.toBe(false);
      await save;
      expect(r.surface.logs).toContain('[device] clock settings not applied: not confirmed text');
      expect(r.surface.channels).toEqual(['clock']);
      expect(r.surface.colors).toHaveLength(1);
      expect(r.surface.colors[0].hue).toBeCloseTo(1 / 3, 10);
    });

    it('a save during a tile colour change keeps the colour; black writes no colour tile', async () => {
      const r = await online(0, { clockColor: GREEN });
      r.surface.colors.length = 0;
      const tile = r.c.setTileColor(2 / 3, 1); // blue
      const save = r.c.setClockSettings(BOXED);
      await save;
      await expect(tile).resolves.toBeNull();
      expect(clockFrames(r).at(-1)).toBe('45 00 01 02 01 00 01 00 00 00 ff');
      expect(r.surface.colors.at(-1)?.hue).toBeCloseTo(2 / 3, 10);
      const black = await online(0, { clockColor: { r: 0, g: 0, b: 0 } });
      black.surface.colors.length = 0;
      const show = black.c.showClock(3, { r: 0, g: 0, b: 0 });
      await black.c.setClockSettings(BOXED);
      await show;
      expect(black.surface.colors).toEqual([]);
      expect(black.surface.channels.at(-1)).toBe('clock');
    });

    it('a save during a power-off is only stored: no clock frame, the panel stays off', async () => {
      const r = await online(0, { clockColor: GREEN });
      r.t.writes.length = 0;
      const off = r.c.setPower(false);
      const save = r.c.setClockSettings(BOXED);
      await Promise.all([off, save]);
      expect(clockFrames(r)).toEqual([]);
      expect(r.surface.logs).toContain(notStored);
      expect(r.device.power).toBe(false);
      expect(r.surface.logs).not.toContain('[device] power off superseded by a newer change');
    });

    it('a save during the power-on restore of the clock applies the new face and turns on once', async () => {
      const r = await online(0, { clockColor: GREEN });
      await r.c.setPower(false);
      r.t.writes.length = 0;
      r.surface.onoffs.length = 0;
      const on = r.c.setPower(true);
      const save = r.c.setClockSettings(BOXED);
      await Promise.all([on, save]);
      expect(clockFrames(r).at(-1)).toBe(BOXED_FRAME);
      expect(r.device.power).toBe(true);
      expect(r.surface.onoffs).toEqual([true]);
      expect(r.surface.logs).toContain('[device] clock settings applied');
      expect(r.surface.logs).not.toContain(notStored);
    });
  });

  it('logs superseded instead of applied when a newer switch overtakes the apply', async () => {
    const r = await online(0);
    const apply = r.c.setClockSettings(BOXED);
    const away = r.c.setChannel('custom');
    await Promise.all([apply, away]);
    expect(r.surface.logs).toContain('[device] clock settings superseded by a newer change');
    expect(r.surface.logs).not.toContain('[device] clock settings applied');
  });

  it('before start and after stop: never rejects and writes nothing', async () => {
    const early = rig();
    await expect(early.c.setClockSettings(BOXED)).resolves.toBeUndefined();
    expect(early.t.writes).toHaveLength(0);
    expect(early.surface.logs).toContain('[device] clock settings saved, applied when the clock is shown');

    const r = await online(0);
    await r.c.stop();
    r.t.writes.length = 0;
    await expect(r.c.setClockSettings(BOXED)).resolves.toBeUndefined();
    expect(r.t.writes).toHaveLength(0);
  });

  it('logs a failure instead of rejecting', async () => {
    const r = await online(0);
    r.t.writeErrors.push(new Error('write failed'));
    await expect(r.c.setClockSettings(BOXED)).resolves.toBeUndefined();
    expect(r.surface.logs.some((l) => l.startsWith('[device] clock settings not applied: '))).toBe(true);
    expect(r.surface.logs).not.toContain('[device] clock settings applied');
  });
});

describe('showClock', () => {
  it('switches to the clock with this style and colour, 12/24 h and flags from the settings, and confirms', async () => {
    const r = await online(1, GREEN_BOXED);
    r.t.writes.length = 0;
    await r.c.showClock(3, { r: 0, g: 0, b: 255 });
    expect(payloads(r)).toEqual(['26 00', '45 00 01 03 01 00 01 00 00 00 ff', '46']);
    expect(r.surface.logs).toContain('[device] clock face confirmed: style analog_square colour #0000FF');
    expect(r.surface.channelChanges).toEqual(['clock']);
  });

  it('C13: stores the colour and writes the tile; the style is one-shot, the colour stays', async () => {
    const r = await online(1, GREEN_BOXED);
    r.surface.colors.length = 0;
    await r.c.showClock(3, { r: 0, g: 0, b: 255 });
    expect(r.surface.savedClockColors).toEqual([{ r: 0, g: 0, b: 255 }]);
    expect(r.surface.colors).toHaveLength(1);
    expect(r.surface.colors[0].hue).toBeCloseTo(2 / 3, 10);
    expect(r.surface.colors[0].saturation).toBe(1);
    await r.c.setChannel('lighting');
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 02 01 00 01 00 00 00 ff']);
  });

  it('C13: black is stored and sent, the tile is not written', async () => {
    const r = await online(1, GREEN_BOXED);
    r.surface.colors.length = 0;
    r.t.writes.length = 0;
    await r.c.showClock(2, { r: 0, g: 0, b: 0 });
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 02 01 00 01 00 00 00 00']);
    expect(r.surface.savedClockColors).toEqual([{ r: 0, g: 0, b: 0 }]);
    expect(r.surface.colors).toEqual([]);
  });

  it('does not store or write the colour again when it is unchanged', async () => {
    const r = await online(1, GREEN_BOXED);
    await r.c.showClock(3, GREEN);
    expect(r.surface.savedClockColors).toEqual([]);
  });

  it('rejects an invalid style or colour before anything is written, and a stopped controller readably', async () => {
    const r = await online(1);
    r.t.writes.length = 0;
    await expect(r.c.showClock(7, DEFAULT_CLOCK_COLOR)).rejects.toThrow(RangeError);
    await expect(r.c.showClock(2, { r: 256, g: 0, b: 0 })).rejects.toThrow(RangeError);
    expect(r.t.writes).toHaveLength(0);
    // an invalid request does not supersede a pending switch
    const pending = r.c.setChannel('custom');
    await expect(r.c.showClock(7, DEFAULT_CLOCK_COLOR)).rejects.toThrow(RangeError);
    await pending;
    expect(r.surface.logs).toContain('[device] channel confirmed: custom');
    expect(r.surface.logs).not.toContain('[device] channel custom superseded by a newer change');
    await r.c.stop();
    await expect(r.c.showClock(2, DEFAULT_CLOCK_COLOR)).rejects.toThrow('not connected text');
  });
});

describe('clock animation pages (#106)', () => {
  const ON: ClockSettings = { ...DEFAULT_CLOCK_SETTINGS, animations: true };
  const hotLogs = (r: Rig) => r.surface.logs.filter((l) => l.includes('clock animations'));

  it('default off: 26 00 goes immediately before the clock frame, then the confirm', async () => {
    const r = await online(1);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.setChannel('clock');
    expect(payloads(r)).toEqual(['26 00', '45 00 01 00 01 00 00 00 ff ff ff', '46']);
    expect(hotLogs(r)).toEqual(['[device] clock animations -> off: 26 00 (switch)']);
  });

  it('on: 26 01 goes ahead of the clock frame', async () => {
    const r = await online(1, { clockSettings: ON });
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.setChannel('clock');
    expect(payloads(r)).toEqual(['26 01', '45 00 01 00 01 00 00 00 ff ff ff', '46']);
    expect(hotLogs(r)).toEqual(['[device] clock animations -> on: 26 01 (switch)']);
  });

  it('"Show clock" sends it too, with the setting of the face', async () => {
    const r = await online(1, { clockSettings: ON });
    r.t.writes.length = 0;
    await r.c.showClock(2, GREEN);
    expect(payloads(r).slice(0, 2)).toEqual(['26 01', '45 00 01 02 01 00 00 00 00 ff 00']);
  });

  it('a change of the setting while the clock is shown sends the flag and the frame at once', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    await r.c.setClockSettings(ON);
    expect(payloads(r)).toEqual(['26 01', '45 00 01 00 01 00 00 00 ff ff ff', '46']);
    r.t.writes.length = 0;
    await r.c.setClockSettings(DEFAULT_CLOCK_SETTINGS);
    expect(payloads(r)).toEqual(['26 00', '45 00 01 00 01 00 00 00 ff ff ff', '46']);
  });

  it('a change of the setting on another channel sends nothing; the next clock switch carries it', async () => {
    const r = await online(1);
    r.t.writes.length = 0;
    await r.c.setClockSettings(ON);
    expect(payloads(r)).toEqual([]);
    await r.c.setChannel('clock');
    expect(payloads(r)[0]).toBe('26 01');
  });

  it('lighting and custom never send it', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    await r.c.setChannel('custom');
    await r.c.showLighting({ r: 0, g: 255, b: 0 });
    expect(payloads(r).filter((p) => p.startsWith('26'))).toEqual([]);
  });

  it('a failing 26 is logged and the clock frame is still sent', async () => {
    const r = await online(1);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    const send = r.m.send.bind(r.m);
    const spy = vi.spyOn(r.m, 'send').mockRejectedValueOnce(new Error('write failed')).mockImplementation(send);
    await r.c.setChannel('clock');
    expect(spy).toHaveBeenCalledTimes(2); // 26 (failed), the clock frame
    expect(r.surface.logs.some((l) => l.startsWith('[device] clock animations not set: '))).toBe(true);
    expect(r.surface.logs).toContain('[device] clock animations not set: write failed');
    expect(payloads(r)).toEqual(['45 00 01 00 01 00 00 00 ff ff ff', '46']);
    expect(r.surface.logs.filter((l) => l.includes('animations ->'))).toEqual([]);
  });

  it('session start with the clock shown and the panel on: sets it once (connect)', async () => {
    const r = rig({}, { clockSettings: ON });
    r.device.channel = 0;
    r.c.start();
    await flush();
    expect(payloads(r).filter((p) => p.startsWith('26'))).toEqual(['26 01']);
    expect(hotLogs(r)).toEqual(['[device] clock animations -> on: 26 01 (connect)']);
  });

  it.each([
    ['lighting', 1],
    ['cloud', 2],
    ['visualizer', 4],
    ['custom', 5],
    ['an unknown mode', 3],
  ])(
    'session start in %s sends nothing (the effect of 26 was only measured in clock, lighting and off)',
    async (_n, code) => {
      const r = rig({}, { clockSettings: ON });
      r.device.channel = code;
      r.c.start();
      await flush();
      expect(r.m.state).toBe('connected');
      expect(payloads(r).filter((p) => p.startsWith('26'))).toEqual([]);
      expect(hotLogs(r)).toEqual([]);
    },
  );

  it('session start with the panel off sends nothing (the next clock switch sets it)', async () => {
    const r = rig({}, { powerOn: false }, 50);
    r.c.start();
    await flush();
    expect(payloads(r).filter((p) => p.startsWith('26'))).toEqual([]);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 00 01 00 00 00 ff ff ff']);
  });

  it('the small clock re-send does not repeat it', async () => {
    const r = await online(1, { clockSettings: { ...ON, style: 6 }, clockColor: GREEN });
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    await vi.advanceTimersByTimeAsync(CLOCK_RESEND_DELAY_MS + 100);
    expect(payloads(r).filter((p) => p.startsWith('26'))).toEqual(['26 01']);
    expect(payloads(r).filter((p) => p.startsWith('45 00'))).toHaveLength(2);
  });
});

describe('small clock re-send (#88)', () => {
  const SMALL: ClockSettings = { style: 6, weather: false, temperature: false, calendar: false, animations: false };
  const SMALL_OPTS = { clockSettings: SMALL, clockColor: GREEN };
  const SMALL_FRAME = '45 00 01 06 01 00 00 00 00 ff 00';
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const clockFrames = (r: Rig) => payloads(r).filter((p) => p.startsWith('45 00'));
  const resendLogs = (r: Rig) =>
    r.surface.logs.filter((l) => l.includes('clock face re-send') || l.includes('re-sent'));
  /** Pending resend written once and nothing more for a long time. */
  const quiet = async (r: Rig) => {
    await advance(10_000);
    return clockFrames(r);
  };

  it('1: resends the identical frame once after 1.5 s when switching from lighting; the surface is untouched', async () => {
    const r = await online(1, SMALL_OPTS);
    r.t.writes.length = 0;
    await r.c.showClock(6, GREEN);
    expect(clockFrames(r)).toEqual([SMALL_FRAME]);
    const surface = JSON.stringify([r.surface.channels, r.surface.channelChanges, r.surface.colors, r.surface.onoffs]);
    const saved = JSON.stringify([r.surface.savedClockColors, r.surface.savedShownStyles]);
    await advance(1_499);
    expect(clockFrames(r)).toEqual([SMALL_FRAME]);
    await advance(1);
    expect(clockFrames(r)).toEqual([SMALL_FRAME, SMALL_FRAME]);
    expect(r.surface.logs).toContain(`[device] clock face re-sent (small from lighting): ${SMALL_FRAME}`);
    expect(await quiet(r)).toEqual([SMALL_FRAME, SMALL_FRAME]);
    expect(JSON.stringify([r.surface.channels, r.surface.channelChanges, r.surface.colors, r.surface.onoffs])).toBe(
      surface,
    );
    expect(JSON.stringify([r.surface.savedClockColors, r.surface.savedShownStyles])).toBe(saved);
    expect(r.surface.errors).toEqual([]);
  });

  it('1: the timer is the exported default and the option changes it', async () => {
    const r = await online(1, { ...SMALL_OPTS, clockResendDelayMs: 200 });
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    await advance(199);
    expect(clockFrames(r)).toHaveLength(1);
    await advance(1);
    expect(clockFrames(r)).toHaveLength(2);
    expect(CLOCK_RESEND_DELAY_MS).toBe(1_500);
  });

  it('2: resends after "Show clock" from off, and logs off as the origin', async () => {
    const r = await online(1, SMALL_OPTS);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.showClock(6, GREEN);
    await advance(1_500);
    expect(clockFrames(r)).toEqual([SMALL_FRAME, SMALL_FRAME]);
    expect(r.surface.logs).toContain(`[device] clock face re-sent (small from off): ${SMALL_FRAME}`);
  });

  it('3: resends after the power-on restore of the small clock', async () => {
    const r = await online(0, SMALL_OPTS);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(clockFrames(r)).toEqual([SMALL_FRAME]);
    await advance(1_500);
    expect(clockFrames(r)).toEqual([SMALL_FRAME, SMALL_FRAME]);
    expect(r.surface.logs).toContain(`[device] clock face re-sent (small from off): ${SMALL_FRAME}`);
  });

  it('4: no resend when switching from another clock face', async () => {
    const r = await online(0, SMALL_OPTS);
    r.t.writes.length = 0;
    await r.c.showClock(6, { r: 0, g: 0, b: 255 });
    expect(await quiet(r)).toHaveLength(1);
    expect(resendLogs(r)).toEqual([]);
  });

  it('5: a mode switch with the setting small resends, also before any status', async () => {
    const r = await online(1, SMALL_OPTS);
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    await advance(1_500);
    expect(clockFrames(r)).toEqual([SMALL_FRAME, SMALL_FRAME]);

    // no status of this run yet: the link is up (stored channel lighting), the known channel is not known
    const early = rig({}, SMALL_OPTS);
    early.device.answer = false;
    early.c.start();
    await flush();
    early.t.writes.length = 0;
    const entering = early.c.setChannel('clock');
    const entered = expect(entering).rejects.toThrow('not confirmed text');
    await advance(5_000); // the unanswered confirm times out
    await entered;
    await advance(1_500);
    expect(clockFrames(early)).toEqual([SMALL_FRAME, SMALL_FRAME]);
    expect(early.surface.logs).toContain(`[device] clock face re-sent (small from unknown): ${SMALL_FRAME}`);
  });

  it('5: a device in cloud or visualizer mode logs that mode as the origin', async () => {
    const r = await online(2, SMALL_OPTS);
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    await advance(1_500);
    expect(r.surface.logs).toContain(`[device] clock face re-sent (small from cloud): ${SMALL_FRAME}`);
  });

  it('6: no resend for the other styles', async () => {
    const r = await online(1, { clockColor: GREEN });
    for (const style of [0, 1, 2, 3, 4, 5]) {
      await r.c.setChannel('lighting');
      r.t.writes.length = 0;
      await r.c.showClock(style, GREEN);
      expect(await quiet(r)).toHaveLength(1);
    }
    expect(resendLogs(r)).toEqual([]);
  });

  it('7: a newer lighting, mode switch, "Show clock" or power off cancels the resend', async () => {
    const newer: [string, (r: Rig) => Promise<unknown>][] = [
      ['lighting', (r) => r.c.showLighting({ r: 255, g: 0, b: 0 })],
      ['mode switch', (r) => r.c.setChannel('custom')],
      ['show clock', (r) => r.c.showClock(2, GREEN)],
      ['power off', (r) => r.c.setPower(false)],
    ];
    for (const [name, act] of newer) {
      const r = await online(1, SMALL_OPTS);
      await r.c.showClock(6, GREEN);
      await advance(1_000);
      await act(r);
      r.t.writes.length = 0;
      await advance(10_000);
      expect(clockFrames(r), name).toEqual([]);
      expect(resendLogs(r), name).toEqual([]);
    }
  });

  it('8: a device status in the gap that shows another mode skips the resend', async () => {
    const r = await online(1, SMALL_OPTS);
    await r.c.showClock(6, GREEN);
    r.t.writes.length = 0;
    r.t.emitData(statusFrame(50, 1));
    await advance(1_500);
    expect(clockFrames(r)).toEqual([]);
    expect(r.surface.logs).toContain('[device] clock face re-send skipped: mode changed');
    expect(r.surface.logs.some((l) => l.includes('re-sent'))).toBe(false);
  });

  it('9: stop cancels it silently', async () => {
    const r = await online(1, SMALL_OPTS);
    await r.c.showClock(6, GREEN);
    await r.c.stop();
    r.t.writes.length = 0;
    await advance(10_000);
    expect(r.t.writes).toHaveLength(0);
    expect(resendLogs(r)).toEqual([]);
  });

  it('9: a dropped link skips the resend', async () => {
    const r = rig({ backoffBaseMs: 10_000, backoffMaxMs: 10_000 }, SMALL_OPTS);
    r.device.channel = 1;
    r.c.start();
    await flush();
    await r.c.showClock(6, GREEN);
    r.t.dropLink();
    r.t.writes.length = 0;
    await advance(1_500);
    expect(clockFrames(r)).toEqual([]);
    expect(r.surface.logs).toContain('[device] clock face re-send skipped: not connected');
  });

  it('9: a failed send is logged and never rejects', async () => {
    const r = await online(1, SMALL_OPTS);
    await r.c.showClock(6, GREEN);
    r.t.writeErrors.push(new Error('write failed'));
    await advance(1_500);
    expect(r.surface.logs.some((l) => l.startsWith('[device] clock face re-send failed: '))).toBe(true);
    expect(r.surface.logs.some((l) => l.includes('re-sent'))).toBe(false);
    expect(r.surface.errors).toEqual([]);
  });

  it('10: no resend when the device itself switches into the clock', async () => {
    const r = await online(1, SMALL_OPTS);
    r.t.writes.length = 0;
    r.t.emitData(statusFrame(50, 0));
    expect(r.c.getChannel()).toBe('clock');
    expect(await quiet(r)).toEqual([]);
    expect(resendLogs(r)).toEqual([]);
  });

  it('11: a superseded switch schedules nothing', async () => {
    const r = await online(1, SMALL_OPTS);
    r.t.writes.length = 0;
    const small = r.c.showClock(6, GREEN);
    const newer = r.c.setChannel('custom');
    await Promise.all([small, newer]);
    await advance(10_000);
    expect(clockFrames(r)).toEqual([SMALL_FRAME]);
    expect(resendLogs(r)).toEqual([]);
  });

  it('12: stop during the confirm wait arms no timer and sends nothing', async () => {
    const r = await online(1, SMALL_OPTS);
    r.device.answer = false;
    r.t.writes.length = 0;
    const entering = r.c.showClock(6, GREEN);
    const ended = entering.catch(() => undefined); // stopped while waiting: the change fails as not connected
    await flush();
    await r.c.stop();
    await flush();
    await ended;
    expect(vi.getTimerCount()).toBe(0); // no re-send timer armed (and none of the stopped controller's)
    r.t.writes.length = 0;
    await advance(10_000);
    expect(r.t.writes).toHaveLength(0);
    expect(resendLogs(r)).toEqual([]);
  });

  it('13: a switch that starts while an earlier one is still being sent resends (the known channel may be stale)', async () => {
    const r = await online(0, SMALL_OPTS);
    r.t.writes.length = 0;
    const away = r.c.setChannel('lighting');
    const back = r.c.showClock(6, GREEN);
    await Promise.all([away, back]);
    await advance(1_500);
    expect(clockFrames(r)).toEqual([SMALL_FRAME, SMALL_FRAME]);
    expect(r.surface.logs).toContain(`[device] clock face re-sent (small from pending): ${SMALL_FRAME}`);
  });

  it('14: a newer small clock switch inside the gap carries the pending re-send over', async () => {
    const r = await online(1, SMALL_OPTS);
    r.t.writes.length = 0;
    await r.c.showClock(6, GREEN);
    await advance(500);
    await r.c.setTileColor(0, 1); // red, in clock mode: sent with the shown style (small)
    const red = '45 00 01 06 01 00 00 00 ff 00 00';
    expect(clockFrames(r)).toEqual([SMALL_FRAME, red]);
    await advance(1_499);
    expect(clockFrames(r)).toEqual([SMALL_FRAME, red]);
    await advance(1);
    expect(clockFrames(r)).toEqual([SMALL_FRAME, red, red]);
    expect(r.surface.logs).toContain(`[device] clock face re-sent (small from lighting): ${red}`);
    expect(await quiet(r)).toHaveLength(3);
  });
});
