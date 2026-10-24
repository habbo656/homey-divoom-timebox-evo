import { describe, expect, it } from 'vitest';
import { intInRange, le16, oneOf, rgb, u8 } from './validate';

describe('intInRange', () => {
  it('accepts the bounds and values between', () => {
    expect(intInRange('x', 0, 0, 100)).toBe(0);
    expect(intInRange('x', 100, 0, 100)).toBe(100);
    expect(intInRange('x', 42, 0, 100)).toBe(42);
  });

  it.each([-1, 101, 1.5, NaN, Infinity, -Infinity])('rejects %s', (v) => {
    expect(() => intInRange('x', v, 0, 100)).toThrow(RangeError);
  });

  it('rejects non-numbers and names the argument', () => {
    expect(() => intInRange('level', '5' as unknown as number, 0, 100)).toThrow(/level/);
    expect(() => intInRange('level', undefined as unknown as number, 0, 100)).toThrow(RangeError);
  });
});

describe('u8', () => {
  it('accepts 0 and 255, rejects 256 and -1', () => {
    expect(u8('b', 0)).toBe(0);
    expect(u8('b', 255)).toBe(255);
    expect(() => u8('b', 256)).toThrow(RangeError);
    expect(() => u8('b', -1)).toThrow(RangeError);
  });
});

describe('le16', () => {
  it('encodes little-endian', () => {
    expect(le16('v', 0)).toEqual([0, 0]);
    expect(le16('v', 0x1234)).toEqual([0x34, 0x12]);
    expect(le16('v', 0xffff)).toEqual([0xff, 0xff]);
  });

  it('rejects out-of-range and fractional values', () => {
    expect(() => le16('v', 0x10000)).toThrow(RangeError);
    expect(() => le16('v', -1)).toThrow(RangeError);
    expect(() => le16('v', 0.5)).toThrow(RangeError);
  });
});

describe('rgb', () => {
  it('returns the three channels', () => {
    expect(rgb('c', 255, 0, 128)).toEqual([255, 0, 128]);
  });

  it('rejects any bad channel and names it', () => {
    expect(() => rgb('c', 256, 0, 0)).toThrow(/c\.r/);
    expect(() => rgb('c', 0, -1, 0)).toThrow(/c\.g/);
    expect(() => rgb('c', 0, 0, 1.5)).toThrow(/c\.b/);
  });
});

describe('oneOf', () => {
  it('accepts listed values and rejects others', () => {
    expect(oneOf('ch', 5, [0, 2, 5, 6] as const)).toBe(5);
    expect(() => oneOf('ch', 1, [0, 2, 5, 6] as const)).toThrow(RangeError);
    expect(() => oneOf('ch', NaN, [0, 2, 5, 6] as const)).toThrow(RangeError);
  });
});
