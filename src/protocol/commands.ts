// Builders for VERIFIED command payloads (docs/divoom-protocol.md section 5). Each returns the payload (opcode + args);
// wrap it with `envelope()` for BLE. Arguments are validated first and a `RangeError` is thrown before anything is
// built, because the Evo has no NAK and executes malformed commands (section 2).
import type { Rgb } from './status';
import { intInRange, le16, oneOf, rgb } from './validate';

/** Channels selectable with the minimal `45 NN` form: clock, cloud, custom, scoreboard. */
export const SIMPLE_CHANNELS = [0x00, 0x02, 0x05, 0x06] as const;
export type SimpleChannel = (typeof SIMPLE_CHANNELS)[number];

/** Lighting effects `TT` of `45 01` (VERIFIED, protocol section 5.1): 0 plain colour, 1 love, 2 plants, 3 no-mosquito, 4 sleeping. */
export const LIGHTING_EFFECTS = [0, 1, 2, 3, 4] as const;
/** Highest custom page index of `bd 17 PP` (VERIFIED, protocol section 5.4: the Evo has three custom pages 0..2). */
export const MAX_CUSTOM_PAGE = 2;

/** `74 BB`: brightness 0..100 (VERIFIED). */
export function setBrightness(percent: number): Uint8Array {
  return Uint8Array.of(0x74, intInRange('brightness', percent, 0, 100));
}

/** `46`: status query (VERIFIED), answered with a `46 55 …` frame (see `decodeStatus`). */
export function queryStatus(): Uint8Array {
  return Uint8Array.of(0x46);
}

/**
 * `45 NN`: switch to the clock (`00`), cloud (`02`), custom (`05`) or scoreboard (`06`) channel (VERIFIED). Lighting
 * (`01`) and visualization (`04`) need further arguments and `03` does nothing on the Evo, so they are rejected here.
 */
export function setChannel(channel: number): Uint8Array {
  return Uint8Array.of(0x45, oneOf('channel', channel, SIMPLE_CHANNELS));
}

export interface Lighting {
  color: Rgb;
  /** The brightness byte of `45 01`, 0..100. */
  brightness: number;
  /** One of `LIGHTING_EFFECTS` (0 = plain colour). */
  effect: number;
  /** `false` sends power byte `00`, which turns the panel off. */
  on: boolean;
}

/**
 * `45 01 RR GG BB BB TT PP 00 00 00`: switch to the lighting channel with colour, brightness, effect and power
 * (VERIFIED, protocol section 5.1). The short form `45 01 RR GG BB` is never built: it applies a random brightness.
 */
export function setLighting(o: Lighting): Uint8Array {
  const [r, g, b] = rgb('color', o.color.r, o.color.g, o.color.b);
  const brightness = intInRange('brightness', o.brightness, 0, 100);
  const effect = oneOf('effect', o.effect, LIGHTING_EFFECTS);
  if (typeof o.on !== 'boolean') throw new RangeError(`on must be a boolean, got ${String(o.on)}`);
  return Uint8Array.of(0x45, 0x01, r, g, b, brightness, effect, o.on ? 0x01 : 0x00, 0x00, 0x00, 0x00);
}

/**
 * Clock styles `TT` of `45 00` (VERIFIED, protocol section 5.1): 0 full screen, 1 rainbow, 2 boxed, 3 analog square,
 * 4 full screen negative, 5 analog round, 6 small single-line digits. 7..9 look identical to 6 and are not offered.
 */
export const CLOCK_STYLES = [0, 1, 2, 3, 4, 5, 6] as const;

export interface ClockOptions {
  /** `true` = 24 h (`HH` = `01`), `false` = 12 h (`00`). Known issue: `HH` has no visible effect on the Evo (protocol section 5.1). */
  hour24: boolean;
  /** One of `CLOCK_STYLES`. */
  style: number;
  /** Add the weather page to the rotation. */
  weather: boolean;
  /** Add the temperature page to the rotation. */
  temperature: boolean;
  /** Add the calendar page to the rotation. */
  calendar: boolean;
  color: Rgb;
}

/**
 * `45 00 HH TT 01 WW EE CC RR GG BB`: switch to the clock channel with 12/24 h, style, page flags and colour
 * (VERIFIED, protocol section 5.1). The byte after the style is fixed `01`. The flag bytes WW weather, EE temperature,
 * CC calendar are confirmed on hardware (2026-10-06, #25) and defined in this one place (the `flags` line). The flags
 * only add pages: with all off the clock still rotates through animation pages unless `setHot(false)` was sent (the
 * fixed `01` byte has no effect on them, #106).
 */
export function setClock(o: ClockOptions): Uint8Array {
  const style = oneOf('style', o.style, CLOCK_STYLES);
  const [r, g, b] = rgb('color', o.color.r, o.color.g, o.color.b);
  const flag = (name: string, value: boolean): number => {
    if (typeof value !== 'boolean') throw new RangeError(`${name} must be a boolean, got ${String(value)}`);
    return value ? 0x01 : 0x00;
  };
  const hour24 = flag('hour24', o.hour24);
  const flags = [flag('weather', o.weather), flag('temperature', o.temperature), flag('calendar', o.calendar)];
  return Uint8Array.of(0x45, 0x00, hour24, style, 0x01, ...flags, r, g, b);
}

/**
 * `26 0X`: set the "hot" flag (VERIFIED, protocol section 5.1, #106): `26 01` lets the clock rotate through animation pages
 * (the factory state), `26 00` shows only the time and the pages of the `45 00` flags. A persistent device setting; the
 * device sends no reply to the set (read it with `26 ff`). Changes nothing visible in lighting or while the panel is off.
 * `ff` is the read form and never built here.
 */
export function setHot(on: boolean): Uint8Array {
  if (typeof on !== 'boolean') throw new RangeError(`on must be a boolean, got ${String(on)}`);
  return Uint8Array.of(0x26, on ? 0x01 : 0x00);
}

/**
 * `bd 17 PP`: select custom page PP, 0..2, while the custom channel is active (VERIFIED, protocol section 5.4). Send
 * `45 05` first; the device has no documented reply. `PP = ff` is the read form (`queryCustomPage`) and is never
 * accepted here, nor are 3..254.
 */
export function setCustomPage(page: number): Uint8Array {
  return Uint8Array.of(0xbd, 0x17, intInRange('custom page', page, 0, MAX_CUSTOM_PAGE));
}

/** `bd 17 ff`: read the current custom page (VERIFIED), answered with `bd 55 17 PP` (see `decodeCustomPage`). */
export function queryCustomPage(): Uint8Array {
  return Uint8Array.of(0xbd, 0x17, 0xff);
}

export interface DateTimeParts {
  /** 2000..2099 */
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31, must exist in the given month and year */
  day: number;
  /** 0..23 */
  hour: number;
  /** 0..59 */
  minute: number;
  /** 0..59 */
  second: number;
}

/**
 * `18 YL YH MO DD hh mm ss WD`: set the device date and time (VERIFIED, **changes the device clock**). The year is sent
 * as `YL = year % 100`, `YH = floor(year / 100)`; the weekday (0 = Sunday, computed from the date independent of the host time zone) is appended. The date must exist
 * (no 31 April, no 29 February in a non-leap year).
 */
export function setDateTime(parts: DateTimeParts): Uint8Array {
  const year = intInRange('year', parts.year, 2000, 2099);
  const month = intInRange('month', parts.month, 1, 12);
  const day = intInRange('day', parts.day, 1, 31);
  const hour = intInRange('hour', parts.hour, 0, 23);
  const minute = intInRange('minute', parts.minute, 0, 59);
  const second = intInRange('second', parts.second, 0, 59);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== day) {
    throw new RangeError(`day ${day} does not exist in ${year}-${String(month).padStart(2, '0')}`);
  }
  return Uint8Array.of(0x18, year % 100, Math.floor(year / 100), month, day, hour, minute, second, date.getUTCDay());
}

/**
 * Most UTF-16 code units the Evo shows of a native text (VERIFIED, protocol section 5.5, #28): longer text is accepted
 * but silently cut to the first 64 units, so the builder rejects it.
 */
export const MAX_TEXT_UNITS = 64;
/** Native text speed `SP` of `86 00 SP`: about SP columns per second (measured at 1, 2, 3, 4, 5, 10, 20 and 50; 1..50 accepted, protocol section 5.5). */
export const TEXT_SPEED_RANGE = { min: 1, max: 50 } as const;

export interface NativeText {
  /** 1..`MAX_TEXT_UNITS` UTF-16 code units, no lone surrogates. A surrogate pair counts as two units. */
  text: string;
  color: Rgb;
  background: Rgb;
  /** `TEXT_SPEED_RANGE.min`..`max`. */
  speed: number;
}

/** UTF-16LE bytes of `text`, throws `RangeError` for a lone surrogate (it would send invalid UTF-16 to the device). */
function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const high = unit >= 0xd800 && unit <= 0xdbff;
    const low = unit >= 0xdc00 && unit <= 0xdfff;
    if (high && !(i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff)) {
      throw new RangeError(`text has a lone high surrogate at unit ${i}`);
    }
    if (low && !(i > 0 && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff)) {
      throw new RangeError(`text has a lone low surrogate at unit ${i}`);
    }
    out[i * 2] = unit & 0xff;
    out[i * 2 + 1] = unit >> 8;
  }
  return out;
}

/** Frame `index` of the native text upload `6c`: `aa LLLL 3c 00 II 00` + data, LLLL = length of the whole frame. */
function textUpload(index: 0 | 1, frame: Uint8Array): Uint8Array {
  const [lo, hi] = le16('frame length', frame.length);
  const out = new Uint8Array(5 + frame.length);
  out.set([0x6c, index, 0x00, lo, hi]);
  out.set(frame, 5);
  return out;
}

/**
 * Native scrolling text (VERIFIED, protocol section 5.5): returns the five payloads that must be sent in this order
 * (one envelope each): `6e 01`, `86 01 LL text`, `86 00 SP`, `6c 00 00 LLLL frame0`, `6c 01 00 LLLL frame1`. The device
 * renders and scrolls the text itself and loops it until `stopNativeText`, a channel command or another text. frame0
 * carries a 256-colour palette (127 x background, 127 x text colour, 2 x background; glyph pixels use index + 127).
 */
export function nativeText(o: NativeText): Uint8Array[] {
  const units = o.text.length;
  if (units < 1 || units > MAX_TEXT_UNITS) {
    throw new RangeError(`text must be 1..${MAX_TEXT_UNITS} UTF-16 code units, got ${units}`);
  }
  const bytes = utf16le(o.text);
  const speed = intInRange('speed', o.speed, TEXT_SPEED_RANGE.min, TEXT_SPEED_RANGE.max);
  const fg = rgb('color', o.color.r, o.color.g, o.color.b);
  const bg = rgb('background', o.background.r, o.background.g, o.background.b);

  const frame0 = new Uint8Array(7 + 768 + 256);
  frame0.set([0xaa, 0x07, 0x04, 0x3c, 0x00, 0x00, 0x00]);
  for (let i = 0; i < 256; i++) frame0.set(i >= 127 && i < 254 ? fg : bg, 7 + i * 3);
  const frame1 = new Uint8Array(7 + 256);
  frame1.set([0xaa, 0x07, 0x01, 0x3c, 0x00, 0x01, 0x00]);

  return [
    Uint8Array.of(0x6e, 0x01),
    Uint8Array.of(0x86, 0x01, units, ...bytes),
    Uint8Array.of(0x86, 0x00, speed),
    textUpload(0, frame0),
    textUpload(1, frame1),
  ];
}

/** `6e 00`: stop the native text; the previous channel returns (VERIFIED). Harmless when no text runs. */
export function stopNativeText(): Uint8Array {
  return Uint8Array.of(0x6e, 0x00);
}

/** Pixels of the 16x16 panel. */
export const IMAGE_PIXELS = 256;
/** Most palette entries of a static image `44` (VERIFIED, protocol section 4: `NN` 256 is encoded as `00`). */
export const IMAGE_MAX_COLOURS = 256;

export interface StaticImage {
  /** 1..`IMAGE_MAX_COLOURS` colours. */
  palette: readonly Rgb[];
  /** `IMAGE_PIXELS` palette indices, row-major, top-left first. */
  pixels: ArrayLike<number>;
}

/**
 * `44 00 0a 0a 04 aa LLLL 00 00 00 NN palette pixels`: static 16x16 image (VERIFIED, protocol section 4). `NN` is the
 * palette size (256 is sent as `00`), each pixel is a palette index of max(1, ceil(log2 NN)) bits packed LSB-first,
 * `LLLL` counts the bytes from `aa` to the end. A palette of 256 entries gives the fixed 1036-byte payload (8 bpp).
 */
export function staticImage(o: StaticImage): Uint8Array {
  const count = o.palette.length;
  if (!Number.isInteger(count) || count < 1 || count > IMAGE_MAX_COLOURS) {
    throw new RangeError(`palette must have 1..${IMAGE_MAX_COLOURS} colours, got ${count}`);
  }
  if (o.pixels.length !== IMAGE_PIXELS) {
    throw new RangeError(`image must have ${IMAGE_PIXELS} pixels, got ${o.pixels.length}`);
  }
  const bits = Math.max(1, Math.ceil(Math.log2(count)));
  const pixelBytes = (IMAGE_PIXELS * bits) / 8;
  const length = 3 + 3 + 1 + count * 3 + pixelBytes;
  const [lo, hi] = le16('image length', length);
  const out = new Uint8Array(5 + length);
  out.set([0x44, 0x00, 0x0a, 0x0a, 0x04, 0xaa, lo, hi, 0x00, 0x00, 0x00, count === IMAGE_MAX_COLOURS ? 0 : count]);
  let at = 12;
  o.palette.forEach((c, i) => {
    out.set(rgb(`palette[${i}]`, c.r, c.g, c.b), at);
    at += 3;
  });
  let acc = 0;
  let filled = 0;
  for (let i = 0; i < IMAGE_PIXELS; i++) {
    const index = intInRange(`pixels[${i}]`, o.pixels[i], 0, count - 1);
    acc |= index << filled;
    filled += bits;
    while (filled >= 8) {
      out[at++] = acc & 0xff;
      acc >>= 8;
      filled -= 8;
    }
  }
  return out;
}

/** Weather types `WW` of `5f TT WW` (VERIFIED, protocol section 5.1 / #30): 1 clear, 3 cloudy, 5 thunderstorm, 6 rain, 8 snow, 9 fog. */
export const WEATHER_TYPES = [1, 3, 5, 6, 8, 9] as const;

export interface WeatherPayload {
  /** Whole degrees Celsius, -128..127 (sent as one two's-complement byte). */
  temperature: number;
  /** One of `WEATHER_TYPES`. */
  type: number;
}

/**
 * `5f TT WW`: set the weather shown on the clock weather and temperature pages (protocol section 5.1). `TT` is the
 * temperature in whole degrees Celsius as a signed byte, `WW` one of `WEATHER_TYPES`. The device keeps the value until
 * it is replaced; the pages are enabled with the flags of `setClock`.
 */
export function setWeather(o: WeatherPayload): Uint8Array {
  const temperature = intInRange('temperature', o.temperature, -128, 127);
  const type = oneOf('type', o.type, WEATHER_TYPES);
  return Uint8Array.of(0x5f, temperature & 0xff, type);
}

/** Highest minutes value of the countdown: 99:59 counts down correctly, 100 is clamped to 99:59 (protocol section 5.6). */
export const COUNTDOWN_MAX_MINUTES = 99;

export interface CountdownTime {
  /** 0..`COUNTDOWN_MAX_MINUTES` */
  minutes: number;
  /** 0..59 */
  seconds: number;
}

/**
 * `72 02 01`: start the noise meter (dB) mode (VERIFIED, reply `72 55 02`). It is not a `45` channel: any other mode
 * command, a power off or a mode change on the device ends it.
 */
export function startNoiseMeter(): Uint8Array {
  return Uint8Array.of(0x72, 0x02, 0x01);
}

/**
 * `72 03 01 MM SS`: start the countdown overlay (VERIFIED, protocol section 5.6). It is not a channel and replaces a
 * running one or a native text. 0:00 is rejected: the device would end it at once. The device accepts any bytes, so
 * both values are checked first.
 */
export function startCountdown(o: CountdownTime): Uint8Array {
  const minutes = intInRange('minutes', o.minutes, 0, COUNTDOWN_MAX_MINUTES);
  const seconds = intInRange('seconds', o.seconds, 0, 59);
  if (minutes === 0 && seconds === 0) throw new RangeError('countdown must be at least 1 second');
  return Uint8Array.of(0x72, 0x03, 0x01, minutes, seconds);
}

/** `72 03 00 00 00`: stop the countdown (VERIFIED). Only effective while the countdown is on screen (section 5.6). */
export function stopCountdown(): Uint8Array {
  return Uint8Array.of(0x72, 0x03, 0x00, 0x00, 0x00);
}
