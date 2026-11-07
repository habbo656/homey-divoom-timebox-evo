// Volume model (#4): the mapping between the Homey `volume_set` capability (0..1) and the device volume `VV` of
// `08 VV` / `09 55 VV` (0..15), and the level that unmute restores. Pure, no Homey and no link.
import { MAX_VOLUME } from '../protocol/commands';
import { ArgumentError, formatArgValue } from './argumentError';

/** The device volume that unmute restores when no non-zero volume is stored (owner decision, #4). */
export const DEFAULT_UNMUTE_LEVEL = 8;

/**
 * Homey `volume_set` (0..1) to the device volume 0..15 (`Math.round(v * 15)`). Throws `ArgumentError` (a `RangeError`)
 * if `volume` is not a number or outside 0..1.
 */
export function volumeToLevel(volume: number): number {
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) {
    const message = `volume must be a number between 0 and 1, got ${String(volume)}`;
    const params = { value: formatArgValue(volume) };
    if (typeof volume !== 'number' || Number.isNaN(volume)) {
      throw new ArgumentError(message, 'invalid_number', 'volume', params);
    }
    throw new ArgumentError(message, 'invalid_range', 'volume', { ...params, min: 0, max: 1 });
  }
  return Math.round(volume * MAX_VOLUME);
}

/** The device volume 0..15 to Homey `volume_set` (0..1). */
export function levelToVolume(level: number): number {
  return level / MAX_VOLUME;
}

/** The level unmute sends: a stored volume 1..15, otherwise `DEFAULT_UNMUTE_LEVEL` (nothing stored, 0 or garbage). */
export function restoreLevel(stored: unknown): number {
  return typeof stored === 'number' && Number.isInteger(stored) && stored >= 1 && stored <= MAX_VOLUME
    ? stored
    : DEFAULT_UNMUTE_LEVEL;
}
