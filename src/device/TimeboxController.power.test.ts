import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { TransportError } from '../transport/Transport';
import { opcodeOf, replyFrame, statusFrame } from '../transport/__fixtures__/frames';
import { CHANNEL_CONFIRM_TIMEOUT_MS } from './TimeboxController';
import type { TimeboxControllerOptions } from './TimeboxController';
import { DEFAULT_CLOCK_SETTINGS } from './clock';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const OFF_RED_50 = '45 01 ff 00 00 32 00 00 00 00 00';
const CLOCK = '45 00 01 00 01 00 00 00 ff ff ff';

/** A started controller whose first status reply (channel `channel`, lighting colour red, brightness 50) has been processed. */
async function online(channel = 0, opts: TimeboxControllerOptions = {}): Promise<Rig> {
  const r = rig({}, opts, 50);
  r.device.channel = channel;
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('power off', () => {
  it('sends the lighting form with power 00 (colour and brightness unchanged), then confirms with 46', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    await r.c.setPower(false);
    expect(payloads(r)).toEqual([OFF_RED_50, '46']);
    expect(r.surface.logs).toContain(`[device] power -> off: ${OFF_RED_50}`);
    expect(r.surface.logs).toContain('[device] power off: device reports lighting');
    expect(r.c.isOn()).toBe(false);
    expect(r.device.power).toBe(false);
  });

  it('keeps the known channel, writes no tile and fires no trigger', async () => {
    const r = await online(5);
    r.surface.channels.length = 0;
    r.surface.channelChanges.length = 0;
    await r.c.setPower(false);
    expect(r.c.getChannel()).toBe('custom');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.onoffs).toEqual([true]); // only the first status of the run; Homey writes the tile for the listener
  });

  it('ignores reports with the shadow code while off, also at the next polls', async () => {
    const r = await online(5);
    await r.c.setPower(false);
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 1, { 3: 0xff }));
    await advance(60_000);
    await advance(60_000);
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.c.isOn()).toBe(false);
    expect(r.c.getChannel()).toBe('custom');
  });

  it('uses d0 01 as the shadow if the confirm times out: the next real poll does not power on', async () => {
    const r = await online(0);
    r.device.answer = false;
    r.t.autoReply = undefined;
    r.surface.channelChanges.length = 0;
    const p = r.c.setPower(false);
    const failed = expect(p).rejects.toThrow('not confirmed text'); // #151
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await failed;
    expect(r.surface.logs).toContain('[device] power off confirm timeout');
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 1)); // what the Evo really reports after the off command
    r.t.emitData(statusFrame(50, 1));
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([true, false]); // the rejected off aligned the tile (#151)
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.logs).not.toContain('[device] power <- device: on');
    r.t.emitData(statusFrame(50, 5)); // a real switch on at the device still powers on
    expect(r.c.isOn()).toBe(true);
  });

  it('writes the colour the app knows into the off command when its confirm timed out', async () => {
    const r = await online(1); // lighting, the last status carries the lighting colour red
    r.device.answer = false; // the simulator still applies commands but no longer answers 46
    const change = r.c.setTileColor(1 / 3, 1);
    const failed = expect(change).rejects.toThrow('not confirmed text');
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await failed;
    r.t.writes.length = 0;
    const off = r.c.setPower(false);
    const offFailed = expect(off).rejects.toThrow('not confirmed text'); // #151
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await offFailed;
    expect(payloads(r)[0]).toBe('45 01 00 ff 00 32 00 00 00 00 00');
  });

  it('powers on when the device reports another known channel (switched on at the device), then syncs it', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.surface.channels.length = 0;
    r.surface.channelChanges.length = 0;
    r.t.emitData(statusFrame(50, 5));
    expect(r.surface.onoffs).toEqual([true, true]);
    expect(r.surface.logs).toContain('[device] power <- device: on');
    expect(r.surface.channels).toEqual(['custom']);
    expect(r.surface.channelChanges).toEqual(['custom']);
    expect(r.c.isOn()).toBe(true);
    // The shadow is gone: the code that was the shadow is a real report again.
    r.t.emitData(statusFrame(50, 1));
    expect(r.surface.channels).toEqual(['custom', 'lighting']);
  });

  it.each([2, 4])(
    'powers on when the device reports the removed mode %i while off, and clears the tile',
    async (code) => {
      const r = await online(0);
      await r.c.setPower(false);
      r.surface.channels.length = 0;
      r.surface.channelChanges.length = 0;
      r.t.emitData(statusFrame(50, code));
      expect(r.c.isOn()).toBe(true);
      expect(r.surface.onoffs).toEqual([true, true]);
      expect(r.surface.logs).toContain('[device] power <- device: on');
      expect(r.surface.channelClears).toBe(1);
      expect(r.surface.channels).toEqual([]);
      expect(r.surface.channelChanges).toEqual([]);
      expect(r.c.getChannel()).toBeNull();
    },
  );

  it('switched on at the device back to the channel from before off: no tile write and no trigger', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 0));
    expect(r.surface.onoffs).toEqual([true, true]);
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('an unknown code while off does not power on', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.emitData(statusFrame(50, 3));
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([true]);
  });
});

describe('power on', () => {
  it('restores the clock with the clock face', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.channelChanges.length = 0;
    await r.c.setPower(true);
    expect(payloads(r)).toEqual(['26 00', CLOCK, '46']);
    expect(r.c.isOn()).toBe(true);
    expect(r.device.power).toBe(true);
    expect(r.surface.onoffs).toEqual([true, true]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.logs).toContain('[device] channel confirmed: clock');
  });

  it('restores the last offered mode after the device showed a removed mode, writes the tile and fires the trigger', async () => {
    const r = await online(5);
    r.t.emitData(statusFrame(50, 2)); // cloud selected on the device: tile cleared
    expect(r.c.onOtherMode()).toBe(true);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.channels.length = 0;
    r.surface.channelChanges.length = 0;
    await r.c.setPower(true);
    expect(payloads(r)).toEqual(['45 05', '46']);
    expect(r.c.getChannel()).toBe('custom');
    expect(r.c.onOtherMode()).toBe(false);
    expect(r.surface.channels).toEqual(['custom']);
    expect(r.surface.channelChanges).toEqual(['custom']);
  });

  it('restores lighting as plain colour with the stored colour and the known brightness', async () => {
    const r = await online(0);
    await r.c.setChannel('lighting');
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r)).toEqual(['45 01 ff 00 00 32 00 01 00 00 00', '46']);
  });

  it('sends the restore command even if the app thinks the panel is on', async () => {
    const r = await online(5);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r)).toEqual(['45 05', '46']);
    expect(r.surface.onoffs).toEqual([true]);
  });

  it('a clock face change while off is only stored and applied at the next switch on', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setClockSettings({ ...DEFAULT_CLOCK_SETTINGS, style: 2 });
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toContain('[device] clock settings saved, applied when the clock is shown');
    expect(r.c.isOn()).toBe(false);
    await r.c.setPower(true);
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', '45 00 01 02 01 00 00 00 ff ff ff']);
  });
});

describe('display changes switch the panel on', () => {
  it('a channel pick while off sends the channel, sets onoff and fires the trigger', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.channelChanges.length = 0;
    await r.c.setChannel('custom');
    expect(payloads(r)).toEqual(['45 05', '46']);
    expect(r.surface.onoffs).toEqual([true, true]);
    expect(r.surface.channelChanges).toEqual(['custom']);
    expect(r.c.isOn()).toBe(true);
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 2)); // reports apply again
    r.t.emitData(statusFrame(50, 0));
    expect(r.surface.channels).toEqual(['clock']);
  });

  it('Show clock while off switches on', async () => {
    const r = await online(5);
    await r.c.setPower(false);
    await r.c.showClock(2, { r: 0, g: 255, b: 0 });
    expect(r.surface.onoffs).toEqual([true, true]);
    expect(r.c.isOn()).toBe(true);
    expect(r.c.getChannel()).toBe('clock');
  });
});

describe('startup from stored off', () => {
  it('writes onoff false from the first status, leaves the tile and the channel alone and restores the stored channel', async () => {
    const r = rig({}, { powerOn: false, storedChannel: 'custom' }, 50);
    r.device.channel = 1;
    r.device.power = false;
    r.c.start();
    await flush();
    expect(r.surface.onoffs).toEqual([false]);
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.c.isOn()).toBe(false);
    expect(r.c.getChannel()).toBe('custom');
    r.t.emitData(statusFrame(50, 1)); // the adopted shadow
    expect(r.c.isOn()).toBe(false);

    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r)).toEqual(['45 05', '46']);
    expect(r.surface.onoffs).toEqual([false, true]);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('restores the clock when no channel is known or stored', async () => {
    const r = rig({}, { powerOn: false }, 50);
    r.c.start();
    await flush();
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r).slice(0, 2)).toEqual(['26 00', CLOCK]);
  });

  it('at a startup from off, the first report is adopted as the shadow, a later different one powers on', async () => {
    const r = rig({}, { powerOn: false, storedChannel: 'clock' }, 50);
    r.device.channel = 4;
    r.c.start();
    await flush();
    expect(r.c.isOn()).toBe(false);
    r.t.emitData(statusFrame(50, 0));
    expect(r.c.isOn()).toBe(true);
  });
});

describe('ordering and errors', () => {
  it('off then on without waiting: the newest wins and the panel ends on', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    const off = r.c.setPower(false);
    const on = r.c.setPower(true);
    await Promise.all([off, on]);
    expect(payloads(r)).toEqual([OFF_RED_50, '26 00', CLOCK, '46']);
    expect(r.surface.logs).toContain('[device] power off superseded by a newer change');
    expect(r.c.isOn()).toBe(true);
    expect(r.device.power).toBe(true);
    expect(r.surface.onoffs).toEqual([true, true]);
    r.t.emitData(statusFrame(50, 1)); // no stale shadow is left behind
    expect(r.surface.logs).not.toContain('[device] power <- device: on');
  });

  it('on then off without waiting: the newest wins and the panel ends off with its shadow', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    const on = r.c.setChannel('custom');
    const off = r.c.setPower(false);
    await Promise.all([on, off]);
    expect(payloads(r)).toEqual(['45 05', OFF_RED_50, '46']);
    expect(r.c.isOn()).toBe(false);
    expect(r.c.getChannel()).toBe('custom');
    r.surface.channels.length = 0;
    r.t.emitData(statusFrame(50, 1));
    expect(r.surface.channels).toEqual([]);
    expect(r.c.isOn()).toBe(false);
  });

  it('writes nothing and rejects readably while not connected', async () => {
    const r = rig();
    await expect(r.c.setPower(false)).rejects.toThrow('not connected text');
    await expect(r.c.setPower(true)).rejects.toThrow('not connected text');
    r.c.start();
    r.t.failNextOpen(new TransportError('nope'));
    await flush();
    await expect(r.c.setPower(false)).rejects.toThrow('not connected text');
    expect(r.t.writes).toHaveLength(0);
    await r.c.stop();
    await expect(r.c.setPower(true)).rejects.toThrow('not connected text');
    expect(r.c.isOn()).toBe(true);
  });

  it('maps a link lost during the off write to the readable error and stays on', async () => {
    const r = await online(0);
    r.t.holdWrites();
    const p = r.c.setPower(false);
    const assertion = expect(p).rejects.toThrow('not connected text');
    await flush();
    r.t.dropLink();
    r.t.releaseWrites();
    await flush();
    await assertion;
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.errors).toEqual([]);
  });

  it.each(['on', 'off', 1, 0, null, undefined, {}])(
    'rejects %s with a RangeError before anything else',
    async (bad) => {
      const connected = await online(0);
      connected.t.writes.length = 0;
      await expect(connected.c.setPower(bad as unknown as boolean)).rejects.toThrow(RangeError);
      expect(connected.t.writes).toHaveLength(0);
      const offline = rig();
      await expect(offline.c.setPower(bad as unknown as boolean)).rejects.toThrow(RangeError);
    },
  );

  it('never sends 45 03 or any other opcode than 45, 46 and the animation flag 26 ahead of the clock for power changes', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    await r.c.setPower(false);
    await r.c.setPower(true);
    const ops = r.t.writes.map(opcodeOf).filter((op) => op !== -1);
    expect(new Set(ops)).toEqual(new Set([0x45, 0x46, 0x26]));
  });
});

describe('dim while off (#62)', () => {
  const HELD = '[device] dim held while off: 30 (sent at power on)';

  /** The `74` payloads written so far. */
  const brightnessWrites = (r: Rig) => payloads(r).filter((p) => p.startsWith('74'));

  it('T1: holds the value: nothing is written, the panel stays off', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setDim(0.3);
    expect(r.t.writes).toHaveLength(0);
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.surface.logs).toContain(HELD);
  });

  it('T2: power on sends the channel command, then 74 with the held value', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.setDim(0.3);
    r.t.writes.length = 0;
    r.surface.dims.length = 0;
    await r.c.setPower(true);
    await flush();
    expect(payloads(r)).toEqual(['26 00', CLOCK, '74 1e', '46']);
    expect(r.surface.onoffs).toEqual([true, true]);
    expect(r.surface.logs).toContain('[device] dim sent at power on: 30');
    expect(r.device.brightness).toBe(30);
    expect(r.surface.dims).toEqual([]);
  });

  it('T3: power on sends no 74 when no dim was held', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    await flush();
    expect(brightnessWrites(r)).toEqual([]);
  });

  it('T4: a 46 poll while held does not overwrite the tile or the held value', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.setDim(0.3);
    r.surface.dims.length = 0;
    r.surface.logs.length = 0;
    r.t.emitData(statusFrame(70, 1)); // the off shadow, with another brightness
    expect(r.surface.dims).toEqual([]);
    expect(r.surface.logs.filter((l) => l.startsWith('[device] dim <- device'))).toEqual([]);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    await flush();
    expect(brightnessWrites(r)).toEqual(['74 1e']);
    expect(r.surface.dims).toEqual([]);
  });

  it('T5: two dims while off: only the newest is sent', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.setDim(0.2);
    await r.c.setDim(0.3);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    await flush();
    expect(brightnessWrites(r)).toEqual(['74 1e']);
  });

  it('T6: a dim during an off in flight is held and not queued after the off command', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    const off = r.c.setPower(false);
    await r.c.setDim(0.3);
    await off;
    await flush();
    expect(payloads(r)).toEqual([OFF_RED_50, '46']);
    expect(r.surface.logs).toContain(HELD);
    expect(r.c.isOn()).toBe(false);
    r.t.writes.length = 0;
    await r.c.setPower(true);
    await flush();
    expect(brightnessWrites(r)).toEqual(['74 1e']);
  });

  it('T7: a mode pick and Show lighting while off also send the held value', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.setDim(0.3);
    r.t.writes.length = 0;
    await r.c.setChannel('custom');
    await flush();
    expect(payloads(r)).toEqual(['45 05', '74 1e', '46']);

    await r.c.setPower(false);
    await r.c.setDim(0.3);
    r.t.writes.length = 0;
    await r.c.showLighting({ r: 0xff, g: 0, b: 0 });
    await flush();
    expect(payloads(r)).toEqual(['45 01 ff 00 00 1e 00 01 00 00 00', '74 1e', '46']);
  });

  it('T8: a switch on at the device and a countdown end each send the held value', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.setDim(0.3);
    r.t.writes.length = 0;
    r.t.emitData(statusFrame(50, 0));
    await flush();
    expect(r.c.isOn()).toBe(true);
    expect(brightnessWrites(r)).toEqual(['74 1e']);
    expect(r.surface.logs).toContain('[device] dim sent at power on: 30');

    await r.c.setPower(false);
    await r.c.setDim(0.3);
    r.t.writes.length = 0;
    r.t.emitData(replyFrame(0x71, 0x03, 0x01, 0x01, 0x00));
    await flush();
    expect(r.c.isOn()).toBe(true);
    expect(brightnessWrites(r)).toEqual(['74 1e']);
  });

  it('T9: a held value that cannot be sent writes the known brightness back to the tile', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.setDim(0.3);
    const reply = r.t.autoReply;
    r.t.autoReply = (w) => {
      if (opcodeOf(w) === 0x45) r.t.writeErrors.push(new Error('boom')); // the next write is the 74
      return reply?.(w);
    };
    r.surface.dims.length = 0;
    await r.c.setChannel('custom').catch(() => undefined); // the failed write drops the link, the confirm is lost
    await flush();
    expect(r.surface.logs.some((l) => l.startsWith('[device] dim not sent at power on:'))).toBe(true);
    expect(r.surface.dims).toEqual([0.5]);
  });

  it('a newer direct dim is not overwritten by a value held during an off that a power on replaced', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    const off = r.c.setPower(false);
    await r.c.setDim(0.3); // held: the off is in flight
    const on = r.c.setPower(true); // supersedes the off
    await r.c.setDim(0.8); // power is still true and no off is the newest change: sent directly
    await Promise.all([off, on]);
    await flush();
    expect(brightnessWrites(r)).toEqual(['74 50']);
    expect(r.device.brightness).toBe(80);
    expect(r.surface.logs.filter((l) => l.startsWith('[device] dim sent at power on'))).toEqual([]);
  });

  it('an off that fails before it was sent applies the value held meanwhile: the link is lost, so the tile is written back', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    r.t.writeErrors.push(new Error('boom')); // the off command; the failed write drops the link
    r.surface.dims.length = 0;
    const off = r.c.setPower(false);
    const failed = expect(off).rejects.toThrow('not connected text');
    await r.c.setDim(0.3);
    await failed;
    await flush();
    expect(r.c.isOn()).toBe(true);
    expect(brightnessWrites(r)).toEqual([]);
    expect(r.surface.logs.some((l) => l.startsWith('[device] dim not sent at power on:'))).toBe(true);
    expect(r.surface.dims).toEqual([0.5]);
  });

  it('T10: a dim while on is unchanged: 74, then the 46 confirm', async () => {
    const r = await online(0);
    r.t.writes.length = 0;
    await r.c.setDim(0.3);
    expect(payloads(r)).toEqual(['74 1e', '46']);
    expect(r.surface.logs).toContain('[device] dim confirmed: 30');
    expect(r.surface.logs).not.toContain(HELD);
  });

  it('T11: a stopped controller rejects with not connected', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.stop();
    await expect(r.c.setDim(0.3)).rejects.toThrow('not connected text');
  });

  it('T12: from a stored off, a dim without a link resolves and is held', async () => {
    const r = rig({}, { powerOn: false }, 50);
    await expect(r.c.setDim(0.3)).resolves.toBeUndefined();
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.logs).toContain(HELD);
  });
});
