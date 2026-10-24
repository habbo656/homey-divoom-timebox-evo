import { describe, expect, it } from 'vitest';
import { translator } from './__fixtures__/translator';
import { ArgumentError, formatArgValue, localiseError } from './argumentError';
import { ImageError } from './imageError';

const de = translator('de');
const en = translator('en');

const range = (field: 'duration' | 'temperature' | 'minutes', value: number, min: number, max: number) =>
  new ArgumentError(`${field} out of range`, 'invalid_range', field, { value: formatArgValue(value), min, max });

describe('ArgumentError', () => {
  it('is a RangeError with kind, field and params', () => {
    const e = range('duration', 4000, 0, 3600);
    expect(e).toBeInstanceOf(RangeError);
    expect(e.name).toBe('ArgumentError');
    expect(e.message).toBe('duration out of range');
    expect([e.kind, e.field, e.params]).toEqual(['invalid_range', 'duration', { value: '4000', min: 0, max: 3600 }]);
  });
});

describe('formatArgValue', () => {
  it('keeps numbers and quotes strings', () => {
    expect(formatArgValue(4000)).toBe('4000');
    expect(formatArgValue(NaN)).toBe('NaN');
    expect(formatArgValue('red')).toBe('"red"');
  });

  it('shows an empty or missing value as empty quotes', () => {
    expect(formatArgValue('')).toBe('""');
    expect(formatArgValue(null)).toBe('""');
    expect(formatArgValue(undefined)).toBe('""');
  });

  it('cuts a long string after 32 characters', () => {
    expect(formatArgValue('a'.repeat(32))).toBe(`"${'a'.repeat(32)}"`);
    expect(formatArgValue('a'.repeat(40))).toBe(`"${'a'.repeat(32)}…"`);
  });
});

describe('localiseError', () => {
  it('localises a range error (de, en)', () => {
    const e = range('duration', 4000, 0, 3600);
    expect((localiseError(e, de) as Error).message).toBe(
      'Dauer (s): 4000 liegt außerhalb des erlaubten Bereichs von 0 bis 3600.',
    );
    expect((localiseError(e, en) as Error).message).toBe('Duration (s): 4000 is out of range. Allowed is 0 to 3600.');
  });

  it('returns a plain Error, not an ArgumentError', () => {
    const out = localiseError(range('minutes', 100, 0, 99), de);
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBeInstanceOf(ArgumentError);
    expect((out as Error).message).toBe('Minuten: 100 liegt außerhalb des erlaubten Bereichs von 0 bis 99.');
  });

  it('localises temperature, colour and choice errors', () => {
    const temperature = range('temperature', 150, -99, 99);
    expect((localiseError(temperature, de) as Error).message).toBe(
      'Temperatur (°C): 150 liegt außerhalb des erlaubten Bereichs von -99 bis 99.',
    );
    const colour = new ArgumentError('colour', 'invalid_color', 'color', { value: formatArgValue('red') });
    expect((localiseError(colour, de) as Error).message).toBe(
      'Farbe: "red" ist keine Farbe. Verwende eine Hex-Farbe wie #FF8000.',
    );
    expect((localiseError(colour, en) as Error).message).toBe(
      'Colour: "red" is not a colour. Use a hex colour such as #FF8000.',
    );
    const speed = new ArgumentError('speed', 'invalid_choice', 'speed', {
      value: formatArgValue('turbo'),
      allowed: 'slow, normal, fast',
    });
    expect((localiseError(speed, de) as Error).message).toBe(
      'Geschwindigkeit: "turbo" ist keine gültige Auswahl. Erlaubt sind: slow, normal, fast.',
    );
    expect((localiseError(speed, en) as Error).message).toBe(
      'Speed: "turbo" is not a valid choice. Allowed are: slow, normal, fast.',
    );
  });

  it('localises number and text errors', () => {
    const number = new ArgumentError('n', 'invalid_number', 'seconds', { value: formatArgValue('abc') });
    expect((localiseError(number, de) as Error).message).toBe('Sekunden: "abc" ist keine Zahl.');
    const text = new ArgumentError('t', 'invalid_text', 'text', { type: 'number' });
    expect((localiseError(text, en) as Error).message).toBe('Text must be text.');
    expect((localiseError(text, de) as Error).message).toBe('Text muss ein Text sein.');
  });

  it('localises an image error with its limits (de, en)', () => {
    const tooLarge = new ImageError('too big', 'too_large', { max_mb: 5, max_mp: 8.3, max_side: 16384 });
    expect((localiseError(tooLarge, en) as Error).message).toBe(
      'The image is too large. At most 5 MB, 8.3 megapixels and 16384 pixels per side are supported.',
    );
    expect((localiseError(tooLarge, de) as Error).message).toBe(
      'Das Bild ist zu groß. Unterstützt werden höchstens 5 MB, 8.3 Megapixel und 16384 Pixel pro Seite.',
    );
    for (const kind of ['unreachable', 'unreadable', 'unsupported', 'missing'] as const) {
      const out = localiseError(new ImageError('secret cause: https://x/y?token=1', kind), en) as Error;
      expect(out).not.toBeInstanceOf(ImageError);
      expect(out.message).not.toContain('secret');
      expect(out.message).toBeTruthy();
    }
  });

  it('shows a long value cut', () => {
    const e = new ArgumentError('c', 'invalid_color', 'color', { value: formatArgValue('x'.repeat(50)) });
    expect((localiseError(e, en) as Error).message).toContain(`"${'x'.repeat(32)}…"`);
    expect((localiseError(e, en) as Error).message).not.toContain('x'.repeat(33));
  });

  it('returns every other value as the same object', () => {
    const plain = new Error('x');
    const range = new RangeError('y');
    expect(localiseError(plain, de)).toBe(plain);
    expect(localiseError(range, de)).toBe(range);
    expect(localiseError('boom', de)).toBe('boom');
    expect(localiseError(undefined, de)).toBeUndefined();
  });
});
