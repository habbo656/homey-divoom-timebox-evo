import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { staticImage } from '../protocol/commands';
import type { SleepLight } from '../protocol/commands';
import { toHex } from '../protocol/hex';
import { replyFrame } from '../transport/__fixtures__/frames';
import { CHANNEL_CONFIRM_TIMEOUT_MS } from './TimeboxController';
import { rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const RED: SleepLight = { minutes: 5, sound: 0, volume: 10, color: { r: 0xff, g: 0, b: 0 }, brightness: 50 };
const START_RED = '40 05 00 ff 00 00 0a ff 00 00 32';
const STOP = '40 05 00 00 00 00 00 00 00 00 00';
const OFF_RED_50 = '45 01 ff 00 00 32 00 00 00 00 00';
const BLUE = { r: 0, g: 0, b: 0xff };
const NOT_CONNECTED = 'not connected text';
const NOT_CONFIRMED = 'not confirmed text';

/** A started controller whose first status reply (channel `channel`, lighting colour red, brightness 50) has been processed. */
async function online(channel = 0): Promise<Rig> {
  const r = rig({}, {}, 50);
  r.device.channel = channel;
  r.device.color = [0xff, 0, 0];
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  reset(r);
  return r;
}

function reset(r: Rig): void {
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  r.surface.onoffs.length = 0;
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

const stops = (r: Rig) => payloads(r).filter((p) => p === STOP).length;

/** Settle a promise into its outcome: `resolved` or the error message. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: Error) => e.message,
  );

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('start sleep light (#6)', () => {
  it('sends 40 and confirms with an a2 read; the panel was on, so onoff and the mode stay', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    expect(payloads(r)).toEqual([START_RED, 'a2']);
    expect(r.surface.logs).toEqual([
      `[device] sleep light started: 5 min, #FF0000, brightness 50, phone audio, volume 10: ${START_RED}`,
      '[device] sleep light confirmed',
    ]);
    expect(r.device.sleepStarts).toEqual([[5, 0, 0xff, 0, 0, 10, 0xff, 0, 0, 50]]);
    expect(r.surface.onoffs).toEqual([]);
    expect(r.c.isOn()).toBe(true);
    expect(r.c.getChannel()).toBe('clock');
  });

  it('logs a mismatch of the read-back and still resolves', async () => {
    const r = await online(0);
    r.device.answerSleep = false;
    const started = outcome(r.c.startSleepLight(RED));
    await flush();
    // The device answers with another scene (on/off 00: it did not take the start).
    r.t.emitData(replyFrame(0xa2, 5, 0, 0, 0, 0, 10, 0xff, 0, 0, 50));
    await flush();
    expect(await started).toBe('resolved');
    expect(r.surface.logs).toContain(
      '[device] sleep light mismatch: device 05 00 00 00 00 0a ff 00 00 32, requested 05 00 ff 00 00 0a ff 00 00 32',
    );
  });

  it('started while off: queues the held dim first, lights onoff, re-reads 46 and follows its mode', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.setDim(0.3);
    reset(r);
    r.surface.channels.length = 0;
    await r.c.startSleepLight(RED);
    await flush();
    expect(payloads(r)).toEqual(['74 1e', START_RED, '46', 'a2']);
    expect(r.surface.onoffs).toEqual([true]);
    expect(r.c.isOn()).toBe(true);
    expect(r.surface.logs).toContain('[device] power <- device: on (sleep light)');
    // `46` reports the off shadow d0 `01` (lighting) with d8 `01`: the tile follows the device.
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channels).toEqual(['lighting']);
  });

  it('started while off: the next polls with d8 01 send no off again (no self-wake resend)', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    await r.c.startSleepLight(RED);
    await flush();
    reset(r);
    await advance(65_000);
    expect(payloads(r).some((p) => p.startsWith('45'))).toBe(false);
    expect(r.surface.logs.some((l) => l.includes('woke while off'))).toBe(false);
    expect(r.c.isOn()).toBe(true);
  });

  it('started while an off is in flight: the power is left to that change', async () => {
    const r = await online(0);
    r.device.answer = false; // the off waits for its 46 confirm while the sleep light starts
    const off = outcome(r.c.setPower(false));
    await flush();
    await r.c.startSleepLight(RED);
    expect(r.surface.logs).toContain('[device] sleep light: panel lit, power left to the change in flight');
    expect(r.surface.onoffs).toEqual([]);
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await off).toBe(NOT_CONFIRMED);
    expect(r.c.isOn()).toBe(false);
  });

  it('forgets a running text and ends nothing else on the device', async () => {
    const r = await online(0);
    await r.c.showText({
      text: 'Hi',
      color: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      speed: 5,
      durationS: 0,
    });
    reset(r);
    await r.c.startSleepLight(RED);
    expect(r.c.isTextShown()).toBe(false);
    expect(r.surface.logs).toContain('[device] text stopped (sleep light)');
    expect(payloads(r)).toEqual([START_RED, 'a2']);
  });

  it('a new start replaces a running one without a stop; the older start is superseded', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    reset(r);
    const first = r.c.startSleepLight({ ...RED, brightness: 100 });
    const second = r.c.startSleepLight({ ...RED, brightness: 10 });
    await first;
    await second;
    expect(payloads(r)).toEqual(['40 05 00 ff 00 00 0a ff 00 00 64', '40 05 00 ff 00 00 0a ff 00 00 0a', 'a2', 'a2']);
    expect(r.surface.logs).toContain('[device] sleep light superseded by a newer change');
    expect(r.surface.logs.at(-1)).toBe('[device] sleep light confirmed');
  });

  it('rejects with not_confirmed when the a2 read-back does not come', async () => {
    const r = await online(0);
    r.device.answerSleep = false;
    const started = outcome(r.c.startSleepLight(RED));
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await started).toBe(NOT_CONFIRMED);
    expect(r.surface.logs).toContain('[device] sleep light confirm timeout');
  });

  it('rejects with not_connected when the link is lost during the confirm', async () => {
    const r = await online(0);
    r.device.answerSleep = false;
    const started = outcome(r.c.startSleepLight(RED));
    await flush();
    r.t.dropLink();
    await flush();
    expect(await started).toBe(NOT_CONNECTED);
  });

  it('rejects without a link and for invalid values, sending nothing', async () => {
    const r = await online(0);
    await expect(r.c.startSleepLight({ ...RED, minutes: 0 })).rejects.toThrow(RangeError);
    await expect(r.c.startSleepLight({ ...RED, sound: 24 })).rejects.toThrow(RangeError);
    expect(r.t.writes).toEqual([]);
    r.t.dropLink();
    await flush();
    await expect(r.c.startSleepLight(RED)).rejects.toThrow(NOT_CONNECTED);
  });
});

describe('stop sleep light (#6)', () => {
  it('reads a2 and, while a sleep light runs, sends the stop and waits for its a2 answer', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    reset(r);
    await r.c.stopSleepLight();
    expect(payloads(r)).toEqual(['a2', STOP]);
    expect(r.device.sleepStops).toBe(1);
    expect(r.surface.logs).toEqual(['[device] sleep light stopped']);
    expect(r.surface.onoffs).toEqual([]);
  });

  it('also stops a sleep light the app did not start (Divoom app, app restart)', async () => {
    const r = await online(0);
    r.device.sleep[2] = 0xff;
    await r.c.stopSleepLight();
    expect(payloads(r)).toEqual(['a2', STOP]);
  });

  it('resolves silently without sending a stop when none runs', async () => {
    const r = await online(0);
    await r.c.stopSleepLight();
    expect(payloads(r)).toEqual(['a2']);
    expect(r.surface.logs).toEqual(['[device] sleep light: none running']);
    await r.c.startSleepLight(RED);
    await r.c.stopSleepLight();
    reset(r);
    await r.c.stopSleepLight();
    expect(payloads(r)).toEqual(['a2']);
    expect(r.surface.logs).toEqual(['[device] sleep light: none running']);
  });

  it('after the stop, a display change sends no stop', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    await r.c.stopSleepLight();
    reset(r);
    await r.c.showLighting(BLUE);
    expect(stops(r)).toBe(0);
  });

  it('with the panel turned off after the start: stops and keeps onoff false', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    await r.c.setPower(false);
    reset(r);
    await r.c.stopSleepLight();
    expect(payloads(r)).toEqual(['a2', STOP]);
    expect(r.surface.onoffs).toEqual([]);
    expect(r.c.isOn()).toBe(false);
  });

  it('rejects with not_confirmed when the read or the stop answer does not come', async () => {
    const r = await online(0);
    r.device.answerSleep = false;
    const read = outcome(r.c.stopSleepLight());
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await read).toBe(NOT_CONFIRMED);
    expect(r.surface.logs).toContain('[device] sleep light read timeout');

    r.device.answerSleep = true;
    r.device.sleep[2] = 0xff;
    r.device.answerSleepStop = false;
    const stop = outcome(r.c.stopSleepLight());
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await stop).toBe(NOT_CONFIRMED);
    expect(r.surface.logs).toContain('[device] sleep light stop confirm timeout');
  });

  it('a failed read keeps the tracking: the next display change still sends the stop', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    r.device.answerSleep = false;
    const read = outcome(r.c.stopSleepLight());
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    expect(await read).toBe(NOT_CONFIRMED);
    reset(r);
    await r.c.showLighting(BLUE);
    expect(payloads(r)[0]).toBe(STOP);
  });

  it('rejects with not_connected without a link', async () => {
    const r = await online(0);
    r.t.dropLink();
    await flush();
    await expect(r.c.stopSleepLight()).rejects.toThrow(NOT_CONNECTED);
  });
});

describe('stop before a display change (#6)', () => {
  it('sends the stop right before the lighting command, once', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    reset(r);
    await r.c.showLighting(BLUE);
    expect(payloads(r)).toEqual([STOP, '45 01 00 00 ff 32 00 01 00 00 00', '46']);
    expect(r.surface.logs).toContain(`[device] sleep light stop before lighting: ${STOP}`);
    reset(r);
    await r.c.showLighting(RED.color);
    expect(stops(r)).toBe(0);
  });

  it('sends one stop for two changes at once', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    reset(r);
    await Promise.all([r.c.setChannel('custom'), r.c.showLighting(BLUE)]);
    expect(stops(r)).toBe(1);
    expect(payloads(r)[0]).toBe(STOP);
  });

  it.each([
    ['mode', (r: Rig) => r.c.setChannel('custom'), 'mode custom', '45 05'],
    ['clock', (r: Rig) => r.c.showClock(1, BLUE), 'mode clock', '26'],
    ['custom page', (r: Rig) => r.c.showCustomPage(1), 'mode custom', '45 05'],
    ['tile colour', (r: Rig) => r.c.setTileColor(0.5, 1), 'mode clock', '26'],
    [
      'text',
      (r: Rig) =>
        r.c.showText({
          text: 'Hi',
          color: { r: 255, g: 255, b: 255 },
          background: { r: 0, g: 0, b: 0 },
          speed: 5,
          durationS: 0,
        }),
      'text',
      '6e 01',
    ],
    [
      'image',
      (r: Rig) =>
        r.c.showImage({
          payload: staticImage({ palette: [{ r: 0, g: 0, b: 0 }], pixels: new Array<number>(256).fill(0) }),
          colours: 1,
          fit: 'contain',
          durationS: 0,
        }),
      'image',
      '44',
    ],
    ['countdown', (r: Rig) => r.c.startCountdown({ minutes: 1, seconds: 0 }), 'countdown', '72 03 01 01 00'],
  ] as const)('before %s', async (_name, change, what, first) => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    reset(r);
    await change(r);
    const sent = payloads(r);
    expect(sent[0]).toBe(STOP);
    expect(sent[1].startsWith(first)).toBe(true);
    expect(stops(r)).toBe(1);
    expect(r.surface.logs).toContain(`[device] sleep light stop before ${what}: ${STOP}`);
  });

  it('sends no stop once the minutes have run out', async () => {
    const r = await online(0);
    await r.c.startSleepLight({ ...RED, minutes: 1 });
    await advance(60_000);
    reset(r);
    await r.c.showLighting(BLUE);
    expect(stops(r)).toBe(0);
  });

  it('power off sends no stop; the power on afterwards does (the timer still runs)', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    reset(r);
    await r.c.setPower(false);
    expect(payloads(r)).toEqual([OFF_RED_50, '46']);
    reset(r);
    await r.c.setPower(true);
    expect(payloads(r)[0]).toBe(STOP);
    expect(r.surface.logs).toContain(`[device] sleep light stop before mode clock: ${STOP}`);
  });

  it('volume, weather and the notification icon send no stop', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    reset(r);
    await r.c.setVolume(0.5);
    await r.c.setWeather({ temperatureC: 20, condition: 'clear' }, 'flow');
    await r.c.showNotificationIcon('telegram');
    expect(stops(r)).toBe(0);
    await r.c.showLighting(BLUE);
    expect(stops(r)).toBe(1);
  });

  it('a failed stop is logged and the change goes on', async () => {
    const r = await online(0);
    await r.c.startSleepLight(RED);
    reset(r);
    r.t.writeErrors.push(new Error('write failed once'));
    const changed = outcome(r.c.showLighting(BLUE));
    await flush();
    await advance(CHANNEL_CONFIRM_TIMEOUT_MS);
    await changed;
    expect(r.surface.logs.some((l) => l.startsWith('[device] sleep light stop before lighting failed:'))).toBe(true);
  });
});
