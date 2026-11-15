import { describe, expect, it } from 'vitest';
import { ArgumentError } from './argumentError';
import {
  formatSleepLight,
  parseSleepLightArgs,
  parseSleepSoundId,
  SLEEP_SOUND_IDS,
  sleepLightCommand,
} from './sleepLight';
import { toHex } from '../protocol/hex';

const valid = { color: '#FF0000', brightness: 50, minutes: 5, sound: 'phone', volume: 10 };

function thrown(fn: () => unknown): ArgumentError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ArgumentError);
    return e as ArgumentError;
  }
  throw new Error('did not throw');
}

describe('sleep light sounds (#6)', () => {
  it('offers phone audio and sounds 1..23, in code order', () => {
    expect(SLEEP_SOUND_IDS).toHaveLength(24);
    expect(SLEEP_SOUND_IDS[0]).toBe('phone');
    expect(SLEEP_SOUND_IDS[1]).toBe('sound_1');
    expect(SLEEP_SOUND_IDS[23]).toBe('sound_23');
  });

  it('maps every id to its code', () => {
    SLEEP_SOUND_IDS.forEach((id, code) => expect(parseSleepSoundId(id)).toBe(code));
  });

  it.each(['sound_0', 'sound_24', 'Phone', '', 'toString', 1, null, undefined])('rejects %j', (value) => {
    const e = thrown(() => parseSleepSoundId(value));
    expect(e.kind).toBe('invalid_choice');
    expect(e.field).toBe('sound');
  });
});

describe('parseSleepLightArgs (#6)', () => {
  it('returns the validated sleep light', () => {
    expect(parseSleepLightArgs(valid)).toEqual({
      color: { r: 0xff, g: 0, b: 0 },
      brightness: 50,
      minutes: 5,
      sound: 0,
      volume: 10,
    });
  });

  it('accepts the limits and rounds decimals', () => {
    expect(parseSleepLightArgs({ ...valid, brightness: 1, minutes: 1, volume: 1, sound: 'sound_23' })).toMatchObject({
      brightness: 1,
      minutes: 1,
      volume: 1,
      sound: 23,
    });
    expect(parseSleepLightArgs({ ...valid, brightness: 100, minutes: 240, volume: 100 })).toMatchObject({
      brightness: 100,
      minutes: 240,
      volume: 100,
    });
    expect(parseSleepLightArgs({ ...valid, minutes: 4.6, brightness: 0.6 })).toMatchObject({
      minutes: 5,
      brightness: 1,
    });
  });

  it.each([
    ['minutes', 0, 1, 240],
    ['minutes', 241, 1, 240],
    ['brightness', 0, 1, 100],
    ['brightness', 101, 1, 100],
    ['volume', 0, 1, 100],
    ['volume', 100.6, 1, 100],
  ] as const)('rejects %s %s as out of range %s..%s', (field, value, min, max) => {
    const e = thrown(() => parseSleepLightArgs({ ...valid, [field]: value }));
    expect([e.kind, e.field, e.params]).toEqual(['invalid_range', field, { value: String(value), min, max }]);
  });

  it.each([
    ['minutes', '5'],
    ['brightness', NaN],
    ['volume', Infinity],
    ['minutes', undefined],
  ] as const)('rejects %s %j as not a number', (field, value) => {
    const e = thrown(() => parseSleepLightArgs({ ...valid, [field]: value }));
    expect([e.kind, e.field]).toEqual(['invalid_number', field]);
  });

  it('rejects a colour that is not a hex colour', () => {
    const e = thrown(() => parseSleepLightArgs({ ...valid, color: 'red' }));
    expect([e.kind, e.field]).toEqual(['invalid_color', 'color']);
  });
});

describe('sleepLightCommand and formatSleepLight (#6)', () => {
  it('builds the 40 payload with on ff and FM 00 00', () => {
    expect(toHex(sleepLightCommand(parseSleepLightArgs(valid)))).toBe('40 05 00 ff 00 00 0a ff 00 00 32');
    expect(toHex(sleepLightCommand(parseSleepLightArgs({ ...valid, sound: 'sound_7', volume: 100 })))).toBe(
      '40 05 07 ff 00 00 64 ff 00 00 32',
    );
  });

  it('words the sleep light for the log', () => {
    expect(formatSleepLight(parseSleepLightArgs(valid))).toBe('5 min, #FF0000, brightness 50, phone audio, volume 10');
    expect(formatSleepLight(parseSleepLightArgs({ ...valid, sound: 'sound_3' }))).toContain('sound 3');
  });
});
