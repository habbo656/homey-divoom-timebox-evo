import { describe, expect, it } from 'vitest';
import { MAX_TEXT_UNITS } from '../protocol/commands';
import {
  MAX_TEXT_DURATION_S,
  parseTextDuration,
  parseTextDurationArg,
  parseTextSpeedId,
  prepareText,
  TEXT_SPEED_IDS,
  TEXT_SPEED_LEVELS,
} from './scrollText';

describe('text speed', () => {
  it('maps the ids to the measured device speeds', () => {
    expect(TEXT_SPEED_IDS).toEqual(['slow', 'normal', 'fast']);
    expect(TEXT_SPEED_IDS.map(parseTextSpeedId)).toEqual([3, 5, 10]);
    expect(TEXT_SPEED_LEVELS.normal).toBe(5);
  });

  it.each(['', 'Slow', 'medium', '5', 5, null, undefined])('rejects %s', (value) => {
    expect(() => parseTextSpeedId(value)).toThrow(RangeError);
  });
});

describe('text duration', () => {
  it.each([
    [0, 0],
    [10, 10],
    [2.4, 2],
    [2.5, 3],
    [MAX_TEXT_DURATION_S, 3600],
  ])('accepts %s and rounds to %s', (value, seconds) => {
    expect(parseTextDuration(value)).toBe(seconds);
  });

  it.each([-1, 3601, Number.NaN, Infinity, '10', null, undefined])('rejects %s', (value) => {
    expect(() => parseTextDuration(value)).toThrow(RangeError);
  });
});

describe('text duration argument', () => {
  it('treats a blank field as 0 and converts numeric strings', () => {
    expect([undefined, null, '', '  ', 0, '15', 7.6].map(parseTextDurationArg)).toEqual([0, 0, 0, 0, 0, 15, 8]);
  });

  it.each(['abc', '-5', '4000', Number.NaN, {}, true])('rejects %s', (value) => {
    expect(() => parseTextDurationArg(value)).toThrow(RangeError);
  });
});

describe('prepareText', () => {
  it('keeps plain text and the characters the font draws', () => {
    expect(prepareText('Hallo Homey 123')).toEqual({ text: 'Hallo Homey 123', units: 15 });
    expect(prepareText('Grüße Äöß € é ñ 日本').text).toBe('Grüße Äöß € é ñ 日本');
  });

  it('normalises to NFC (a combining umlaut becomes one unit)', () => {
    const decomposed = String.fromCharCode(0x75, 0x308);
    expect(prepareText(decomposed)).toEqual({ text: 'ü', units: 1 });
  });

  it('strips emoji (non-BMP pairs) and lone surrogates', () => {
    expect(prepareText('Hi 😀 there').text).toBe('Hi  there');
    expect(prepareText('😀').text).toBe('');
    expect(prepareText(`a${String.fromCharCode(0xd83d)}b`).text).toBe('ab');
    expect(prepareText(`a${String.fromCharCode(0xde00)}b`).text).toBe('ab');
    expect(prepareText('👨‍👩‍👧').text).toBe('');
  });

  it('strips variation selectors and zero-width characters', () => {
    expect(
      prepareText(
        ['a', 0xfe0f, 'b', 0x200b, 'c'].map((p) => (typeof p === 'number' ? String.fromCharCode(p) : p)).join(''),
      ).text,
    ).toBe('abc');
  });

  it('turns controls into spaces and trims', () => {
    expect(prepareText('  a\nb\tc\r\nd  ').text).toBe('a b c  d');
    expect(prepareText('\n\t ').text).toBe('');
    expect(prepareText('').text).toBe('');
  });

  it('never cuts: the full text and its length come back so the caller can reject it', () => {
    const exact = 'x'.repeat(MAX_TEXT_UNITS);
    expect(prepareText(exact)).toEqual({ text: exact, units: MAX_TEXT_UNITS });
    const long = prepareText(`${'x'.repeat(MAX_TEXT_UNITS - 1)} y z`);
    expect(long.text).toBe(`${'x'.repeat(MAX_TEXT_UNITS - 1)} y z`);
    expect(long.units).toBe(MAX_TEXT_UNITS + 3);
    expect(prepareText('y'.repeat(200))).toEqual({ text: 'y'.repeat(200), units: 200 });
  });

  it('counts the length after the stripping', () => {
    const text = `${'😀'.repeat(100)}${'x'.repeat(MAX_TEXT_UNITS)}`;
    expect(prepareText(text)).toEqual({ text: 'x'.repeat(MAX_TEXT_UNITS), units: MAX_TEXT_UNITS });
  });

  it.each([null, undefined, 5, {}, ['a']])('rejects %s', (value) => {
    expect(() => prepareText(value)).toThrow(RangeError);
  });
});
