import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { statusFrame } from '../transport/__fixtures__/frames';
import { MESSAGES, rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import type { TextRequest } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply (channel `initialChannel`) has been processed. */
async function online(initialChannel = 0, opts: Parameters<typeof rig>[1] = {}): Promise<Rig> {
  const r = rig({}, opts);
  r.device.channel = initialChannel;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  for (const list of [r.surface.channels, r.surface.channelChanges, r.surface.colors, r.surface.onoffs])
    list.length = 0;
  return r;
}

/** The payloads written since the last reset, chunks joined back into envelopes (opcode first). */
function payloads(r: Rig): Uint8Array[] {
  const all = Uint8Array.from(r.t.writes.flatMap((w) => [...w]));
  const out: Uint8Array[] = [];
  for (let at = 0; at < all.length;) {
    const len = all[at + 4] | (all[at + 5] << 8);
    out.push(all.subarray(at + 11, at + 6 + len - 2));
    at += 6 + len;
  }
  return out;
}
const opcodes = (r: Rig): string[] => payloads(r).map((p) => p[0].toString(16).padStart(2, '0'));
const frames = (r: Rig): string[] => payloads(r).map((p) => toHex(p.subarray(0, 5)));

const SMALL = { style: 6, weather: false, temperature: false, calendar: false, animations: false };
const request = (over: Partial<TextRequest> = {}): TextRequest => ({
  text: 'Hallo Homey 123',
  color: { r: 255, g: 255, b: 0 },
  background: { r: 0, g: 0, b: 128 },
  speed: 5,
  durationS: 0,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startCountdown', () => {
  it('sends exactly 72 03 01 MM SS and logs it', async () => {
    const r = await online();
    await r.c.startCountdown({ minutes: 5, seconds: 0 });
    expect(frames(r)).toEqual(['72 03 01 05 00']);
    expect(r.surface.logs).toEqual(['[device] countdown started: 05:00']);
  });

  it('encodes the seconds and the 99:59 maximum', async () => {
    const r = await online();
    await r.c.startCountdown({ minutes: 0, seconds: 30 });
    await r.c.startCountdown({ minutes: 99, seconds: 59 });
    expect(frames(r)).toEqual(['72 03 01 00 1e', '72 03 01 63 3b']);
  });

  it('is an overlay: no tile write, no trigger, the known channel stays', async () => {
    const r = await online(5);
    await r.c.startCountdown({ minutes: 1, seconds: 0 });
    expect(r.c.getChannel()).toBe('custom');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.colors).toEqual([]);
    expect(r.surface.onoffs).toEqual([]);
  });

  it('a 46 report with the unchanged channel during the countdown writes no tile and fires no trigger', async () => {
    const r = await online(5);
    await r.c.startCountdown({ minutes: 1, seconds: 0 });
    r.t.emitData(statusFrame(50, 5));
    await flush();
    await advance(60_000); // polls
    expect(r.c.getChannel()).toBe('custom');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('starting again just sends the new frame', async () => {
    const r = await online();
    await r.c.startCountdown({ minutes: 0, seconds: 20 });
    await r.c.startCountdown({ minutes: 0, seconds: 8 });
    expect(frames(r)).toEqual(['72 03 01 00 14', '72 03 01 00 08']);
  });

  describe('rejections send nothing', () => {
    it('0:00 rejects with the localised message', async () => {
      const r = await online();
      await expect(r.c.startCountdown({ minutes: 0, seconds: 0 })).rejects.toThrow(MESSAGES.countdownZero);
      expect(r.t.writes).toHaveLength(0);
      expect(r.surface.logs).toEqual([]);
    });

    it.each([
      [-1, 10],
      [100, 0],
      [1.5, 10],
      [NaN, 10],
      [1, 60],
      [1, -1],
      [1, NaN],
    ])('%s min %s s rejects with a RangeError', async (minutes, seconds) => {
      const r = await online();
      await expect(r.c.startCountdown({ minutes, seconds })).rejects.toThrow(RangeError);
      expect(r.t.writes).toHaveLength(0);
    });

    it('not connected rejects with the readable error', async () => {
      const r = rig();
      await expect(r.c.startCountdown({ minutes: 1, seconds: 0 })).rejects.toThrow(MESSAGES.notConnected);
      expect(r.t.writes).toHaveLength(0);
    });

    it('a stopped controller rejects with the readable error', async () => {
      const r = await online();
      await r.c.stop();
      r.t.writes.length = 0;
      await expect(r.c.startCountdown({ minutes: 1, seconds: 0 })).rejects.toThrow(MESSAGES.notConnected);
      expect(r.t.writes).toHaveLength(0);
    });
  });

  it('turns the panel on first when it is off (the mode from before off returns)', async () => {
    const r = await online(5);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.startCountdown({ minutes: 2, seconds: 0 });
    expect(opcodes(r)).toEqual(['45', '46', '72']);
    expect(payloads(r)[0][1]).toBe(0x05);
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.surface.logs).toContain('[device] countdown: panel is off, turning it on first');
    expect(r.surface.logs).toContain('[device] countdown started: 02:00');
  });

  describe('a pending small clock re-send (#88)', () => {
    it('is sent ahead of the countdown so it cannot end it 1.5 s later', async () => {
      const r = rig({}, { clockSettings: SMALL });
      r.device.channel = 0;
      r.c.start();
      await flush();
      await r.c.setPower(false);
      r.t.writes.length = 0;
      await r.c.startCountdown({ minutes: 1, seconds: 0 });
      expect(opcodes(r)).toEqual(['26', '45', '46', '45', '72']); // the re-send does not repeat the 26 flag
      expect(r.surface.logs.some((l) => l.includes('clock face re-sent before the countdown'))).toBe(true);
      r.t.writes.length = 0;
      await advance(5_000);
      expect(opcodes(r).filter((o) => o === '45')).toEqual([]);
    });

    it('is dropped, not sent, when the clock is no longer the known mode', async () => {
      const r = rig({}, { clockSettings: SMALL });
      r.device.channel = 5;
      r.c.start();
      await flush();
      await r.c.showClock(6, { r: 255, g: 255, b: 255 }); // schedules the re-send
      r.t.emitData(statusFrame(50, 5)); // the device reports the custom channel again
      await flush();
      r.t.writes.length = 0;
      await r.c.startCountdown({ minutes: 1, seconds: 0 });
      expect(opcodes(r)).toEqual(['72']);
      expect(r.surface.logs).toContain('[device] clock face re-send dropped before the countdown: mode changed');
      await advance(5_000);
      expect(opcodes(r).filter((o) => o === '45')).toEqual([]);
    });

    it('nothing is added when none is pending', async () => {
      const r = await online(0, { clockSettings: SMALL });
      await r.c.startCountdown({ minutes: 1, seconds: 0 });
      expect(opcodes(r)).toEqual(['72']);
    });
  });

  describe('with a native text', () => {
    it('replaces a shown text: the app forgets it and never sends 6e 00 for it', async () => {
      const r = await online();
      await r.c.showText(request({ durationS: 5 }));
      expect(r.c.isTextShown()).toBe(true);
      r.t.writes.length = 0;
      await r.c.startCountdown({ minutes: 1, seconds: 0 });
      expect(r.c.isTextShown()).toBe(false);
      expect(r.surface.logs).toContain('[device] text stopped (countdown)');
      r.t.writes.length = 0;
      await advance(10_000); // the text duration would have passed
      expect(payloads(r).map(toHex)).not.toContain('6e 00');
    });

    it('supersedes a text that is still being sent', async () => {
      const r = await online();
      const text = r.c.showText(request());
      const countdown = r.c.startCountdown({ minutes: 1, seconds: 0 });
      await Promise.all([text, countdown]);
      expect(r.c.isTextShown()).toBe(false);
      expect(r.surface.logs).toContain('[device] text superseded by a newer text, a countdown or a stop');
      expect(opcodes(r).slice(-1)).toEqual(['72']);
    });

    it('a text after the countdown is shown as usual', async () => {
      const r = await online();
      await r.c.startCountdown({ minutes: 1, seconds: 0 });
      await r.c.showText(request());
      expect(r.c.isTextShown()).toBe(true);
    });
  });

  it('does not disturb the weather: no hold, the weather is sent as usual', async () => {
    const r = await online();
    await r.c.startCountdown({ minutes: 1, seconds: 0 });
    r.t.writes.length = 0;
    await r.c.setWeather({ temperatureC: 17, condition: 'clear' }, 'flow');
    expect(frames(r)).toEqual(['5f 11 01']);
  });
});

describe('stopCountdown', () => {
  it('sends 72 03 00 00 00 and the clock again (the device would switch to the clock by itself)', async () => {
    const r = await online(0);
    await r.c.stopCountdown();
    expect(opcodes(r)).toEqual(['72', '26', '45', '46']);
    expect(frames(r)[0]).toBe('72 03 00 00 00');
    expect(r.surface.logs).toContain('[device] countdown stopped (action)');
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('sends the known mode again: lighting', async () => {
    const r = await online(1);
    await r.c.stopCountdown();
    expect(opcodes(r)).toEqual(['72', '45', '46']);
    expect(payloads(r)[1][1]).toBe(0x01);
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('sends the known mode again: custom', async () => {
    const r = await online(5);
    await r.c.stopCountdown();
    expect(payloads(r)[1].subarray(0, 2)).toEqual(Uint8Array.of(0x45, 0x05));
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('sends only the stop while the device shows another mode (cloud)', async () => {
    const r = await online(2);
    await r.c.stopCountdown();
    expect(frames(r)).toEqual(['72 03 00 00 00']);
  });

  it('sends only the stop while the mode is not known yet', async () => {
    const r = rig();
    r.device.answer = false;
    r.c.start();
    await flush();
    expect(r.m.state).toBe('connected');
    r.t.writes.length = 0;
    await r.c.stopCountdown();
    expect(frames(r)).toEqual(['72 03 00 00 00']);
  });

  it('is skipped with the panel off: nothing is sent, the panel stays dark', async () => {
    const r = await online(1);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.stopCountdown();
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toEqual(['[device] countdown stop skipped: panel off']);
    expect(r.surface.onoffs).toEqual([]);
  });

  it('is skipped while a text is shown: no stop, no mode re-send, the text keeps running', async () => {
    const r = await online(1);
    await r.c.showText(request());
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.stopCountdown();
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toEqual(['[device] countdown stop skipped: text shown']);
    expect(r.c.isTextShown()).toBe(true);
  });

  it('is skipped while a text is being sent', async () => {
    const r = await online(1);
    const text = r.c.showText(request());
    await r.c.stopCountdown();
    await text;
    expect(opcodes(r)).toEqual(['6e', '86', '86', '6c', '6c']);
    expect(r.surface.logs).toContain('[device] countdown stop skipped: text shown');
    expect(r.c.isTextShown()).toBe(true);
  });

  it('works again after the text was stopped', async () => {
    const r = await online(1);
    await r.c.showText(request());
    await r.c.stopText();
    r.t.writes.length = 0;
    await r.c.stopCountdown();
    expect(opcodes(r)).toEqual(['72', '45', '46']);
  });

  it('is harmless without a countdown: it behaves the same', async () => {
    const r = await online(1);
    await r.c.stopCountdown();
    await r.c.stopCountdown();
    expect(opcodes(r)).toEqual(['72', '45', '46', '72', '45', '46']);
  });

  it('not connected rejects with the readable error and sends nothing', async () => {
    const r = rig();
    await expect(r.c.stopCountdown()).rejects.toThrow(MESSAGES.notConnected);
    expect(r.t.writes).toHaveLength(0);
  });

  it('a lost link during the stop rejects with the readable error', async () => {
    const r = await online(0);
    r.t.dropLink();
    await flush();
    await expect(r.c.stopCountdown()).rejects.toThrow(MESSAGES.notConnected);
  });
});
