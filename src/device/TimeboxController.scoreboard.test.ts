import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { TransportError } from '../transport/Transport';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { ArgumentError } from './argumentError';
import { CHANNEL_CONFIRM_TIMEOUT_MS, STATUS_POLL_INTERVAL_MS } from './TimeboxController';
import type { TimeboxControllerOptions } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller on the clock whose first status reply has been processed; writes, logs and tile calls cleared. */
async function online(opts: TimeboxControllerOptions = {}): Promise<Rig> {
  const r = rig({}, opts);
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
  r.surface.savedScores.length = 0;
  r.surface.scoreChanges.length = 0;
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('showing the scoreboard', () => {
  it('sends 45 06 then 72 01 01 with the scores, and confirms with the d0 of the previous mode', async () => {
    const r = await online();
    await expect(r.c.setScore({ red: 12, blue: 34 })).resolves.toBe(true);
    expect(sent(r)).toEqual(['45 06', '72 01 01 0c 00 22 00', '46']);
    expect(r.c.getChannel()).toBe('scoreboard');
    expect(r.device.scores).toEqual([12, 34]);
    expect(r.surface.channels).toEqual([]); // the device layer writes the mode tile
    expect(r.surface.channelChanges).toEqual(['scoreboard']);
    expect(r.surface.colors).toEqual([]);
    expect(r.surface.logs).toContain('[device] channel -> scoreboard: 45 06');
    expect(r.surface.logs).toContain('[device] scoreboard -> red 12, blue 34: 72 01 01 0c 00 22 00');
    expect(r.surface.logs).toContain('[device] channel confirmed: scoreboard (device reports channel code 0x00)');
    expect(logs(r, 'channel mismatch')).toEqual([]);
  });

  it('the mode picker (setChannel) shows the scoreboard with the stored scores', async () => {
    const r = await online({ scores: { red: 5, blue: 1 } });
    await r.c.setChannel('scoreboard');
    expect(sent(r)).toEqual(['45 06', '72 01 01 05 00 01 00', '46']);
    expect(r.surface.scoreChanges).toEqual([]);
    expect(r.surface.savedScores).toEqual([]);
  });

  it('starts at 0/0 without stored scores', async () => {
    const r = await online();
    expect(r.c.getScores()).toEqual({ red: 0, blue: 0 });
    await r.c.setChannel('scoreboard');
    expect(sent(r)).toEqual(['45 06', '72 01 01 00 00 00 00', '46']);
  });

  it('keeps the scoreboard across polls: the shadow equals the d0 of the previous mode', async () => {
    const r = await online();
    await r.c.setScore({ red: 1, blue: 2 });
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.getChannel()).toBe('scoreboard');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(logs(r, 'scoreboard ended')).toEqual([]);
  });

  it('turns a panel that is off on and shows the scoreboard', async () => {
    const r = await online();
    await r.c.setPower(false);
    clear(r);
    await r.c.setScore({ red: 3 });
    expect(sent(r)).toEqual(['45 06', '72 01 01 03 00 00 00', '46']);
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.onoffs).toEqual([true]);
  });
});

describe('the score actions', () => {
  it('set score: an empty value keeps the current one, values are rounded and clamped', async () => {
    const r = await online();
    await r.c.setScore({ red: 12, blue: 34 });
    clear(r);
    await r.c.setScore({ red: 5 });
    expect(r.c.getScores()).toEqual({ red: 5, blue: 34 });
    await r.c.setScore({ blue: 7.4 });
    expect(r.c.getScores()).toEqual({ red: 5, blue: 7 });
    await r.c.setScore({ red: 5000, blue: -3 });
    expect(r.c.getScores()).toEqual({ red: 999, blue: 0 });
    await r.c.setScore({});
    expect(r.c.getScores()).toEqual({ red: 999, blue: 0 });
    expect(sent(r).filter((p) => p.startsWith('72 01 01'))).toEqual([
      '72 01 01 05 00 22 00',
      '72 01 01 05 00 07 00',
      '72 01 01 e7 03 00 00',
      '72 01 01 e7 03 00 00',
    ]);
  });

  it('increase and decrease step one team, the step defaults to 1 and the result is clamped', async () => {
    const r = await online();
    await r.c.setScore({ red: 12, blue: 34 });
    await r.c.changeScore('blue', undefined, 1);
    expect(r.c.getScores()).toEqual({ red: 12, blue: 35 });
    await r.c.changeScore('red', 5, -1);
    expect(r.c.getScores()).toEqual({ red: 7, blue: 35 });
    await r.c.changeScore('red', 999, 1);
    expect(r.c.getScores()).toEqual({ red: 999, blue: 35 });
    await r.c.changeScore('blue', 999, -1);
    expect(r.c.getScores()).toEqual({ red: 999, blue: 0 });
    expect(r.device.scores).toEqual([999, 0]);
  });

  it('reset sets both scores to 0', async () => {
    const r = await online();
    await r.c.setScore({ red: 12, blue: 34 });
    clear(r);
    await r.c.resetScores();
    expect(r.c.getScores()).toEqual({ red: 0, blue: 0 });
    expect(sent(r)).toEqual(['45 06', '72 01 01 00 00 00 00', '46']);
  });

  it('rejects an invalid team or step before anything changes or is sent', async () => {
    const r = await online();
    await r.c.setScore({ red: 4, blue: 4 });
    clear(r);
    await expect(r.c.changeScore('green', 1, 1)).rejects.toBeInstanceOf(ArgumentError);
    await expect(r.c.changeScore('red', 0, 1)).rejects.toBeInstanceOf(ArgumentError);
    await expect(r.c.changeScore('red', 1000, -1)).rejects.toBeInstanceOf(ArgumentError);
    await expect(r.c.changeScore('red', Number.NaN, 1)).rejects.toBeInstanceOf(ArgumentError);
    await expect(r.c.setScore({ red: Number.NaN })).rejects.toBeInstanceOf(ArgumentError);
    await expect(r.c.setScore({ blue: 'x' })).rejects.toBeInstanceOf(ArgumentError);
    expect(r.c.getScores()).toEqual({ red: 4, blue: 4 });
    expect(sent(r)).toEqual([]);
    expect(r.surface.savedScores).toEqual([]);
    expect(r.surface.scoreChanges).toEqual([]);
  });
});

describe('persistence and the "Score changed" trigger', () => {
  it('saves the scores and fires the trigger once per change', async () => {
    const r = await online();
    await r.c.setScore({ red: 12, blue: 34 });
    await r.c.changeScore('blue', 1, 1);
    expect(r.surface.savedScores).toEqual([
      { red: 12, blue: 34 },
      { red: 12, blue: 35 },
    ]);
    expect(r.surface.scoreChanges).toEqual([
      { red: 12, blue: 34 },
      { red: 12, blue: 35 },
    ]);
  });

  it('does not fire or save when nothing changed, but still shows the scoreboard', async () => {
    const r = await online();
    await r.c.resetScores(); // 0/0 already
    expect(r.surface.savedScores).toEqual([]);
    expect(r.surface.scoreChanges).toEqual([]);
    expect(sent(r)).toEqual(['45 06', '72 01 01 00 00 00 00', '46']);
    clear(r);
    await r.c.changeScore('red', 1, -1); // decrease at 0
    expect(r.c.getScores()).toEqual({ red: 0, blue: 0 });
    expect(r.surface.scoreChanges).toEqual([]);
    expect(sent(r)).toEqual(['45 06', '72 01 01 00 00 00 00', '46']);
  });

  it('a failure of the save is only logged', async () => {
    const r = await online();
    r.surface.saveScores = () => Promise.reject(new Error('store full'));
    await expect(r.c.setScore({ red: 1 })).resolves.toBe(true);
    expect(r.surface.errors.some((e) => e.includes('surface call failed: store full'))).toBe(true);
    expect(r.c.getScores()).toEqual({ red: 1, blue: 0 });
  });

  it('a switch to the scoreboard through the mode picker does not fire the score trigger', async () => {
    const r = await online({ scores: { red: 2, blue: 3 } });
    await r.c.setChannel('scoreboard');
    expect(r.surface.scoreChanges).toEqual([]);
  });
});

describe('without a link', () => {
  it('rejects with not_connected and changes nothing, before start and while disconnected', async () => {
    const r = rig();
    await expect(r.c.setScore({ red: 3 })).rejects.toThrow('not connected text');
    r.c.start();
    r.t.failNextOpen(new TransportError('nope'));
    await flush();
    expect(r.m.state).not.toBe('connected');
    await expect(r.c.setScore({ red: 3 })).rejects.toThrow('not connected text');
    await expect(r.c.changeScore('red', 1, 1)).rejects.toThrow('not connected text');
    await expect(r.c.resetScores()).rejects.toThrow('not connected text');
    expect(r.c.getScores()).toEqual({ red: 0, blue: 0 });
    expect(r.t.writes).toHaveLength(0);
    expect(r.surface.savedScores).toEqual([]);
    expect(r.surface.scoreChanges).toEqual([]);
  });

  it('rejects after stop()', async () => {
    const r = await online();
    await r.c.stop();
    await expect(r.c.setScore({ red: 3 })).rejects.toThrow('not connected text');
    expect(r.c.getScores()).toEqual({ red: 0, blue: 0 });
  });
});

describe('device reports while the scoreboard is tracked (the shadow)', () => {
  it('ignores a code that is neither a mode nor a removed mode', async () => {
    const r = await online();
    await r.c.setScore({ red: 1 });
    clear(r);
    r.device.channel = 0x09;
    await advance(STATUS_POLL_INTERVAL_MS);
    r.device.channel = 0x00;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.getChannel()).toBe('scoreboard');
    expect(logs(r, 'scoreboard ended')).toEqual([]);
    expect(logs(r, 'not a known channel')).toEqual([]);
  });

  it('a different known code is a mode change at the device: the tracking ends and the report is handled', async () => {
    const r = await online();
    await r.c.setScore({ red: 1 });
    clear(r);
    r.device.channel = 0x05; // custom
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'scoreboard ended (device mode change): channel code 0x00 -> 0x05')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('custom');
    expect(r.surface.channels).toEqual(['custom']);
    expect(r.surface.channelChanges).toEqual(['custom']);
  });

  it('a cloud code other than the shadow ends the tracking and enters the other-mode state', async () => {
    const r = await online();
    await r.c.setScore({ red: 1 });
    clear(r);
    r.device.channel = 0x02;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'scoreboard ended (device mode change): channel code 0x00 -> 0x02')).toHaveLength(1);
    expect(r.c.onOtherMode()).toBe(true);
  });

  it('keeps the scoreboard across a reconnect when the first status equals the shadow', async () => {
    const r = await online();
    await r.c.setScore({ red: 1 });
    clear(r);
    r.t.dropLink();
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(r.c.getChannel()).toBe('scoreboard');
    expect(logs(r, 'scoreboard ended')).toEqual([]);
  });

  it('takes the shadow from the first report when the switch was not confirmed', async () => {
    const r = await online();
    r.device.answer = false;
    const settled = r.c.setScore({ red: 9 }).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await settled).toBe('not confirmed text');
    expect(r.surface.logs).toContain('[device] channel confirm timeout');
    // The scores stay, the mode is kept, the trigger fired and the mode tile is aligned.
    expect(r.c.getScores()).toEqual({ red: 9, blue: 0 });
    expect(r.c.getChannel()).toBe('scoreboard');
    expect(r.surface.scoreChanges).toEqual([{ red: 9, blue: 0 }]);
    expect(r.surface.channels).toEqual(['scoreboard']);
    r.device.answer = true;
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'scoreboard shadow: device reports channel code 0x00')).toHaveLength(1);
    expect(r.surface.channels).toEqual([]);
    r.device.channel = 0x01;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'scoreboard ended (device mode change): channel code 0x00 -> 0x01')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('lighting');
  });
});

describe('ending the scoreboard from the app', () => {
  it('another mode ends it; a score action while another mode shows switches back', async () => {
    const r = await online();
    await r.c.setScore({ red: 5 });
    clear(r);
    await r.c.setChannel('clock');
    expect(logs(r, 'scoreboard ended (mode change)')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('clock');
    clear(r);
    await r.c.changeScore('blue', 1, 1);
    expect(sent(r)).toEqual(['45 06', '72 01 01 05 00 01 00', '46']);
    expect(r.c.getChannel()).toBe('scoreboard');
    expect(r.surface.channelChanges).toEqual(['scoreboard']);
  });

  it('a tile colour change switches to lighting', async () => {
    const r = await online();
    await r.c.setScore({ red: 5 });
    clear(r);
    await expect(r.c.setTileColor(0, 1)).resolves.toBe('lighting');
    expect(logs(r, 'scoreboard ended (mode change)')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('lighting');
  });

  it('power off ends it and power on shows the scoreboard with the stored scores again', async () => {
    const r = await online();
    await r.c.setScore({ red: 5, blue: 1 });
    clear(r);
    await r.c.setPower(false);
    expect(logs(r, 'scoreboard ended (power off)')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('scoreboard'); // the mode from before off
    clear(r);
    await r.c.setPower(true);
    expect(sent(r)).toEqual(['45 06', '72 01 01 05 00 01 00', '46']);
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.channels).toEqual([]);
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.getChannel()).toBe('scoreboard');
  });

  it('switching from the noise meter to the scoreboard ends the noise meter', async () => {
    const r = await online();
    r.device.channel = 0x09;
    await r.c.setChannel('noise_meter');
    clear(r);
    await r.c.setScore({ red: 1 });
    expect(logs(r, 'noise meter ended (mode change)')).toHaveLength(1);
    expect(logs(r, 'scoreboard ended')).toEqual([]);
    expect(r.surface.logs).toContain('[device] channel confirmed: scoreboard (device reports channel code 0x09)');
  });

  it('stopping a countdown shows the scoreboard again with the scores', async () => {
    const r = await online();
    await r.c.setScore({ red: 5, blue: 1 });
    await r.c.startCountdown({ minutes: 1, seconds: 0 });
    clear(r);
    await r.c.stopCountdown();
    expect(sent(r)).toEqual(['72 03 00 00 00', '45 06', '72 01 01 05 00 01 00', '46']);
    expect(r.c.getChannel()).toBe('scoreboard');
  });
});

describe('weather while the scoreboard is shown', () => {
  it('is held, and sent when the scoreboard ends', async () => {
    const r = await online();
    await r.c.setScore({ red: 1 });
    clear(r);
    await r.c.setWeather(RAIN, 'flow');
    expect(logs(r, 'weather held (scoreboard shown)')).toHaveLength(1);
    expect(sent(r).filter((p) => p.startsWith('5f'))).toEqual([]);
    await r.c.setChannel('clock');
    clear(r);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(sent(r).filter((p) => p.startsWith('5f'))).toEqual(['5f 15 06']);
  });
});

describe('quick successive score actions', () => {
  it('compute from the scores of the previous action and the newest frame carries the final scores', async () => {
    const r = await online();
    await r.c.setScore({ red: 10, blue: 0 });
    clear(r);
    const results = await Promise.all([
      r.c.changeScore('red', 1, 1),
      r.c.changeScore('red', 1, 1),
      r.c.changeScore('red', 1, 1),
    ]);
    expect(r.c.getScores()).toEqual({ red: 13, blue: 0 });
    expect(r.surface.scoreChanges).toEqual([
      { red: 11, blue: 0 },
      { red: 12, blue: 0 },
      { red: 13, blue: 0 },
    ]);
    expect(r.device.scores).toEqual([13, 0]);
    expect(results.filter((completed) => completed)).not.toHaveLength(0); // the newest one completes
    expect(results[2]).toBe(true);
    expect(r.c.getChannel()).toBe('scoreboard');
  });
});
