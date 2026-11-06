// Self-wake while off (#29): the firmware lights the panel by itself; `46` shows d0 = off shadow and d8 `01` again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceStatus } from '../protocol/status';
import { toHex } from '../protocol/hex';
import { statusFrame } from '../transport/__fixtures__/frames';
import { CHANNEL_CONFIRM_TIMEOUT_MS, MAX_OFF_RESENDS } from './TimeboxController';
import type { TimeboxControllerOptions } from './TimeboxController';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const OFF_RED_50 = '45 01 ff 00 00 32 00 00 00 00 00';
const WOKE = '[device] power <- device: woke while off (d8 01), sending off again';
const GAVE_UP = `[device] woke while off: off not taken after ${MAX_OFF_RESENDS} resends, giving up`;

/** A started controller whose first status reply (clock, lighting colour red, brightness 50) has been processed. */
async function online(opts: TimeboxControllerOptions = {}): Promise<Rig> {
  const r = rig({}, opts, 50);
  r.device.channel = 0;
  r.device.color = [0xff, 0, 0];
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

/** The `46` report of a panel that lit itself while off: d0 `01` (the off shadow), d8 `01`. */
const wake = (d0 = 1) => statusFrame(50, d0, { 3: 0xff, 8: 1 });
/** The `46` report of a panel that stays off: d0 `01`, d8 `00`. */
const dark = () => statusFrame(50, 1, { 3: 0xff, 8: 0 });

/** The device ignores the off command: it reports d8 `01` again after every one. */
function stubbornDevice(r: Rig): void {
  const reply = r.t.autoReply;
  r.t.autoReply = (w) => {
    const out = reply?.(w);
    r.device.power = true;
    return out;
  };
}

const offWrites = (r: Rig) => payloads(r).filter((p) => p === OFF_RED_50);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('self-wake while off (#29)', () => {
  it('sends the off again once (same bytes), then 46; the tile stays off and no trigger fires', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    r.surface.channelChanges.length = 0;
    r.device.power = true; // the firmware lit the panel; the next 46 report carries d8 01
    r.t.emitData(wake());
    await flush();
    expect(payloads(r)).toEqual([OFF_RED_50, '46']);
    expect(r.surface.logs).toContain(WOKE);
    expect(r.surface.logs).toContain(`[device] power -> off: ${OFF_RED_50}`);
    expect(r.device.power).toBe(false);
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.logs).not.toContain('[device] power <- device: on');
    // The next polls report the panel dark again: nothing more is sent.
    r.t.writes.length = 0;
    r.t.emitData(dark());
    await flush();
    expect(r.t.writes).toHaveLength(0);
  });

  it('also reacts to the 60 s poll', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.device.power = true;
    await advance(60_000);
    expect(offWrites(r)).toHaveLength(1);
    expect(r.surface.logs).toContain(WOKE);
    expect(r.device.power).toBe(false);
  });

  it('a report with d8 00 while off sends nothing', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.t.emitData(dark());
    await advance(60_000);
    expect(offWrites(r)).toHaveLength(0);
    expect(r.surface.logs).not.toContain(WOKE);
  });

  it('d8 01 with another known d0 is a switch on at the device: onoff true, no resend', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.t.emitData(statusFrame(50, 5, { 3: 0xff, 8: 1 }));
    await flush();
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.onoffs).toEqual([true, true]);
    expect(r.surface.logs).toContain('[device] power <- device: on');
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).not.toContain(WOKE);
  });

  it('while on, d8 01 does nothing', async () => {
    const r = await online();
    r.t.writes.length = 0;
    r.t.emitData(wake(0));
    r.t.emitData(wake(1));
    await advance(60_000);
    expect(offWrites(r)).toHaveLength(0);
    expect(r.surface.logs).not.toContain(WOKE);
    expect(r.c.isOn()).toBe(true);
  });

  it('a power on in flight: the report does not resend the off', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.t.holdWrites();
    const on = r.c.setPower(true);
    await flush();
    r.t.emitData(wake());
    r.t.releaseWrites();
    await on;
    await flush();
    expect(offWrites(r)).toHaveLength(0);
    expect(r.surface.logs).not.toContain(WOKE);
    expect(r.c.isOn()).toBe(true);
  });

  it('an off (resend) in flight: further reports send no second off', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.t.holdWrites();
    r.t.emitData(wake());
    await flush();
    r.t.emitData(wake());
    r.t.emitData(wake());
    r.t.releaseWrites();
    await flush();
    expect(offWrites(r)).toHaveLength(1);
    expect(r.surface.logs.filter((l) => l === WOKE)).toHaveLength(1);
  });

  it('a power on during the resend wins: the panel ends on', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.t.holdWrites();
    r.device.power = true;
    r.t.emitData(wake());
    await flush();
    const on = r.c.setPower(true);
    r.t.releaseWrites();
    await on;
    await flush();
    expect(r.c.isOn()).toBe(true);
    expect(r.device.power).toBe(true);
    expect(r.surface.onoffs.at(-1)).toBe(true);
  });

  it('stops after 3 resends in a row and logs it once; a report with d8 00 starts the count again', async () => {
    const r = await online();
    await r.c.setPower(false);
    stubbornDevice(r);
    r.t.writes.length = 0;
    for (let i = 0; i < MAX_OFF_RESENDS; i++) {
      r.t.emitData(wake());
      await flush();
    }
    expect(offWrites(r)).toHaveLength(MAX_OFF_RESENDS);
    expect(r.surface.logs).not.toContain(GAVE_UP);
    r.t.emitData(wake());
    r.t.emitData(wake());
    await flush();
    expect(offWrites(r)).toHaveLength(MAX_OFF_RESENDS);
    expect(r.surface.logs.filter((l) => l === GAVE_UP)).toHaveLength(1);

    r.t.emitData(dark());
    for (let i = 0; i < MAX_OFF_RESENDS + 1; i++) {
      r.t.emitData(wake());
      await flush();
    }
    expect(offWrites(r)).toHaveLength(2 * MAX_OFF_RESENDS);
    expect(r.surface.logs.filter((l) => l === GAVE_UP)).toHaveLength(2);
  });

  it('a power change (setPower) starts the count again', async () => {
    const r = await online();
    await r.c.setPower(false);
    stubbornDevice(r);
    for (let i = 0; i < MAX_OFF_RESENDS + 1; i++) {
      r.t.emitData(wake());
      await flush();
    }
    expect(r.surface.logs).toContain(GAVE_UP);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    await r.c.setPower(false); // stubborn: the report after it carries d8 01 again
    r.t.writes.length = 0;
    r.t.emitData(wake());
    await flush();
    expect(offWrites(r)).toHaveLength(1);
  });

  it('startup from stored off: the first report (shadow adopted, d8 01) sends the off', async () => {
    const r = rig({}, { powerOn: false, storedChannel: 'clock' }, 50);
    r.device.channel = 1;
    r.device.color = [0xff, 0, 0];
    r.device.power = true; // the panel lit itself while the app was away
    r.c.start();
    await flush();
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([false]);
    expect(r.surface.logs).toContain(WOKE);
    expect(offWrites(r)).toHaveLength(1);
    expect(r.device.power).toBe(false);
  });

  it('a resend whose confirm fails is only logged: no tile write to true, no rejection', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.device.answer = false;
    r.device.power = true;
    r.t.emitData(wake());
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(r.surface.logs).toContain('[device] power off confirm timeout');
    expect(r.surface.logs).toContain('[device] off resend failed: not confirmed text');
    expect(r.surface.onoffs.slice(1).every((v) => !v)).toBe(true);
    expect(r.c.isOn()).toBe(false);
  });

  it('not connected: nothing is sent, the failure is only logged', async () => {
    const r = await online();
    await r.c.setPower(false);
    r.t.dropLink();
    r.t.writes.length = 0;
    const onStatus = (r.c as unknown as { onStatus: (s: DeviceStatus) => void }).onStatus;
    onStatus({
      channel: 1,
      lightingColor: { r: 255, g: 0, b: 0 },
      brightness: 50,
      powerByte: 1,
      visualization: 3,
      clockColor: { r: 0, g: 0, b: 0 },
      clockStyle: 0,
    });
    await flush();
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toContain('[device] off resend failed: not connected text');
    expect(r.c.isOn()).toBe(false);
  });

  it('stopped: nothing is sent', async () => {
    const r = await online();
    await r.c.setPower(false);
    await r.c.stop();
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    const onStatus = (r.c as unknown as { onStatus: (s: DeviceStatus) => void }).onStatus;
    onStatus({
      channel: 1,
      lightingColor: { r: 255, g: 0, b: 0 },
      brightness: 50,
      powerByte: 1,
      visualization: 3,
      clockColor: { r: 0, g: 0, b: 0 },
      clockStyle: 0,
    });
    await flush();
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).not.toContain(WOKE);
  });

  it('a held dim (#62) stays held across a resend and is sent at the next power on', async () => {
    const r = await online();
    await r.c.setPower(false);
    await r.c.setDim(0.3);
    r.t.writes.length = 0;
    r.device.power = true;
    r.t.emitData(wake());
    await flush();
    expect(offWrites(r)).toHaveLength(1);
    expect(payloads(r).filter((p) => p.startsWith('74'))).toEqual([]);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    await flush();
    expect(payloads(r).filter((p) => p.startsWith('74'))).toEqual(['74 1e']);
    expect(r.surface.logs).toContain('[device] dim sent at power on: 30');
  });
});
