// Lighting model (docs/architecture.md, "Power and lighting"): the HSV conversion between the Homey colour
// capabilities and the device RGB, and the power-off command. Pure, no Homey and no link.
import { setLighting } from '../protocol/commands';
import type { DeviceStatus, Rgb } from '../protocol/status';
import { ArgumentError, formatArgValue } from './argumentError';

/**
 * Whether the `onoff` options of a device already have `setOnDim: false`. `read` returns the stored options; a capability
 * without options may make Homey return nothing or throw, which both count as "not set".
 */
export function onoffSetOnDimDisabled(read: () => unknown): boolean {
  try {
    const options = read();
    return typeof options === 'object' && options !== null && (options as { setOnDim?: unknown }).setOnDim === false;
  } catch {
    return false;
  }
}

const unit = (name: 'hue' | 'saturation', value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    const message = `${name} must be a number between 0 and 1, got ${String(value)}`;
    const params = { value: formatArgValue(value) };
    if (typeof value !== 'number' || Number.isNaN(value))
      throw new ArgumentError(message, 'invalid_number', name, params);
    throw new ArgumentError(message, 'invalid_range', name, { ...params, min: 0, max: 1 });
  }
  return value;
};

/** Homey `light_hue` and `light_saturation` (both 0..1) to the device RGB (HSV with value 1; the brightness is `dim`'s). Throws `ArgumentError` (a `RangeError`) outside 0..1. */
export function hueSatToRgb(hue: number, saturation: number): Rgb {
  const h = unit('hue', hue);
  const s = unit('saturation', saturation);
  const sector = (h * 6) % 6; // hue 1 is the same colour as hue 0
  const i = Math.floor(sector);
  const f = sector - i;
  const p = 1 - s;
  const q = 1 - f * s;
  const t = 1 - (1 - f) * s;
  const [r, g, b] = [
    [1, t, p],
    [q, 1, p],
    [p, 1, t],
    [p, q, 1],
    [t, p, 1],
    [1, p, q],
  ][i];
  const byte = (v: number): number => Math.round(v * 255);
  return { r: byte(r), g: byte(g), b: byte(b) };
}

/** The device RGB as Homey hue and saturation (0..1); null for black (no hue to show). The value is dropped (the tile's brightness is `dim`). */
export function rgbToHueSat(color: Rgb): { hue: number; saturation: number } | null {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  if (max === 0) return null;
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === color.r) hue = ((color.g - color.b) / d + 6) % 6;
    else if (max === color.g) hue = (color.b - color.r) / d + 2;
    else hue = (color.r - color.g) / d + 4;
    hue /= 6;
  }
  return { hue, saturation: d / max };
}

/**
 * `45 01 RR GG BB BB 00 00 00 00 00`: the power-off command (VERIFIED, protocol section 3). It carries the colour the app
 * knows (`color`, e.g. one whose confirm timed out), else the status colour as it is, else white, and the known brightness (else the status brightness, else 100, clamped to
 * 0..100) so that it changes neither, effect 0, power byte `00`.
 */
export function powerOffCommand(
  status: DeviceStatus | null,
  brightness: number | null,
  color: Rgb | null = null,
): Uint8Array {
  const raw = brightness ?? status?.brightness ?? 100;
  return setLighting({
    color: color ?? status?.lightingColor ?? { r: 255, g: 255, b: 255 },
    brightness: Math.min(100, Math.max(0, Math.round(raw))),
    effect: 0,
    on: false,
  });
}
