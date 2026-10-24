import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { CHANNEL_CONFIRM_TIMEOUT_MS, STATUS_POLL_INTERVAL_MS } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller on the clock whose first status reply has been processed; writes, logs and tile calls cleared. */
async function online(): Promise<Rig> {
  const r = rig();
  r.device.channel = 0;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  clear(r);
  return r;
}

function clear(r: Rig): void {
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  for (const list of [r.surface.channels, r.surface.channelChanges, r.surface.colors, r.surface.onoffs])
    list.length = 0;
}

/** The payloads written since the last reset (chunks joined back into envelopes), as hex. */
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
const RAIN = { temperatureC: 21, condition: 'rain' } as const;

/**
 * Start the noise meter while the simulated Evo reports d0 `code` under it (the simulator does not know `72 02 01` and
 * keeps its channel, so the code is set beforehand).
 */
async function startNoise(r: Rig, code: number): Promise<void> {
  r.device.channel = code;
  await r.c.setChannel('noise_meter');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('switching to the noise meter', () => {
  it('sends 72 02 01 and no 45, confirms with any d0, fires the trigger and stores the shadow', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    expect(sent(r)).toEqual(['72 02 01', '46']);
    expect(r.c.getChannel()).toBe('noise_meter');
    expect(r.surface.channels).toEqual([]); // Homey writes the mode tile when the listener resolves
    expect(r.surface.channelChanges).toEqual(['noise_meter']);
    expect(r.surface.colors).toEqual([]); // no colour for the noise meter
    expect(r.surface.logs).toContain('[device] channel -> noise_meter: 72 02 01');
    expect(r.surface.logs).toContain('[device] channel confirmed: noise_meter (device reports channel code 0x09)');
    expect(logs(r, 'channel mismatch')).toEqual([]);
  });

  it('works with a d0 that equals a mode code: the clock code is the shadow too', async () => {
    const r = await online();
    await startNoise(r, 0x00);
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.getChannel()).toBe('noise_meter');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
  });
});

describe('device reports while the noise meter is tracked (the noise shadow)', () => {
  it('ignores reports equal to the shadow and codes that are neither a mode nor a removed mode', async () => {
    const r = await online();
    await startNoise(r, 0x01);
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    r.device.channel = 0x09; // text, games, ...
    await advance(STATUS_POLL_INTERVAL_MS);
    r.device.channel = 0x01;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.getChannel()).toBe('noise_meter');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(logs(r, 'noise meter ended')).toEqual([]);
    expect(logs(r, 'not a known channel')).toEqual([]);
  });

  it('a different known code is a mode change at the device: the tracking ends and the report is handled', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    clear(r);
    r.device.channel = 0x05; // custom
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'noise meter ended (device mode change): channel code 0x09 -> 0x05')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('custom');
    expect(r.surface.channels).toEqual(['custom']);
    expect(r.surface.channelChanges).toEqual(['custom']);
    // The tracking is over: the same code later is an ordinary report again.
    r.device.channel = 0x09;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'not a known channel')).toHaveLength(1);
  });

  it('a removed mode (cloud) other than the shadow ends the tracking and enters the other-mode state', async () => {
    const r = await online();
    await startNoise(r, 0x00);
    clear(r);
    r.device.channel = 0x02;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'noise meter ended (device mode change): channel code 0x00 -> 0x02')).toHaveLength(1);
    expect(r.c.onOtherMode()).toBe(true);
    expect(r.surface.channelClears).toBe(1);
  });

  it('keeps the noise meter across a reconnect when the first status equals the shadow', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    clear(r);
    r.t.dropLink();
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(r.c.getChannel()).toBe('noise_meter');
    expect(r.surface.channels).toEqual([]);
    expect(logs(r, 'noise meter ended')).toEqual([]);
  });

  it('ends the tracking when the first status of a new session is a different known code', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    clear(r);
    r.t.dropLink();
    r.device.channel = 0x01; // the Evo was power-cycled meanwhile
    await advance(10_000);
    expect(logs(r, 'noise meter ended (device mode change): channel code 0x09 -> 0x01')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channelChanges).toEqual(['lighting']);
  });
});

describe('an unconfirmed noise meter', () => {
  it('rejects with not_confirmed, keeps the mode, and the first later report becomes the shadow', async () => {
    const r = await online();
    r.device.channel = 0x09;
    r.device.answer = false;
    const settled = r.c.setChannel('noise_meter').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await settled).toBe('not confirmed text');
    expect(r.surface.logs).toContain('[device] channel confirm timeout');
    expect(r.c.getChannel()).toBe('noise_meter');
    expect(r.surface.channelChanges).toEqual(['noise_meter']);
    r.device.answer = true;
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'noise meter shadow: device reports channel code 0x09')).toHaveLength(1);
    expect(r.surface.channels).toEqual([]);
    r.device.channel = 0x00;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'noise meter ended (device mode change): channel code 0x09 -> 0x00')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('clock');
  });
});

describe('ending the noise meter from the app', () => {
  it('any other mode change ends it', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    clear(r);
    await r.c.setChannel('lighting');
    expect(logs(r, 'noise meter ended (mode change)')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('lighting');
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS); // d0 is lighting now: an ordinary report
    expect(r.c.getChannel()).toBe('lighting');
  });

  it('a tile colour change switches to lighting with the colour', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    clear(r);
    await expect(r.c.setTileColor(0, 1)).resolves.toBe('lighting');
    expect(sent(r)).toEqual(['45 01 ff 00 00 32 00 01 00 00 00', '46']);
    expect(logs(r, 'noise meter ended (mode change)')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('lighting');
  });

  it('power off ends it and power on sends the noise meter again', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    clear(r);
    await r.c.setPower(false);
    expect(logs(r, 'noise meter ended (power off)')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('noise_meter'); // the mode from before off
    expect(r.surface.channels).toEqual([]);
    clear(r);
    r.device.channel = 0x09;
    await r.c.setPower(true);
    expect(sent(r)).toEqual(['72 02 01', '46']);
    expect(r.c.isOn()).toBe(true);
    expect(logs(r, 'channel confirmed: noise_meter (device reports channel code 0x09)')).toHaveLength(1);
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.surface.channels).toEqual([]);
    expect(r.c.getChannel()).toBe('noise_meter');
  });

  it('stopping a countdown sends the noise meter again', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    await r.c.startCountdown({ minutes: 1, seconds: 0 });
    clear(r);
    await r.c.stopCountdown();
    expect(sent(r)).toEqual(['72 03 00 00 00', '72 02 01', '46']);
    expect(r.c.getChannel()).toBe('noise_meter');
  });
});

describe('weather while the noise meter is shown', () => {
  it('is held, and sent when the noise meter ends', async () => {
    const r = await online();
    await startNoise(r, 0x09);
    clear(r);
    await r.c.setWeather(RAIN, 'flow');
    expect(logs(r, 'weather held (noise meter shown)')).toHaveLength(1);
    expect(sent(r).filter((p) => p.startsWith('5f'))).toEqual([]);
    await r.c.setChannel('clock');
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(sent(r).filter((p) => p.startsWith('5f'))).toEqual(['5f 15 06']);
  });
});
