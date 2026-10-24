import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTimerMs, MAX_TIMER_MS, settleWithin } from './settle';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('settleWithin', () => {
  it('resolves true when the promise fulfils or rejects in time and leaves no timer behind', async () => {
    await expect(settleWithin(Promise.resolve(1), 1_000)).resolves.toBe(true);
    await expect(settleWithin(Promise.reject(new Error('x')), 1_000)).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves false once the time limit has passed for a promise that never settles', async () => {
    let result: boolean | undefined;
    void settleWithin(new Promise(() => undefined), 1_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('assertTimerMs', () => {
  it('accepts integers within 1..2^31-1 and rejects everything else with a RangeError naming the option', () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
    expect(() => assertTimerMs('x', 1)).not.toThrow();
    expect(() => assertTimerMs('x', 2 ** 31 - 1)).not.toThrow();
    for (const ms of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(() => assertTimerMs('someOption', ms)).toThrow(RangeError);
      expect(() => assertTimerMs('someOption', ms)).toThrow(/^someOption must be an integer within 1\.\.2147483647 ms/);
    }
  });
});
