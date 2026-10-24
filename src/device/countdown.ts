// Countdown model (docs/architecture.md, "Countdown (#33)"): validation of the Flow card arguments and the display
// form for logs. Pure, no Homey and no link.
import { ArgumentError, formatArgValue } from './argumentError';
import { COUNTDOWN_MAX_MINUTES, type CountdownTime } from '../protocol/commands';

/**
 * Validate the arguments of the "Start countdown" Flow card: finite numbers, whole minutes 0..`COUNTDOWN_MAX_MINUTES`
 * and seconds 0..59 after rounding (a decimal token is rounded, -0 becomes 0). 0:00 is accepted here; the controller
 * rejects it with a localised message. Throws `ArgumentError` (a `RangeError`) for anything else.
 */
export function parseCountdownArgs(minutes: unknown, seconds: unknown): CountdownTime {
  return {
    minutes: parsePart('minutes', minutes, COUNTDOWN_MAX_MINUTES),
    seconds: parsePart('seconds', seconds, 59),
  };
}

function parsePart(name: 'minutes' | 'seconds', value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ArgumentError(`${name} must be a number, got ${String(value)}`, 'invalid_number', name, {
      value: formatArgValue(value),
    });
  }
  const rounded = Math.round(value) + 0; // + 0 turns -0 into 0
  if (rounded < 0 || rounded > max) {
    throw new ArgumentError(`${name} must be within 0..${max}, got ${String(value)}`, 'invalid_range', name, {
      value: formatArgValue(value),
      min: 0,
      max,
    });
  }
  return rounded;
}

/** `MM:SS` for logs, e.g. `05:00`. */
export function formatCountdown(minutes: number, seconds: number): string {
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
