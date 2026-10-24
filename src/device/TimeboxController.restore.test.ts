import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import type { ClockSettings } from './clock';
import { DEFAULT_CLOCK_SETTINGS } from './clock';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import type { TimeboxControllerOptions } from './TimeboxController';

// Power on shows what was displayed before power off, including the style of "Show clock" (#85).

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const RED = { r: 255, g: 0, b: 0 };
const GREEN = { r: 0, g: 255, b: 0 };
const CYAN = { r: 0, g: 255, b: 255 };
const ROUND: ClockSettings = { ...DEFAULT_CLOCK_SETTINGS, style: 5 };
const BOXED: ClockSettings = { ...DEFAULT_CLOCK_SETTINGS, style: 2 };

/** `45 00 HH TT 01 WW EE CC RR GG BB` of the clock with style `TT` and colour `rgb` (24 h, no pages). */
const clock = (style: number, rgb: string): string => `45 00 01 0${style} 01 00 00 00 ${rgb}`;

/** A started controller whose first status reply (channel `channel`, lighting green) has been processed. */
async function online(channel: number, opts: TimeboxControllerOptions): Promise<Rig> {
  const r = rig({}, opts, 50);
  r.device.channel = channel;
  r.device.color = [0, 0xff, 0];
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('power on restores the clock face shown by "Show clock"', () => {
  it('R1: the owner sequence shows the red full-screen clock again, and the setting is not touched', async () => {
    const r = await online(1, { clockSettings: ROUND, clockColor: CYAN });
    await r.c.setTileColor(1 / 3, 1);
    await r.c.showClock(0, RED);
    await advance(61_000);
    await r.c.setPower(false);
    await advance(61_000);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.setPower(true);
    expect(payloads(r)).toEqual(['26 00', clock(0, 'ff 00 00'), '46']);
    expect(r.surface.logs).toContain('[device] clock face confirmed: style full_screen colour #FF0000');
    expect(r.surface.logs.some((l) => l.includes('colour for clock'))).toBe(false);
    expect(r.surface.savedShownStyles).toEqual([0]);
    expect(r.surface.errors).toEqual([]);
  });

  it('R2: "Switch mode" to the clock shows the style of the settings again, also after off and on', async () => {
    const r = await online(1, { clockSettings: ROUND, clockColor: CYAN });
    await r.c.showClock(0, RED);
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', clock(5, 'ff 00 00')]);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', clock(5, 'ff 00 00')]);
    expect(r.surface.savedShownStyles).toEqual([0, null]);
  });

  it('R3: changing the clock settings while off clears the shown style: power on shows the new setting', async () => {
    const r = await online(1, { clockSettings: ROUND, clockColor: CYAN });
    await r.c.showClock(6, GREEN);
    await r.c.setPower(false);
    await r.c.setClockSettings(BOXED);
    expect(r.surface.savedShownStyles).toEqual([6, null]);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', clock(2, '00 ff 00')]);
  });

  it('R4: the tile colour in clock mode keeps the shown style', async () => {
    const r = await online(1, { clockSettings: ROUND, clockColor: CYAN });
    await r.c.showClock(0, RED);
    r.t.writes.length = 0;
    expect(await r.c.setTileColor(1 / 3, 1)).toBe('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', clock(0, '00 ff 00')]);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', clock(0, '00 ff 00')]);
    expect(r.surface.savedShownStyles).toEqual([0]);
    expect(r.surface.savedClockColors).toEqual([RED, GREEN]);
  });

  it('R5: started from off with a stored style, power on shows it', async () => {
    const r = await online(0, {
      clockSettings: ROUND,
      clockColor: GREEN,
      shownClockStyle: 6,
      powerOn: false,
      storedChannel: 'clock',
    });
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', clock(6, '00 ff 00')]);
    expect(r.surface.savedShownStyles).toEqual([]);
  });

  it('R6: a lighting restore is plain lighting and leaves the shown style alone', async () => {
    const r = await online(1, { clockSettings: ROUND, clockColor: CYAN });
    await r.c.showClock(0, RED);
    await r.c.showLighting(GREEN);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r)[0]).toBe('45 01 00 ff 00 32 00 01 00 00 00');
    expect(r.surface.savedShownStyles).toEqual([0]);
    // The clock is shown again by the tile colour of a clock mode only: switching back via the mode resets the style.
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', clock(5, 'ff 00 00')]);
    expect(r.surface.savedShownStyles).toEqual([0, null]);
  });

  it('R7: the style is saved once, however often the same face is sent', async () => {
    const r = await online(1, { clockSettings: ROUND, clockColor: CYAN });
    await r.c.showClock(0, RED);
    await r.c.showClock(0, GREEN);
    await r.c.setTileColor(0, 1);
    await r.c.setPower(false);
    await r.c.setPower(true);
    expect(r.surface.savedShownStyles).toEqual([0]);
  });

  it('R8: Show clock racing a mode switch to the clock ends with the style of the settings', async () => {
    const r = await online(1, { clockSettings: ROUND, clockColor: CYAN });
    const show = r.c.showClock(0, RED);
    const mode = r.c.setChannel('clock');
    await Promise.all([show, mode]);
    await flush();
    r.t.writes.length = 0;
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    // The newer switch carries the clock colour of the moment (cyan, "Switch mode" does not change it).
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', clock(5, '00 ff ff')]);
    expect(r.surface.savedShownStyles.at(-1)).toBeNull();
  });

  it('logs a failing save and carries on', async () => {
    const r = await online(1, { clockSettings: ROUND, clockColor: CYAN });
    r.surface.saveShownClockStyle = () => Promise.reject(new Error('store full'));
    await r.c.showClock(0, RED);
    await flush();
    expect(r.surface.errors).toContain('[device] surface call failed: store full');
  });
});
