// Mode model of the `timebox_channel` capability (docs/architecture.md, "Channel picker"): stable ids, the device
// codes of `46` d0 and the command that switches to a mode. Pure, no Homey and no link.
import { ArgumentError, formatArgValue } from './argumentError';
import type { ArgumentField } from './argumentError';
import { setChannel, setClock, setLighting, startNoiseMeter } from '../protocol/commands';
import type { DeviceStatus, Rgb } from '../protocol/status';
import type { ClockFace } from './clock';

/** The enum values of the capability (stable ids, never translated). */
export const CHANNEL_IDS = ['clock', 'lighting', 'custom', 'noise_meter'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

/** A mode with a device code in `46` d0. The noise meter has none: the device reports no known code under it. */
export type CodedChannelId = Exclude<ChannelId, 'noise_meter'>;

/** Device codes of the modes (`45 NN`, `46` d0). */
const CODES: Record<CodedChannelId, number> = {
  clock: 0x00,
  lighting: 0x01,
  custom: 0x05,
};

export function channelCode(id: CodedChannelId): number {
  return CODES[id];
}

/** The mode of a `46` d0 code, or null for a code that is not one of the three coded modes (cloud, visualizer, text, games, alarms, ...). Never the noise meter. */
export function channelFromCode(code: number): CodedChannelId | null {
  const coded = Object.keys(CODES) as CodedChannelId[];
  return coded.find((id) => CODES[id] === code) ?? null;
}

/** The name of a mode that the device can show but the app does not offer: `02` cloud, `04` visualizer; null for any other code. */
export function otherModeName(code: number): 'cloud' | 'visualizer' | null {
  if (code === 0x02) return 'cloud';
  if (code === 0x04) return 'visualizer';
  return null;
}

/** Validate a channel id coming from a capability value or a Flow card. Throws `ArgumentError` (a `RangeError`) for anything else. */
export function parseChannelId(value: unknown): ChannelId {
  const id = CHANNEL_IDS.find((candidate) => candidate === value);
  if (!id) {
    throw new ArgumentError(
      `channel must be one of ${CHANNEL_IDS.join(', ')}, got ${String(value)}`,
      'invalid_choice',
      'channel',
      { value: formatArgValue(value), allowed: CHANNEL_IDS.join(', ') },
    );
  }
  return id;
}

/** The ids of the Flow dropdown "Show custom page" (1-based; the device page is the id minus 1, 0..2). */
export const CUSTOM_PAGE_IDS = ['1', '2', '3'] as const;

function parseOneBased(what: string, field: ArgumentField, ids: readonly string[], value: unknown): number {
  const at = typeof value === 'string' ? ids.indexOf(value) : -1;
  if (at < 0) {
    throw new ArgumentError(`${what} must be one of ${ids.join(', ')}, got ${String(value)}`, 'invalid_choice', field, {
      value: formatArgValue(value),
      allowed: ids.join(', '),
    });
  }
  return at;
}

/** Validate a custom page id of a Flow card and return the device page 0..2. Throws `ArgumentError` (a `RangeError`) for anything else. */
export function parseCustomPageId(value: unknown): number {
  return parseOneBased('custom page', 'page', CUSTOM_PAGE_IDS, value);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** A colour that replaces the stored lighting colour (the Flow action "Set lighting" and the tile colour; #26, #69). */
export interface LightingOverride {
  color: Rgb;
}

/** Values that replace what `channelCommand` takes from the stored state; each applies to one channel only. */
export interface ChannelOverride {
  /** Lighting channel: the colour (the Flow action "Set lighting"; #26). */
  lighting?: LightingOverride;
}

/**
 * The payload that switches to `id`, built from the last known `46` status (null if none yet):
 * - lighting: the stored colour (d3..d5, black becomes white so the switch is visible) with the known brightness (so
 *   `dim` does not jump; falls back to the status brightness, then 100), effect 0, power on (`45 01 RRGGBB BB 00 01 000000`);
 *   an `lighting` override replaces the colour (as given; #26);
 * - clock: the full form `45 00 HH TT 01 WW EE CC RR GG BB` built from `clock` (the clock face; #25);
 * - custom: `45 05` (the custom page is a second command, see `setCustomPage`);
 * - noise_meter: `72 02 01`.
 */
export function channelCommand(
  id: ChannelId,
  status: DeviceStatus | null,
  brightness: number | null,
  clock: ClockFace,
  override?: ChannelOverride,
): Uint8Array {
  const lighting = override?.lighting;
  switch (id) {
    case 'lighting': {
      const stored = status?.lightingColor;
      const color = lighting?.color ?? (stored && (stored.r > 0 || stored.g > 0 || stored.b > 0) ? stored : WHITE);
      const raw = brightness ?? status?.brightness ?? 100;
      return setLighting({
        color,
        brightness: Math.min(100, Math.max(0, Math.round(raw))),
        effect: 0,
        on: true,
      });
    }
    case 'clock':
      return setClock(clock);
    case 'noise_meter':
      return startNoiseMeter();
    default:
      return setChannel(CODES[id]);
  }
}
