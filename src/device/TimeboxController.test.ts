import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportError } from '../transport/Transport';
import { opcodeOf, replyFrame, statusFrame } from '../transport/__fixtures__/frames';
import { brightnessToDim, DIM_SEND_TIMEOUT_MS, dimToBrightness } from './TimeboxController';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply has been processed. */
async function online(initialBrightness = 50): Promise<Rig> {
  const r = rig({}, {}, initialBrightness);
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dim mapping', () => {
  it('rounds 0..1 to 0..100', () => {
    expect(dimToBrightness(0)).toBe(0);
    expect(dimToBrightness(1)).toBe(100);
    expect(dimToBrightness(0.5)).toBe(50);
    expect(dimToBrightness(0.555)).toBe(56);
    expect(dimToBrightness(0.004)).toBe(0);
  });

  it('rejects everything else with a RangeError', () => {
    for (const bad of [Number.NaN, -0.1, 1.1, Infinity, '0.5', null, undefined]) {
      expect(() => dimToBrightness(bad)).toThrow(RangeError);
    }
  });

  it('maps brightness back and clamps out-of-range values, reporting the raw value', () => {
    const clamped: number[] = [];
    expect(brightnessToDim(0)).toBe(0);
    expect(brightnessToDim(100)).toBe(1);
    expect(brightnessToDim(56, (v) => clamped.push(v))).toBe(0.56);
    expect(clamped).toEqual([]);
    expect(brightnessToDim(126, (v) => clamped.push(v))).toBe(1);
    expect(brightnessToDim(-3, (v) => clamped.push(v))).toBe(0);
    expect(clamped).toEqual([126, -3]);
    expect(() => brightnessToDim(Number.NaN)).toThrow(RangeError);
  });
});

describe('setDim', () => {
  it('writes 74 32, then queries 46, and logs the confirmation', async () => {
    const r = await online();
    r.t.writes.length = 0;
    await r.c.setDim(0.5);
    expect(r.t.writes.map((w) => opcodeOf(w))).toEqual([0x74, 0x46]);
    expect(r.t.writes[0][12]).toBe(0x32);
    expect(r.surface.logs).toContain('[device] dim confirmed: 50');
  });

  it('does not write the capability value itself', async () => {
    const r = await online(10);
    r.surface.dims.length = 0;
    await r.c.setDim(0.8);
    expect(r.surface.dims).toEqual([]);
    expect(r.device.brightness).toBe(80);
  });

  it('logs a mismatch if the device reports something else', async () => {
    const r = await online();
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(33, 0)] : undefined);
    await r.c.setDim(0.8);
    expect(r.surface.logs).toContain('[device] dim mismatch: device 33, requested 80');
  });

  it('rejects an invalid dim before anything is written', async () => {
    const r = await online();
    r.t.writes.length = 0;
    await expect(r.c.setDim(Number.NaN)).rejects.toThrow(RangeError);
    await expect(r.c.setDim(1.1)).rejects.toThrow(/between 0 and 1/);
    await expect(r.c.setDim('0.5' as unknown as number)).rejects.toThrow(RangeError);
    expect(r.t.writes).toHaveLength(0);
  });

  it('gives a readable error and writes nothing while disconnected', async () => {
    const r = rig();
    r.c.start();
    r.t.failNextOpen(new TransportError('nope'));
    await flush();
    r.t.writes.length = 0;
    await expect(r.c.setDim(0.5)).rejects.toThrow('not connected text');
    expect(r.t.writes).toHaveLength(0);
    await r.c.stop();
  });

  it('gives a readable error before start and after stop', async () => {
    const r = rig();
    await expect(r.c.setDim(0.5)).rejects.toThrow('not connected text');
    r.c.start();
    await flush();
    await r.c.stop();
    await expect(r.c.setDim(0.5)).rejects.toThrow('not connected text');
  });

  it('maps a link lost during the send to the readable error', async () => {
    const r = await online();
    r.t.holdWrites();
    const p = r.c.setDim(0.5);
    const assertion = expect(p).rejects.toThrow('not connected text');
    await flush();
    r.t.dropLink();
    r.t.releaseWrites();
    await flush();
    await assertion;
    expect(r.surface.errors).toEqual([]);
  });

  it('fails readably when the write hangs and applies device reports again afterwards', async () => {
    const r = await online();
    r.t.holdWrites();
    const p = r.c.setDim(0.5);
    const assertion = expect(p).rejects.toThrow('not connected text');
    await advance(DIM_SEND_TIMEOUT_MS - 1);
    let settled = false;
    void p.catch(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await advance(1);
    await assertion;
    expect(r.surface.errors).toEqual([]);
    // inFlight is released: a device report is applied again.
    r.surface.dims.length = 0;
    r.t.emitData(statusFrame(20, 0));
    expect(r.surface.dims).toEqual([0.2]);
    // The abandoned write finishing late (or failing) is harmless.
    r.t.releaseWrites();
    await flush();
    await r.c.stop();
  });

  it('makes no log or surface call when stopped while a change is running', async () => {
    const r = await online();
    r.device.answer = false;
    const p = r.c.setDim(0.5);
    const rejected = expect(p).rejects.toThrow('not connected text'); // pending at stop (#151)
    await flush();
    const logs = r.surface.logs.length;
    await r.c.stop();
    await advance(10_000);
    await rejected;
    expect(r.surface.logs).toHaveLength(logs);
    expect(r.surface.errors).toEqual([]);
  });

  it('rejects with not_confirmed after a confirm timeout (#151)', async () => {
    const r = await online();
    r.device.answer = false;
    let done = false;
    const p = r.c.setDim(0.3).then(
      () => (done = true),
      (e: Error) => {
        done = true;
        return e.message;
      },
    );
    await advance(4_999);
    expect(done).toBe(false);
    await advance(1);
    expect(await p).toBe('not confirmed text');
    expect(r.surface.logs).toContain('[device] dim confirm timeout');
    expect(r.surface.errors).toEqual([]);
  });

  it('ignores a stale status while a change is in flight', async () => {
    const r = await online(50);
    r.surface.dims.length = 0;
    r.t.holdWrites();
    const p = r.c.setDim(0.9);
    await flush();
    r.t.emitData(statusFrame(20, 0));
    r.t.emitData(replyFrame(0x31, 20));
    expect(r.surface.dims).toEqual([]);
    r.t.releaseWrites();
    await p;
    expect(r.surface.dims).toEqual([]);
    expect(r.surface.logs).toContain('[device] dim confirmed: 90');
  });

  it('keeps the last of two quick changes', async () => {
    const r = await online(50);
    r.surface.dims.length = 0;
    const a = r.c.setDim(0.2);
    const b = r.c.setDim(0.7);
    await Promise.all([a, b]);
    expect(r.device.brightness).toBe(70);
    expect(r.surface.logs).toContain('[device] dim confirmed: 70');
    expect(r.surface.dims).toEqual([]);
    // The sent values are known now: an equal report does not call the surface.
    r.t.emitData(statusFrame(70, 0));
    expect(r.surface.dims).toEqual([]);
  });
});

describe('status sync', () => {
  it('copies the first reported brightness to dim and later changes', async () => {
    const r = await online(40);
    expect(r.surface.dims).toEqual([0.4]);
    expect(r.surface.logs).toContain('[device] dim <- device: 40');
    r.t.emitData(statusFrame(75, 0));
    expect(r.surface.dims).toEqual([0.4, 0.75]);
    r.t.emitData(replyFrame(0x31, 10));
    expect(r.surface.dims).toEqual([0.4, 0.75, 0.1]);
  });

  it('makes no call for an equal value', async () => {
    const r = await online(40);
    r.t.emitData(statusFrame(40, 0));
    r.t.emitData(replyFrame(0x31, 40));
    expect(r.surface.dims).toEqual([0.4]);
  });

  it('ignores a 31 report without data', async () => {
    const r = await online(40);
    r.t.emitData(replyFrame(0x31));
    expect(r.surface.dims).toEqual([0.4]);
  });

  it('ignores a 31 report with ok=false', async () => {
    const r = await online(40);
    // `04 31 00 0a`: status byte is not 55
    const payload = [0x04, 0x31, 0x00, 0x0a];
    const len = payload.length + 2;
    const body = [len & 0xff, len >> 8, ...payload];
    const crc = body.reduce((a, b) => a + b, 0) & 0xffff;
    r.t.emitData(Uint8Array.from([0x01, ...body, crc & 0xff, crc >> 8, 0x02]));
    expect(r.surface.dims).toEqual([0.4]);
  });

  it('clamps an out-of-range report and logs the raw value', async () => {
    const r = await online(40);
    r.t.emitData(statusFrame(126, 0));
    expect(r.surface.dims).toEqual([0.4, 1]);
    expect(r.surface.logs).toContain('[device] device brightness 126 out of range, clamped');
  });

  it('logs a failing surface call and keeps going', async () => {
    const r = rig();
    r.surface.setDimImpl = () => Promise.reject(new Error('homey says no'));
    r.c.start();
    await flush();
    expect(r.surface.errors).toEqual(['[device] surface call failed: homey says no']);
    r.t.emitData(statusFrame(10, 0));
    await flush();
    expect(r.surface.dims).toEqual([0.5, 0.1]);
  });

  it('does not touch the surface after stop', async () => {
    const r = await online(40);
    await r.c.stop();
    r.surface.dims.length = 0;
    r.t.emitData(statusFrame(10, 0));
    expect(r.surface.dims).toEqual([]);
    expect(r.m.listenerCount('status')).toBe(0);
    expect(r.m.listenerCount('reply')).toBe(0);
  });
});
