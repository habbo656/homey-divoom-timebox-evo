// Volume, mute and the audio play status (#4): `08 VV` set, `09` volume read-back and poll, `0b` play status.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { replyFrame, statusFrame } from '../transport/__fixtures__/frames';
import { ArgumentError } from './argumentError';
import { AUDIO_READ_INTERVAL_MS, AUDIO_REQUEST_TIMEOUT_MS } from './TimeboxController';
import type { TimeboxControllerOptions } from './TimeboxController';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const OFF_RED_50 = '45 01 ff 00 00 32 00 00 00 00 00';
const WOKE = '[device] power <- device: woke while off (d8 01), sending off again';

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
/** The audio frames written: `08 VV`, `09`, `0b`. */
const audio = (r: Rig): string[] => payloads(r).filter((p) => /^(08|09|0b)\b/.test(p));

/** Clear what the tests compare: writes, logs and the recorded surface calls. */
function reset(r: Rig): void {
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  r.surface.volumes.length = 0;
  r.surface.mutes.length = 0;
  r.surface.playing.length = 0;
  r.surface.playingChanges.length = 0;
  r.surface.savedRestoreVolumes.length = 0;
}

/**
 * A started controller whose first status and audio reads (device volume `volume`, play status `playing`) are done, in
 * lighting red at brightness 50; recorded calls cleared.
 */
async function online(opts: TimeboxControllerOptions = {}, volume = 5, playing = 0): Promise<Rig> {
  const r = rig({}, opts, 50);
  r.device.channel = 1;
  r.device.color = [0xff, 0, 0];
  r.device.volume = volume;
  r.device.playing = playing;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  reset(r);
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('audio reads (#4)', () => {
  it('reads 09 then 0b after the first status and writes the tiles, without a trigger', async () => {
    const r = rig({}, {}, 50);
    r.device.volume = 5;
    r.c.start();
    await flush();
    expect(audio(r)).toEqual(['09', '0b']);
    expect(r.surface.volumes).toEqual([5 / 15]);
    expect(r.surface.mutes).toEqual([false]);
    expect(r.surface.playing).toEqual([false]);
    expect(r.surface.playingChanges).toEqual([]);
    expect(r.surface.savedRestoreVolumes).toEqual([5]);
    expect(r.surface.logs).toContain('[device] volume <- device: 5');
    expect(r.surface.logs).toContain('[device] audio playing <- device: no');
    expect(r.c.isAudioPlaying()).toBe(false);
    expect(r.surface.errors).toEqual([]);
  });

  it('a device at volume 0 shows 0 and mute on; the stored restore volume is kept', async () => {
    const r = rig({}, { restoreVolume: 7 }, 50);
    r.device.volume = 0;
    r.c.start();
    await flush();
    expect(r.surface.volumes).toEqual([0]);
    expect(r.surface.mutes).toEqual([true]);
    expect(r.surface.savedRestoreVolumes).toEqual([]);
  });

  it('reads once per 60 s poll: extra 46 reports in between read nothing', async () => {
    const r = await online();
    r.t.emitData(statusFrame(50, 1, { 3: 0xff, 8: 1 })); // an unsolicited report
    await advance(30_000);
    expect(audio(r)).toEqual([]);
    await advance(30_000); // the 60 s poll
    expect(audio(r)).toEqual(['09', '0b']);
    await advance(60_000);
    expect(audio(r)).toEqual(['09', '0b', '09', '0b']);
    expect(AUDIO_READ_INTERVAL_MS).toBeLessThan(60_000);
  });

  it('writes nothing for an unchanged poll', async () => {
    const r = await online();
    await advance(60_000);
    expect(audio(r)).toEqual(['09', '0b']);
    expect(r.surface.volumes).toEqual([]);
    expect(r.surface.mutes).toEqual([]);
    expect(r.surface.playing).toEqual([]);
    expect(r.surface.logs.filter((l) => l.includes('volume') || l.includes('audio'))).toEqual([]);
  });

  it('a read failure is only logged, the link stays up', async () => {
    const r = await online();
    r.device.answerPlay = false;
    await advance(60_000 + AUDIO_REQUEST_TIMEOUT_MS);
    expect(r.surface.logs.some((l) => l.startsWith('[device] audio read failed: play status:'))).toBe(true);
    expect(r.m.state).toBe('connected');
    expect(r.surface.errors).toEqual([]);
    // The next poll reads again.
    r.device.answerPlay = true;
    r.t.writes.length = 0;
    await advance(60_000);
    expect(audio(r)).toEqual(['09', '0b']);
  });
});

describe('volume from the device (#4)', () => {
  it('follows a volume changed outside Homey; 0 turns mute on, non-zero turns it off again', async () => {
    const r = await online();
    r.device.volume = 0;
    await advance(60_000);
    expect(r.surface.volumes).toEqual([0]);
    expect(r.surface.mutes).toEqual([true]);
    expect(r.surface.logs).toContain('[device] volume <- device: 0');
    r.device.volume = 9;
    await advance(60_000);
    expect(r.surface.volumes).toEqual([0, 9 / 15]);
    expect(r.surface.mutes).toEqual([true, false]);
    expect(r.surface.savedRestoreVolumes).toEqual([9]);
  });

  it('an outside non-zero volume while muted from Homey clears mute', async () => {
    const r = await online();
    await r.c.setMute(true);
    reset(r);
    r.device.volume = 4;
    await advance(60_000);
    expect(r.surface.volumes).toEqual([4 / 15]);
    expect(r.surface.mutes).toEqual([false]);
  });

  it('handles an unsolicited 09 push like a read', async () => {
    const r = await online();
    r.t.emitData(replyFrame(0x09, 12));
    await flush();
    expect(r.surface.volumes).toEqual([12 / 15]);
    expect(r.surface.logs).toContain('[device] volume <- device: 12');
  });

  it('ignores a volume above 15 and an unknown play status', async () => {
    const r = await online();
    r.t.emitData(replyFrame(0x09, 16));
    r.t.emitData(replyFrame(0x0b, 2));
    await flush();
    expect(r.surface.volumes).toEqual([]);
    expect(r.surface.playing).toEqual([]);
    expect(r.surface.logs).toContain('[device] volume report ignored: volume 16 is above 15');
    expect(r.surface.logs).toContain('[device] play status 0x02 is not known, tile unchanged');
  });
});

describe('setVolume (#4)', () => {
  it.each([
    [0.2, '08 03', 3],
    [0.5, '08 08', 8],
    [1, '08 0f', 15],
    [1 / 15, '08 01', 1],
  ])('maps %s to %s on the wire and confirms with 09', async (volume, frame, level) => {
    const r = await online();
    await r.c.setVolume(volume);
    expect(audio(r)).toEqual([frame, '09']);
    expect(r.device.volume).toBe(level);
    expect(r.surface.logs).toContain(`[device] volume -> ${level}: ${frame}`);
    expect(r.surface.logs).toContain(`[device] volume confirmed: ${level}`);
    // Homey writes volume_set itself; mute stays off.
    expect(r.surface.volumes).toEqual([]);
    expect(r.surface.mutes).toEqual([]);
  });

  it('volume 0 turns mute on; a later non-zero volume turns it off (unmutes)', async () => {
    const r = await online();
    await r.c.setVolume(0);
    expect(audio(r)).toEqual(['08 00', '09']);
    expect(r.surface.mutes).toEqual([true]);
    await r.c.setVolume(0.4);
    expect(audio(r)).toEqual(['08 00', '09', '08 06', '09']);
    expect(r.surface.mutes).toEqual([true, false]);
    expect(r.surface.volumes).toEqual([]);
  });

  it('rejects an invalid value with an ArgumentError and sends nothing', async () => {
    const r = await online();
    for (const v of [-0.1, 1.5, NaN, '0.5' as unknown as number]) {
      await expect(r.c.setVolume(v)).rejects.toBeInstanceOf(ArgumentError);
    }
    expect(audio(r)).toEqual([]);
  });

  it('rejects with not_connected without a link and sends nothing', async () => {
    const r = rig();
    await expect(r.c.setVolume(0.5)).rejects.toThrow('not connected text');
    expect(r.t.writes).toEqual([]);
  });

  it('a confirm timeout rejects with not_confirmed and writes both tiles to the requested volume', async () => {
    const r = await online();
    r.device.answerVolume = false;
    const done = r.c.setVolume(0.2);
    const result = expect(done).rejects.toThrow('not confirmed text');
    await advance(AUDIO_REQUEST_TIMEOUT_MS);
    await result;
    expect(r.surface.logs).toContain('[device] volume confirm timeout');
    expect(r.surface.volumes).toEqual([3 / 15]);
    expect(r.surface.mutes).toEqual([false]);
  });

  it('ignores 09 frames while a change is in flight (the read-back confirms it)', async () => {
    const r = await online();
    r.device.answerVolume = false;
    const done = r.c.setVolume(0.2);
    await flush();
    r.t.emitData(replyFrame(0x09, 12)); // a stray push answers the read-back
    await done;
    expect(r.surface.logs).toContain('[device] volume mismatch: device 12, requested 3');
    expect(r.surface.volumes).toEqual([]);
    expect(r.surface.logs).not.toContain('[device] volume <- device: 12');
    // The next poll reads the device value and writes it.
    r.device.answerVolume = true;
    r.device.volume = 12;
    await advance(60_000);
    expect(r.surface.volumes).toEqual([12 / 15]);
  });

  it('the newest change wins: a superseded change writes no tile', async () => {
    const r = await online();
    const first = r.c.setVolume(0);
    const second = r.c.setVolume(0.6);
    await Promise.all([first, second]);
    expect(audio(r)).toEqual(['08 00', '08 09', '09']);
    expect(r.surface.logs).toContain('[device] volume 0 superseded by a newer change');
    expect(r.surface.mutes).toEqual([]);
    expect(r.device.volume).toBe(9);
  });

  it('is sent while the panel is off; the panel lights and the next poll sends the off again (#29)', async () => {
    const r = await online();
    await r.c.setPower(false);
    expect(r.device.power).toBe(false);
    reset(r);
    await r.c.setVolume(0.33);
    expect(audio(r)).toEqual(['08 05', '09']);
    expect(r.device.power).toBe(true); // 08 lit the panel (research #4)
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([true]);
    await advance(60_000);
    expect(r.surface.logs).toContain(WOKE);
    expect(payloads(r)).toContain(OFF_RED_50);
    expect(r.device.power).toBe(false);
    expect(r.c.isOn()).toBe(false);
  });
});

describe('setMute (#4)', () => {
  it('on sends 08 00 and shows 0; off restores the volume from before', async () => {
    const r = await online();
    await r.c.setMute(true);
    expect(audio(r)).toEqual(['08 00', '09']);
    expect(r.surface.logs).toContain('[device] mute -> on: 08 00');
    expect(r.surface.volumes).toEqual([0]);
    expect(r.surface.mutes).toEqual([]);
    await r.c.setMute(false);
    expect(audio(r)).toEqual(['08 00', '09', '08 05', '09']);
    expect(r.surface.logs).toContain('[device] mute -> off: 08 05');
    expect(r.surface.volumes).toEqual([0, 5 / 15]);
    expect(r.surface.savedRestoreVolumes).toEqual([]);
  });

  it('restores the last volume set from Homey', async () => {
    const r = await online();
    await r.c.setVolume(0.2);
    await r.c.setVolume(0);
    await r.c.setMute(false);
    expect(audio(r).slice(-2)).toEqual(['08 03', '09']);
    expect(r.surface.savedRestoreVolumes).toEqual([3]);
  });

  it('unmute without a stored non-zero volume restores 8', async () => {
    const r = await online({}, 0);
    await r.c.setMute(false);
    expect(audio(r)).toEqual(['08 08', '09']);
    expect(r.surface.volumes).toEqual([8 / 15]);
    expect(r.surface.savedRestoreVolumes).toEqual([8]);
  });

  it('unmute uses the stored restore volume of an earlier run', async () => {
    const r = await online({ restoreVolume: 7 }, 0);
    await r.c.setMute(false);
    expect(audio(r)).toEqual(['08 07', '09']);
  });

  it('rejects a value that is not a boolean', async () => {
    const r = await online();
    await expect(r.c.setMute('yes' as unknown as boolean)).rejects.toBeInstanceOf(RangeError);
    expect(audio(r)).toEqual([]);
  });

  it('a confirm timeout writes both tiles and rejects', async () => {
    const r = await online();
    r.device.answerVolume = false;
    const done = r.c.setMute(true);
    const result = expect(done).rejects.toThrow('not confirmed text');
    await advance(AUDIO_REQUEST_TIMEOUT_MS);
    await result;
    expect(r.surface.volumes).toEqual([0]);
    expect(r.surface.mutes).toEqual([true]);
  });
});

describe('audio playing (#4)', () => {
  it('a change within the session fires the triggers', async () => {
    const r = await online();
    r.device.playing = 1;
    await advance(60_000);
    expect(r.surface.playing).toEqual([true]);
    expect(r.surface.playingChanges).toEqual([true]);
    expect(r.c.isAudioPlaying()).toBe(true);
    expect(r.surface.logs).toContain('[device] audio playing <- device: yes');
    r.device.playing = 0;
    await advance(60_000);
    expect(r.surface.playing).toEqual([true, false]);
    expect(r.surface.playingChanges).toEqual([true, false]);
    expect(r.c.isAudioPlaying()).toBe(false);
  });

  it('the first read after a start fires nothing, also when audio plays', async () => {
    const r = rig();
    r.device.playing = 1;
    r.c.start();
    await flush();
    expect(r.surface.playing).toEqual([true]);
    expect(r.surface.playingChanges).toEqual([]);
  });

  it('the first read after a reconnect updates the tile only', async () => {
    const r = await online();
    r.t.dropLink();
    await flush();
    r.device.playing = 1;
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(r.surface.playing).toEqual([true]);
    expect(r.surface.playingChanges).toEqual([]);
    // A later change in the new session fires again.
    r.device.playing = 0;
    await advance(60_000);
    expect(r.surface.playingChanges).toEqual([false]);
  });
});
