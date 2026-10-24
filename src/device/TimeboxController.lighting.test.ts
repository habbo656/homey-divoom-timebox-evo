import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { opcodeOf, statusFrame } from '../transport/__fixtures__/frames';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller on `channel` whose first status carries lighting colour `color` and brightness 50. */
async function online(channel = 0, color: [number, number, number] = [0, 0, 0]): Promise<Rig> {
  const r = rig({}, {}, 50);
  r.device.channel = channel;
  r.device.color = color;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  return r;
}

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

describe('setTileColor in lighting mode (tile)', () => {
  it('C3: sends the colour as plain lighting with the known brightness, then confirms with 46', async () => {
    const r = await online(1);
    r.t.writes.length = 0;
    await expect(r.c.setTileColor(0, 1)).resolves.toBe('lighting');
    expect(payloads(r)).toEqual(['45 01 ff 00 00 32 00 01 00 00 00', '46']);
    expect(r.surface.logs).toContain('[device] colour for lighting: #FF0000');
    expect(r.surface.logs).toContain('[device] lighting -> #FF0000: 45 01 ff 00 00 32 00 01 00 00 00');
    expect(r.surface.logs).toContain('[device] lighting confirmed: #FF0000');
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.c.getChannel()).toBe('lighting');
  });

  it('converts hue and saturation (0.5, 0.5 is #80FFFF) and keeps the dim value', async () => {
    const r = await online(1);
    await r.c.setDim(0.2);
    r.t.writes.length = 0;
    await r.c.setTileColor(0.5, 0.5);
    expect(payloads(r)[0]).toBe('45 01 80 ff ff 14 00 01 00 00 00');
  });

  it('logs a mismatch if the device keeps another colour', async () => {
    const r = await online(1);
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(50, 1, { 3: 1, 4: 2, 5: 3 })] : undefined);
    await r.c.setTileColor(0, 1);
    expect(r.surface.logs).toContain('[device] lighting mismatch: device #010203, requested #FF0000');
  });

  it('does not write the colour tile itself and does not echo the device report of its own colour', async () => {
    const r = await online(1);
    r.surface.colors.length = 0;
    await r.c.setTileColor(1 / 3, 1);
    r.t.emitData(statusFrame(50, 1, { 3: 0, 4: 255, 5: 0 }));
    await advance(60_000);
    expect(r.surface.colors).toEqual([]);
    expect(r.surface.logs.some((l) => l.includes('colour <- device'))).toBe(false);
  });

  it.each([
    [-0.1, 1],
    [1.1, 1],
    [0, -1],
    [0, 2],
    [NaN, 1],
    [0, Infinity],
    ['0.5', 1],
    [undefined, 1],
  ])('C6: rejects hue %s saturation %s before anything is written', async (hue, saturation) => {
    const r = await online(1);
    r.t.writes.length = 0;
    await expect(r.c.setTileColor(hue as number, saturation as number)).rejects.toThrow(RangeError);
    expect(r.t.writes).toHaveLength(0);
  });

  it('C6: gives a readable error and writes nothing while not connected (after validating)', async () => {
    const r = rig();
    await expect(r.c.setTileColor(0, 1)).rejects.toThrow('not connected text');
    await expect(r.c.setTileColor(2, 1)).rejects.toThrow(RangeError);
    expect(r.t.writes).toHaveLength(0);
  });

  it('switches the panel on while off', async () => {
    const r = await online(1);
    await r.c.setPower(false);
    await expect(r.c.setTileColor(0, 1)).resolves.toBe('lighting');
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.onoffs).toEqual([true, true]);
    expect(r.device.power).toBe(true);
  });

  it('resolves null if a newer change superseded it', async () => {
    const r = await online(1);
    const a = r.c.setTileColor(0, 1);
    const b = r.c.setChannel('custom');
    await expect(a).resolves.toBeNull();
    await b;
  });
});

describe('showLighting (Flow)', () => {
  it('L2: sends the colour as plain lighting (effect byte 00) and writes it to the tile', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    r.surface.colors.length = 0;
    await r.c.showLighting({ r: 255, g: 0, b: 255 });
    expect(payloads(r)).toEqual(['45 01 ff 00 ff 32 00 01 00 00 00', '46']);
    expect(r.surface.logs).toContain('[device] lighting -> #FF00FF: 45 01 ff 00 ff 32 00 01 00 00 00');
    expect(r.surface.logs).toContain('[device] lighting confirmed: #FF00FF');
    expect(r.surface.colors).toHaveLength(1);
    expect(r.surface.colors[0].hue).toBeCloseTo(5 / 6, 10);
    expect(r.surface.colors[0].saturation).toBe(1);
  });

  it('writes no tile colour for black', async () => {
    const r = await online(0);
    r.surface.colors.length = 0;
    await r.c.showLighting({ r: 0, g: 0, b: 0 });
    expect(r.surface.colors).toEqual([]);
  });

  it('switches the panel on while off', async () => {
    const r = await online(5);
    await r.c.setPower(false);
    await r.c.showLighting({ r: 0, g: 255, b: 0 });
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.onoffs).toEqual([true, true]);
  });

  it('does not write the tile colour if a newer change superseded it', async () => {
    const r = await online(0);
    r.surface.colors.length = 0;
    const a = r.c.showLighting({ r: 255, g: 0, b: 0 });
    const b = r.c.setChannel('custom');
    await Promise.all([a, b]);
    expect(r.surface.logs).toContain('[device] channel lighting superseded by a newer change');
    expect(r.surface.colors).toEqual([]);
  });
});

describe('colour sync from the device', () => {
  it('C9: the first status of a lighting device writes the lighting colour to the tile and logs it', async () => {
    const r = await online(1, [0, 255, 0]);
    expect(r.surface.colors).toHaveLength(1);
    expect(r.surface.colors[0].hue).toBeCloseTo(1 / 3, 10);
    expect(r.surface.colors[0].saturation).toBe(1);
    expect(r.surface.logs).toContain('[device] colour <- device: #00FF00');
  });

  it('follows a colour change on the device once, and ignores an unchanged colour', async () => {
    const r = await online(1, [0, 255, 0]);
    r.surface.colors.length = 0;
    r.t.emitData(statusFrame(50, 1, { 3: 0, 4: 255, 5: 0 }));
    expect(r.surface.colors).toEqual([]);
    r.t.emitData(statusFrame(50, 1, { 3: 0, 4: 0, 5: 255 }));
    r.t.emitData(statusFrame(50, 1, { 3: 0, 4: 0, 5: 255 }));
    expect(r.surface.colors).toHaveLength(1);
    expect(r.surface.colors[0].hue).toBeCloseTo(2 / 3, 10);
  });

  it('C10: a changed lighting colour while the clock is shown is remembered, not written to the tile', async () => {
    const r = await online(0, [0, 255, 0]);
    r.surface.colors.length = 0;
    r.t.emitData(statusFrame(50, 0, { 3: 0, 4: 0, 5: 255 }));
    expect(r.surface.colors).toEqual([]);
    r.t.emitData(statusFrame(50, 1, { 3: 0, 4: 0, 5: 255 })); // the device switches to lighting: the colour shows now
    expect(r.surface.colors).toHaveLength(1);
    expect(r.surface.colors[0].hue).toBeCloseTo(2 / 3, 10);
  });

  it('C10: the remembered colour shows on the tile with the next switch to lighting', async () => {
    const r = await online(0, [0, 255, 0]);
    r.t.emitData(statusFrame(50, 0, { 3: 0, 4: 0, 5: 255 }));
    r.surface.colors.length = 0;
    await r.c.setChannel('lighting');
    expect(r.surface.colors).toHaveLength(1);
    expect(r.surface.colors[0].hue).toBeCloseTo(2 / 3, 10);
  });

  it('skips black (no hue to show), also as the first value', async () => {
    const r = await online(1, [0, 0, 0]);
    r.t.emitData(statusFrame(50, 1, { 3: 0, 4: 0, 5: 0 }));
    expect(r.surface.colors).toEqual([]);
    expect(r.surface.logs.some((l) => l.includes('colour <- device'))).toBe(false);
  });

  it('ignores reports while a lighting change is in flight', async () => {
    const r = await online(1, [0, 255, 0]);
    r.surface.colors.length = 0;
    r.t.holdWrites();
    const p = r.c.setTileColor(0, 1);
    await flush();
    r.t.emitData(statusFrame(50, 1, { 3: 9, 4: 9, 5: 9 }));
    expect(r.surface.colors).toEqual([]);
    r.t.releaseWrites();
    await p;
    expect(r.surface.colors).toEqual([]);
  });

  it('makes no surface call after stop and survives a surface failure', async () => {
    const r = await online(1, [0, 255, 0]);
    r.surface.setLightColor = () => {
      throw new Error('boom');
    };
    r.t.emitData(statusFrame(50, 1, { 3: 0, 4: 0, 5: 255 }));
    expect(r.surface.errors).toEqual(['[device] surface call failed: boom']);
    await r.c.stop();
    r.surface.errors.length = 0;
    r.t.emitData(statusFrame(50, 1, { 3: 255, 4: 0, 5: 0 }));
    expect(r.surface.errors).toEqual([]);
  });
});
