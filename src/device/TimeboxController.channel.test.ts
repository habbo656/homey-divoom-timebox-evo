import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { TransportError } from '../transport/Transport';
import { opcodeOf, statusFrame } from '../transport/__fixtures__/frames';
import { CHANNEL_CONFIRM_TIMEOUT_MS, DIM_SEND_TIMEOUT_MS } from './TimeboxController';
import type { ChannelId } from './channel';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply (channel `initialChannel`) has been processed. */
async function online(initialChannel = 0, initialBrightness = 50): Promise<Rig> {
  const r = rig({}, {}, initialBrightness);
  r.device.channel = initialChannel;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  return r;
}

/** The payloads (hex) written since the last reset: chunks are joined back into envelopes (`FE EF AA 55 LEN LEN ...`). */
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

describe('setChannel', () => {
  it('sends the lighting form from the last status, then confirms with 46', async () => {
    const r = await online();
    r.device.color = [0xff, 0, 0];
    r.t.emitData(statusFrame(50, 0, { 3: 0xff }));
    r.t.writes.length = 0;
    await r.c.setChannel('lighting');
    expect(payloads(r)).toEqual(['45 01 ff 00 00 32 00 01 00 00 00', '46']);
    expect(r.surface.logs).toContain('[device] channel -> lighting: 45 01 ff 00 00 32 00 01 00 00 00');
    expect(r.surface.logs).toContain('[device] channel confirmed: lighting');
    expect(r.device.channel).toBe(1);
  });

  it('uses the known brightness (after a dim change) for lighting', async () => {
    const r = await online();
    await r.c.setDim(0.2);
    r.t.writes.length = 0;
    await r.c.setChannel('lighting');
    expect(payloads(r)[0]).toBe('45 01 ff ff ff 14 00 01 00 00 00'); // black colour becomes white
  });

  it.each([
    ['clock', ['26 00', '45 00 01 00 01 00 00 00 ff ff ff']], // the animation flag goes ahead of the clock frame (#106)
    ['custom', ['45 05']],
  ] as const)('sends %s as %s', async (id, hex) => {
    const r = await online(1);
    r.t.writes.length = 0;
    await r.c.setChannel(id);
    expect(payloads(r).slice(0, hex.length)).toEqual(hex);
    expect(r.surface.logs).toContain(`[device] channel confirmed: ${id}`);
  });

  it('never sends 45 03', async () => {
    const r = await online();
    for (const id of ['lighting', 'custom', 'clock'] as const) {
      await r.c.setChannel(id);
    }
    const subs = r.t.writes.filter((w) => opcodeOf(w) === 0x45).map((w) => w[12]);
    expect(subs).toEqual([1, 5, 0]);
  });

  it('does not write the tile itself, but fires the trigger once per change', async () => {
    const r = await online(0);
    r.surface.channels.length = 0;
    await r.c.setChannel('custom');
    await r.c.setChannel('custom');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual(['custom']);
    expect(r.c.getChannel()).toBe('custom');
  });

  it('logs a mismatch and a confirm timeout without failing', async () => {
    const r = await online();
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(50, 0x0a)] : undefined);
    await r.c.setChannel('lighting');
    expect(r.surface.logs).toContain('[device] channel mismatch: device code 10, requested lighting');
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(50, 4)] : undefined);
    await r.c.setChannel('clock');
    expect(r.surface.logs).toContain('[device] channel mismatch: device visualizer, requested clock');
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(50, 0)] : undefined);
    await r.c.setChannel('custom');
    expect(r.surface.logs).toContain('[device] channel mismatch: device clock, requested custom');

    r.device.answer = false;
    r.t.autoReply = undefined;
    let done = false;
    const p = r.c.setChannel('lighting').then(
      () => (done = true),
      () => (done = true),
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await advance(1);
    await p;
    // The unanswered confirm is logged (and fails the change, see TimeboxController.unconfirmed.test.ts).
    expect(r.surface.logs).toContain('[device] channel confirm timeout');
    expect(r.surface.errors).toEqual([]);
  });

  it('rejects an invalid id before anything is written', async () => {
    const r = await online();
    r.t.writes.length = 0;
    for (const bad of ['game', '', 'cloud', 'visualizer', 'scoreboard', 3, null, undefined]) {
      await expect(r.c.setChannel(bad as unknown as ChannelId)).rejects.toThrow(RangeError);
    }
    expect(r.t.writes).toHaveLength(0);
  });

  it('gives a readable error and writes nothing while disconnected, before start and after stop', async () => {
    const r = rig();
    await expect(r.c.setChannel('clock')).rejects.toThrow('not connected text');
    r.c.start();
    r.t.failNextOpen(new TransportError('nope'));
    await flush();
    r.t.writes.length = 0;
    await expect(r.c.setChannel('clock')).rejects.toThrow('not connected text');
    expect(r.t.writes).toHaveLength(0);
    await r.c.stop();
    await expect(r.c.setChannel('clock')).rejects.toThrow('not connected text');
  });

  it('maps a link lost during the send to the readable error', async () => {
    const r = await online();
    r.t.holdWrites();
    const p = r.c.setChannel('custom');
    const assertion = expect(p).rejects.toThrow('not connected text');
    await flush();
    r.t.dropLink();
    r.t.releaseWrites();
    await flush();
    await assertion;
    expect(r.surface.errors).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('fails readably when the write hangs and applies device reports again afterwards', async () => {
    const r = await online(0);
    r.t.holdWrites();
    const p = r.c.setChannel('lighting');
    const assertion = expect(p).rejects.toThrow('not connected text');
    await advance(DIM_SEND_TIMEOUT_MS);
    await assertion;
    expect(r.surface.channelChanges).toEqual([]);
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 5));
    expect(r.surface.channels).toEqual(['custom']);
    r.t.releaseWrites();
    await flush();
    await r.c.stop();
  });

  it('ignores a stale channel report while a change is in flight and keeps the last of two quick changes', async () => {
    const r = await online(0);
    r.surface.channels.length = 0;
    r.t.holdWrites();
    const p = r.c.setChannel('custom');
    await flush();
    r.t.emitData(statusFrame(50, 0));
    expect(r.surface.channels).toEqual([]);
    r.t.releaseWrites();
    await p;
    expect(r.surface.channels).toEqual([]);

    const a = r.c.setChannel('lighting');
    const b = r.c.setChannel('clock');
    await Promise.all([a, b]);
    expect(r.device.channel).toBe(0);
    expect(r.surface.logs).toContain('[device] channel lighting superseded by a newer change');
    expect(r.surface.channelChanges).toEqual(['custom', 'lighting', 'clock']);
  });

  it('makes no log or surface call when stopped while a change is running', async () => {
    const r = await online();
    r.device.answer = false;
    r.t.autoReply = undefined;
    const p = r.c.setChannel('custom');
    const assertion = expect(p).rejects.toThrow('not connected text');
    await flush();
    const logs = r.surface.logs.length;
    const channels = r.surface.channels.length;
    await r.c.stop();
    await advance(10_000);
    await assertion;
    expect(r.surface.channels).toHaveLength(channels);
    expect(r.surface.logs).toHaveLength(logs);
    expect(r.surface.errors).toEqual([]);
  });
});

describe('channel sync from the device', () => {
  it('sets the tile from the first status without a trigger', async () => {
    const r = await online(5);
    expect(r.surface.channels).toEqual(['custom']);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.logs).toContain('[device] channel <- device: custom');
    expect(r.c.getChannel()).toBe('custom');
  });

  it('sets the tile and fires the trigger when the device changes the channel, once per change', async () => {
    const r = await online(0);
    r.t.emitData(statusFrame(50, 5));
    r.t.emitData(statusFrame(50, 5));
    expect(r.surface.channels).toEqual(['clock', 'custom']);
    expect(r.surface.channelChanges).toEqual(['custom']);
    r.t.emitData(statusFrame(50, 1));
    expect(r.surface.channels).toEqual(['clock', 'custom', 'lighting']);
    expect(r.surface.channelChanges).toEqual(['custom', 'lighting']);
  });

  it('sees a change made on the device at the next poll', async () => {
    const r = await online(0);
    r.device.channel = 5;
    await advance(60_000);
    expect(r.surface.channels).toEqual(['clock', 'custom']);
    expect(r.surface.channelChanges).toEqual(['custom']);
  });

  it('leaves the tile unchanged for an unknown code and logs each new code once', async () => {
    const r = await online(0);
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 3));
    r.t.emitData(statusFrame(50, 3));
    r.t.emitData(statusFrame(50, 9));
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.logs.filter((l) => l.includes('is not a known channel'))).toEqual([
      '[device] channel code 0x03 is not a known channel, tile unchanged',
      '[device] channel code 0x09 is not a known channel, tile unchanged',
    ]);
    // Back on the known channel: nothing to do, and a later unknown code is logged again.
    r.t.emitData(statusFrame(50, 0));
    expect(r.surface.channels).toEqual([]);
    r.t.emitData(statusFrame(50, 3));
    expect(r.surface.logs.filter((l) => l.includes('code 0x03'))).toHaveLength(2);
  });

  it('survives a surface failure without breaking the link logic', async () => {
    const r = await online(0);
    r.surface.setChannel = () => {
      throw new Error('boom');
    };
    r.t.emitData(statusFrame(50, 5));
    expect(r.surface.errors).toEqual(['[device] surface call failed: boom']);
    expect(r.surface.channelChanges).toEqual(['custom']);
  });

  it('makes no surface call after stop', async () => {
    const r = await online(0);
    await r.c.stop();
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 5));
    expect(r.surface.channels).toEqual([]);
  });
});

describe('modes that are not offered (cloud 02, visualizer 04)', () => {
  const otherLogs = (r: Rig) => r.surface.logs.filter((l) => l.includes('mode not offered'));

  it('clears the tile once, fires no trigger and reports no mode; repeats change nothing', async () => {
    const r = await online(0);
    r.t.emitData(statusFrame(50, 2));
    expect(r.surface.channelClears).toBe(1);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.c.getChannel()).toBeNull();
    expect(r.c.onOtherMode()).toBe(true);
    expect(otherLogs(r)).toEqual(['[device] channel <- device: cloud (mode not offered), tile cleared']);
    r.t.emitData(statusFrame(50, 2));
    r.t.emitData(statusFrame(50, 2));
    expect(r.surface.channelClears).toBe(1);
    expect(otherLogs(r)).toHaveLength(1);
    expect(r.surface.channels).toEqual(['clock']);
  });

  it('logs the next removed mode once more but neither clears again nor fires', async () => {
    const r = await online(0);
    r.t.emitData(statusFrame(50, 2));
    r.t.emitData(statusFrame(50, 4));
    r.t.emitData(statusFrame(50, 4));
    expect(r.surface.channelClears).toBe(1);
    expect(r.surface.channelChanges).toEqual([]);
    expect(otherLogs(r)).toEqual([
      '[device] channel <- device: cloud (mode not offered), tile cleared',
      '[device] channel <- device: visualizer (mode not offered), tile cleared',
    ]);
  });

  it('writes the tile and fires the trigger once when the device returns to an offered mode, also the same as before', async () => {
    const r = await online(0);
    r.t.emitData(statusFrame(50, 2));
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 0));
    r.t.emitData(statusFrame(50, 0));
    expect(r.surface.channels).toEqual(['clock']);
    expect(r.surface.channelChanges).toEqual(['clock']);
    expect(r.c.getChannel()).toBe('clock');
    expect(r.c.onOtherMode()).toBe(false);
    r.t.emitData(statusFrame(50, 4));
    r.t.emitData(statusFrame(50, 1));
    expect(r.surface.channelChanges).toEqual(['clock', 'lighting']);
  });

  it('clears the tile without a trigger from the first status of a run, and fires the trigger when it returns', async () => {
    const r = await online(4);
    expect(r.surface.channelClears).toBe(1);
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.c.getChannel()).toBeNull();
    r.t.emitData(statusFrame(50, 5));
    expect(r.surface.channels).toEqual(['custom']);
    expect(r.surface.channelChanges).toEqual(['custom']);
  });

  it('sees a removed mode at the next poll', async () => {
    const r = await online(0);
    r.device.channel = 4;
    await advance(60_000);
    expect(r.surface.channelClears).toBe(1);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('a switch from the tile to the last offered mode writes the tile and fires the trigger', async () => {
    const r = await online(0);
    r.t.emitData(statusFrame(50, 2));
    r.surface.channels.length = 0;
    await r.c.setChannel('clock');
    expect(r.surface.channels).toEqual(['clock']);
    expect(r.surface.channelChanges).toEqual(['clock']);
    expect(r.c.getChannel()).toBe('clock');
    expect(r.c.onOtherMode()).toBe(false);
    await r.c.setChannel('clock');
    expect(r.surface.channelChanges).toEqual(['clock']);
  });

  it('logs the removed mode by name in a confirm mismatch', async () => {
    const r = await online(0);
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(50, 2)] : undefined);
    await r.c.setChannel('lighting');
    expect(r.surface.logs).toContain('[device] channel mismatch: device cloud, requested lighting');
  });

  it('survives a failing clear without breaking the link logic', async () => {
    const r = await online(0);
    r.surface.clearChannel = () => {
      throw new Error('boom');
    };
    r.t.emitData(statusFrame(50, 2));
    expect(r.surface.errors).toEqual(['[device] surface call failed: boom']);
    r.t.emitData(statusFrame(50, 0));
    expect(r.surface.channelChanges).toEqual(['clock']);
  });

  it('rejects the removed modes as ids and sends nothing', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    for (const id of ['cloud', 'visualizer', 'scoreboard']) {
      await expect(r.c.setChannel(id as unknown as ChannelId)).rejects.toThrow(RangeError);
    }
    expect(r.t.writes).toHaveLength(0);
  });
});
