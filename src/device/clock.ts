// Clock face model (docs/architecture.md, "Clock face"): stable style ids, the device settings that describe the face,
// colour parsing. Pure, no Homey and no link.
import { CLOCK_STYLES } from '../protocol/commands';
import type { ClockOptions } from '../protocol/commands';
import type { Rgb } from '../protocol/status';
import { ArgumentError, formatArgValue } from './argumentError';
import type { ArgumentField } from './argumentError';

/** Style ids as used by the setting and the Flow card (stable, never translated); the index is the device style `TT`. */
export const CLOCK_STYLE_IDS = [
  'full_screen',
  'rainbow',
  'boxed',
  'analog_square',
  'negative',
  'analog_round',
  'small',
] as const;
export type ClockStyleId = (typeof CLOCK_STYLE_IDS)[number];

/**
 * The complete clock face: what `setClock` needs (12/24 h, style, page flags, colour) plus whether the animation pages
 * are shown, which is a separate command (`setHot`, `26 0X`, #106) and not part of the `45 00` frame.
 */
export type ClockFace = ClockOptions & { animations: boolean };

/**
 * The clock face without its colour and 12/24 h flag: what the clock settings describe. The colour is owned by the app
 * (`resolveStoredClockColor`); the 12/24 h flag is fixed (`CLOCK_HOUR24`).
 */
export type ClockSettings = Omit<ClockFace, 'color' | 'hour24'>;

/**
 * The 12/24 h flag `HH` of `45 00`, always sent as 24 h (`01`). The Timebox Evo ignores it, `HH` has no effect on the display
 * (#58), so there is no setting for it (#70).
 */
export const CLOCK_HOUR24 = true;

/** The clock colour until the user (or a migrated setting) chose one: white. */
export const DEFAULT_CLOCK_COLOR: Rgb = { r: 255, g: 255, b: 255 };

export const DEFAULT_CLOCK_SETTINGS: ClockSettings = {
  style: 0,
  weather: false,
  temperature: false,
  calendar: false,
  animations: false,
};

export const DEFAULT_CLOCK_FACE: ClockFace = {
  ...DEFAULT_CLOCK_SETTINGS,
  hour24: CLOCK_HOUR24,
  color: DEFAULT_CLOCK_COLOR,
};

/** The id of a device style number (`TT` of `45 00`, `46` d15), or null for a style that is not offered (7..9 and beyond). */
export function clockStyleId(style: number): ClockStyleId | null {
  return (CLOCK_STYLES as readonly number[]).includes(style) ? CLOCK_STYLE_IDS[style] : null;
}

/** Validate a style id coming from a setting or a Flow card and return the device style number. Throws `ArgumentError` (a `RangeError`). */
export function parseClockStyleId(value: unknown): number {
  const index = CLOCK_STYLE_IDS.findIndex((id) => id === value);
  if (index < 0) {
    throw new ArgumentError(
      `clock style must be one of ${CLOCK_STYLE_IDS.join(', ')}, got ${String(value)}`,
      'invalid_choice',
      'style',
      { value: formatArgValue(value), allowed: CLOCK_STYLE_IDS.join(', ') },
    );
  }
  return index;
}

/** `#RRGGBB` or `RRGGBB` (surrounding blanks and any case allowed). Throws `ArgumentError` (a `RangeError`) for anything else; `field` names the argument in the message. */
export function parseHexColor(value: unknown, field: ArgumentField = 'color'): Rgb {
  const match = typeof value === 'string' ? /^#?([0-9a-fA-F]{6})$/.exec(value.trim()) : null;
  if (!match) {
    throw new ArgumentError(
      `colour must be a hex colour such as #FF8000, got ${String(value)}`,
      'invalid_color',
      field,
      {
        value: formatArgValue(value),
      },
    );
  }
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** `#RRGGBB`, upper case. */
export function formatHexColor(color: Rgb): string {
  const byte = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`.toUpperCase();
}

/** The setting keys of the clock face (the colour is not a setting, it follows the tile colour picker). */
export const CLOCK_SETTING_KEYS = [
  'clock_style',
  'clock_weather',
  'clock_temperature',
  'clock_calendar',
  'clock_animations',
] as const;

/** Read one setting through `parse`: a missing value gives the fallback silently, an invalid one gives it and is reported through `onInvalid`. */
function pickSetting<T>(
  settings: Readonly<Record<string, unknown>>,
  key: string,
  parse: (raw: unknown) => T,
  fallback: T,
  onInvalid: (key: string) => void,
): T {
  const raw = settings[key];
  if (raw === undefined || raw === null) return fallback;
  try {
    return parse(raw);
  } catch {
    onInvalid(key);
    return fallback;
  }
}

const parseBool = (raw: unknown): boolean => {
  if (typeof raw !== 'boolean') throw new RangeError('not a boolean');
  return raw;
};

/**
 * The clock settings (style, page flags, animation pages) described by the device settings. A missing value (undefined or null)
 * silently gives the default; a present but invalid value also gives the default and its key is listed in `invalid`
 * (so it can be logged). A legacy `clock_color` (and a removed `clock_24h`) is ignored (see `resolveStoredClockColor`).
 */
export function resolveClockSettings(settings: Readonly<Record<string, unknown>>): {
  settings: ClockSettings;
  invalid: string[];
} {
  const invalid: string[] = [];
  const note = (key: string): void => void invalid.push(key);
  const d = DEFAULT_CLOCK_SETTINGS;
  return {
    settings: {
      style: pickSetting(settings, 'clock_style', parseClockStyleId, d.style, note),
      weather: pickSetting(settings, 'clock_weather', parseBool, d.weather, note),
      temperature: pickSetting(settings, 'clock_temperature', parseBool, d.temperature, note),
      calendar: pickSetting(settings, 'clock_calendar', parseBool, d.calendar, note),
      animations: pickSetting(settings, 'clock_animations', parseBool, d.animations, note),
    },
    invalid,
  };
}

/** Where the clock colour of a device comes from: the device store, else the legacy `clock_color` setting (migration), else white. */
export type ClockColorSource = 'store' | 'setting' | 'default';

/**
 * The clock colour: the stored `#RRGGBB` (device store `clock_color`) wins, then a valid legacy `clock_color` setting
 * (taken over once), else the default (white). An invalid value is skipped, never thrown.
 */
export function resolveStoredClockColor(
  stored: unknown,
  legacySetting: unknown,
): { color: Rgb; source: ClockColorSource } {
  for (const [value, source] of [
    [stored, 'store'],
    [legacySetting, 'setting'],
  ] as const) {
    if (value === undefined || value === null) continue;
    try {
      return { color: parseHexColor(value), source };
    } catch {
      // invalid: try the next source
    }
  }
  return { color: DEFAULT_CLOCK_COLOR, source: 'default' };
}

/**
 * The style of the last "Show clock" as stored in the device store (`clock_shown_style`, a style id): a missing value
 * (undefined or null) gives no style silently; an invalid one gives none and is flagged `invalid` (so it can be logged).
 */
export function resolveStoredShownStyle(raw: unknown): { style: number | null; invalid: boolean } {
  if (raw === undefined || raw === null) return { style: null, invalid: false };
  try {
    return { style: parseClockStyleId(raw), invalid: false };
  } catch {
    return { style: null, invalid: true };
  }
}
