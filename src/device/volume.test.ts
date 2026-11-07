import { describe, expect, it } from 'vitest';
import { ArgumentError } from './argumentError';
import { DEFAULT_UNMUTE_LEVEL, levelToVolume, restoreLevel, volumeToLevel } from './volume';

describe('volumeToLevel', () => {
  it.each([
    [0, 0],
    [1, 15],
    [0.5, 8],
    [0.2, 3],
    [0.33, 5],
    [0.07, 1],
    [1 / 15, 1],
  ])('maps %s to %i', (volume, level) => {
    expect(volumeToLevel(volume)).toBe(level);
  });

  it('round-trips every device level', () => {
    for (let level = 0; level <= 15; level++) expect(volumeToLevel(levelToVolume(level))).toBe(level);
  });

  it.each([-0.01, 1.01, 2, -1, Infinity, -Infinity])('rejects %s as out of range', (v) => {
    const e = (() => {
      try {
        volumeToLevel(v);
      } catch (err) {
        return err;
      }
    })();
    expect(e).toBeInstanceOf(ArgumentError);
    expect(e).toBeInstanceOf(RangeError);
    expect((e as ArgumentError).kind).toBe('invalid_range');
    expect((e as ArgumentError).field).toBe('volume');
  });

  it.each([NaN, '0.5' as unknown as number, undefined as unknown as number, null as unknown as number])(
    'rejects %s as not a number',
    (v) => {
      expect(() => volumeToLevel(v)).toThrow(ArgumentError);
      try {
        volumeToLevel(v);
      } catch (err) {
        expect((err as ArgumentError).kind).toBe('invalid_number');
      }
    },
  );
});

describe('levelToVolume', () => {
  it('maps 0 to 0, 15 to 1 and 8 to 8/15', () => {
    expect(levelToVolume(0)).toBe(0);
    expect(levelToVolume(15)).toBe(1);
    expect(levelToVolume(8)).toBeCloseTo(0.5333, 4);
  });
});

describe('restoreLevel', () => {
  it('returns a stored level 1..15', () => {
    for (let level = 1; level <= 15; level++) expect(restoreLevel(level)).toBe(level);
  });

  it.each([undefined, null, 0, 16, -1, 2.5, '5', NaN])('falls back to 8 for %s', (stored) => {
    expect(restoreLevel(stored)).toBe(DEFAULT_UNMUTE_LEVEL);
    expect(DEFAULT_UNMUTE_LEVEL).toBe(8);
  });
});
