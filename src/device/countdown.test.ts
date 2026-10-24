import { describe, expect, it } from 'vitest';
import { formatCountdown, parseCountdownArgs } from './countdown';

describe('parseCountdownArgs', () => {
  it.each([
    [5, 0, { minutes: 5, seconds: 0 }],
    [0, 30, { minutes: 0, seconds: 30 }],
    [99, 59, { minutes: 99, seconds: 59 }],
    [1.4, 29.5, { minutes: 1, seconds: 30 }],
    [-0.4, 10, { minutes: 0, seconds: 10 }],
    [0, 0, { minutes: 0, seconds: 0 }],
  ])('parses %s min %s s', (minutes, seconds, expected) => {
    const result = parseCountdownArgs(minutes, seconds);
    expect(result).toEqual(expected);
    expect(Object.is(result.minutes, -0)).toBe(false);
  });

  it.each([-1, 99.6, 100, NaN, Infinity, '5', null, undefined, {}])('rejects minutes %j', (bad) => {
    expect(() => parseCountdownArgs(bad, 10)).toThrow(RangeError);
  });

  it.each([-1, -0.6, 59.6, 60, NaN, -Infinity, '30', null, undefined, true])('rejects seconds %j', (bad) => {
    expect(() => parseCountdownArgs(5, bad)).toThrow(RangeError);
  });

  it('names the argument in the error', () => {
    expect(() => parseCountdownArgs(100, 0)).toThrow(/minutes must be within 0\.\.99/);
    expect(() => parseCountdownArgs(0, 59.6)).toThrow(/seconds must be within 0\.\.59/);
  });
});

describe('formatCountdown', () => {
  it.each([
    [5, 0, '05:00'],
    [0, 30, '00:30'],
    [99, 59, '99:59'],
  ])('formats %s:%s', (m, s, text) => {
    expect(formatCountdown(m, s)).toBe(text);
  });
});
