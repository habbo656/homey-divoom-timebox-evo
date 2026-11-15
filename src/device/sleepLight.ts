// Sleep light model (docs/architecture/sleep-light.md, #6): the stable sound ids of the Flow card, the validation of the
// card arguments and the `40` payload they give. Pure, no Homey and no link.
import { ArgumentError, formatArgValue } from './argumentError';
import type { ArgumentField } from './argumentError';
import { formatHexColor, parseHexColor } from './clock';
import { MAX_SLEEP_SOUND, SLEEP_MAX_MINUTES, startSleepLight } from '../protocol/commands';
import type { SleepLight } from '../protocol/commands';

/**
 * Sound ids of the Flow card (stable, never translated; the dropdown value), in code order: `phone` is sound 0 (audio
 * from the phone over Bluetooth), `sound_N` the built-in sleep sound N, 1..23 (protocol section 5.4).
 */
export const SLEEP_SOUND_IDS = [
  'phone',
  ...Array.from({ length: MAX_SLEEP_SOUND }, (_, i) => `sound_${i + 1}`),
] as readonly string[];

/** The lowest brightness and volume of the card (owner, #6: 1..100 %); the device bytes take them as they are. */
const MIN_PERCENT = 1;
const MAX_PERCENT = 100;

/** The raw arguments of the Flow card "Start sleep light", validated by `parseSleepLightArgs`. */
export interface SleepLightArgs {
  color: unknown;
  brightness: unknown;
  minutes: unknown;
  sound: unknown;
  volume: unknown;
}

/**
 * Validate the arguments of "Start sleep light": a hex colour, whole minutes 1..`SLEEP_MAX_MINUTES`, brightness and
 * volume 1..100 % (finite numbers, rounded like the countdown card; -0 becomes 0) and a sound id of `SLEEP_SOUND_IDS`.
 * Throws `ArgumentError` (a `RangeError`) for anything else.
 */
export function parseSleepLightArgs(args: SleepLightArgs): SleepLight {
  return {
    color: parseHexColor(args.color),
    brightness: parseWhole('brightness', args.brightness, MIN_PERCENT, MAX_PERCENT),
    minutes: parseWhole('minutes', args.minutes, 1, SLEEP_MAX_MINUTES),
    sound: parseSleepSoundId(args.sound),
    volume: parseWhole('volume', args.volume, MIN_PERCENT, MAX_PERCENT),
  };
}

/** Validate a sound id from the Flow card and return the device sound `MO`. Throws `ArgumentError` (a `RangeError`). */
export function parseSleepSoundId(value: unknown): number {
  const code = SLEEP_SOUND_IDS.findIndex((candidate) => candidate === value);
  if (code < 0) {
    throw new ArgumentError(
      `sound must be one of phone, sound_1..sound_${MAX_SLEEP_SOUND}, got ${String(value)}`,
      'invalid_choice',
      'sound',
      { value: formatArgValue(value), allowed: `phone, sound_1 … sound_${MAX_SLEEP_SOUND}` },
    );
  }
  return code;
}

/** The `40` payload of a validated sleep light (`startSleepLight`; throws `RangeError` for values out of range). */
export function sleepLightCommand(light: SleepLight): Uint8Array {
  return startSleepLight(light);
}

/** The sleep light for logs, e.g. `5 min, #FF0000, brightness 50, phone audio, volume 10`. */
export function formatSleepLight(light: SleepLight): string {
  const sound = light.sound === 0 ? 'phone audio' : `sound ${light.sound}`;
  return (
    `${light.minutes} min, ${formatHexColor(light.color)}, brightness ${light.brightness}, ${sound}, ` +
    `volume ${light.volume}`
  );
}

function parseWhole(field: ArgumentField, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ArgumentError(`${field} must be a number, got ${String(value)}`, 'invalid_number', field, {
      value: formatArgValue(value),
    });
  }
  const rounded = Math.round(value) + 0; // + 0 turns -0 into 0
  if (rounded < min || rounded > max) {
    throw new ArgumentError(`${field} must be within ${min}..${max}, got ${String(value)}`, 'invalid_range', field, {
      value: formatArgValue(value),
      min,
      max,
    });
  }
  return rounded;
}
