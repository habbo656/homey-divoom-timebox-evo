// Native scrolling text, device side (docs/architecture.md, "Native text (#28)"): the stable speed ids of the Flow card,
// the cleaning of the user's text to what the device can show, and the duration check. Pure, no Homey and no link.
import { ArgumentError, formatArgValue } from './argumentError';

/** Speed ids of the Flow card (stable, never translated). */
export const TEXT_SPEED_IDS = ['slow', 'normal', 'fast'] as const;
export type TextSpeedId = (typeof TEXT_SPEED_IDS)[number];

/**
 * The device speed `SP` of each id. The device scrolls about SP columns per second (VERIFIED, protocol section 5.5), so
 * the pass time of a text is about 1.7x (slow), 1x (normal) and 0.5x (fast) of SP 5, which reads well.
 */
export const TEXT_SPEED_LEVELS: Readonly<Record<TextSpeedId, number>> = { slow: 3, normal: 5, fast: 10 };

/** The longest duration of "Show text" in seconds; 0 means until stopped. */
export const MAX_TEXT_DURATION_S = 3600;

/** Validate a speed id from a Flow card and return the device speed `SP`. Throws `ArgumentError` (a `RangeError`). */
export function parseTextSpeedId(value: unknown): number {
  const id = TEXT_SPEED_IDS.find((candidate) => candidate === value);
  if (!id) {
    throw new ArgumentError(
      `text speed must be one of ${TEXT_SPEED_IDS.join(', ')}, got ${String(value)}`,
      'invalid_choice',
      'speed',
      { value: formatArgValue(value), allowed: TEXT_SPEED_IDS.join(', ') },
    );
  }
  return TEXT_SPEED_LEVELS[id];
}

/**
 * Validate the duration of "Show text" (seconds, a finite number 0..3600) and return it rounded to whole seconds;
 * 0 = until stopped. Throws `ArgumentError` (a `RangeError`) for anything else. `given` is what the user gave when
 * `value` was converted from it (a numeric string); it is what the localised message shows.
 */
export function parseTextDuration(value: unknown, given: unknown = value): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TEXT_DURATION_S) {
    const message = `duration must be a number of seconds within 0..${MAX_TEXT_DURATION_S}, got ${String(value)}`;
    const params = { value: formatArgValue(given) };
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new ArgumentError(message, 'invalid_number', 'duration', params);
    }
    throw new ArgumentError(message, 'invalid_range', 'duration', { ...params, min: 0, max: MAX_TEXT_DURATION_S });
  }
  return Math.round(value);
}

/**
 * The duration argument of the Flow card: a blank field (or a token without a value) means 0 (until stopped), a numeric
 * string (from a token) is converted, everything else goes through `parseTextDuration`.
 */
export function parseTextDurationArg(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return value.trim() === '' ? 0 : parseTextDuration(Number(value), value);
  return parseTextDuration(value);
}

export interface PreparedText {
  /** The cleaned text: NFC, no controls, no characters the device cannot draw. Empty = nothing to show. */
  text: string;
  /** UTF-16 units of `text`. The caller rejects a text above `MAX_TEXT_UNITS`; nothing is cut here. */
  units: number;
}

/**
 * What the device cannot draw: non-BMP code points (an emoji pair draws a filled box, protocol section 5.5), lone
 * surrogates (invalid UTF-16), variation selectors and zero-width characters.
 */
function isUndrawable(code: number): boolean {
  return (
    code > 0xffff ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0x200b && code <= 0x200d) ||
    code === 0x2060 ||
    code === 0xfeff
  );
}

/** Control characters (line feed, tab, ...) and the Unicode line separators: the device draws nothing for them. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/**
 * Clean `raw` for the device: NFC, strip what it cannot draw, controls to a space and trim. The text is never cut: the
 * caller compares `units` with `MAX_TEXT_UNITS` and rejects a longer text (#107). Throws `ArgumentError` (a `RangeError`) if `raw` is not a
 * string. The result may be empty or longer than `MAX_TEXT_UNITS`.
 */
export function prepareText(raw: unknown): PreparedText {
  if (typeof raw !== 'string') {
    // Never echo the content: only its type goes into the message.
    throw new ArgumentError(`text must be a string, got ${typeof raw}`, 'invalid_text', 'text', { type: typeof raw });
  }
  let cleaned = '';
  // `for ... of` walks code points: a surrogate pair is one step, a lone surrogate comes through as itself.
  for (const char of raw.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0;
    if (!isUndrawable(code)) cleaned += isControl(code) ? ' ' : char;
  }
  cleaned = cleaned.trim();
  return { text: cleaned, units: cleaned.length };
}
