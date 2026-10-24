import { describe, expect, it } from 'vitest';
import { FrameError, ProtocolError } from './errors';
import { fromHex, toHex } from './hex';

describe('hex helpers', () => {
  it('parses spaced, unspaced and mixed-case hex', () => {
    expect(Array.from(fromHex('fe ef AA 55'))).toEqual([0xfe, 0xef, 0xaa, 0x55]);
    expect(Array.from(fromHex('feefaa55'))).toEqual([0xfe, 0xef, 0xaa, 0x55]);
    expect(fromHex('').length).toBe(0);
  });

  it('rejects odd length and non-hex characters', () => {
    expect(() => fromHex('abc')).toThrow(ProtocolError);
    expect(() => fromHex('zz')).toThrow(ProtocolError);
  });

  it('formats lowercase with single spaces and round-trips', () => {
    const bytes = Uint8Array.of(0x00, 0x0f, 0xff);
    expect(toHex(bytes)).toBe('00 0f ff');
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(toHex(new Uint8Array())).toBe('');
  });
});

describe('errors', () => {
  it('FrameError is a ProtocolError that carries the frame', () => {
    const err = new FrameError('bad', Uint8Array.of(1, 2));
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FrameError');
    expect(err.frame).toEqual(Uint8Array.of(1, 2));
  });
});
