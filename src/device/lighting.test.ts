import { describe, expect, it } from 'vitest';
import { toHex } from '../protocol/hex';
import { decodeSppFrame, parseReply } from '../protocol/replies';
import { decodeStatus } from '../protocol/status';
import { fromHex } from '../protocol/hex';
import { STATUS_CLOCK_B50 } from '../protocol/__fixtures__/golden';
import { formatHexColor } from './clock';
import { hueSatToRgb, onoffSetOnDimDisabled, powerOffCommand, rgbToHueSat } from './lighting';

const status = decodeStatus(parseReply(decodeSppFrame(fromHex(STATUS_CLOCK_B50)))); // lighting colour red, brightness 50

describe('onoffSetOnDimDisabled', () => {
  it('is true only if the options carry setOnDim false', () => {
    expect(onoffSetOnDimDisabled(() => ({ setOnDim: false }))).toBe(true);
    expect(onoffSetOnDimDisabled(() => ({ setOnDim: true }))).toBe(false);
    expect(onoffSetOnDimDisabled(() => ({}))).toBe(false);
  });

  it('treats missing options and a throwing read as not set', () => {
    for (const none of [undefined, null, 'x', 0]) expect(onoffSetOnDimDisabled(() => none)).toBe(false);
    expect(
      onoffSetOnDimDisabled(() => {
        throw new Error('no options');
      }),
    ).toBe(false);
  });
});

describe('hueSatToRgb', () => {
  it.each([
    [0, 1, '#FF0000'],
    [0.5, 1, '#00FFFF'],
    [1 / 3, 1, '#00FF00'],
    [2 / 3, 1, '#0000FF'],
    [1, 1, '#FF0000'],
    [0.25, 0, '#FFFFFF'],
    [0.9, 0, '#FFFFFF'],
    [0.5, 0.5, '#80FFFF'],
    [1 / 6, 1, '#FFFF00'],
    [5 / 6, 1, '#FF00FF'],
  ])('hue %s saturation %s is %s', (hue, saturation, hex) => {
    expect(formatHexColor(hueSatToRgb(hue, saturation))).toBe(hex);
  });

  it.each([
    [-0.1, 1],
    [1.1, 1],
    [0, -0.1],
    [0, 1.1],
    [NaN, 1],
    [0, Infinity],
    ['0.5' as unknown as number, 1],
    [undefined as unknown as number, 1],
  ])('rejects hue %s saturation %s', (hue, saturation) => {
    expect(() => hueSatToRgb(hue, saturation)).toThrow(RangeError);
  });
});

describe('rgbToHueSat', () => {
  it('converts the primaries and a mix', () => {
    expect(rgbToHueSat({ r: 255, g: 0, b: 0 })).toEqual({ hue: 0, saturation: 1 });
    expect(rgbToHueSat({ r: 0, g: 255, b: 0 })?.hue).toBeCloseTo(1 / 3, 10);
    expect(rgbToHueSat({ r: 0, g: 0, b: 255 })?.hue).toBeCloseTo(2 / 3, 10);
    const magenta = rgbToHueSat({ r: 255, g: 0, b: 255 });
    expect(magenta?.hue).toBeCloseTo(5 / 6, 10);
    expect(magenta?.saturation).toBe(1);
  });

  it('white and grey have saturation 0, black has no hue', () => {
    expect(rgbToHueSat({ r: 255, g: 255, b: 255 })).toEqual({ hue: 0, saturation: 0 });
    expect(rgbToHueSat({ r: 128, g: 128, b: 128 })).toEqual({ hue: 0, saturation: 0 });
    expect(rgbToHueSat({ r: 0, g: 0, b: 0 })).toBeNull();
  });

  it('round-trips every hue and saturation step to the same device colour', () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const hs = rgbToHueSat({ r, g, b });
          if (!hs) continue;
          // The value is dropped, so the round trip gives the colour scaled to full value.
          const max = Math.max(r, g, b);
          const back = hueSatToRgb(hs.hue, hs.saturation);
          const scale = 255 / max;
          expect(Math.abs(back.r - r * scale)).toBeLessThanOrEqual(1);
          expect(Math.abs(back.g - g * scale)).toBeLessThanOrEqual(1);
          expect(Math.abs(back.b - b * scale)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('powerOffCommand', () => {
  it('keeps the status colour and the known brightness, effect 0, power off', () => {
    expect(toHex(powerOffCommand(status, 50))).toBe('45 01 ff 00 00 32 00 00 00 00 00');
    expect(toHex(powerOffCommand(status, 20))).toBe('45 01 ff 00 00 14 00 00 00 00 00');
  });

  it('falls back to the status brightness, then 100, and to white without a status', () => {
    expect(toHex(powerOffCommand(status, null))).toBe('45 01 ff 00 00 32 00 00 00 00 00');
    expect(toHex(powerOffCommand(null, null))).toBe('45 01 ff ff ff 64 00 00 00 00 00');
  });

  it('a known colour wins over the status colour', () => {
    expect(toHex(powerOffCommand(status, 50, { r: 0, g: 255, b: 0 }))).toBe('45 01 00 ff 00 32 00 00 00 00 00');
    expect(toHex(powerOffCommand(null, null, { r: 0, g: 255, b: 0 }))).toBe('45 01 00 ff 00 64 00 00 00 00 00');
  });

  it('keeps a black status colour as it is and clamps the brightness', () => {
    const black = { ...status, lightingColor: { r: 0, g: 0, b: 0 } };
    expect(toHex(powerOffCommand(black, 126))).toBe('45 01 00 00 00 64 00 00 00 00 00');
    expect(toHex(powerOffCommand(black, -4))).toBe('45 01 00 00 00 00 00 00 00 00 00');
  });
});
