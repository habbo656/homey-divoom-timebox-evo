import { describe, expect, it } from 'vitest';
import { toHex } from '../protocol/hex';
import {
  clampTemperature,
  DEFAULT_WEATHER_INTERVAL_MIN,
  mergeWeather,
  parseTemperatureArg,
  parseWeatherConditionId,
  resolveWeatherSettings,
  TEMPERATURE_RANGE,
  WEATHER_CONDITION_IDS,
  WEATHER_INTERVAL_IDS,
  weatherCommand,
  wmoToCondition,
  type WeatherCondition,
} from './weather';

describe('weather condition ids', () => {
  it('maps every id to its device type', () => {
    const types = WEATHER_CONDITION_IDS.map((condition) => toHex(weatherCommand({ temperatureC: 0, condition })));
    expect(types).toEqual(['5f 00 01', '5f 00 03', '5f 00 05', '5f 00 06', '5f 00 08', '5f 00 09']);
  });

  it.each(WEATHER_CONDITION_IDS)('parses %s', (id) => {
    expect(parseWeatherConditionId(id)).toBe(id);
  });

  it.each(['', 'Clear', 'sunny', 1, null, undefined, {}])('rejects %j and names the allowed ids', (bad) => {
    expect(() => parseWeatherConditionId(bad)).toThrow(RangeError);
    expect(() => parseWeatherConditionId(bad)).toThrow(/clear, cloudy, thunder, rain, snow, fog/);
  });
});

describe('parseTemperatureArg', () => {
  it.each([
    [21, 21],
    [21.5, 22],
    [21.4, 21],
    [-0.4, 0],
    [-5.5, -5],
    [-0, 0],
    [99, 99],
    [-99, -99],
    [98.6, 99],
  ])('turns %s into %s', (value, expected) => {
    const result = parseTemperatureArg(value);
    expect(result).toBe(expected);
    expect(Object.is(result, -0)).toBe(false);
  });

  it.each([99.6, -99.6, 100, -100, 1000, NaN, Infinity, -Infinity, '5', null, undefined, true])('rejects %j', (bad) => {
    expect(() => parseTemperatureArg(bad)).toThrow(RangeError);
  });

  it('exposes the range', () => {
    expect(TEMPERATURE_RANGE).toEqual({ min: -99, max: 99 });
  });
});

describe('clampTemperature', () => {
  it('rounds and does not report an in-range value', () => {
    const seen: number[] = [];
    expect(clampTemperature(21.5, (r) => seen.push(r))).toBe(22);
    expect(clampTemperature(-0.2)).toBe(0);
    expect(Object.is(clampTemperature(-0.2), -0)).toBe(false);
    expect(seen).toEqual([]);
  });

  it('clamps and reports', () => {
    const seen: [number, number][] = [];
    expect(clampTemperature(120.4, (r, c) => seen.push([r, c]))).toBe(99);
    expect(clampTemperature(-150, (r, c) => seen.push([r, c]))).toBe(-99);
    expect(seen).toEqual([
      [120, 99],
      [-150, -99],
    ]);
  });
});

describe('wmoToCondition', () => {
  const cases: [WeatherCondition, number[]][] = [
    ['clear', [0, 1]],
    ['cloudy', [2, 3]],
    ['fog', [45, 48]],
    ['rain', [51, 52, 53, 54, 55, 56, 57, 61, 62, 63, 64, 65, 66, 67, 80, 81, 82]],
    ['snow', [71, 72, 73, 74, 75, 76, 77, 85, 86]],
    ['thunder', [95, 96, 97, 98, 99]],
  ];
  it.each(cases.flatMap(([condition, codes]) => codes.map((code) => [code, condition] as const)))(
    'maps WMO code %i to %s',
    (code, condition) => {
      expect(wmoToCondition(code)).toBe(condition);
    },
  );

  it.each([-1, 4, 10, 44, 46, 50, 58, 60, 68, 70, 78, 83, 84, 87, 94, 100, 1.5, NaN])(
    'has no mapping for %s',
    (code) => {
      expect(wmoToCondition(code)).toBeNull();
    },
  );
});

describe('resolveWeatherSettings', () => {
  it('defaults to off and 30 minutes', () => {
    expect(resolveWeatherSettings({})).toEqual({ settings: { auto: false, intervalMin: 30 }, invalid: [] });
    expect(DEFAULT_WEATHER_INTERVAL_MIN).toBe(30);
  });

  it.each(WEATHER_INTERVAL_IDS)('reads interval %s', (id) => {
    expect(resolveWeatherSettings({ weather_auto: true, weather_interval: id })).toEqual({
      settings: { auto: true, intervalMin: Number(id) },
      invalid: [],
    });
  });

  it('treats null as missing', () => {
    expect(resolveWeatherSettings({ weather_auto: null, weather_interval: null }).invalid).toEqual([]);
  });

  it('falls back and lists invalid values', () => {
    expect(resolveWeatherSettings({ weather_auto: 'yes', weather_interval: '45' })).toEqual({
      settings: { auto: false, intervalMin: 30 },
      invalid: ['weather_auto', 'weather_interval'],
    });
    expect(resolveWeatherSettings({ weather_interval: 15 }).invalid).toEqual(['weather_interval']);
  });
});

describe('mergeWeather', () => {
  it('a temperature alone on nothing stored gives the default condition', () => {
    expect(mergeWeather(null, { temperatureC: 23 })).toEqual({ temperatureC: 23, condition: 'clear' });
  });

  it('a condition alone on nothing stored gives the default temperature', () => {
    expect(mergeWeather(null, { condition: 'rain' })).toEqual({ temperatureC: 0, condition: 'rain' });
  });

  it('each part keeps the stored other part', () => {
    const stored = { temperatureC: 21, condition: 'rain' } as const;
    expect(mergeWeather(stored, { temperatureC: -3 })).toEqual({ temperatureC: -3, condition: 'rain' });
    expect(mergeWeather(stored, { condition: 'snow' })).toEqual({ temperatureC: 21, condition: 'snow' });
  });

  it('both parts overwrite the stored weather and the stored value is not changed', () => {
    const stored = { temperatureC: 21, condition: 'rain' } as const;
    expect(mergeWeather(stored, { temperatureC: 5, condition: 'fog' })).toEqual({ temperatureC: 5, condition: 'fog' });
    expect(stored).toEqual({ temperatureC: 21, condition: 'rain' });
  });

  it('an update without a part is a RangeError', () => {
    expect(() => mergeWeather(null, {})).toThrow(RangeError);
    expect(() => mergeWeather({ temperatureC: 1, condition: 'fog' }, {})).toThrow(RangeError);
  });

  it('an invalid part is a RangeError', () => {
    expect(() => mergeWeather(null, { temperatureC: 1.5 })).toThrow(RangeError);
    expect(() => mergeWeather(null, { temperatureC: 200 })).toThrow(RangeError);
    expect(() => mergeWeather(null, { condition: 'sunny' as never })).toThrow(RangeError);
  });
});
