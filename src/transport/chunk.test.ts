import { describe, expect, it } from 'vitest';
import { chunk } from './chunk';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);

describe('chunk', () => {
  it('returns no chunks for empty input', () => {
    expect(chunk(new Uint8Array(0))).toEqual([]);
  });

  it('keeps 20 bytes in one chunk', () => {
    expect(chunk(bytes(20)).map((c) => c.length)).toEqual([20]);
  });

  it('splits 21 bytes into 20 + 1', () => {
    expect(chunk(bytes(21)).map((c) => c.length)).toEqual([20, 1]);
  });

  it('splits 41 bytes into 20 + 20 + 1 and preserves order', () => {
    const parts = chunk(bytes(41));
    expect(parts.map((c) => c.length)).toEqual([20, 20, 1]);
    expect(Uint8Array.from(parts.flatMap((c) => [...c]))).toEqual(bytes(41));
  });

  it('honours a custom size and rejects an invalid one', () => {
    expect(chunk(bytes(5), 2).map((c) => c.length)).toEqual([2, 2, 1]);
    expect(() => chunk(bytes(5), 0)).toThrow(RangeError);
  });
});
