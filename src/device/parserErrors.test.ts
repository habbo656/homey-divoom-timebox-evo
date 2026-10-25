// Every user-input parser throws an `ArgumentError` whose kind, field and params feed the localised message
// (src/device/argumentError.ts). The English `message` stays the log text.
import { describe, expect, it } from 'vitest';
import { ArgumentError } from './argumentError';
import { parseChannelId, parseCustomPageId } from './channel';
import { parseClockStyleId, parseHexColor } from './clock';
import { parseCountdownArgs } from './countdown';
import { hueSatToRgb } from './lighting';
import { parseTextDuration, parseTextDurationArg, parseTextSpeedId, prepareText } from './scrollText';
import { parseNotificationIconId } from './notification';
import { dimToBrightness } from './TimeboxController';
import { parseTemperatureArg, parseWeatherConditionId } from './weather';

function thrown(fn: () => unknown): ArgumentError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ArgumentError);
    expect(e).toBeInstanceOf(RangeError);
    return e as ArgumentError;
  }
  throw new Error('did not throw');
}

const summary = (e: ArgumentError) => [e.kind, e.field, e.params];

describe('Show text', () => {
  it('speed: invalid_choice with the allowed ids', () => {
    const e = thrown(() => parseTextSpeedId('turbo'));
    expect(summary(e)).toEqual(['invalid_choice', 'speed', { value: '"turbo"', allowed: 'slow, normal, fast' }]);
    expect(e.message).toBe('text speed must be one of slow, normal, fast, got turbo');
  });

  it('duration: out of range is invalid_range, not a number is invalid_number', () => {
    const range = thrown(() => parseTextDuration(4000));
    expect(summary(range)).toEqual(['invalid_range', 'duration', { value: '4000', min: 0, max: 3600 }]);
    expect(range.message).toBe('duration must be a number of seconds within 0..3600, got 4000');
    expect(thrown(() => parseTextDuration(-1)).kind).toBe('invalid_range');
    expect(thrown(() => parseTextDuration(Infinity)).kind).toBe('invalid_range');
    expect(summary(thrown(() => parseTextDuration(NaN)))).toEqual(['invalid_number', 'duration', { value: 'NaN' }]);
    expect(summary(thrown(() => parseTextDuration(true)))).toEqual(['invalid_number', 'duration', { value: 'true' }]);
  });

  it('duration argument: a non-numeric string is reported as given', () => {
    const e = thrown(() => parseTextDurationArg('abc'));
    expect(summary(e)).toEqual(['invalid_number', 'duration', { value: '"abc"' }]);
    expect(e.message).toBe('duration must be a number of seconds within 0..3600, got NaN');
    expect(summary(thrown(() => parseTextDurationArg('4000')))).toEqual([
      'invalid_range',
      'duration',
      { value: '"4000"', min: 0, max: 3600 },
    ]);
  });

  it('text: invalid_text carries only the type, never the content', () => {
    const e = thrown(() => prepareText({ secret: 'x' }));
    expect(summary(e)).toEqual(['invalid_text', 'text', { type: 'object' }]);
    expect(e.message).toBe('text must be a string, got object');
  });
});

describe('Start countdown', () => {
  it('minutes and seconds: range and number', () => {
    const minutes = thrown(() => parseCountdownArgs(100, 0));
    expect(summary(minutes)).toEqual(['invalid_range', 'minutes', { value: '100', min: 0, max: 99 }]);
    const seconds = thrown(() => parseCountdownArgs(0, 60));
    expect(summary(seconds)).toEqual(['invalid_range', 'seconds', { value: '60', min: 0, max: 59 }]);
    expect(summary(thrown(() => parseCountdownArgs('5', 0)))).toEqual(['invalid_number', 'minutes', { value: '"5"' }]);
    expect(summary(thrown(() => parseCountdownArgs(0, NaN)))).toEqual(['invalid_number', 'seconds', { value: 'NaN' }]);
  });
});

describe('weather', () => {
  it('condition: invalid_choice', () => {
    expect(summary(thrown(() => parseWeatherConditionId('sunny')))).toEqual([
      'invalid_choice',
      'condition',
      { value: '"sunny"', allowed: 'clear, cloudy, thunder, rain, snow, fog' },
    ]);
  });

  it('temperature: range and number', () => {
    const e = thrown(() => parseTemperatureArg(150));
    expect(summary(e)).toEqual(['invalid_range', 'temperature', { value: '150', min: -99, max: 99 }]);
    expect(e.message).toBe('temperature must be within -99..99 °C, got 150');
    expect(summary(thrown(() => parseTemperatureArg(NaN)))).toEqual([
      'invalid_number',
      'temperature',
      { value: 'NaN' },
    ]);
  });
});

describe('clock and colour', () => {
  it('style: invalid_choice', () => {
    const e = thrown(() => parseClockStyleId('x'));
    expect(e.kind).toBe('invalid_choice');
    expect(e.field).toBe('style');
    expect(e.params.value).toBe('"x"');
    expect(String(e.params.allowed)).toContain(', ');
  });

  it('colour: invalid_color for the given field, default color', () => {
    const e = thrown(() => parseHexColor('red'));
    expect(summary(e)).toEqual(['invalid_color', 'color', { value: '"red"' }]);
    expect(e.message).toBe('colour must be a hex colour such as #FF8000, got red');
    expect(summary(thrown(() => parseHexColor('#12345', 'background')))).toEqual([
      'invalid_color',
      'background',
      { value: '"#12345"' },
    ]);
    expect(thrown(() => parseHexColor(5, 'text_color')).field).toBe('text_color');
  });
});

describe('channel and custom page', () => {
  it('channel: invalid_choice', () => {
    expect(summary(thrown(() => parseChannelId('cloud')))).toEqual([
      'invalid_choice',
      'channel',
      { value: '"cloud"', allowed: 'clock, lighting, custom, noise_meter' },
    ]);
  });

  it('page: invalid_choice with 1, 2, 3', () => {
    expect(summary(thrown(() => parseCustomPageId('4')))).toEqual([
      'invalid_choice',
      'page',
      { value: '"4"', allowed: '1, 2, 3' },
    ]);
  });
});

describe('lighting and brightness', () => {
  it('hue and saturation: range and number', () => {
    expect(summary(thrown(() => hueSatToRgb(1.5, 1)))).toEqual([
      'invalid_range',
      'hue',
      { value: '1.5', min: 0, max: 1 },
    ]);
    expect(summary(thrown(() => hueSatToRgb(0, -0.1)))).toEqual([
      'invalid_range',
      'saturation',
      { value: '-0.1', min: 0, max: 1 },
    ]);
    expect(summary(thrown(() => hueSatToRgb(NaN, 1)))).toEqual(['invalid_number', 'hue', { value: 'NaN' }]);
  });

  it('dim: range and number', () => {
    expect(summary(thrown(() => dimToBrightness(2)))).toEqual(['invalid_range', 'dim', { value: '2', min: 0, max: 1 }]);
    expect(summary(thrown(() => dimToBrightness('0.5')))).toEqual(['invalid_number', 'dim', { value: '"0.5"' }]);
  });
});

describe('notification icon (#5)', () => {
  it('icon: invalid_choice with the allowed ids', () => {
    const e = thrown(() => parseNotificationIconId('nope'));
    expect(e.kind).toBe('invalid_choice');
    expect(e.field).toBe('icon');
    expect(e.params.value).toBe('"nope"');
    expect(String(e.params.allowed)).toMatch(/^kakaotalk, instagram, .*, telegram, .*, tamtam$/);
    expect(e.message).toMatch(/^icon must be one of kakaotalk, .*, got nope$/);
  });
});
