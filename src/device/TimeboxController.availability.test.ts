import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportError } from '../transport/Transport';
import { statusFrame } from '../transport/__fixtures__/frames';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { STATUS_POLL_INTERVAL_MS, UNAVAILABLE_GRACE_MS } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const UNREACHABLE = 'unavailable:unreachable text';
const NOT_TIMEBOX = 'unavailable:not a timebox text';

/** Make every following `open` fail transiently until `restore()` is called. */
function breakOpen(r: Rig, error: () => Error = () => new TransportError('device not found')) {
  const original = r.t.open.bind(r.t);
  r.t.open = async () => {
    r.t.opens++;
    throw error();
  };
  return () => {
    r.t.open = original;
  };
}

async function online(): Promise<Rig> {
  const r = rig();
  r.c.start();
  await flush();
  expect(r.surface.calls).toEqual(['available']);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('availability', () => {
  it('uses a 30 s grace period', () => {
    expect(UNAVAILABLE_GRACE_MS).toBe(30_000);
  });

  it('is neither available nor unavailable before the first status', async () => {
    const r = rig();
    r.t.hangNextOpen();
    r.c.start();
    await advance(UNAVAILABLE_GRACE_MS - 1);
    expect(r.surface.calls).toEqual([]);
    await r.c.stop();
  });

  it('becomes available once, after connect and the first status, without a trigger at startup', async () => {
    const r = rig();
    const events: string[] = [];
    r.m.on('connected', () => events.push(`connected:${r.surface.calls.length}`));
    r.c.start();
    await flush();
    expect(events).toEqual(['connected:0']);
    expect(r.surface.calls).toEqual(['available']);
    expect(r.surface.logs).toContain('[device] available');
    r.t.emitData(statusFrame(50, 0));
    await advance(180_000);
    expect(r.surface.calls).toEqual(['available']);
  });

  it('stays available and silent when the link drops and reconnects within the grace period', async () => {
    const r = await online();
    r.t.dropLink();
    await advance(1_000); // reconnect + poll answer
    expect(r.m.state).toBe('connected');
    await advance(120_000);
    expect(r.surface.calls).toEqual(['available']);
  });

  it('goes unavailable once after the grace period when reconnects fail, then available with a trigger', async () => {
    const r = await online();
    const restore = breakOpen(r);
    r.t.dropLink();
    await advance(UNAVAILABLE_GRACE_MS - 1);
    expect(r.surface.calls).toEqual(['available']);
    await advance(1);
    expect(r.surface.calls).toEqual(['available', UNREACHABLE, 'online:false']);
    expect(r.surface.logs.some((l) => l.startsWith('[device] unavailable: '))).toBe(true);
    await advance(120_000);
    expect(r.surface.calls).toEqual(['available', UNREACHABLE, 'online:false']);

    restore();
    await advance(60_000);
    expect(r.m.state).toBe('connected');
    expect(r.surface.calls).toEqual(['available', UNREACHABLE, 'online:false', 'available', 'online:true']);
  });

  it('logs the reason of the unavailable decision', async () => {
    const r = await online();
    breakOpen(r, () => new TransportError('device not found'));
    r.t.dropLink();
    await advance(UNAVAILABLE_GRACE_MS);
    expect(r.surface.logs).toContain('[device] unavailable: device not found');
  });

  it('goes unavailable at startup after the grace period without a trigger', async () => {
    const r = rig();
    breakOpen(r);
    r.c.start();
    await advance(UNAVAILABLE_GRACE_MS);
    expect(r.surface.calls).toEqual([UNREACHABLE]);
    await advance(120_000);
    expect(r.surface.calls).toEqual([UNREACHABLE]);
    await r.c.stop();
  });

  it('a later connect after a startup expiry makes it available with a trigger', async () => {
    const r = rig();
    const restore = breakOpen(r);
    r.c.start();
    await advance(UNAVAILABLE_GRACE_MS);
    restore();
    await advance(60_000);
    expect(r.surface.calls).toEqual([UNREACHABLE, 'available', 'online:true']);
  });

  it('goes unavailable immediately on a permanent connect error, once, and recovers', async () => {
    const r = rig();
    r.t.failNextOpen(new TransportError('GATT service missing', true));
    r.c.start();
    await flush();
    expect(r.surface.calls).toEqual([NOT_TIMEBOX]);
    expect(r.surface.logs).toContain('[device] unavailable: GATT service missing (permanent)');
    // No second decision from the grace timer, none from the next permanent retry.
    r.t.failNextOpen(new TransportError('GATT service missing', true));
    await advance(300_000 + UNAVAILABLE_GRACE_MS);
    expect(r.surface.calls).toEqual([NOT_TIMEBOX]);
    await advance(300_000);
    expect(r.surface.calls).toEqual([NOT_TIMEBOX, 'available', 'online:true']);
  });

  it('a permanent error of an online device is unavailable at once with a disconnected trigger', async () => {
    const r = await online();
    r.t.dropLink();
    r.t.failNextOpen(new TransportError('GATT service missing', true));
    await advance(1_000);
    expect(r.surface.calls).toEqual(['available', NOT_TIMEBOX, 'online:false']);
  });

  it('a connected but silent device never becomes available', async () => {
    const r = rig();
    r.device.answer = false;
    r.c.start();
    await advance(UNAVAILABLE_GRACE_MS);
    expect(r.m.state).toBe('connected');
    expect(r.surface.calls).toEqual([UNREACHABLE]);
    await advance(300_000);
    expect(r.surface.calls).not.toContain('available');
    await r.c.stop();
  });

  it('a reconnect that stays silent still ends in unavailable', async () => {
    const r = await online();
    r.device.answer = false;
    r.t.dropLink();
    await advance(1_000);
    expect(r.m.state).toBe('connected');
    await advance(UNAVAILABLE_GRACE_MS);
    expect(r.surface.calls).toEqual(['available', UNREACHABLE, 'online:false']);
    await r.c.stop();
  });

  it('logs a failing surface call and continues', async () => {
    const r = rig();
    r.surface.setAvailable = () => {
      throw new Error('boom');
    };
    r.c.start();
    await flush();
    expect(r.surface.errors).toEqual(['[device] surface call failed: boom']);
    await r.c.stop();
  });
});

describe('isConnected', () => {
  it('follows the online state (session answered), like availability and the triggers', async () => {
    const r = rig();
    expect(r.c.isConnected()).toBe(false);
    r.device.answer = false; // GATT connects, but the Timebox never answers a status query
    r.c.start();
    await flush();
    expect(r.m.state).toBe('connected');
    expect(r.c.isConnected()).toBe(false);
    r.device.answer = true;
    r.t.emitData(statusFrame(50, 0));
    expect(r.c.isConnected()).toBe(true);
    breakOpen(r);
    r.t.dropLink();
    // The link is down but the grace period has not expired: still online (no flapping, no trigger yet).
    expect(r.c.isConnected()).toBe(true);
    await advance(UNAVAILABLE_GRACE_MS);
    expect(r.c.isConnected()).toBe(false);
    expect(r.surface.calls).toContain('online:false');
    await r.c.stop();
    expect(r.c.isConnected()).toBe(false);
  });
});

describe('stop', () => {
  it('clears timers and listeners, is idempotent and makes no surface call afterwards', async () => {
    const r = await online();
    r.t.dropLink(); // arms the grace timer
    await r.c.stop();
    await r.c.stop();
    r.surface.calls.length = 0;
    await advance(300_000);
    expect(r.surface.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    for (const event of ['status', 'reply', 'connected', 'disconnected', 'connectFailed'] as const) {
      expect(r.m.listenerCount(event)).toBe(0);
    }
    r.t.emitData(statusFrame(1, 0));
    expect(r.surface.dims).toEqual([0.5]);
  });

  it('cancels the startup grace timer', async () => {
    const r = rig();
    breakOpen(r);
    r.c.start();
    await r.c.stop();
    await advance(300_000);
    expect(r.surface.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start after stop does nothing', async () => {
    const r = rig();
    await r.c.stop();
    r.c.start();
    await flush();
    expect(r.t.opens).toBe(0);
  });
});

describe('STATUS_POLL_INTERVAL_MS', () => {
  it('is fixed at 60 s (#70)', () => {
    expect(STATUS_POLL_INTERVAL_MS).toBe(60_000);
  });
});
