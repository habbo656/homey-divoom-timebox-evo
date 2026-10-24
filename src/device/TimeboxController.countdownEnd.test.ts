import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { replyFrame, statusFrame } from '../transport/__fixtures__/frames';
import { CHANNEL_CONFIRM_TIMEOUT_MS } from './TimeboxController';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';

const flush = () => vi.advanceTimersByTimeAsync(0);

/** The unsolicited end frame `71 55 03 01 01 00`. */
const endFrame = () => replyFrame(0x71, 0x03, 0x01, 0x01, 0x00);

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

/** A started controller whose first status reply (channel `initialChannel`) has been processed. */
async function online(initialChannel = 0, opts: Parameters<typeof rig>[1] = {}): Promise<Rig> {
  const r = rig({}, opts);
  r.device.channel = initialChannel;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('countdown ended (#101)', () => {
  it('fires the trigger once per end frame and logs it', async () => {
    const r = await online();
    r.t.emitData(endFrame());
    expect(r.surface.countdownEnds).toBe(1);
    expect(r.surface.logs).toEqual(['[device] countdown ended (device)']);
  });

  it('also fires after a countdown started by the app, without the app tracking it', async () => {
    const r = await online();
    await r.c.startCountdown({ minutes: 0, seconds: 10 });
    r.t.writes.length = 0;
    r.t.emitData(endFrame());
    expect(r.surface.countdownEnds).toBe(1);
    expect(r.t.writes).toEqual([]);
  });

  it('also fires without a countdown from the app and with the panel off, and onoff follows the lit panel', async () => {
    const r = await online();
    r.t.emitData(endFrame());
    expect(r.surface.countdownEnds).toBe(1);

    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.onoffs.length = 0;
    r.t.emitData(endFrame());
    await flush();
    expect(r.surface.countdownEnds).toBe(2);
    expect(payloads(r)).toEqual(['46']);
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.c.isOn()).toBe(true);
  });

  it('fires with a text shown and sends nothing', async () => {
    const r = await online();
    await r.c.showText({
      text: 'Hallo',
      color: { r: 255, g: 255, b: 0 },
      background: { r: 0, g: 0, b: 128 },
      speed: 5,
      durationS: 0,
    });
    r.t.writes.length = 0;
    r.t.emitData(endFrame());
    expect(r.surface.countdownEnds).toBe(1);
    expect(r.t.writes).toEqual([]);
  });

  it('does not change the mode or the tile', async () => {
    const r = await online(1);
    r.surface.channels.length = 0;
    r.surface.channelChanges.length = 0;
    r.t.emitData(endFrame());
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('fires once per frame: two end frames give two triggers', async () => {
    const r = await online();
    r.t.emitData(endFrame());
    r.t.emitData(endFrame());
    expect(r.surface.countdownEnds).toBe(2);
  });

  it('is not fired by the bd 55 13 frames that follow the end', async () => {
    const r = await online();
    r.t.emitData(endFrame());
    r.t.emitData(replyFrame(0xbd, 0x13, 0x01, 0x32, 0x00));
    r.t.emitData(replyFrame(0xbd, 0x13, 0x01, 0x1e, 0x00));
    expect(r.surface.countdownEnds).toBe(1);
    expect(r.surface.errors).toEqual([]);
  });

  it('logs other 71 frames and fires nothing', async () => {
    const r = await online();
    r.t.emitData(replyFrame(0x71, 0x03, 0x01, 0x00, 0x00));
    r.t.emitData(replyFrame(0x71));
    expect(r.surface.countdownEnds).toBe(0);
    expect(r.surface.logs).toEqual([
      '[device] countdown: unknown 71 frame 71 55 03 01 00 00',
      '[device] countdown: unknown 71 frame 71 55',
    ]);
  });

  it('fires nothing for other opcodes', async () => {
    const r = await online();
    r.t.emitData(replyFrame(0x72, 0x03, 0x01, 0x01, 0x00));
    r.t.emitData(replyFrame(0x31, 50));
    expect(r.surface.countdownEnds).toBe(0);
  });

  it('fires nothing after stop()', async () => {
    const r = await online();
    await r.c.stop();
    r.t.emitData(endFrame());
    expect(r.surface.countdownEnds).toBe(0);
  });

  it('a throwing trigger is logged as an error and does not break the link', async () => {
    const r = await online();
    r.surface.onCountdownEnded = () => {
      throw new Error('boom');
    };
    r.t.emitData(endFrame());
    await flush();
    expect(r.surface.errors.some((e) => e.includes('surface call failed: boom'))).toBe(true);
    expect(r.m.state).toBe('connected');
  });
});

/** A started controller whose panel was switched off by the app (device: lighting `01`, power false). */
async function offRig(initialChannel = 0, opts: Parameters<typeof rig>[1] = {}): Promise<Rig> {
  const r = await online(initialChannel, opts);
  await r.c.setPower(false);
  expect(r.c.isOn()).toBe(false);
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  r.surface.onoffs.length = 0;
  r.surface.channels.length = 0;
  r.surface.channelChanges.length = 0;
  r.surface.colors.length = 0;
  return r;
}

describe('countdown end with the panel off (#125)', () => {
  it('lighting before off: onoff becomes true, one 46 query, no mode change, trigger after the correction', async () => {
    const r = await offRig(1);
    const order: string[] = [];
    const setOnOff = r.surface.setOnOff.bind(r.surface);
    r.surface.setOnOff = (on) => {
      order.push(`onoff:${on}`);
      setOnOff(on);
    };
    r.surface.onCountdownEnded = () => {
      order.push('ended');
      r.surface.countdownEnds++;
    };
    r.t.emitData(endFrame());
    await flush();
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.c.isOn()).toBe(true);
    expect(order).toEqual(['onoff:true', 'ended']);
    expect(payloads(r)).toEqual(['46']);
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.logs).toEqual([
      '[device] countdown ended (device)',
      '[device] power <- device: on (countdown end display)',
    ]);
  });

  it('clock before off: the status sync aligns the mode tile, the colour tile and the trigger with d0', async () => {
    const r = await offRig(0);
    r.device.color = [0, 0xff, 0];
    r.t.emitData(endFrame());
    await flush();
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channels).toEqual(['lighting']);
    expect(r.surface.channelChanges).toEqual(['lighting']);
    expect(r.surface.colors).toHaveLength(1); // #00ff00
    expect(r.surface.colors[0].hue).toBeCloseTo(1 / 3, 3);
    expect(r.surface.colors[0].saturation).toBeCloseTo(1, 3);
    expect(r.surface.logs).toContain('[device] channel <- device: lighting');
    expect(r.surface.errors).toEqual([]);
  });

  it('panel on: no query, no onoff write', async () => {
    const r = await online(0);
    r.surface.onoffs.length = 0;
    r.t.emitData(endFrame());
    await flush();
    expect(r.surface.countdownEnds).toBe(1);
    expect(r.t.writes).toEqual([]);
    expect(r.surface.onoffs).toEqual([]);
    expect(r.surface.logs).toEqual(['[device] countdown ended (device)']);
  });

  it('an end during a power off in flight leaves the power to that change', async () => {
    const r = await online(0);
    r.device.answer = false; // the off confirm stays pending
    const off = r.c.setPower(false);
    await flush();
    expect(r.c.isOn()).toBe(false);
    r.t.writes.length = 0;
    r.surface.onoffs.length = 0;
    r.t.emitData(endFrame());
    await flush();
    expect(r.surface.countdownEnds).toBe(1);
    expect(r.t.writes).toEqual([]);
    expect(r.surface.onoffs).toEqual([]);
    expect(r.surface.logs).toContain('[device] countdown end: panel lit, power left to the change in flight');
    const failed = expect(off).rejects.toThrow('not confirmed text'); // #151: the unanswered off confirm
    await vi.advanceTimersByTimeAsync(CHANNEL_CONFIRM_TIMEOUT_MS);
    await failed;
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([false]); // the tile is aligned with the off, never lit by the end display
  });

  it('a status sync timeout is only logged and onoff stays true', async () => {
    const r = await offRig(1);
    r.device.answer = false;
    r.t.emitData(endFrame());
    await flush();
    await vi.advanceTimersByTimeAsync(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(r.surface.logs).toContain('[device] countdown end: status sync timeout');
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.errors).toEqual([]);
  });

  it('a second end frame sends nothing more and fires the trigger again', async () => {
    const r = await offRig(1);
    r.t.emitData(endFrame());
    await flush();
    r.t.writes.length = 0;
    r.t.emitData(endFrame());
    await flush();
    expect(r.surface.countdownEnds).toBe(2);
    expect(r.t.writes).toEqual([]);
    expect(r.surface.onoffs).toEqual([true]);
  });

  it('a startup from stored off follows the lit panel as well', async () => {
    const r = rig({}, { powerOn: false, storedChannel: 'clock' }, 50);
    r.device.channel = 1;
    r.device.power = false;
    r.c.start();
    await flush();
    expect(r.surface.onoffs).toEqual([false]);
    r.t.emitData(endFrame());
    await flush();
    expect(r.surface.onoffs).toEqual([false, true]);
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.countdownEnds).toBe(1);
  });

  it('switching off again afterwards works and its shadow is fresh', async () => {
    const r = await offRig(1);
    r.t.emitData(endFrame());
    await flush();
    r.t.writes.length = 0;
    await r.c.setPower(false);
    expect(payloads(r)[0]).toMatch(/^45 01 /);
    expect(r.c.isOn()).toBe(false);
    r.surface.logs.length = 0;
    r.surface.onoffs.length = 0;
    r.t.emitData(statusFrame(50, 1)); // the off shadow: no switch on at the device
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([]);
    expect(r.surface.logs).not.toContain('[device] power <- device: on');
  });
});
