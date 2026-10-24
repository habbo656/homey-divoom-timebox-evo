// Argument validation for command builders. The Evo has no NAK and executes malformed commands
// (docs/divoom-protocol.md section 2), so every argument is checked before anything is sent.
// All helpers throw `RangeError` naming the offending argument.

/** Return `value` if it is an integer within `min..max` (inclusive), otherwise throw `RangeError`. */
export function intInRange(name: string, value: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer within ${min}..${max}, got ${String(value)}`);
  }
  return value;
}

/** Validate a single byte (integer 0..255). */
export function u8(name: string, value: number): number {
  return intInRange(name, value, 0, 0xff);
}

/** Validate a 16-bit unsigned value and return it as little-endian bytes `[lo, hi]`. */
export function le16(name: string, value: number): [number, number] {
  const v = intInRange(name, value, 0, 0xffff);
  return [v & 0xff, v >> 8];
}

/** Validate an RGB colour (each channel 0..255) and return `[r, g, b]`. */
export function rgb(name: string, r: number, g: number, b: number): [number, number, number] {
  return [u8(`${name}.r`, r), u8(`${name}.g`, g), u8(`${name}.b`, b)];
}

/** Return `value` if it is one of `allowed`, otherwise throw `RangeError`. */
export function oneOf<T extends number>(name: string, value: number, allowed: readonly T[]): T {
  if (!(allowed as readonly number[]).includes(value)) {
    throw new RangeError(`${name} must be one of ${allowed.join(', ')}, got ${String(value)}`);
  }
  return value as T;
}
