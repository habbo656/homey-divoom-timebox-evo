// The tile colour belongs to the mode that is shown (#69): clock colour in clock mode, lighting colour in lighting mode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { statusFrame } from '../transport/__fixtures__/frames';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { CHANNEL_CONFIRM_TIMEOUT_MS } from './TimeboxController';
import type { TimeboxControllerOptions } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);

const RED = { r: 255, g: 0, b: 0 };
const GREEN = { r: 0, g: 255, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };

/** A started controller whose first status (mode `channel`, lighting colour `color`, brightness 50) has been processed; the tile writes of that status are cleared. */
async function online(
  channel = 0,
  color: [number, number, number] = [0, 0, 255],
  opts: TimeboxControllerOptions = {},
): Promise<Rig> {
  const r = rig({}, opts, 50);
  r.device.channel = channel;
  r.device.color = color;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  r.surface.colors.length = 0;
  r.t.writes.length = 0;
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

const hueOf = (r: Rig, i = 0) => r.surface.colors[i].hue;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tile colour while the clock is shown', () => {
  it('C1: sets the clock colour with the current face, stores it, and neither switches mode nor writes the tile', async () => {
    const r = await online(0);
    await expect(r.c.setTileColor(0, 1)).resolves.toBe('clock');
    expect(payloads(r)).toEqual(['26 00', '45 00 01 00 01 00 00 00 ff 00 00', '46']);
    expect(r.surface.logs).toContain('[device] colour for clock: #FF0000');
    expect(r.surface.logs).toContain('[device] channel -> clock: 45 00 01 00 01 00 00 00 ff 00 00');
    expect(r.surface.logs).toContain('[device] clock face confirmed: style full_screen colour #FF0000');
    expect(r.surface.savedClockColors).toEqual([RED]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.colors).toEqual([]);
    expect(payloads(r).some((p) => p.startsWith('45 01'))).toBe(false);
    expect(r.c.getChannel()).toBe('clock');
  });

  it('keeps the style and the page flags of the settings', async () => {
    const r = await online(0, undefined, {
      clockSettings: { style: 2, weather: true, temperature: false, calendar: false, animations: false },
    });
    await r.c.setTileColor(1 / 3, 1);
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 02 01 01 00 00 00 ff 00']);
  });

  it('C2: a later switch to the clock from lighting uses the new colour', async () => {
    const r = await online(0);
    await r.c.setTileColor(0, 1);
    await r.c.setChannel('lighting');
    r.t.writes.length = 0;
    await r.c.setChannel('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 00 01 00 00 00 ff 00 00']);
  });

  it('does not store an unchanged colour again', async () => {
    const r = await online(0, undefined, { clockColor: RED });
    await r.c.setTileColor(0, 1);
    expect(r.surface.savedClockColors).toEqual([]);
  });

  it('C5: a panel that is off returns to the clock with the new colour and is on again', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await expect(r.c.setTileColor(0, 1)).resolves.toBe('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 00 01 00 00 00 ff 00 00']);
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.onoffs.at(-1)).toBe(true);
  });

  it('C6: an invalid hue rejects without changing the clock colour; not connected rejects readably', async () => {
    const r = await online(0);
    await expect(r.c.setTileColor(1.5, 1)).rejects.toThrow(RangeError);
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.savedClockColors).toEqual([]);
    await r.c.setChannel('lighting');
    await r.c.setChannel('clock');
    expect(payloads(r).at(-2)).toBe('45 00 01 00 01 00 00 00 ff ff ff');
    const early = rig();
    await expect(early.c.setTileColor(0, 1)).rejects.toThrow('not connected text');
    expect(early.t.writes).toHaveLength(0);
  });
});

describe('tile colour outside the clock', () => {
  it.each([
    ['custom', 5],
    ['cloud', 2],
    ['visualizer', 4],
  ])('C4: %s switches to lighting in that colour and fires the trigger', async (_name, code) => {
    const r = await online(code);
    r.surface.channelChanges.length = 0;
    await expect(r.c.setTileColor(0, 1)).resolves.toBe('lighting');
    expect(payloads(r)).toEqual(['45 01 ff 00 00 32 00 01 00 00 00', '46']);
    expect(r.surface.channelChanges).toEqual(['lighting']);
    expect(r.surface.savedClockColors).toEqual([]);
    expect(r.surface.colors).toEqual([]);
    expect(r.c.getChannel()).toBe('lighting');
  });

  it('C4: before the first status it is lighting too', async () => {
    const r = rig({}, {}, 50);
    r.device.answer = false;
    r.c.start();
    await flush();
    expect(r.m.state).toBe('connected');
    r.t.writes.length = 0;
    expect(r.c.getChannel()).toBeNull();
    const change = r.c.setTileColor(1 / 3, 1);
    const failed = expect(change).rejects.toThrow('not confirmed text');
    await vi.advanceTimersByTimeAsync(CHANNEL_CONFIRM_TIMEOUT_MS); // the 46 confirm is never answered
    await failed;
    expect(payloads(r)[0]).toBe('45 01 00 ff 00 64 00 01 00 00 00');
    expect(r.surface.channelChanges).toEqual(['lighting']);
  });
});

describe('the tile follows the mode', () => {
  it('C7: a mode switch of Homey writes the colour of the new mode', async () => {
    const r = await online(1, [0, 0, 255], { clockColor: GREEN });
    await r.c.setChannel('clock');
    expect(r.surface.colors).toHaveLength(1);
    expect(hueOf(r)).toBeCloseTo(1 / 3, 10);
    r.surface.colors.length = 0;
    await r.c.setChannel('lighting');
    expect(r.surface.colors).toHaveLength(1);
    expect(hueOf(r)).toBeCloseTo(2 / 3, 10);
    r.surface.colors.length = 0;
    await r.c.setChannel('custom');
    expect(r.surface.colors).toEqual([]);
  });

  it('C8: a mode change reported by the device writes the colour of the new mode', async () => {
    const r = await online(1, [0, 0, 255], { clockColor: GREEN });
    r.t.emitData(statusFrame(50, 0, { 3: 0, 4: 0, 5: 255 }));
    expect(r.surface.colors).toHaveLength(1);
    expect(hueOf(r)).toBeCloseTo(1 / 3, 10);
    r.surface.colors.length = 0;
    r.t.emitData(statusFrame(50, 5, { 3: 0, 4: 0, 5: 255 }));
    expect(r.surface.colors).toEqual([]);
  });

  it('C9: the first status writes the clock colour for the clock and the device colour for lighting', async () => {
    const clock = rig({}, { clockColor: GREEN }, 50);
    clock.device.channel = 0;
    clock.device.color = [0, 0, 255];
    clock.c.start();
    await flush();
    expect(clock.surface.colors).toHaveLength(1);
    expect(hueOf(clock)).toBeCloseTo(1 / 3, 10);

    const lighting = rig({}, { clockColor: GREEN }, 50);
    lighting.device.channel = 1;
    lighting.device.color = [0, 0, 255];
    lighting.c.start();
    await flush();
    expect(lighting.surface.colors).toHaveLength(1);
    expect(hueOf(lighting)).toBeCloseTo(2 / 3, 10);
  });

  it('C10: a lighting colour reported while the clock is shown shows with the next switch to lighting', async () => {
    const r = await online(0, [0, 0, 255], { clockColor: GREEN });
    r.t.emitData(statusFrame(50, 0, { 3: 255, 4: 0, 5: 0 }));
    expect(r.surface.colors).toEqual([]);
    await r.c.setChannel('lighting');
    expect(r.surface.colors).toHaveLength(1);
    expect(hueOf(r)).toBeCloseTo(0, 10);
  });

  it('C11: at most one tile write per status (mode change and colour change together)', async () => {
    const r = await online(0, [0, 0, 255], { clockColor: GREEN });
    r.t.emitData(statusFrame(50, 1, { 3: 255, 4: 0, 5: 0 }));
    expect(r.surface.colors).toHaveLength(1);
    expect(hueOf(r)).toBeCloseTo(0, 10);
    r.surface.colors.length = 0;
    r.t.emitData(statusFrame(50, 1, { 3: 0, 4: 255, 5: 0 }));
    expect(r.surface.colors).toHaveLength(1);
  });

  it('C12: the clockColor option is used on the first clock switch', async () => {
    const r = await online(1, [0, 0, 255], { clockColor: BLUE });
    await r.c.setChannel('clock');
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 00 01 00 00 00 00 00 ff']);
  });
});
