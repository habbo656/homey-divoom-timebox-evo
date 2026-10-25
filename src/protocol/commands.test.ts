import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_MAX_MINUTES,
  CLOCK_STYLES,
  MAX_NOTIFICATION_ICON,
  MAX_TEXT_UNITS,
  nativeText,
  notificationIcon,
  queryCustomPage,
  queryStatus,
  setBrightness,
  setChannel,
  setClock,
  setCustomPage,
  setDateTime,
  setHot,
  setLighting,
  setWeather,
  startNoiseMeter,
  staticImage,
  startCountdown,
  stopCountdown,
  stopNativeText,
  type ClockOptions,
  type DateTimeParts,
  type Lighting,
} from './commands';
import { envelope } from './envelope';
import { fromHex, toHex } from './hex';
import { decodeSppFrame } from './replies';
import { IMAGE_PAYLOAD, NOTIFICATION_TELEGRAM_ENVELOPE, NOTIFICATION_TELEGRAM_SPP_FRAME } from './__fixtures__/golden';

describe('setBrightness', () => {
  it.each([
    [0, '74 00'],
    [1, '74 01'],
    [50, '74 32'],
    [100, '74 64'],
  ])('encodes %i', (value, hex) => {
    expect(toHex(setBrightness(value))).toBe(hex);
  });

  it.each([-1, 101, 126, 255, 1.5, NaN, Infinity])('rejects %s', (value) => {
    expect(() => setBrightness(value)).toThrow(RangeError);
  });
});

describe('queryStatus', () => {
  it('is the bare opcode', () => {
    expect(toHex(queryStatus())).toBe('46');
  });
});

describe('setChannel', () => {
  it.each([
    [0, '45 00'],
    [2, '45 02'],
    [5, '45 05'],
    [6, '45 06'],
  ])('encodes %i', (value, hex) => {
    expect(toHex(setChannel(value))).toBe(hex);
  });

  // 1 lighting needs arguments, 4 (visualizer) is not offered, 3 does nothing on the Evo, 7 is ignored.
  it.each([1, 3, 4, 7, -1, 256, 0.5, NaN])('rejects %s', (value) => {
    expect(() => setChannel(value)).toThrow(RangeError);
  });
});

describe('startNoiseMeter', () => {
  it('is 72 02 01', () => {
    expect(toHex(startNoiseMeter())).toBe('72 02 01');
  });
});

describe('setLighting', () => {
  const base: Lighting = { color: { r: 0, g: 255, b: 0 }, brightness: 100, effect: 0, on: true };

  it('encodes the full 11-byte form', () => {
    expect(toHex(setLighting(base))).toBe('45 01 00 ff 00 64 00 01 00 00 00');
    expect(toHex(setLighting({ ...base, color: { r: 255, g: 0, b: 0 }, brightness: 50 }))).toBe(
      '45 01 ff 00 00 32 00 01 00 00 00',
    );
  });

  it('encodes effect and power off', () => {
    expect(toHex(setLighting({ ...base, effect: 4 }))).toBe('45 01 00 ff 00 64 04 01 00 00 00');
    expect(toHex(setLighting({ ...base, on: false }))).toBe('45 01 00 ff 00 64 00 00 00 00 00');
  });

  it.each<[string, Partial<Lighting>]>([
    ['r 256', { color: { r: 256, g: 0, b: 0 } }],
    ['g -1', { color: { r: 0, g: -1, b: 0 } }],
    ['b 1.5', { color: { r: 0, g: 0, b: 1.5 } }],
    ['r NaN', { color: { r: NaN, g: 0, b: 0 } }],
    ['brightness 101', { brightness: 101 }],
    ['brightness -1', { brightness: -1 }],
    ['brightness NaN', { brightness: NaN }],
    ['effect 5', { effect: 5 }],
    ['effect -1', { effect: -1 }],
    ['effect NaN', { effect: NaN }],
  ])('rejects %s', (_label, override) => {
    expect(() => setLighting({ ...base, ...override })).toThrow(RangeError);
  });
});

describe('setClock', () => {
  const base: ClockOptions = {
    hour24: true,
    style: 0,
    weather: false,
    temperature: false,
    calendar: false,
    color: { r: 255, g: 255, b: 255 },
  };

  it.each([
    [{ weather: true, temperature: true, calendar: true }, '45 00 01 00 01 01 01 01 ff ff ff'],
    [
      { hour24: false, style: 5, temperature: true, color: { r: 0, g: 255, b: 255 } },
      '45 00 00 05 01 00 01 00 00 ff ff',
    ],
    [{ style: 6, color: { r: 255, g: 128, b: 0 } }, '45 00 01 06 01 00 00 00 ff 80 00'],
  ] as [Partial<ClockOptions>, string][])('encodes %j', (override, hex) => {
    expect(toHex(setClock({ ...base, ...override }))).toBe(hex);
  });

  it('puts each flag in its own byte (weather, temperature, calendar)', () => {
    expect(toHex(setClock({ ...base, weather: true }))).toBe('45 00 01 00 01 01 00 00 ff ff ff');
    expect(toHex(setClock({ ...base, temperature: true }))).toBe('45 00 01 00 01 00 01 00 ff ff ff');
    expect(toHex(setClock({ ...base, calendar: true }))).toBe('45 00 01 00 01 00 00 01 ff ff ff');
  });

  it('encodes every offered style', () => {
    expect(CLOCK_STYLES.map((style) => setClock({ ...base, style })[3])).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it.each([
    { style: 7 },
    { style: 9 },
    { style: -1 },
    { style: 1.5 },
    { style: '1' as unknown as number },
    { hour24: 1 as unknown as boolean },
    { weather: 'yes' as unknown as boolean },
    { temperature: undefined as unknown as boolean },
    { calendar: 0 as unknown as boolean },
    { color: { r: 256, g: 0, b: 0 } },
    { color: { r: 0, g: -1, b: 0 } },
    { color: { r: 0, g: 0, b: 1.5 } },
  ])('rejects %j', (override) => {
    expect(() => setClock({ ...base, ...override })).toThrow(RangeError);
  });
});

describe('setHot', () => {
  it('is 26 01 (animation pages on) and 26 00 (off)', () => {
    expect(toHex(setHot(true))).toBe('26 01');
    expect(toHex(setHot(false))).toBe('26 00');
  });

  it.each([1, 0, 'true', 255, undefined, null])('rejects the non-boolean %j', (value) => {
    expect(() => setHot(value as unknown as boolean)).toThrow(RangeError);
  });
});

describe('setCustomPage', () => {
  it.each([
    [0, 'bd 17 00'],
    [1, 'bd 17 01'],
    [2, 'bd 17 02'],
  ])('encodes %i', (value, hex) => {
    expect(toHex(setCustomPage(value))).toBe(hex);
  });

  it.each([3, -1, 255, 1.5, NaN, '1'])('rejects %s', (value) => {
    expect(() => setCustomPage(value as number)).toThrow(RangeError);
  });
});

describe('queryCustomPage', () => {
  it('is the read form bd 17 ff', () => {
    expect(toHex(queryCustomPage())).toBe('bd 17 ff');
  });
});

describe('setDateTime', () => {
  const base: DateTimeParts = { year: 2026, month: 10, day: 6, hour: 13, minute: 45, second: 30 };

  it('encodes the year as LE bytes and appends the computed weekday (2026-10-06 is a Tuesday)', () => {
    expect(toHex(setDateTime(base))).toBe('18 1a 14 0a 06 0d 2d 1e 02');
  });

  it('computes the weekday (0 = Sunday)', () => {
    const wd = (year: number, month: number, day: number): number => setDateTime({ ...base, year, month, day })[8];
    expect(wd(2026, 10, 4)).toBe(0); // Sunday
    expect(wd(2026, 10, 5)).toBe(1); // Monday
    expect(wd(2026, 10, 10)).toBe(6); // Saturday
    expect(wd(2000, 1, 1)).toBe(6); // Saturday
    expect(wd(2099, 12, 31)).toBe(4); // Thursday
    expect(wd(2024, 2, 29)).toBe(4); // Thursday, leap day
  });

  it('accepts the lower and upper bounds', () => {
    expect(toHex(setDateTime({ year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 }))).toBe(
      '18 00 14 01 01 00 00 00 06',
    );
    expect(toHex(setDateTime({ year: 2099, month: 12, day: 31, hour: 23, minute: 59, second: 59 }))).toBe(
      '18 63 14 0c 1f 17 3b 3b 04',
    );
  });

  it.each<[string, Partial<DateTimeParts>]>([
    ['year below range', { year: 1999 }],
    ['year above range', { year: 2100 }],
    ['month 0', { month: 0 }],
    ['month 13', { month: 13 }],
    ['day 0', { day: 0 }],
    ['day 32', { day: 32 }],
    ['hour 24', { hour: 24 }],
    ['hour -1', { hour: -1 }],
    ['minute 60', { minute: 60 }],
    ['second 60', { second: 60 }],
    ['fractional second', { second: 1.5 }],
    ['NaN year', { year: NaN }],
    ['31 April', { month: 4, day: 31 }],
    ['30 February', { month: 2, day: 30 }],
    ['29 February in a non-leap year', { year: 2025, month: 2, day: 29 }],
    ['29 February 2100 is out of range anyway', { year: 2100, month: 2, day: 29 }],
  ])('rejects %s', (_label, override) => {
    expect(() => setDateTime({ ...base, ...override })).toThrow(RangeError);
  });
});

describe('nativeText', () => {
  // Golden vector from the Mac probe (docs/divoom-protocol.md 5.5, #28): "Hallo Homey 123", SP 5, yellow on #000080.
  const golden = {
    text: 'Hallo Homey 123',
    color: { r: 255, g: 255, b: 0 },
    background: { r: 0, g: 0, b: 128 },
    speed: 5,
  };
  const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  it('builds the five verified payloads in order', () => {
    const p = nativeText(golden);
    expect(p).toHaveLength(5);
    expect(toHex(p[0])).toBe('6e 01');
    expect(toHex(p[1])).toBe(
      '86 01 0f 48 00 61 00 6c 00 6c 00 6f 00 20 00 48 00 6f 00 6d 00 65 00 79 00 20 00 31 00 32 00 33 00',
    );
    expect(toHex(p[2])).toBe('86 00 05');
    expect([p[3].length, p[4].length]).toEqual([1036, 268]);
    expect(sha256(p[3])).toBe('a0a587877ec1c0bf4a8223ec13f56f5d54af5342b133e5c3f0f445dda5eae17d');
    expect(sha256(p[4])).toBe('1084c78519b412d9b7ae54f2bbb94b15ec98fb0107f1238f5a9b4eb1d29a99cd');
  });

  it('writes the 6c headers and frame headers', () => {
    const p = nativeText(golden);
    expect(toHex(p[3].subarray(0, 12))).toBe('6c 00 00 07 04 aa 07 04 3c 00 00 00');
    expect(toHex(p[4].subarray(0, 12))).toBe('6c 01 00 07 01 aa 07 01 3c 00 01 00');
    expect(p[3].subarray(12 + 768).every((b) => b === 0)).toBe(true);
    expect(p[4].subarray(12).every((b) => b === 0)).toBe(true);
  });

  it('lays out the palette: 127 x background, 127 x text colour, 2 x background', () => {
    const palette = nativeText(golden)[3].subarray(12, 12 + 768);
    const colour = (i: number) => toHex(palette.subarray(i * 3, i * 3 + 3));
    for (const i of [0, 1, 126, 254, 255]) expect(colour(i)).toBe('00 00 80');
    for (const i of [127, 128, 200, 253]) expect(colour(i)).toBe('ff ff 00');
  });

  it('counts UTF-16 code units in LL', () => {
    expect(nativeText({ ...golden, text: 'Grüße' })[1][2]).toBe(5);
    const emoji = nativeText({ ...golden, text: '😀' })[1];
    expect(toHex(emoji)).toBe('86 01 02 3d d8 00 de');
  });

  it('accepts the maximum and rejects empty or longer text', () => {
    expect(nativeText({ ...golden, text: 'x'.repeat(MAX_TEXT_UNITS) })[1][2]).toBe(MAX_TEXT_UNITS);
    expect(() => nativeText({ ...golden, text: '' })).toThrow(RangeError);
    expect(() => nativeText({ ...golden, text: 'x'.repeat(MAX_TEXT_UNITS + 1) })).toThrow(RangeError);
  });

  it('rejects lone surrogates but accepts pairs', () => {
    expect(() => nativeText({ ...golden, text: 'a\ud83d' })).toThrow(RangeError);
    expect(() => nativeText({ ...golden, text: '\ude00b' })).toThrow(RangeError);
    expect(() => nativeText({ ...golden, text: 'a😀b' })).not.toThrow();
  });

  it.each([0, 51, 1.5, NaN, -1])('rejects speed %s', (speed) => {
    expect(() => nativeText({ ...golden, speed })).toThrow(RangeError);
  });

  it.each([1, 50])('accepts speed %i', (speed) => {
    expect(nativeText({ ...golden, speed })[2][2]).toBe(speed);
  });

  it('rejects colours outside 0..255', () => {
    expect(() => nativeText({ ...golden, color: { r: 256, g: 0, b: 0 } })).toThrow(RangeError);
    expect(() => nativeText({ ...golden, background: { r: 0, g: -1, b: 0 } })).toThrow(RangeError);
  });
});

describe('stopNativeText', () => {
  it('is 6e 00', () => {
    expect(toHex(stopNativeText())).toBe('6e 00');
  });
});

describe('setWeather', () => {
  it.each([
    [{ temperature: -5, type: 8 }, '5f fb 08'],
    [{ temperature: 23, type: 1 }, '5f 17 01'],
    [{ temperature: 0, type: 3 }, '5f 00 03'],
    [{ temperature: -128, type: 9 }, '5f 80 09'],
    [{ temperature: 127, type: 5 }, '5f 7f 05'],
    [{ temperature: -1, type: 6 }, '5f ff 06'],
  ])('encodes %j', (value, hex) => {
    expect(toHex(setWeather(value))).toBe(hex);
  });

  it.each([128, -129, 1.5, NaN, Infinity, '5' as unknown as number])('rejects temperature %s', (temperature) => {
    expect(() => setWeather({ temperature, type: 1 })).toThrow(RangeError);
  });

  it.each([0, 2, 4, 7, 10, 256, 1.5, NaN])('rejects type %s', (type) => {
    expect(() => setWeather({ temperature: 10, type })).toThrow(RangeError);
  });
});

describe('startCountdown', () => {
  it.each([
    [{ minutes: 0, seconds: 30 }, '72 03 01 00 1e'],
    [{ minutes: 5, seconds: 0 }, '72 03 01 05 00'],
    [{ minutes: 99, seconds: 59 }, '72 03 01 63 3b'],
    [{ minutes: 0, seconds: 1 }, '72 03 01 00 01'],
    [{ minutes: 1, seconds: 0 }, '72 03 01 01 00'],
  ])('encodes %j', (value, hex) => {
    expect(toHex(startCountdown(value))).toBe(hex);
  });

  it('has the documented maximum', () => {
    expect(COUNTDOWN_MAX_MINUTES).toBe(99);
  });

  it.each([-1, 100, 1.5, NaN, Infinity, '5' as unknown as number])('rejects minutes %s', (minutes) => {
    expect(() => startCountdown({ minutes, seconds: 10 })).toThrow(RangeError);
  });

  it.each([-1, 60, 255, 1.5, NaN, undefined as unknown as number])('rejects seconds %s', (seconds) => {
    expect(() => startCountdown({ minutes: 1, seconds })).toThrow(RangeError);
  });

  it('rejects 0:00 (the device would end it at once)', () => {
    expect(() => startCountdown({ minutes: 0, seconds: 0 })).toThrow(RangeError);
  });
});

describe('stopCountdown', () => {
  it('is 72 03 00 00 00', () => {
    expect(toHex(stopCountdown())).toBe('72 03 00 00 00');
  });
});

describe('staticImage', () => {
  const blue = { r: 0, g: 0, b: 255 };
  const red = { r: 255, g: 0, b: 0 };
  const green = { r: 0, g: 255, b: 0 };
  const grid = (f: (x: number, y: number) => number) =>
    Array.from({ length: 256 }, (_, i) => f(i % 16, Math.floor(i / 16)));

  it('encodes the golden vector (2 bits per pixel)', () => {
    const pixels = grid((x, y) => (y === 0 ? 0 : x < 8 ? 1 : 2));
    expect(toHex(staticImage({ palette: [blue, red, green], pixels }))).toBe(IMAGE_PAYLOAD);
    expect(staticImage({ palette: [blue, red, green], pixels })).toEqual(fromHex(IMAGE_PAYLOAD));
  });

  it('encodes 256 colours as NN 00, 8 bits per pixel, 1036 bytes, LLLL 07 04', () => {
    const palette = Array.from({ length: 256 }, (_, i) => ({ r: i, g: 255 - i, b: i ^ 0x55 }));
    const pixels = grid((x, y) => y * 16 + x);
    const out = staticImage({ palette, pixels });
    expect(out.length).toBe(1036);
    expect(toHex(out.subarray(0, 12))).toBe('44 00 0a 0a 04 aa 07 04 00 00 00 00');
    expect(Array.from(out.subarray(12, 15))).toEqual([0, 255, 0x55]);
    expect(Array.from(out.subarray(1036 - 256))).toEqual(pixels);
  });

  it('packs one bit per pixel for a single colour', () => {
    const out = staticImage({ palette: [red], pixels: new Array(256).fill(0) });
    expect(toHex(out.subarray(0, 12))).toBe('44 00 0a 0a 04 aa 2a 00 00 00 00 01');
    expect(out.length).toBe(5 + 7 + 3 + 32);
    expect(Array.from(out.subarray(15))).toEqual(new Array(32).fill(0));
  });

  it('packs LSB-first with 1 bit for two colours', () => {
    const pixels = grid((x) => (x === 0 || x === 2 ? 1 : 0));
    const out = staticImage({ palette: [red, green], pixels });
    expect(out[11]).toBe(2);
    expect(Array.from(out.subarray(18, 20))).toEqual([0b00000101, 0]);
  });

  it('packs 3 bits per pixel for 5..8 colours', () => {
    const palette = Array.from({ length: 5 }, (_, i) => ({ r: i, g: 0, b: 0 }));
    const pixels = grid((x) => (x === 0 ? 4 : x === 1 ? 3 : x === 2 ? 1 : 0));
    const out = staticImage({ palette, pixels });
    expect(out.length).toBe(5 + 7 + 15 + 96);
    // indices 4, 3, 1 -> bits 100 | 011<<3 | 001<<6 = 0b01011100, then bit 8: 001>>2 = 0
    expect(out[12 + 15]).toBe(0b01011100);
    expect(out[12 + 16]).toBe(0);
  });

  it('rejects bad palettes, pixel counts, indices and colours', () => {
    const px = new Array(256).fill(0);
    expect(() => staticImage({ palette: [], pixels: px })).toThrow(RangeError);
    expect(() => staticImage({ palette: new Array(257).fill(red), pixels: px })).toThrow(RangeError);
    expect(() => staticImage({ palette: [red], pixels: new Array(255).fill(0) })).toThrow(RangeError);
    expect(() => staticImage({ palette: [red], pixels: new Array(257).fill(0) })).toThrow(RangeError);
    expect(() => staticImage({ palette: [red], pixels: new Array(256).fill(1) })).toThrow(RangeError);
    expect(() => staticImage({ palette: [red], pixels: new Array(256).fill(-1) })).toThrow(RangeError);
    expect(() => staticImage({ palette: [red], pixels: new Array(256).fill(0.5) })).toThrow(RangeError);
    expect(() => staticImage({ palette: [{ r: 256, g: 0, b: 0 }], pixels: px })).toThrow(RangeError);
    expect(() => staticImage({ palette: [{ r: 0, g: -1, b: 0 }], pixels: px })).toThrow(RangeError);
  });
});

describe('notificationIcon (#5)', () => {
  it.each([
    [0, '50 00'],
    [1, '50 01'],
    [3, '50 03'],
    [18, '50 12'],
    [23, '50 17'],
  ])('encodes code %i', (code, hex) => {
    expect(toHex(notificationIcon(code))).toBe(hex);
  });

  it('has 24 codes, 0..23', () => {
    expect(MAX_NOTIFICATION_ICON).toBe(23);
  });

  it('matches the golden vector for Telegram (18) in the BLE envelope and as SPP frame', () => {
    expect(toHex(envelope(notificationIcon(18), 0x0101))).toBe(NOTIFICATION_TELEGRAM_ENVELOPE);
    expect(decodeSppFrame(fromHex(NOTIFICATION_TELEGRAM_SPP_FRAME))).toEqual(notificationIcon(18));
  });

  it.each([-1, 24, 25, 255, 1.5, NaN, Infinity, '1' as unknown as number, undefined as unknown as number])(
    'rejects %s (codes from 24 read past the firmware table)',
    (code) => {
      expect(() => notificationIcon(code)).toThrow(RangeError);
    },
  );
});
