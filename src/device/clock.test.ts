import { describe, expect, it } from 'vitest';
import { CLOCK_STYLES, setClock } from '../protocol/commands';
import { toHex } from '../protocol/hex';
import {
  CLOCK_HOUR24,
  CLOCK_SETTING_KEYS,
  CLOCK_STYLE_IDS,
  clockStyleId,
  formatHexColor,
  parseClockStyleId,
  parseHexColor,
  DEFAULT_CLOCK_COLOR,
  DEFAULT_CLOCK_FACE,
  DEFAULT_CLOCK_SETTINGS,
  resolveClockSettings,
  resolveStoredClockColor,
  resolveStoredShownStyle,
} from './clock';

describe('clock style ids', () => {
  it('maps every offered style id to its device style number and back', () => {
    expect(CLOCK_STYLE_IDS.map(parseClockStyleId)).toEqual([...CLOCK_STYLES]);
    for (const style of CLOCK_STYLES) expect(parseClockStyleId(clockStyleId(style))).toBe(style);
  });

  it.each([7, 9, -1, 1.5, NaN])('has no id for style %s', (style) => {
    expect(clockStyleId(style)).toBeNull();
  });

  it.each(['', 'Boxed', 'style', 2, null, undefined, {}])('rejects style id %s', (bad) => {
    expect(() => parseClockStyleId(bad)).toThrow(RangeError);
  });
});

describe('hex colours', () => {
  it.each([
    ['#FF8000', { r: 255, g: 128, b: 0 }],
    ['ff8000', { r: 255, g: 128, b: 0 }],
    ['  #00ffFF ', { r: 0, g: 255, b: 255 }],
    ['#000000', { r: 0, g: 0, b: 0 }],
  ])('parses %j', (text, color) => {
    expect(parseHexColor(text)).toEqual(color);
  });

  it.each(['', '#FFF', '#GG0000', 'red', '#FF80001', '##FF8000', 255, null, undefined])('rejects %j', (bad) => {
    expect(() => parseHexColor(bad)).toThrow(RangeError);
  });

  it('formats upper case #RRGGBB and round-trips', () => {
    expect(formatHexColor({ r: 0, g: 10, b: 255 })).toBe('#000AFF');
    expect(parseHexColor(formatHexColor({ r: 1, g: 2, b: 3 }))).toEqual({ r: 1, g: 2, b: 3 });
  });
});

describe('resolveClockSettings', () => {
  it('gives the default settings for missing values', () => {
    expect(resolveClockSettings({})).toEqual({ settings: DEFAULT_CLOCK_SETTINGS, invalid: [] });
  });

  it('reads every setting', () => {
    const { settings, invalid } = resolveClockSettings({
      clock_style: 'boxed',
      clock_weather: true,
      clock_temperature: true,
      clock_calendar: true,
      clock_animations: true,
    });
    expect(invalid).toEqual([]);
    expect(settings).toEqual({ style: 2, weather: true, temperature: true, calendar: true, animations: true });
    expect(toHex(setClock({ ...settings, hour24: CLOCK_HOUR24, color: { r: 0, g: 255, b: 0 } }))).toBe(
      '45 00 01 02 01 01 01 01 00 ff 00',
    );
  });

  it('K1: ignores a legacy clock_color (valid or not)', () => {
    expect(resolveClockSettings({ clock_color: '#00ff00' })).toEqual({ settings: DEFAULT_CLOCK_SETTINGS, invalid: [] });
    expect(resolveClockSettings({ clock_color: 'red' })).toEqual({ settings: DEFAULT_CLOCK_SETTINGS, invalid: [] });
    expect(Object.keys(resolveClockSettings({ clock_color: '#00ff00' }).settings)).not.toContain('color');
  });

  it('ignores a legacy clock_24h (valid or not): no entry, no invalid key', () => {
    for (const legacy of [false, true, 'yes']) {
      const r = resolveClockSettings({ clock_24h: legacy });
      expect(r).toEqual({ settings: DEFAULT_CLOCK_SETTINGS, invalid: [] });
      expect(Object.keys(r.settings)).not.toContain('hour24');
    }
  });

  it('the default clock face is 24 h (HH 01)', () => {
    expect(CLOCK_HOUR24).toBe(true);
    expect(DEFAULT_CLOCK_FACE.hour24).toBe(true);
    expect(toHex(setClock(DEFAULT_CLOCK_FACE)).startsWith('45 00 01')).toBe(true);
  });

  it('animation pages: off by default (missing or null), a boolean is taken, anything else falls back and is listed (#106)', () => {
    expect(DEFAULT_CLOCK_SETTINGS.animations).toBe(false);
    expect(resolveClockSettings({ clock_animations: null }).settings.animations).toBe(false);
    expect(resolveClockSettings({ clock_animations: true })).toEqual({
      settings: { ...DEFAULT_CLOCK_SETTINGS, animations: true },
      invalid: [],
    });
    expect(resolveClockSettings({ clock_animations: false }).settings.animations).toBe(false);
    for (const bad of ['yes', 1, 0, {}]) {
      expect(resolveClockSettings({ clock_animations: bad })).toEqual({
        settings: DEFAULT_CLOCK_SETTINGS,
        invalid: ['clock_animations'],
      });
    }
    expect(CLOCK_SETTING_KEYS).toContain('clock_animations');
  });

  it('the animation flag is not part of the 45 00 frame', () => {
    const base = { ...DEFAULT_CLOCK_FACE };
    expect(toHex(setClock({ ...base, animations: true }))).toBe(toHex(setClock({ ...base, animations: false })));
  });

  it('falls back per invalid key and lists it', () => {
    const { settings, invalid } = resolveClockSettings({
      clock_style: 'sideways',
      clock_weather: true,
      clock_calendar: 'x',
    });
    expect(invalid).toEqual(['clock_style', 'clock_calendar']);
    expect(settings).toEqual({ ...DEFAULT_CLOCK_SETTINGS, weather: true });
  });
});

describe('resolveStoredClockColor (K2)', () => {
  const GREEN = { r: 0, g: 255, b: 0 };
  const RED = { r: 255, g: 0, b: 0 };

  it.each([
    ['store and setting', '#00FF00', '#FF0000', GREEN, 'store'],
    ['store only', '#00FF00', undefined, GREEN, 'store'],
    ['setting only', undefined, '#FF0000', RED, 'setting'],
    ['setting with a null store', null, '#FF0000', RED, 'setting'],
    ['neither', undefined, undefined, DEFAULT_CLOCK_COLOR, 'default'],
    ['invalid store, valid setting', 'green', '#FF0000', RED, 'setting'],
    ['invalid store, no setting', 'green', undefined, DEFAULT_CLOCK_COLOR, 'default'],
    ['valid store, invalid setting', '#00FF00', 'red', GREEN, 'store'],
    ['invalid setting only', undefined, 'red', DEFAULT_CLOCK_COLOR, 'default'],
    ['both invalid', 5, {}, DEFAULT_CLOCK_COLOR, 'default'],
  ])('%s', (_name, stored, legacy, color, source) => {
    expect(resolveStoredClockColor(stored, legacy)).toEqual({ color, source });
  });
});

describe('resolveStoredShownStyle (#85)', () => {
  it.each([
    ['full_screen', 0],
    ['boxed', 2],
    ['small', 6],
  ])('the style id %s is device style %i', (id, style) => {
    expect(resolveStoredShownStyle(id)).toEqual({ style, invalid: false });
  });

  it.each([[undefined], [null]])('%s is no style, silently', (raw) => {
    expect(resolveStoredShownStyle(raw)).toEqual({ style: null, invalid: false });
  });

  it.each([['digital'], [2], [''], [{}], [true]])('%j is no style and flagged invalid', (raw) => {
    expect(resolveStoredShownStyle(raw)).toEqual({ style: null, invalid: true });
  });
});
