// Weather model (docs/architecture.md, "Weather (#30)"): the stable condition ids of the Flow card and their device
// types, the temperature rules, the WMO weather code mapping of Open-Meteo and the weather settings. Pure, no Homey and
// no link.
import { ArgumentError, formatArgValue } from './argumentError';
import { setWeather, TEMPERATURE_UNITS, WEATHER_TYPES } from '../protocol/commands';
import type { TemperatureUnit } from '../protocol/commands';

/** Condition ids as used by the Flow card (stable, never translated); the index into `WEATHER_TYPES` is the device type `WW`. */
export const WEATHER_CONDITION_IDS = ['clear', 'cloudy', 'thunder', 'rain', 'snow', 'fog'] as const;
export type WeatherCondition = (typeof WEATHER_CONDITION_IDS)[number];

/** The device type `WW` of each condition (1 clear, 3 cloudy, 5 thunderstorm, 6 rain, 8 snow, 9 fog). */
const CONDITION_TYPES: Readonly<Record<WeatherCondition, (typeof WEATHER_TYPES)[number]>> = {
  clear: WEATHER_TYPES[0],
  cloudy: WEATHER_TYPES[1],
  thunder: WEATHER_TYPES[2],
  rain: WEATHER_TYPES[3],
  snow: WEATHER_TYPES[4],
  fog: WEATHER_TYPES[5],
};

/** The weather the Timebox shows: whole degrees Celsius and a condition. */
export interface Weather {
  temperatureC: number;
  condition: WeatherCondition;
}

/** A part of the weather: the Flow cards set the temperature and the condition separately (#98). */
export type WeatherUpdate = Partial<Weather>;

/** The temperature shown until one was set (a Flow card that only sets the condition, nothing set before). */
export const DEFAULT_TEMPERATURE_C = 0;
/** The condition shown until one was set (a Flow card that only sets the temperature, nothing set before). */
export const DEFAULT_WEATHER_CONDITION: WeatherCondition = 'clear';

/** Where a weather value came from (only used for logging). */
export type WeatherSource = 'flow' | 'open-meteo';

/** The temperatures the Flow card accepts and Open-Meteo values are clamped to (whole degrees Celsius). */
export const TEMPERATURE_RANGE = { min: -99, max: 99 } as const;

/** The temperatures the Flow card accepts in °F: the range that matches `TEMPERATURE_RANGE` (-99..99 °C is -146.2..210.2 °F). */
export const TEMPERATURE_RANGE_F = { min: -146, max: 210 } as const;

/** The choices of the unit argument of the Flow card "Set temperature": the device setting or a fixed unit. */
export const TEMPERATURE_UNIT_ARG_IDS = ['device', 'celsius', 'fahrenheit'] as const;
export type TemperatureUnitArg = (typeof TEMPERATURE_UNIT_ARG_IDS)[number];

/**
 * Validate the unit argument of the Flow card "Set temperature". A missing value (a Flow saved before the argument
 * existed) is Celsius, the old behaviour. Throws `ArgumentError` (a `RangeError`) listing the allowed ids otherwise.
 */
export function parseTemperatureUnitArg(value: unknown): TemperatureUnitArg {
  if (value === undefined || value === null) return 'celsius';
  const id = TEMPERATURE_UNIT_ARG_IDS.find((candidate) => candidate === value);
  if (!id) {
    throw new ArgumentError(
      `unit must be one of ${TEMPERATURE_UNIT_ARG_IDS.join(', ')}, got ${String(value)}`,
      'invalid_choice',
      'unit',
      { value: formatArgValue(value), allowed: TEMPERATURE_UNIT_ARG_IDS.join(', ') },
    );
  }
  return id;
}

/** Validate a condition id from a Flow card. Throws `ArgumentError` (a `RangeError`) listing the allowed ids. */
export function parseWeatherConditionId(value: unknown): WeatherCondition {
  const id = WEATHER_CONDITION_IDS.find((candidate) => candidate === value);
  if (!id) {
    throw new ArgumentError(
      `condition must be one of ${WEATHER_CONDITION_IDS.join(', ')}, got ${String(value)}`,
      'invalid_choice',
      'condition',
      { value: formatArgValue(value), allowed: WEATHER_CONDITION_IDS.join(', ') },
    );
  }
  return id;
}

/**
 * Validate the temperature argument of the Flow card (a finite number, whole degrees after rounding, within
 * `TEMPERATURE_RANGE` in °C or `TEMPERATURE_RANGE_F` in °F) and return it as whole degrees Celsius: a value in °F is
 * converted and rounded (the Evo shows it converted back, so it can differ by 1 °F, e.g. 76 °F shows as 75 °F). -0
 * becomes 0. Throws `ArgumentError` (a `RangeError`) for anything else.
 */
export function parseTemperatureArg(value: unknown, unit: TemperatureUnit = 'celsius'): number {
  const fahrenheit = unit === 'fahrenheit';
  const symbol = fahrenheit ? '°F' : '°C';
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ArgumentError(
      `temperature must be a number of degrees ${fahrenheit ? 'Fahrenheit' : 'Celsius'}, got ${String(value)}`,
      'invalid_number',
      'temperature',
      { value: formatArgValue(value) },
    );
  }
  const range = fahrenheit ? TEMPERATURE_RANGE_F : TEMPERATURE_RANGE;
  const rounded = Math.round(value) + 0; // + 0 turns -0 into 0
  if (rounded < range.min || rounded > range.max) {
    throw new ArgumentError(
      `temperature must be within ${range.min}..${range.max} ${symbol}, got ${String(value)}`,
      'invalid_range',
      'temperature',
      { value: formatArgValue(value), min: range.min, max: range.max },
    );
  }
  return fahrenheit ? Math.round(((rounded - 32) * 5) / 9) + 0 : rounded;
}

/**
 * Round a measured temperature to whole degrees and clamp it to `TEMPERATURE_RANGE` (a sensor value is never an error).
 * `onClamp` is called with the rounded value when it had to be clamped.
 */
export function clampTemperature(value: number, onClamp?: (rounded: number, clamped: number) => void): number {
  const rounded = Math.round(value) + 0;
  const clamped = Math.min(TEMPERATURE_RANGE.max, Math.max(TEMPERATURE_RANGE.min, rounded));
  if (clamped !== rounded) onClamp?.(rounded, clamped);
  return clamped;
}

/** The `5f TT WW` payload of a weather value. Throws `RangeError` for an invalid temperature or condition. */
export function weatherCommand(weather: Weather): Uint8Array {
  return setWeather({
    temperature: weather.temperatureC,
    type: CONDITION_TYPES[parseWeatherConditionId(weather.condition)],
  });
}

/**
 * The weather after `update`: the given parts replace the stored ones, a part that was never set is the default
 * (`DEFAULT_TEMPERATURE_C`, `DEFAULT_WEATHER_CONDITION`). Throws `RangeError` when `update` has no part or the result is
 * not valid (see `weatherCommand`).
 */
export function mergeWeather(stored: Weather | null, update: WeatherUpdate): Weather {
  if (update.temperatureC === undefined && update.condition === undefined) {
    throw new RangeError('weather update needs a temperature or a condition');
  }
  const merged: Weather = {
    temperatureC: update.temperatureC ?? stored?.temperatureC ?? DEFAULT_TEMPERATURE_C,
    condition: update.condition ?? stored?.condition ?? DEFAULT_WEATHER_CONDITION,
  };
  weatherCommand(merged);
  return merged;
}

const inRange = (code: number, min: number, max: number): boolean => code >= min && code <= max;

/** The condition of a WMO weather code as reported by Open-Meteo, or null for a code that is not mapped. */
export function wmoToCondition(code: number): WeatherCondition | null {
  if (!Number.isInteger(code)) return null;
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (inRange(code, 51, 57) || inRange(code, 61, 67) || inRange(code, 80, 82)) return 'rain';
  if (inRange(code, 71, 77) || code === 85 || code === 86) return 'snow';
  if (inRange(code, 95, 99)) return 'thunder';
  return null;
}

/** Refresh intervals of the automatic weather in minutes (stable ids of the setting). */
export const WEATHER_INTERVAL_IDS = ['15', '30', '60'] as const;
export const DEFAULT_WEATHER_INTERVAL_MIN = 30;

export interface WeatherSettings {
  /** Fetch the weather from Open-Meteo automatically. */
  auto: boolean;
  intervalMin: number;
}

/**
 * The weather settings described by the device settings (`weather_auto`, `weather_interval`). A missing value gives the
 * default (off, 30 min) silently; a present but invalid value also gives the default and its key is listed in `invalid`.
 */
export function resolveWeatherSettings(settings: Readonly<Record<string, unknown>>): {
  settings: WeatherSettings;
  invalid: string[];
} {
  const invalid: string[] = [];
  let auto = false;
  let intervalMin = DEFAULT_WEATHER_INTERVAL_MIN;
  const rawAuto = settings.weather_auto;
  if (rawAuto !== undefined && rawAuto !== null) {
    if (typeof rawAuto === 'boolean') auto = rawAuto;
    else invalid.push('weather_auto');
  }
  const rawInterval = settings.weather_interval;
  if (rawInterval !== undefined && rawInterval !== null) {
    const id = WEATHER_INTERVAL_IDS.find((candidate) => candidate === rawInterval);
    if (id) intervalMin = Number(id);
    else invalid.push('weather_interval');
  }
  return { settings: { auto, intervalMin }, invalid };
}

export const WEATHER_SETTING_KEYS = ['weather_auto', 'weather_interval'] as const;

/** The device setting of the temperature unit (#7): `celsius` or `fahrenheit`. */
export const TEMPERATURE_UNIT_SETTING = 'temperature_unit';
export const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = 'celsius';

/**
 * The temperature unit described by the device setting `temperature_unit`. A missing value gives `celsius` silently; a
 * present but invalid value also gives `celsius` and is flagged in `invalid`.
 */
export function resolveTemperatureUnit(raw: unknown): { unit: TemperatureUnit; invalid: boolean } {
  if (raw === undefined || raw === null) return { unit: DEFAULT_TEMPERATURE_UNIT, invalid: false };
  const unit = TEMPERATURE_UNITS.find((candidate) => candidate === raw);
  return unit ? { unit, invalid: false } : { unit: DEFAULT_TEMPERATURE_UNIT, invalid: true };
}

/** The first value of the setting: from Homey's unit system (`homey.i18n.getUnits()`, `metric` or `imperial`), `imperial` gives `fahrenheit`. */
export function defaultTemperatureUnit(units: unknown): TemperatureUnit {
  return units === 'imperial' ? 'fahrenheit' : DEFAULT_TEMPERATURE_UNIT;
}
