// Typed validation error of user input (docs/architecture.md, "User-facing errors"). The parsers throw `ArgumentError`
// (a `RangeError`, so existing handling keeps working); the Homey layer turns it into a localised message with
// `localiseError`. Pure, no Homey: the translation function is passed in.
import { ImageError } from './imageError';
import { fillPlaceholders } from './text';

/** What was wrong with the value; each kind has a locale string `device.error.<kind>`. */
export const ARGUMENT_ERROR_KINDS = [
  'invalid_range',
  'invalid_number',
  'invalid_choice',
  'invalid_color',
  'invalid_text',
  'invalid_url',
] as const;
export type ArgumentErrorKind = (typeof ARGUMENT_ERROR_KINDS)[number];

/** Which argument it was; each field has a locale string `device.field.<field>` (the title of the card argument). */
export const ARGUMENT_FIELDS = [
  'text',
  'color',
  'text_color',
  'background',
  'speed',
  'duration',
  'minutes',
  'seconds',
  'temperature',
  'condition',
  'style',
  'page',
  'channel',
  'dim',
  'hue',
  'saturation',
  'fit',
  'url',
  'icon',
] as const;
export type ArgumentField = (typeof ARGUMENT_FIELDS)[number];

/**
 * An invalid argument of a Flow card or a capability. `message` is the English text for logs; `kind`, `field` and
 * `params` (`value`, `min`, `max`, `allowed`, `type` ...) feed the localised message.
 */
export class ArgumentError extends RangeError {
  constructor(
    message: string,
    readonly kind: ArgumentErrorKind,
    readonly field: ArgumentField,
    readonly params: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = 'ArgumentError';
  }
}

const MAX_SHOWN_CHARS = 32;

/** A given value for a message: numbers as they are, strings in double quotes and cut after 32 characters. */
export function formatArgValue(value: unknown): string {
  if (typeof value === 'string' || value === null || value === undefined) {
    const text = value ?? '';
    const shown = text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}…` : text;
    return `"${shown}"`;
  }
  return String(value);
}

/**
 * The error a user sees: an `ArgumentError` or an `ImageError` becomes a plain `Error` with the localised message
 * (`translate` is `homey.__`); every other value is returned unchanged.
 */
export function localiseError(e: unknown, translate: (key: string) => string): unknown {
  if (e instanceof ImageError) return new Error(fillPlaceholders(translate(`device.error.image_${e.kind}`), e.params));
  if (!(e instanceof ArgumentError)) return e;
  return new Error(
    fillPlaceholders(translate(`device.error.${e.kind}`), { ...e.params, field: translate(`device.field.${e.field}`) }),
  );
}
