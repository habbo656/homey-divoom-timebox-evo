// #141, #151: a display change the TimeBox never confirmed (no `46` reply in time) fails instead of reporting success.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { opcodeOf, replyFrame, statusFrame } from '../transport/__fixtures__/frames';
import type { ClockSettings } from './clock';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { CHANNEL_CONFIRM_TIMEOUT_MS } from './TimeboxController';
import type { ImageRequest, TextRequest } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const NOT_CONFIRMED = 'not confirmed text';
const NOT_CONNECTED = 'not connected text';
const GREEN = { r: 0, g: 255, b: 0 };
const BOXED: ClockSettings = { style: 2, weather: false, temperature: true, calendar: false, animations: false };

/** A started controller whose first status reply (channel `initialChannel`) has been processed. */
async function online(initialChannel = 0): Promise<Rig> {
  const r = rig({}, {}, 50);
  r.device.channel = initialChannel;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  return r;
}

/** The simulator still applies commands but never answers `46`. */
function mute(r: Rig): void {
  r.device.answer = false;
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

/** Run an action to its end with the confirm timeout elapsing, and return what it rejected with (or 'resolved'). */
async function outcome(action: Promise<unknown>): Promise<string> {
  const settled = action.then(
    () => 'resolved',
    (e: unknown) => (e as Error).message,
  );
  await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an unconfirmed mode change (#141)', () => {
  it('rejects with not_confirmed after the confirm timeout, writes the tile and fires the trigger once', async () => {
    const r = await online(0);
    mute(r);
    r.t.writes.length = 0;
    const channelsBefore = r.surface.channels.length;
    let done = false;
    const settled = r.c.setChannel('lighting').then(
      () => (done = true),
      (e: Error) => {
        done = true;
        return e;
      },
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await advance(1);
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(NOT_CONFIRMED);
    expect(payloads(r).filter((p) => p.startsWith('45 01'))).toHaveLength(1); // sent once, not retried
    expect(payloads(r).filter((p) => p === '46')).toHaveLength(1);
    expect(r.surface.logs).toContain('[device] channel confirm timeout');
    expect(r.surface.channels.slice(channelsBefore)).toEqual(['lighting']); // the tile reads the requested mode
    expect(r.surface.channelChanges).toEqual(['lighting']);
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.errors).toEqual([]);
  });

  it('rejects with not_connected when the link is lost during the confirm wait', async () => {
    const r = await online(0);
    mute(r);
    const settled = r.c.setChannel('custom').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    r.t.dropLink();
    await flush();
    expect(await settled).toBe(NOT_CONNECTED);
    expect(r.surface.logs.some((l) => l.startsWith('[device] channel confirm failed:'))).toBe(true);
    expect(r.surface.channels.at(-1)).toBe('custom');
    expect(r.surface.errors).toEqual([]);
  });

  it('resolves when the device confirms the mode', async () => {
    const r = await online(0);
    await expect(r.c.setChannel('lighting')).resolves.toBeUndefined();
    expect(r.surface.logs).toContain('[device] channel confirmed: lighting');
  });

  it('still resolves on a mode mismatch', async () => {
    const r = await online(0);
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(50, 0x0a)] : undefined);
    await expect(r.c.setChannel('lighting')).resolves.toBeUndefined();
    expect(r.surface.logs).toContain('[device] channel mismatch: device code 10, requested lighting');
  });

  it('resolves false and writes nothing when a newer change supersedes it during the confirm wait', async () => {
    const r = await online(0);
    mute(r);
    const first = r.c.setChannel('lighting').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush(); // the first change is waiting for its confirm
    const second = r.c.setChannel('custom').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS * 2);
    expect(await first).toBe('resolved');
    expect(await second).toBe(NOT_CONFIRMED);
    expect(r.surface.logs).toContain('[device] channel lighting superseded by a newer change');
    expect(r.surface.channels).not.toContain('lighting'); // only the newer change wrote its tile
    expect(r.surface.channels.at(-1)).toBe('custom');
  });
});

describe('Show clock and Set lighting report a superseded change (#141)', () => {
  it('resolve false when a newer change supersedes them, so the caller skips its tile write', async () => {
    const r = await online(0);
    mute(r);
    const clock = r.c.showClock(2, GREEN).then(
      (v) => v,
      (e: Error) => e.message,
    );
    await flush();
    const lighting = r.c.showLighting({ r: 0, g: 0, b: 255 }).then(
      (v) => v,
      (e: Error) => e.message,
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS * 2);
    expect(await clock).toBe(false);
    expect(await lighting).toBe(NOT_CONFIRMED);
  });

  it('resolve true when confirmed', async () => {
    const r = await online(0);
    await expect(r.c.showClock(2, GREEN)).resolves.toBe(true);
    await expect(r.c.showLighting({ r: 0, g: 0, b: 255 })).resolves.toBe(true);
  });
});

describe('every path through switchTo rejects when unconfirmed (#141)', () => {
  it('Show clock rejects and writes the mode and the colour tile', async () => {
    const r = await online(1);
    mute(r);
    r.surface.colors.length = 0;
    expect(await outcome(r.c.showClock(2, GREEN))).toBe(NOT_CONFIRMED);
    expect(r.surface.channels.at(-1)).toBe('clock');
    expect(r.surface.colors).toHaveLength(1);
    expect(r.surface.colors[0].hue).toBeCloseTo(1 / 3, 10);
  });

  it('Set lighting rejects and writes the mode and the colour tile', async () => {
    const r = await online(0);
    mute(r);
    r.surface.colors.length = 0;
    expect(await outcome(r.c.showLighting({ r: 0, g: 0, b: 255 }))).toBe(NOT_CONFIRMED);
    expect(r.surface.channels.at(-1)).toBe('lighting');
    expect(r.surface.colors.at(-1)?.hue).toBeCloseTo(2 / 3, 10);
  });

  it('Show custom page rejects and does not read the page back', async () => {
    const r = await online(0);
    mute(r);
    r.t.writes.length = 0;
    expect(await outcome(r.c.showCustomPage(1))).toBe(NOT_CONFIRMED);
    expect(payloads(r)).not.toContain('bd 17 ff');
    expect(r.surface.channels.at(-1)).toBe('custom');
  });

  it('the colour tile rejects in lighting and in clock mode', async () => {
    const r = await online(1);
    mute(r);
    expect(await outcome(r.c.setTileColor(0, 1))).toBe(NOT_CONFIRMED);
    expect(r.surface.channels.at(-1)).toBe('lighting');
    expect(r.surface.colors.at(-1)?.hue).toBeCloseTo(0, 10);
    expect(r.surface.colors.at(-1)?.saturation).toBeCloseTo(1, 10);
    const clock = await online(0);
    mute(clock);
    expect(await outcome(clock.c.setTileColor(1 / 3, 1))).toBe(NOT_CONFIRMED);
    expect(clock.surface.colors.at(-1)?.hue).toBeCloseTo(1 / 3, 10);
  });

  it('power on rejects when the restored mode is not confirmed; power off rejects too (#151)', async () => {
    const r = await online(0);
    mute(r);
    expect(await outcome(r.c.setPower(false))).toBe(NOT_CONFIRMED);
    expect(await outcome(r.c.setPower(true))).toBe(NOT_CONFIRMED);
  });

  it('the clock settings change only logs the failure', async () => {
    const r = await online(0);
    mute(r);
    const change = r.c.setClockSettings(BOXED);
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await expect(change).resolves.toBeUndefined();
    expect(r.surface.logs).toContain(`[device] clock settings not applied: ${NOT_CONFIRMED}`);
    expect(r.surface.errors).toEqual([]);
  });

  it('the countdown stop re-send only logs the failure', async () => {
    const r = await online(0);
    await r.c.startCountdown({ minutes: 1, seconds: 0 });
    mute(r);
    const stop = r.c.stopCountdown();
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await expect(stop).resolves.toBeUndefined();
    expect(r.surface.logs).toContain(`[device] countdown stop: mode re-send failed: ${NOT_CONFIRMED}`);
  });
});

describe('the internal power-on passes the error on (#141)', () => {
  const textRequest: TextRequest = {
    text: 'Hallo',
    color: { r: 255, g: 255, b: 0 },
    background: { r: 0, g: 0, b: 128 },
    speed: 5,
    durationS: 0,
  };
  const imageRequest: ImageRequest = {
    payload: Uint8Array.from({ length: 1036 }, (_, i) => (i === 0 ? 0x44 : i % 251)),
    colours: 3,
    fit: 'cover',
    durationS: 0,
  };
  const cases: [string, number, (r: Rig) => Promise<void>][] = [
    ['Show text', 0x6e, (r) => r.c.showText(textRequest)],
    ['Start countdown', 0x72, (r) => r.c.startCountdown({ minutes: 1, seconds: 0 })],
    ['Show image', 0x44, (r) => r.c.showImage(imageRequest)],
    ['Show notification icon', 0x50, (r) => r.c.showNotificationIcon('telegram')],
  ];

  it.each(cases)('%s rejects with not_confirmed and sends its own frame never', async (_name, opcode, run) => {
    const r = await online(0);
    await r.c.setPower(false);
    mute(r);
    r.t.writes.length = 0;
    expect(await outcome(run(r))).toBe(NOT_CONFIRMED);
    expect(payloads(r).filter((p) => p.startsWith(opcode.toString(16).padStart(2, '0')))).toEqual([]);
    expect(r.surface.errors).toEqual([]);
  });
});

describe('the image end re-send (#141)', () => {
  it('only logs an unconfirmed re-send of the mode', async () => {
    const r = await online(0);
    await r.c.showImage({
      payload: Uint8Array.from({ length: 1036 }, (_, i) => (i === 0 ? 0x44 : i % 251)),
      colours: 3,
      fit: 'cover',
      durationS: 15,
    });
    mute(r);
    await advance(15_000 + CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(r.surface.logs).toContain(`[device] image ended (duration): mode re-send failed: ${NOT_CONFIRMED}`);
    expect(r.surface.errors).toEqual([]);
  });
});

describe('the not_confirmed text is localised', () => {
  it('exists in en and de, non-empty and different', () => {
    const read = (lang: string) =>
      JSON.parse(readFileSync(new URL(`../../locales/${lang}.json`, import.meta.url), 'utf8')) as {
        device: { error: Record<string, string> };
      };
    const en = read('en').device.error;
    const de = read('de').device.error;
    expect(en.not_confirmed).toBe(
      'The TimeBox did not confirm the change. Check the display and try again in a moment.',
    );
    expect(de.not_confirmed).toBe(
      'Die TimeBox hat die Änderung nicht bestätigt. Prüfe die Anzeige und versuche es gleich noch einmal.',
    );
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
  });
});

describe('an unconfirmed dim (#151)', () => {
  it('rejects with not_confirmed after the confirm timeout, writes the tile and sends 74 once', async () => {
    const r = await online(0);
    mute(r);
    r.t.writes.length = 0;
    r.surface.dims.length = 0;
    let done = false;
    const settled = r.c.setDim(0.3).then(
      () => (done = true),
      (e: Error) => {
        done = true;
        return e;
      },
    );
    await advance(4_999);
    expect(done).toBe(false);
    await advance(1);
    const error = await settled;
    expect((error as Error).message).toBe(NOT_CONFIRMED);
    expect(payloads(r).filter((p) => p.startsWith('74'))).toEqual(['74 1e']); // sent once, not retried
    expect(r.surface.logs).toContain('[device] dim confirm timeout');
    expect(r.surface.dims).toEqual([0.3]); // the tile reads the requested value
    expect(r.surface.errors).toEqual([]);
  });

  it('rejects with not_connected when the link is lost during the confirm wait', async () => {
    const r = await online(0);
    mute(r);
    r.surface.dims.length = 0;
    const settled = r.c.setDim(0.3).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    r.t.dropLink();
    await flush();
    expect(await settled).toBe(NOT_CONNECTED);
    expect(r.surface.logs.some((l) => l.startsWith('[device] dim confirm failed:'))).toBe(true);
    expect(r.surface.dims).toEqual([0.3]);
  });

  it('rejects with not_connected when stopped during the confirm wait, without a tile write', async () => {
    const r = await online(0);
    mute(r);
    r.surface.dims.length = 0;
    const settled = r.c.setDim(0.3).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    await r.c.stop();
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await settled).toBe(NOT_CONNECTED);
    expect(r.surface.dims).toEqual([]);
  });

  it('resolves the older dim when a newer one arrives during the wait and writes no tile for it', async () => {
    const r = await online(0);
    r.t.autoReply = undefined; // no unsolicited status after 74 either: the newer 74 cannot answer the older 46
    r.surface.dims.length = 0;
    const older = r.c.setDim(0.3).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    const newer = r.c.setDim(0.8).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await older).toBe('resolved');
    expect(await newer).toBe(NOT_CONFIRMED);
    expect(r.surface.logs).toContain('[device] dim 30 superseded by a newer change');
    expect(r.surface.dims).toEqual([0.8]); // only the newest value reaches the tile
  });

  it('resolves on a brightness mismatch', async () => {
    const r = await online(0);
    r.t.autoReply = (w) => (opcodeOf(w) === 0x46 ? [statusFrame(10, 0)] : undefined);
    await expect(r.c.setDim(0.3)).resolves.toBeUndefined();
    expect(r.surface.logs).toContain('[device] dim mismatch: device 10, requested 30');
  });

  it('resolves at once while the panel is off: the value is held and nothing is sent', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    mute(r);
    r.t.writes.length = 0;
    r.surface.dims.length = 0;
    await expect(r.c.setDim(0.3)).resolves.toBeUndefined();
    expect(payloads(r)).toEqual([]);
    expect(r.surface.dims).toEqual([]);
  });
});

describe('an unconfirmed power off (#151)', () => {
  it('rejects with not_confirmed after the confirm timeout and keeps the optimistic off and the shadow', async () => {
    const r = await online(0);
    mute(r);
    r.t.writes.length = 0;
    r.surface.onoffs.length = 0;
    let done = false;
    const settled = r.c.setPower(false).then(
      () => (done = true),
      (e: Error) => {
        done = true;
        return e;
      },
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await advance(1);
    expect(((await settled) as Error).message).toBe(NOT_CONFIRMED);
    expect(payloads(r).filter((p) => p.startsWith('45 01'))).toHaveLength(1); // sent once, not retried
    expect(r.surface.logs).toContain('[device] power off confirm timeout');
    expect(r.surface.onoffs).toEqual([false]); // the tile reads off
    expect(r.c.isOn()).toBe(false);
    // The shadow is d0 01: a poll with it does not look like a switch on at the device.
    r.t.emitData(statusFrame(50, 1));
    expect(r.c.isOn()).toBe(false);
    expect(r.surface.onoffs).toEqual([false]);
    expect(r.surface.errors).toEqual([]);
  });

  it('rejects with not_connected when the link is lost during the confirm wait', async () => {
    const r = await online(0);
    mute(r);
    r.surface.onoffs.length = 0;
    const settled = r.c.setPower(false).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    r.t.dropLink();
    await flush();
    expect(await settled).toBe(NOT_CONNECTED);
    expect(r.surface.logs.some((l) => l.startsWith('[device] power off confirm failed:'))).toBe(true);
    expect(r.surface.onoffs).toEqual([false]);
    expect(r.c.isOn()).toBe(false);
  });

  it('resolves the off when a power on replaces it during the wait and writes no off tile for it', async () => {
    const r = await online(0);
    mute(r);
    r.surface.onoffs.length = 0;
    const off = r.c.setPower(false).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    const on = r.c.setPower(true).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await off).toBe('resolved');
    expect(await on).toBe(NOT_CONFIRMED); // the power on is the unconfirmed one now
    expect(r.surface.logs).toContain('[device] power off superseded by a newer change');
    expect(r.surface.onoffs).not.toContain(false);
    expect(r.c.isOn()).toBe(true);
  });

  it('rejects with not_connected when stopped during the confirm wait, without a tile write', async () => {
    const r = await online(0);
    mute(r);
    r.surface.onoffs.length = 0;
    const settled = r.c.setPower(false).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    await r.c.stop();
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await settled).toBe(NOT_CONNECTED);
    expect(r.surface.onoffs).toEqual([]);
  });

  it('still holds a dim sent during the off wait and applies it at the next power on (#62)', async () => {
    const r = await online(0);
    mute(r);
    const off = r.c.setPower(false).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    r.t.writes.length = 0;
    await expect(r.c.setDim(0.3)).resolves.toBeUndefined();
    expect(payloads(r)).toEqual([]);
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await off).toBe(NOT_CONFIRMED);
    expect(r.surface.logs).toContain('[device] dim held while off: 30 (sent at power on)');
    r.device.answer = true;
    r.t.writes.length = 0;
    await r.c.setPower(true);
    expect(payloads(r)).toContain('74 1e');
  });
});

describe('an unconfirmed custom page (#151)', () => {
  it('rejects with not_confirmed when the 46 is confirmed but the page is not read back; tile and trigger are set once', async () => {
    const r = await online(0);
    r.device.answerPage = false;
    r.t.writes.length = 0;
    r.surface.channels.length = 0;
    r.surface.channelChanges.length = 0;
    expect(await outcome(r.c.showCustomPage(1))).toBe(NOT_CONFIRMED);
    expect(payloads(r).filter((p) => p === 'bd 17 ff')).toHaveLength(1); // asked once, not retried
    expect(r.surface.logs).toContain('[device] channel confirmed: custom');
    expect(r.surface.logs).toContain('[device] custom page confirm timeout');
    expect(r.surface.channels.at(-1)).toBe('custom');
    expect(r.surface.channelChanges).toEqual(['custom']);
    expect(r.c.getChannel()).toBe('custom');
    expect(r.surface.errors).toEqual([]);
  });

  it('rejects with not_confirmed for a malformed page reply', async () => {
    const r = await online(0);
    const original = r.t.autoReply!;
    r.t.autoReply = (w) => (opcodeOf(w) === 0xbd ? [replyFrame(0xbd, 0x17)] : original(w));
    expect(await outcome(r.c.showCustomPage(1))).toBe(NOT_CONFIRMED);
    expect(r.surface.logs.some((l) => l.startsWith('[device] custom page confirm failed:'))).toBe(true);
    expect(r.surface.channels.at(-1)).toBe('custom');
  });

  it('rejects with not_connected when the link is lost while the page is read', async () => {
    const r = await online(0);
    r.device.answerPage = false;
    const settled = r.c.showCustomPage(1).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await flush();
    await flush();
    r.t.dropLink();
    await flush();
    expect(await settled).toBe(NOT_CONNECTED);
    expect(r.surface.logs.some((l) => l.startsWith('[device] custom page confirm failed:'))).toBe(true);
    expect(r.surface.channels.at(-1)).toBe('custom');
  });

  it('resolves false without a tile write when a newer change replaces it during the read-back', async () => {
    const r = await online(0);
    r.device.answerPage = false;
    const page = r.c.showCustomPage(1).then(
      (v) => v,
      (e: Error) => e.message,
    );
    await flush();
    await flush();
    r.surface.channels.length = 0;
    await r.c.setChannel('lighting');
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await page).toBe(false);
    expect(r.surface.logs).toContain('[device] custom page confirm timeout');
    expect(r.surface.logs).toContain('[device] channel custom superseded by a newer change');
    expect(r.surface.channels).toEqual([]); // the superseded page does not write `custom` again (Homey stores the newer listener value)
    expect(r.c.getChannel()).toBe('lighting');
  });

  it('resolves when the device shows another page (a mismatch is only logged)', async () => {
    const r = await online(0);
    r.device.customPage = 2;
    const original = r.t.autoReply!;
    r.t.autoReply = (w) => (opcodeOf(w) === 0xbd && w[13] === 0x01 ? undefined : original(w));
    await expect(r.c.showCustomPage(1)).resolves.toBe(true);
    expect(r.surface.logs).toContain('[device] custom page mismatch: device 3, requested 2');
  });
});
