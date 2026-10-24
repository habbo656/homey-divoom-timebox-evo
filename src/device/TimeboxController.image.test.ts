import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from '../protocol/hex';
import { MESSAGES, rig } from './__fixtures__/controllerRig';
import type { Rig } from './__fixtures__/controllerRig';
import { ImageError } from './imageError';
import type { ImageRequest, TextRequest } from './TimeboxController';
import { STATUS_POLL_INTERVAL_MS } from './TimeboxController';

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A started controller whose first status reply (channel `initialChannel`) has been processed. */
async function online(initialChannel = 0, opts: Parameters<typeof rig>[1] = {}): Promise<Rig> {
  const r = rig({}, opts);
  r.device.channel = initialChannel;
  r.c.start();
  await flush();
  expect(r.m.state).toBe('connected');
  r.t.writes.length = 0;
  r.surface.logs.length = 0;
  for (const list of [r.surface.channels, r.surface.channelChanges, r.surface.colors, r.surface.onoffs])
    list.length = 0;
  return r;
}

/** The payloads written since the last reset, chunks joined back into envelopes (opcode first). */
function payloads(r: Rig): Uint8Array[] {
  const all = Uint8Array.from(r.t.writes.flatMap((w) => [...w]));
  const out: Uint8Array[] = [];
  for (let at = 0; at < all.length;) {
    const len = all[at + 4] | (all[at + 5] << 8);
    out.push(all.subarray(at + 11, at + 6 + len - 2));
    at += 6 + len;
  }
  return out;
}
const opcodes = (r: Rig): string[] => payloads(r).map((p) => p[0].toString(16).padStart(2, '0'));
const sent = (r: Rig): string[] => payloads(r).map((p) => toHex(p.subarray(0, 5)));
const logs = (r: Rig, part: string): string[] => r.surface.logs.filter((l) => l.includes(part));

/** A 1036-byte `44` payload, as `buildImageCommand` makes it. */
const PAYLOAD = Uint8Array.from({ length: 1036 }, (_, i) => (i === 0 ? 0x44 : i % 251));
const request = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  payload: PAYLOAD,
  colours: 3,
  fit: 'cover',
  durationS: 0,
  ...over,
});
const textRequest = (over: Partial<TextRequest> = {}): TextRequest => ({
  text: 'Hallo',
  color: { r: 255, g: 255, b: 0 },
  background: { r: 0, g: 0, b: 128 },
  speed: 5,
  durationS: 0,
  ...over,
});
/** Keep the link down for `ms`: every reconnect attempt in that time fails. */
async function downFor(r: Rig, ms: number): Promise<void> {
  for (let waited = 0; waited < ms; waited += 250) {
    r.t.failNextOpen();
    await advance(250);
  }
}
const RAIN = { temperatureC: 21, condition: 'rain' } as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('showImage', () => {
  it('sends exactly the 44 payload and logs the colours, fit and duration', async () => {
    const r = await online();
    await r.c.showImage(request({ durationS: 0 }));
    const out = payloads(r);
    expect(out).toHaveLength(1);
    expect(Array.from(out[0])).toEqual(Array.from(PAYLOAD));
    expect(r.c.isImageShown()).toBe(true);
    expect(logs(r, 'image shown')).toEqual(['[device] image shown: 3 colours, cover, until a mode change']);
  });

  it('is an overlay: tile, known channel and triggers stay', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 5 }));
    expect(r.c.getChannel()).toBe('clock');
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
    expect(r.surface.colors).toEqual([]);
  });

  it('rejects an invalid duration or payload without sending', async () => {
    const r = await online();
    await expect(r.c.showImage(request({ durationS: -1 }))).rejects.toThrow(RangeError);
    await expect(r.c.showImage(request({ durationS: 3601 }))).rejects.toThrow(RangeError);
    await expect(r.c.showImage(request({ durationS: NaN }))).rejects.toThrow(RangeError);
    await expect(r.c.showImage(request({ payload: new Uint8Array(0) }))).rejects.toThrow(RangeError);
    await expect(r.c.showImage(request({ payload: Uint8Array.of(0x45, 0) }))).rejects.toThrow(RangeError);
    expect(r.t.writes).toEqual([]);
    expect(r.c.isImageShown()).toBe(false);
  });

  it('fails with the readable error when not connected and sends nothing', async () => {
    const r = rig();
    await expect(r.c.showImage(request())).rejects.toThrow(MESSAGES.notConnected);
    expect(r.t.writes).toEqual([]);
  });

  it('turns the panel on first if it is off, then sends the image', async () => {
    const r = await online(0);
    await r.c.setPower(false);
    r.t.writes.length = 0;
    r.surface.logs.length = 0;
    await r.c.showImage(request());
    expect(opcodes(r)).toEqual(['26', '45', '46', '44']);
    expect(logs(r, 'panel is off, turning it on first')).toHaveLength(1);
    expect(r.c.isOn()).toBe(true);
  });

  it('sends a pending small-clock re-send ahead of the image, so it cannot end the image 1.5 s later', async () => {
    const small = { style: 6, weather: false, temperature: false, calendar: false, animations: false };
    const r = rig({}, { clockSettings: small });
    r.device.channel = 0;
    r.c.start();
    await flush();
    await r.c.setPower(false);
    r.t.writes.length = 0;
    await r.c.showImage(request());
    expect(opcodes(r)).toEqual(['26', '45', '46', '45', '44']);
    expect(logs(r, 'clock face re-sent before the image')).toHaveLength(1);
    r.t.writes.length = 0;
    await advance(3000);
    expect(opcodes(r)).toEqual([]);
  });

  it('a second image replaces the first and only the newest duration counts', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 5 }));
    await r.c.showImage(request({ durationS: 20 }));
    r.t.writes.length = 0;
    await advance(6000);
    expect(opcodes(r)).toEqual([]);
    expect(r.c.isImageShown()).toBe(true);
    await advance(15000);
    expect(opcodes(r)).toContain('45');
    expect(r.c.isImageShown()).toBe(false);
  });

  it('does not touch the device status polls: the poll keeps running', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    r.t.writes.length = 0;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(opcodes(r)).toContain('46');
    expect(r.c.isImageShown()).toBe(true);
  });
});

describe('the duration of an image', () => {
  it('re-sends the known mode when it has passed', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 15 }));
    r.t.writes.length = 0;
    await advance(14_999);
    expect(opcodes(r)).toEqual([]);
    await advance(1);
    await flush();
    expect(sent(r).filter((p) => p.startsWith('45 00'))).toHaveLength(1);
    expect(r.c.isImageShown()).toBe(false);
    expect(logs(r, 'image ended (duration): mode clock re-sent')).toHaveLength(1);
    // Not a mode change: nothing is written to the tile or the triggers.
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('re-sends lighting and custom as the same mode', async () => {
    const r = await online(1);
    await r.c.showImage(request({ durationS: 2 }));
    r.t.writes.length = 0;
    await advance(2000);
    await flush();
    expect(sent(r).filter((p) => p.startsWith('45 01'))).toHaveLength(1);
  });

  it('sends nothing when the link is down at expiry', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 3 }));
    r.t.writes.length = 0;
    r.t.dropLink();
    await downFor(r, 3500);
    expect(r.m.state).not.toBe('connected');
    expect(opcodes(r)).toEqual([]);
    expect(logs(r, 'image duration over: not connected')).toHaveLength(1);
    expect(r.c.isImageShown()).toBe(false);
  });

  it('only forgets the image when a mode change is still in flight at expiry', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 3 }));
    r.t.writes.length = 0;
    await advance(2990);
    r.t.holdWrites();
    const change = r.c.setChannel('lighting');
    await advance(10); // the duration is over while the switch is still being written
    r.t.releaseWrites();
    await change;
    await flush();
    expect(r.c.isImageShown()).toBe(false);
    expect(sent(r).filter((p) => p.startsWith('45 00'))).toEqual([]); // no clock re-send over the new mode
    expect(sent(r).filter((p) => p.startsWith('45 01'))).toHaveLength(1);
    expect(r.c.getChannel()).toBe('lighting');
  });

  it('only forgets the image when a text was queued at expiry', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 3 }));
    r.t.writes.length = 0;
    await advance(2990);
    r.t.holdWrites();
    const text = r.c.showText(textRequest());
    await advance(10); // the duration is over while the text is still being written
    r.t.releaseWrites();
    await text;
    await flush();
    expect(opcodes(r)).not.toContain('45');
    expect(r.c.isTextShown()).toBe(true);
  });

  it('re-sends the mode at expiry although a no-op Stop text was sent meanwhile', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 3 }));
    await advance(1000);
    await r.c.stopText(); // no text runs: this only sends 6e 00, it does not replace the image
    r.t.writes.length = 0;
    await advance(2000);
    await flush();
    expect(sent(r).filter((p) => p.startsWith('45 00'))).toHaveLength(1);
    expect(logs(r, 'image ended (duration): mode clock re-sent')).toHaveLength(1);
  });

  it('sends nothing when no mode is known', async () => {
    const r = rig();
    r.device.answer = false; // no status: the channel stays unknown
    r.c.start();
    await flush();
    expect(r.m.state).toBe('connected');
    r.t.writes.length = 0;
    await r.c.showImage(request({ durationS: 3 }));
    r.t.writes.length = 0;
    await advance(3000);
    expect(opcodes(r)).toEqual([]);
    expect(logs(r, 'no known mode to restore')).toHaveLength(1);
  });
});

describe('what ends an image', () => {
  it('a mode change forgets it and cancels the duration timer', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 5 }));
    await r.c.setChannel('lighting');
    expect(r.c.isImageShown()).toBe(false);
    expect(logs(r, 'image ended (mode change)')).toHaveLength(1);
    r.t.writes.length = 0;
    await advance(10_000);
    expect(opcodes(r).filter((o) => o === '45')).toEqual([]);
  });

  it('power off forgets it', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 5 }));
    await r.c.setPower(false);
    expect(r.c.isImageShown()).toBe(false);
    expect(logs(r, 'image ended (power off)')).toHaveLength(1);
  });

  it('a text forgets it, and an image forgets a running text', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    await r.c.showText(textRequest());
    expect(r.c.isImageShown()).toBe(false);
    expect(r.c.isTextShown()).toBe(true);
    expect(logs(r, 'image ended (text)')).toHaveLength(1);
    await r.c.showImage(request());
    expect(r.c.isTextShown()).toBe(false);
    expect(r.c.isImageShown()).toBe(true);
    expect(logs(r, 'text stopped (image)')).toHaveLength(1);
  });

  it('a text with a duration does not end the image later with 6e 00 after being forgotten', async () => {
    const r = await online(0);
    await r.c.showText(textRequest({ durationS: 5 }));
    await r.c.showImage(request());
    r.t.writes.length = 0;
    await advance(6000);
    expect(opcodes(r)).toEqual([]);
  });

  it('a countdown forgets it', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    await r.c.startCountdown({ minutes: 1, seconds: 0 });
    expect(r.c.isImageShown()).toBe(false);
    expect(logs(r, 'image ended (countdown)')).toHaveLength(1);
  });

  it('stop() clears the timer', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 5 }));
    await r.c.stop();
    r.t.writes.length = 0;
    await advance(10_000);
    expect(r.t.writes).toEqual([]);
  });

  it('a command queued after the image but finished before it is confirmed still ends it', async () => {
    const r = await online(0);
    const image = r.c.showImage(request({ durationS: 5 }));
    const mode = r.c.setChannel('lighting');
    await Promise.all([image, mode]);
    await flush();
    expect(r.c.isImageShown()).toBe(false);
    r.t.writes.length = 0;
    await advance(10_000);
    expect(opcodes(r).filter((o) => o === '45')).toEqual([]);
  });
});

describe('stop countdown with an image shown', () => {
  it('is skipped, like with a text', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    r.t.writes.length = 0;
    await r.c.stopCountdown();
    expect(r.t.writes).toEqual([]);
    expect(logs(r, 'countdown stop skipped: image shown')).toHaveLength(1);
  });
});

describe('weather and the hot flag while an image is shown', () => {
  it('holds the weather until the image has ended, then the 60 s check sends it', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    r.t.writes.length = 0;
    await r.c.setWeather(RAIN, 'flow');
    expect(opcodes(r)).toEqual([]);
    expect(logs(r, 'weather held (image shown)')).toHaveLength(1);
    await r.c.setChannel('lighting');
    r.t.writes.length = 0;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(opcodes(r)).toContain('5f');
  });

  it('does not send the hot flag at connect while an image is shown', async () => {
    const r = rig();
    r.device.channel = 0;
    r.c.start();
    await flush();
    r.t.writes.length = 0;
    await r.c.showImage(request());
    r.t.writes.length = 0;
    // A reconnect: the first status of the new session must not send 26 over the image.
    r.t.dropLink();
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(opcodes(r)).toContain('46');
    expect(opcodes(r)).not.toContain('26');
  });
});

describe('mode reports while an image is shown (the image shadow)', () => {
  it('adopts the first report after the image as its shadow and ignores equal reports', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    r.device.channel = 2; // the image changed d0 (unknown effect of 44)
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(logs(r, 'image shadow: device reports channel code 0x02')).toHaveLength(1);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.isImageShown()).toBe(true);
    expect(r.c.onOtherMode()).toBe(false);
    expect(r.surface.channels).toEqual([]);
    expect(r.surface.channelChanges).toEqual([]);
  });

  it('a different known code means a mode change at the device: the image ends and the report is handled (duration 0)', async () => {
    const r = await online(0);
    await r.c.showImage(request({ durationS: 0 }));
    await advance(STATUS_POLL_INTERVAL_MS); // shadow: clock
    r.device.channel = 1; // somebody pressed the button
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.isImageShown()).toBe(false);
    expect(logs(r, 'image ended (device mode change): channel code 0x00 -> 0x01')).toHaveLength(1);
    expect(r.c.getChannel()).toBe('lighting');
    expect(r.surface.channels).toEqual(['lighting']);
    expect(r.surface.channelChanges).toEqual(['lighting']);
  });

  it('a device change to cloud ends the image and enters the other-mode state', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    await advance(STATUS_POLL_INTERVAL_MS);
    r.device.channel = 2;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.isImageShown()).toBe(false);
    expect(r.c.onOtherMode()).toBe(true);
  });

  it('weather and the hot flag are held only as long as the image is tracked', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    await advance(STATUS_POLL_INTERVAL_MS);
    await r.c.setWeather(RAIN, 'flow');
    expect(logs(r, 'weather held (image shown)')).toHaveLength(1);
    r.device.channel = 1;
    r.t.writes.length = 0;
    await advance(STATUS_POLL_INTERVAL_MS);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(opcodes(r)).toContain('5f');
  });

  it('a new session whose d0 differs from the shadow forgets the image, an equal one keeps it', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    await advance(STATUS_POLL_INTERVAL_MS);
    r.t.dropLink();
    await advance(10_000);
    expect(r.m.state).toBe('connected');
    expect(r.c.isImageShown()).toBe(true);
    r.t.dropLink();
    r.device.channel = 1; // the Evo was power-cycled meanwhile
    await advance(10_000);
    expect(r.c.isImageShown()).toBe(false);
  });

  it('does not log the unchanged code and ignores reports while the image is being sent', async () => {
    const r = await online(0);
    const pending = r.c.showImage(request());
    r.device.channel = 1; // a report that arrives before the image is confirmed must not count
    await pending;
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(r.c.isImageShown()).toBe(true);
    expect(logs(r, 'image ended (device mode change)')).toEqual([]);
  });
});

describe('showImageFrom', () => {
  /** A 160x90 PNG: left half red, right half green. */
  const png = (): Uint8Array => {
    const image = new PNG({ width: 160, height: 90 });
    for (let y = 0; y < 90; y++) {
      for (let x = 0; x < 160; x++) image.data.set(x < 80 ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * 160 + x) * 4);
    }
    return new Uint8Array(PNG.sync.write(image));
  };
  const source = (load: () => Promise<Uint8Array>) => ({ origin: 'example.com', load });

  it('loads, converts, logs the origin and format (no path) and shows the image', async () => {
    const r = await online(0);
    const load = vi.fn(async () => png());
    await r.c.showImageFrom(source(load), 'contain', 15);
    expect(load).toHaveBeenCalledTimes(1);
    const out = payloads(r);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(1036);
    expect(out[0][11]).toBe(0); // NN 00 = 256 colours, 8 bpp
    // contain 160x90: rows 0..2 are black, row 3 is red on the left and green on the right.
    const pixels = out[0].subarray(12 + 768);
    const palette = (index: number) => Array.from(out[0].subarray(12 + index * 3, 15 + index * 3));
    expect(palette(pixels[0])).toEqual([0, 0, 0]);
    expect(palette(pixels[3 * 16])).toEqual([255, 0, 0]);
    expect(palette(pixels[3 * 16 + 15])).toEqual([0, 255, 0]);
    expect(palette(pixels[12 * 16])).toEqual([0, 0, 0]);
    expect(logs(r, 'image loaded: example.com, png 160x90')).toHaveLength(1);
    expect(logs(r, 'image shown: 3 colours, contain, 15 s')).toHaveLength(1);
    expect(r.surface.logs.join('\n')).not.toMatch(/https?:/);
    expect(r.c.isImageShown()).toBe(true);
  });

  it('does not load anything while the Timebox is not connected', async () => {
    const r = rig();
    const load = vi.fn(async () => png());
    await expect(r.c.showImageFrom(source(load), 'cover', 0)).rejects.toThrow(MESSAGES.notConnected);
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects an invalid duration before loading', async () => {
    const r = await online(0);
    const load = vi.fn(async () => png());
    await expect(r.c.showImageFrom(source(load), 'cover', 4000)).rejects.toThrow(RangeError);
    expect(load).not.toHaveBeenCalled();
  });

  it('logs the real cause of a load failure, rethrows the ImageError and leaves the display alone', async () => {
    const r = await online(0);
    await r.c.showImage(request());
    r.t.writes.length = 0;
    const failure = new ImageError('HTTP 404', 'unreachable');
    await expect(
      r.c.showImageFrom(
        source(async () => {
          throw failure;
        }),
        'cover',
        0,
      ),
    ).rejects.toBe(failure);
    expect(logs(r, 'image failed (unreachable) from example.com: HTTP 404')).toHaveLength(1);
    expect(r.t.writes).toEqual([]);
    expect(r.c.isImageShown()).toBe(true);
  });

  it('loads and decodes one image at a time: a second card waits for the first', async () => {
    const r = await online(0);
    let release: (bytes: Uint8Array) => void = () => undefined;
    const firstLoad = vi.fn(() => new Promise<Uint8Array>((resolve) => (release = resolve)));
    const secondLoad = vi.fn(async () => png());
    const first = r.c.showImageFrom(source(firstLoad), 'cover', 0);
    const second = r.c.showImageFrom(source(secondLoad), 'contain', 0);
    await flush();
    expect(firstLoad).toHaveBeenCalledTimes(1);
    expect(secondLoad).not.toHaveBeenCalled();
    release(png());
    await first;
    await second;
    expect(secondLoad).toHaveBeenCalledTimes(1);
    expect(logs(r, 'image loaded: example.com, png 160x90')).toHaveLength(2);
    expect(opcodes(r)).toEqual(['44', '44']);
  });

  it('reports an undecodable file as unsupported without sending', async () => {
    const r = await online(0);
    await expect(
      r.c.showImageFrom(
        source(async () => new TextEncoder().encode('<html>')),
        'cover',
        0,
      ),
    ).rejects.toMatchObject({ kind: 'unsupported' });
    expect(r.t.writes).toEqual([]);
  });
});
