import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD, SequenceCounter, envelope } from './envelope';
import { ProtocolError } from './errors';
import { fromHex, toHex } from './hex';
import { IMAGE_ENVELOPE, IMAGE_PAYLOAD, LIGHTING_RED_ENVELOPE, LIGHTING_RED_PAYLOAD } from './__fixtures__/golden';

describe('envelope', () => {
  it('matches the documented lighting red golden vector', () => {
    expect(toHex(envelope(fromHex(LIGHTING_RED_PAYLOAD), 0x0101))).toBe(LIGHTING_RED_ENVELOPE);
  });

  it('matches the documented golden vector bytes (ends with bb 01)', () => {
    const out = envelope(fromHex(LIGHTING_RED_PAYLOAD), 0x0101);
    expect(Array.from(out.slice(-2))).toEqual([0xbb, 0x01]);
  });

  it('matches the image envelope golden vector (ends with 96 22)', () => {
    const payload = fromHex(IMAGE_PAYLOAD);
    expect(payload.length).toBe(85);
    const out = envelope(payload, 0x0101);
    expect(toHex(out)).toBe(IMAGE_ENVELOPE);
    expect(Array.from(out.slice(-2))).toEqual([0x96, 0x22]);
  });

  it('encodes the sequence number big-endian and adjusts the CRC', () => {
    const out = envelope(fromHex(LIGHTING_RED_PAYLOAD), 0x0203);
    expect(Array.from(out.slice(6, 8))).toEqual([0x02, 0x03]);
    // CRC grows by the difference of the seq bytes: (2+3) - (1+1) = 3 -> 0x01bb + 3 = 0x01be
    expect(Array.from(out.slice(-2))).toEqual([0xbe, 0x01]);
  });

  it('wraps the 16-bit CRC', () => {
    const payload = new Uint8Array(300).fill(0xff);
    const out = envelope(payload, 0x0101);
    const len = 307; // 0x0133
    expect(out[4]).toBe(len & 0xff);
    expect(out[5]).toBe(len >> 8);
    const sum = 0x33 + 0x01 + 0x01 + 0x01 + 300 * 0xff; // LEN bytes + seq bytes + payload
    expect(sum).toBeGreaterThan(0xffff);
    const expected = sum & 0xffff;
    expect(out[out.length - 2] | (out[out.length - 1] << 8)).toBe(expected);
  });

  it('rejects an invalid sequence number', () => {
    const payload = Uint8Array.of(0x46);
    for (const seq of [0, 0x0001, 0x00ff, 0x0100 - 1, 0x10000, -1, 1.5, NaN]) {
      expect(() => envelope(payload, seq)).toThrow(ProtocolError);
    }
    expect(() => envelope(payload, 0x0100)).not.toThrow();
    expect(() => envelope(payload, 0xffff)).not.toThrow();
  });

  it('rejects an empty or oversized payload', () => {
    expect(() => envelope(new Uint8Array(), 0x0101)).toThrow(ProtocolError);
    expect(() => envelope(new Uint8Array(MAX_PAYLOAD + 1), 0x0101)).toThrow(ProtocolError);
    const max = envelope(new Uint8Array(MAX_PAYLOAD), 0x0101);
    expect(max[4] | (max[5] << 8)).toBe(0xffff);
  });
});

describe('SequenceCounter', () => {
  it('starts at 0x0101 and counts up', () => {
    const c = new SequenceCounter();
    expect([c.next(), c.next(), c.next()]).toEqual([0x0101, 0x0102, 0x0103]);
  });

  it('always has a non-zero high byte, skips low byte 00 and never repeats the low byte back-to-back', () => {
    const c = new SequenceCounter();
    let prev = -1;
    for (let i = 0; i < 1000; i++) {
      const seq = c.next();
      expect(seq >> 8).not.toBe(0);
      expect(seq & 0xff).not.toBe(0);
      expect(seq & 0xff).not.toBe(prev);
      expect(() => envelope(Uint8Array.of(0x46), seq)).not.toThrow();
      prev = seq & 0xff;
    }
  });

  it('cycles through 0x0101..0x01ff and wraps to 0x0101', () => {
    const c = new SequenceCounter();
    const seen: number[] = [];
    for (let i = 0; i < 255; i++) seen.push(c.next());
    expect(seen[0]).toBe(0x0101);
    expect(seen[254]).toBe(0x01ff);
    expect(new Set(seen).size).toBe(255);
    expect(c.next()).toBe(0x0101);
  });

  it('reset() restarts at 0x0101', () => {
    const c = new SequenceCounter();
    c.next();
    c.next();
    c.reset();
    expect(c.next()).toBe(0x0101);
  });
});
