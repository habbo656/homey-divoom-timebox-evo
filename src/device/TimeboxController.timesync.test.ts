import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { DAILY_SYNC_MS, SYNC_RETRY_MS } from './timeSync';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** 2026-10-06 13:45:30 in Berlin, a Tuesday (the golden vector of the `18` command). */
const T0 = '2026-10-06T11:45:30Z';
const GOLDEN = [0x18, 0x1a, 0x14, 0x0a, 0x06, 0x0d, 0x2d, 0x1e, 0x02];
const SYNC_LOG = /^\[device\] time synced \((.+)\): /;

const syncs = (r: Rig): string[] => r.surface.logs.filter((l) => SYNC_LOG.test(l)).map((l) => SYNC_LOG.exec(l)![1]);

async function started(options: Parameters<typeof rig>[1] = {}, time = T0): Promise<Rig> {
  vi.setSystemTime(new Date(time));
  const r = rig({}, options);
  r.c.start();
  await flush();
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('time sync on connect', () => {
  it('sends 18 with the local time on the first status reply, once, and logs zone and offset', async () => {
    const r = await started();
    expect(r.device.times).toEqual([GOLDEN]);
    expect(r.surface.logs).toContain('[device] time synced (connect): 2026-10-06 13:45:30 Europe/Berlin UTC+02:00');
    await advance(10 * 60_000); // polls (46 replies) do not sync again
    expect(r.device.times).toHaveLength(1);
    await r.c.stop();
  });

  it('syncs again after a reconnect', async () => {
    const r = await started();
    r.t.dropLink();
    await advance(1_000);
    expect(r.m.state).toBe('connected');
    expect(r.device.times).toHaveLength(2);
    expect(syncs(r)).toEqual(['connect', 'connect']);
    await r.c.stop();
  });

  it('does not sync while the setting is off, not even daily', async () => {
    const r = await started({ timeSync: false });
    expect(r.device.times).toEqual([]);
    await advance(DAILY_SYNC_MS + 120_000);
    expect(r.device.times).toEqual([]);
    expect(syncs(r)).toEqual([]);
    await r.c.stop();
  });
});

describe('the time_sync setting', () => {
  it('switching it on while online syncs at once, switching it off stops the automatic syncs', async () => {
    const r = await started({ timeSync: false });
    r.c.setTimeSyncEnabled(true);
    await flush();
    expect(syncs(r)).toEqual(['setting']);
    expect(r.device.times).toHaveLength(1);
    r.c.setTimeSyncEnabled(true); // unchanged: nothing
    await flush();
    expect(r.device.times).toHaveLength(1);
    r.c.setTimeSyncEnabled(false);
    await advance(DAILY_SYNC_MS + 120_000);
    expect(r.device.times).toHaveLength(1);
    await r.c.stop();
  });

  it('switching it on while offline sends nothing; the connect sync follows', async () => {
    vi.setSystemTime(new Date(T0));
    const r = rig({}, { timeSync: false });
    r.c.setTimeSyncEnabled(true);
    await flush();
    expect(r.t.writes).toEqual([]);
    r.c.start();
    await flush();
    expect(syncs(r)).toEqual(['connect']);
    await r.c.stop();
  });
});

describe('automatic re-sync', () => {
  it('syncs 24 h after the last sync', async () => {
    const r = await started();
    await advance(DAILY_SYNC_MS - 60_000);
    expect(r.device.times).toHaveLength(1);
    await advance(120_000);
    expect(syncs(r)).toEqual(['connect', 'daily']);
    expect(r.device.times).toHaveLength(2);
    await r.c.stop();
  });

  it('syncs when the UTC offset changes (DST end in Berlin), within a minute', async () => {
    const r = await started({}, '2026-10-25T00:58:00Z');
    expect(r.surface.logs).toContain('[device] time synced (connect): 2026-10-25 02:58:00 Europe/Berlin UTC+02:00');
    await advance(60_000); // 00:59:00Z, still summer time
    expect(r.device.times).toHaveLength(1);
    await advance(120_000);
    expect(syncs(r)).toEqual(['connect', 'offset change']);
    expect(r.surface.logs.at(-1)).toMatch(
      /^\[device\] time synced \(offset change\): 2026-10-25 02:0\d:00 Europe\/Berlin UTC\+01:00$/,
    );
    await r.c.stop();
  });

  it('syncs when the time zone changes, even to one with the same offset', async () => {
    const r = await started();
    r.surface.zone = 'Europe/Paris';
    await advance(60_000);
    expect(syncs(r)).toEqual(['connect', 'zone change']);
    r.surface.zone = 'Asia/Kolkata';
    await advance(60_000);
    expect(syncs(r)).toEqual(['connect', 'zone change', 'zone change']);
    expect(r.surface.logs.at(-1)).toContain('Asia/Kolkata UTC+05:30');
    await r.c.stop();
  });

  it('does not check while the Timebox is offline', async () => {
    const r = await started();
    r.c.setTimeSyncEnabled(true);
    r.t.dropLink();
    r.t.failNextOpen();
    r.surface.zone = 'Asia/Tokyo';
    await advance(500);
    expect(r.device.times).toHaveLength(1);
    await r.c.stop();
  });
});

describe('concurrent syncs', () => {
  it('switching the setting on during the connect sync shares its command: one 18', async () => {
    vi.setSystemTime(new Date(T0));
    const r = rig();
    r.device.ackTime = false;
    r.c.start();
    await flush(); // the connect sync waits for its acknowledgement
    r.c.setTimeSyncEnabled(false);
    r.c.setTimeSyncEnabled(true);
    await advance(5_000);
    expect(r.device.times).toHaveLength(1);
    expect(syncs(r)).toEqual(['connect']);
    await r.c.stop();
  });
});

describe('failures', () => {
  it('an unknown time zone at connect sends nothing, is logged not thrown, keeps the device available and is retried after 15 min', async () => {
    vi.setSystemTime(new Date(T0));
    const r = rig();
    r.surface.zone = 'Mars/Olympus';
    r.c.start();
    await flush();
    expect(r.device.times).toEqual([]);
    expect(r.surface.calls).toEqual(['available']);
    expect(r.surface.errors).toEqual([]);
    expect(r.surface.logs.some((l) => l.startsWith('[device] time sync failed: '))).toBe(true);
    r.surface.zone = 'Europe/Berlin';
    await advance(SYNC_RETRY_MS - 120_000);
    expect(r.device.times).toHaveLength(0);
    await advance(180_000);
    expect(r.device.times).toHaveLength(1);
    expect(syncs(r)).toEqual(['retry']);
    await r.c.stop();
  });

  it('a link that drops during the connect sync logs the failure; the reconnect syncs again (connect), no 15 min retry is left', async () => {
    vi.setSystemTime(new Date(T0));
    const r = rig();
    r.device.ackTime = false;
    r.c.start();
    await flush(); // the connect sync waits for its acknowledgement
    expect(r.device.times).toHaveLength(1);
    r.t.dropLink();
    await advance(1_000); // the sync fails, the link reconnects and the new session sends the time again
    expect(r.surface.logs.filter((l) => l.startsWith('[device] time sync failed: '))).toHaveLength(1);
    expect(r.m.state).toBe('connected');
    expect(r.device.times).toHaveLength(2);
    await advance(5_000); // the second sync is not acknowledged either: counts as synced
    expect(syncs(r)).toEqual(['connect']);
    await advance(SYNC_RETRY_MS + 120_000);
    expect(r.device.times).toHaveLength(2); // nothing is retried: the failure was cleared by the successful sync
    expect(r.surface.logs.filter((l) => l.startsWith('[device] time sync failed: '))).toHaveLength(1);
    await r.c.stop();
  });

  it('an unknown zone that appears after a sync is logged once, then only every 15 min', async () => {
    const r = await started();
    const failed = () => r.surface.logs.filter((l) => l.startsWith('[device] time sync failed: ')).length;
    r.surface.zone = 'Mars/Olympus';
    await advance(60_000); // first check sees it
    expect(failed()).toBe(1);
    await advance(SYNC_RETRY_MS - 120_000);
    expect(failed()).toBe(1);
    await advance(180_000); // retry delay over
    expect(failed()).toBe(2);
    await advance(SYNC_RETRY_MS - 120_000);
    expect(failed()).toBe(2);
    expect(r.device.times).toHaveLength(1);
    await r.c.stop();
  });

  it('an unknown zone at connect is not logged again every minute', async () => {
    vi.setSystemTime(new Date(T0));
    const r = rig();
    r.surface.zone = 'Mars/Olympus';
    r.c.start();
    await advance(SYNC_RETRY_MS - 120_000);
    expect(r.surface.logs.filter((l) => l.startsWith('[device] time sync failed: '))).toHaveLength(1);
    await r.c.stop();
  });

  it('a sync interrupted by stop() is not logged as a failure', async () => {
    vi.setSystemTime(new Date(T0));
    const r = rig();
    r.device.ackTime = false;
    r.c.start();
    await flush(); // the connect sync waits for its acknowledgement
    await r.c.stop();
    await advance(10_000);
    expect(r.surface.logs.some((l) => l.includes('time sync failed'))).toBe(false);
  });

  it('a missing acknowledgement is logged, counts as synced and is not retried', async () => {
    vi.setSystemTime(new Date(T0));
    const r = rig();
    r.device.ackTime = false;
    r.c.start();
    await advance(5_000);
    expect(r.surface.logs).toContain('[device] time sync not confirmed');
    expect(syncs(r)).toEqual(['connect']);
    await advance(SYNC_RETRY_MS * 2);
    expect(r.device.times).toHaveLength(1);
    expect(r.surface.logs.some((l) => l.startsWith('[device] time sync failed'))).toBe(false);
    await r.c.stop();
  });
});

describe('stop', () => {
  it('clears the check timer: no sync after stop()', async () => {
    const r = await started();
    await r.c.stop();
    r.surface.zone = 'Asia/Tokyo';
    await advance(DAILY_SYNC_MS + 120_000);
    expect(r.device.times).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
