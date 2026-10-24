// The error of an image that cannot be loaded or shown (docs/architecture/images.md, #31). Kept apart from `image.ts`
// so that `argumentError.ts` can localise it without an import cycle.

/** Why an image could not be shown; each kind has a locale string `device.error.image_<kind>`. */
export const IMAGE_ERROR_KINDS = ['unreachable', 'unreadable', 'too_large', 'unsupported', 'missing'] as const;
export type ImageErrorKind = (typeof IMAGE_ERROR_KINDS)[number];

/**
 * An image that cannot be loaded or shown. `message` is the English text for the log, `kind` and `params`
 * (`max_mb`, `max_mp`) feed the localised message.
 */
export class ImageError extends Error {
  constructor(
    message: string,
    readonly kind: ImageErrorKind,
    readonly params: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = 'ImageError';
  }
}
