import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { opcodeOf, statusFrame } from '../transport/__fixtures__/frames';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { STATUS_POLL_INTERVAL_MS } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply (d0 `channel`, d9 `visualization`) has been processed. */
async function online(channel = 0, visualization = 3): Promise<Rig> {
  const r = rig();
  r.device.channel = channel;
  r.device.visualization = visualization;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  return r;
}

/** The payloads (hex) written since the last reset: chunks are joined back into envelopes. */
function sent(r: Rig): string[] {
  const all = Uint8Array.from(r.t.writes.flatMap((w) => [...w]));
  const out: string[] = [];
  for (let at = 0; at < all.length;) {
    const len = all[at + 4] | (all[at + 5] << 8);
    out.push(toHex(all.subarray(at + 11, at + 6 + len - 2)));
    at += 6 + len;
  }
  return out;
}

const logs = (r: Rig, part: string): string[] => r.surface.logs.filter((l) => l.includes(part));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('switching to the equalizer', () => {
  it('sends 45 04 00, confirms with 46 (d0 04, d9 00) and fires the trigger', async () => {
    const r = await online();
    r.surface.channelChanges.length = 0;
    r.surface.colors.length = 0;
    r.t.writes.length = 0;
    await r.c.setChannel('equalizer');
    expect(sent(r)).toEqual(['45 04 00', '46']);
    expect(r.surface.logs).toContain('[device] channel -> equalizer: 45 04 00');
    expect(r.surface.logs).toContain('[device] channel confirmed: equalizer');
    expect(logs(r, 'channel mismatch')).toEqual([]);
    expect(r.c.getChannel()).toBe('equalizer');
    expect(r.surface.channelChanges).toEqual(['equalizer']);
    expect(r.surface.colors).toEqual([]);
    expect(r.device.channel).toBe(4);
    expect(r.device.visualization).toBe(0);
  });

  it('logs a mismatch when the device reports another visualization (d9 03)', async () => {
    const r = await online();
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(50, 4, { 9: 3 })] : undefined);
    await r.c.setChannel('equalizer');
    expect(r.surface.logs).toContain('[device] channel mismatch: device visualizer, requested equalizer');
  });

  it('is not confused by the equalizer when another mode is requested', async () => {
    const r = await online(4, 0);
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(50, 4, { 9: 0 })] : undefined);
    await r.c.setChannel('clock');
    expect(r.surface.logs).toContain('[device] channel mismatch: device equalizer, requested clock');
  });

  it('stays the equalizer across polls (no device-side change, no trigger)', async () => {
    const r = await online();
    await r.c.setChannel('equalizer');
    r.surface.channels.length = 0;
    r.surface.channelChanges.length = 0;
    r.surface.logs.length = 0;
    await advance(STATUS_POLL_INTERVAL_MS * 2);
    expect(r.c.getChannel()).toBe('equalizer');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.channelClears).toBe(0);
    expect(logs(r, 'channel <- device')).toEqual([]);
  });
});

describe('the equalizer shown at the device', () => {
  it('d0 04 with d9 00 writes the tile and fires the trigger', async () => {
    const r = await online(0);
    r.surface.channels.length = 0;
    r.surface.channelChanges.length = 0;
    r.t.emitData(statusFrame(50, 4, { 9: 0 }));
    expect(r.c.getChannel()).toBe('equalizer');
    expect(r.c.onOtherMode()).toBe(false);
    expect(r.surface.channels).toEqual(['equalizer']);
    expect(r.surface.channelChanges).toEqual(['equalizer']);
    expect(r.surface.logs).toContain('[device] channel <- device: equalizer');
  });

  it('d0 04 with another d9 is the visualizer: tile cleared once, no trigger', async () => {
    const r = await online(0);
    r.surface.channelChanges.length = 0;
    r.t.emitData(statusFrame(50, 4, { 9: 3 }));
    r.t.emitData(statusFrame(50, 4, { 9: 3 }));
    expect(r.surface.channelClears).toBe(1);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.c.getChannel()).toBeNull();
    expect(r.c.onOtherMode()).toBe(true);
    expect(logs(r, 'mode not offered')).toEqual([
      '[device] channel <- device: visualizer (mode not offered), tile cleared',
    ]);
  });

  it('visualizer (04/3) to equalizer (04/0): the tile and the trigger once; and back: cleared again', async () => {
    const r = await online(0);
    r.surface.channels.length = 0;
    r.surface.channelChanges.length = 0;
    r.t.emitData(statusFrame(50, 4, { 9: 3 }));
    r.t.emitData(statusFrame(50, 4, { 9: 0 }));
    r.t.emitData(statusFrame(50, 4, { 9: 0 }));
    expect(r.surface.channelClears).toBe(1);
    expect(r.surface.channels).toEqual(['equalizer']);
    expect(r.surface.channelChanges).toEqual(['equalizer']);
    expect(r.c.getChannel()).toBe('equalizer');
    r.t.emitData(statusFrame(50, 4, { 9: 5 }));
    expect(r.surface.channelClears).toBe(2);
    expect(r.surface.channelChanges).toEqual(['equalizer']);
    expect(r.c.getChannel()).toBeNull();
  });

  it('is seen at the next poll', async () => {
    const r = await online(0);
    r.surface.channelChanges.length = 0;
    r.device.channel = 4;
    r.device.visualization = 0;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.getChannel()).toBe('equalizer');
    expect(r.surface.channelChanges).toEqual(['equalizer']);
  });

  it('powers the panel on when it appears while off', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.emitData(statusFrame(50, 4, { 9: 0 }));
    expect(r.c.isOn()).toBe(true);
    expect(r.c.getChannel()).toBe('equalizer');
  });
});

describe('power and other callers with the equalizer', () => {
  it('power off then on sends 45 04 00 again', async () => {
    const r = await online();
    await r.c.setChannel('equalizer');
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.channelChanges.length = 0;
    await r.c.setPower(true);
    expect(sent(r)).toEqual(['45 04 00', '46']);
    expect(r.c.getChannel()).toBe('equalizer');
    expect(r.surface.logs).toContain('[device] channel -> equalizer: 45 04 00');
  });

  it('switching from the noise meter to the equalizer ends the noise tracking', async () => {
    const r = await online();
    r.device.channel = 0x09;
    await r.c.setChannel('noise_meter');
    r.surface.logs.length = 0;
    await r.c.setChannel('equalizer');
    expect(logs(r, 'noise meter ended (mode change)')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('equalizer');
    r.surface.logs.length = 0;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.getChannel()).toBe('equalizer');
    expect(logs(r, 'noise meter')).toEqual([]);
  });

  it('the weather is sent, not held', async () => {
    const r = await online();
    await r.c.setChannel('equalizer');
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.setWeather({ temperatureC: 21, condition: 'rain' }, 'flow');
    expect(sent(r).filter((p) => p.startsWith('5f'))).toEqual(['5f 15 06']);
    expect(logs(r, 'weather held')).toEqual([]);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.getChannel()).toBe('equalizer');
  });
});
