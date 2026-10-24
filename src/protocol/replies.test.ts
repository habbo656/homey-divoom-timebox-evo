import { describe, expect, it } from 'vitest';
import { FrameError } from './errors';
import { fromHex, toHex } from './hex';
import { MAX_SPP_LEN, decodeSppFrame, parseReply, splitFrames } from './replies';
import {
  IMAGE_PAYLOAD,
  IMAGE_SPP_FRAME,
  REPLY_BRIGHTNESS,
  REPLY_HEARTBEAT,
  REPLY_IMAGE_ACK,
  REPLY_NOT_OK,
  REPLY_SEQ_ECHO,
  REPLY_STATUS,
  REPLY_UNKNOWN,
} from './__fixtures__/golden';

const cat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const hexes = (frames: Uint8Array[]): string[] => frames.map(toHex);

describe('splitFrames', () => {
  it('returns a single frame', () => {
    const r = splitFrames(fromHex(REPLY_BRIGHTNESS));
    expect(hexes(r.frames)).toEqual([REPLY_BRIGHTNESS]);
    expect(r.rest.length).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it('splits concatenated frames of different kinds', () => {
    const r = splitFrames(cat(...[REPLY_HEARTBEAT, REPLY_BRIGHTNESS, REPLY_STATUS].map(fromHex)));
    expect(hexes(r.frames)).toEqual([REPLY_HEARTBEAT, REPLY_BRIGHTNESS, REPLY_STATUS]);
    expect(r.rest.length).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it('accepts the golden image SPP frame (CRC 8f 22)', () => {
    const r = splitFrames(fromHex(IMAGE_SPP_FRAME));
    expect(hexes(r.frames)).toEqual([IMAGE_SPP_FRAME]);
    expect(decodeSppFrame(r.frames[0])).toEqual(fromHex(IMAGE_PAYLOAD));
  });

  it('keeps an incomplete tail in rest and completes it with the next chunk', () => {
    const all = cat(fromHex(REPLY_BRIGHTNESS), fromHex(REPLY_STATUS));
    for (let cut = 1; cut < all.length; cut++) {
      const first = splitFrames(all.slice(0, cut));
      const second = splitFrames(cat(first.rest, all.slice(cut)));
      expect([...hexes(first.frames), ...hexes(second.frames)]).toEqual([REPLY_BRIGHTNESS, REPLY_STATUS]);
      expect(second.rest.length).toBe(0);
      expect(first.skipped + second.skipped).toBe(0);
    }
  });

  it('works byte by byte', () => {
    const all = fromHex(REPLY_HEARTBEAT);
    let rest: Uint8Array = new Uint8Array();
    const seen: string[] = [];
    for (const b of all) {
      const r = splitFrames(cat(rest, Uint8Array.of(b)));
      seen.push(...hexes(r.frames));
      rest = r.rest;
    }
    expect(seen).toEqual([REPLY_HEARTBEAT]);
    expect(rest.length).toBe(0);
  });

  it('skips leading and interleaved garbage and counts it', () => {
    const r = splitFrames(cat(fromHex('aa bb cc'), fromHex(REPLY_BRIGHTNESS), fromHex('ff'), fromHex(REPLY_SEQ_ECHO)));
    expect(hexes(r.frames)).toEqual([REPLY_BRIGHTNESS, REPLY_SEQ_ECHO]);
    expect(r.skipped).toBe(4);
    expect(r.rest.length).toBe(0);
  });

  it('resyncs after a frame with a bad CRC and still returns the next frame', () => {
    const bad = fromHex(REPLY_BRIGHTNESS);
    bad[bad.length - 3] ^= 0xff; // corrupt CRC high byte
    const r = splitFrames(cat(bad, fromHex(REPLY_SEQ_ECHO)));
    expect(hexes(r.frames)).toEqual([REPLY_SEQ_ECHO]);
    expect(r.skipped).toBe(bad.length);
    expect(r.rest.length).toBe(0);
  });

  it('resyncs after a missing terminator', () => {
    const bad = fromHex(REPLY_BRIGHTNESS);
    bad[bad.length - 1] = 0x03;
    const r = splitFrames(cat(bad, fromHex(REPLY_IMAGE_ACK)));
    expect(hexes(r.frames)).toEqual([REPLY_IMAGE_ACK]);
    expect(r.skipped).toBe(bad.length);
  });

  it('skips an oversized or undersized LEN without waiting for that many bytes', () => {
    const big = fromHex('01 01 04 aa'); // LEN 0x0401 = 1025 > MAX_SPP_LEN
    expect(MAX_SPP_LEN).toBe(1024);
    const r1 = splitFrames(cat(big, fromHex(REPLY_BRIGHTNESS)));
    expect(hexes(r1.frames)).toEqual([REPLY_BRIGHTNESS]);
    expect(r1.skipped).toBe(big.length);
    const r2 = splitFrames(cat(fromHex('01 01 00 00 00'), fromHex(REPLY_BRIGHTNESS)));
    expect(hexes(r2.frames)).toEqual([REPLY_BRIGHTNESS]);
    expect(r2.skipped).toBe(5);
  });

  it('handles empty input and a lone start byte', () => {
    expect(splitFrames(new Uint8Array())).toEqual({ frames: [], rest: new Uint8Array(), skipped: 0 });
    const r = splitFrames(Uint8Array.of(0x01, 0x06));
    expect(r.frames).toEqual([]);
    expect(Array.from(r.rest)).toEqual([0x01, 0x06]);
  });

  it('does not alias the input buffer', () => {
    const input = fromHex(REPLY_BRIGHTNESS);
    const r = splitFrames(input);
    input.fill(0);
    expect(toHex(r.frames[0])).toBe(REPLY_BRIGHTNESS);
  });
});

describe('decodeSppFrame', () => {
  it('returns the payload without start, LEN, CRC and end', () => {
    expect(toHex(decodeSppFrame(fromHex(REPLY_BRIGHTNESS)))).toBe('04 31 55 32');
  });

  it('throws FrameError carrying the frame for every malformation', () => {
    const good = fromHex(REPLY_BRIGHTNESS);
    const withByte = (i: number, v: number): Uint8Array => {
      const f = good.slice();
      f[i] = v;
      return f;
    };
    const cases: Uint8Array[] = [
      new Uint8Array(),
      good.slice(0, 5), // too short
      good.slice(0, good.length - 1), // truncated: LEN mismatch
      cat(good, Uint8Array.of(0)), // trailing byte: LEN mismatch
      withByte(0, 0x00), // start
      withByte(good.length - 1, 0x00), // end
      withByte(good.length - 3, good[good.length - 3] ^ 1), // CRC
      withByte(1, 0x00), // LEN too small (and mismatch)
      withByte(2, 0x08), // LEN too large
    ];
    for (const c of cases) {
      let caught: unknown;
      try {
        decodeSppFrame(c);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FrameError);
      expect((caught as FrameError).frame).toEqual(c);
    }
  });
});

describe('parseReply', () => {
  const parse = (hex: string) => parseReply(decodeSppFrame(fromHex(hex)));

  it('recognises the unsolicited and known kinds', () => {
    expect(parse(REPLY_HEARTBEAT)).toMatchObject({ cmd: 0xf7, ok: true, kind: 'heartbeat' });
    expect(parse(REPLY_SEQ_ECHO)).toMatchObject({ cmd: 0x33, ok: true, kind: 'seqEcho' });
    expect(parse(REPLY_BRIGHTNESS)).toMatchObject({ cmd: 0x31, ok: true, kind: 'brightness' });
    expect(parse(REPLY_STATUS)).toMatchObject({ cmd: 0x46, ok: true, kind: 'status' });
  });

  it('returns the data bytes after the status byte', () => {
    expect(toHex(parse(REPLY_BRIGHTNESS).data)).toBe('32');
    expect(toHex(parse(REPLY_SEQ_ECHO).data)).toBe('0a 00 00 00');
    expect(toHex(parse(REPLY_HEARTBEAT).data)).toBe('4e 6f 62 02 69 04 00 00');
    expect(parse(REPLY_STATUS).data.length).toBe(20);
  });

  it('treats an image acknowledgement as ok regardless of ZZ', () => {
    expect(parse(REPLY_IMAGE_ACK)).toMatchObject({ cmd: 0x44, ok: true, kind: 'other' });
  });

  it('does not throw for unknown opcodes', () => {
    expect(parse(REPLY_UNKNOWN)).toMatchObject({ cmd: 0xe5, ok: true, kind: 'other' });
    expect(toHex(parse(REPLY_UNKNOWN).data)).toBe('01');
  });

  it('reports a status byte other than 55 as not ok', () => {
    expect(parse(REPLY_NOT_OK)).toMatchObject({ cmd: 0x74, ok: false, kind: 'other' });
    expect(parse(REPLY_NOT_OK).data.length).toBe(0);
  });

  it('accepts a reply without data', () => {
    expect(parseReply(fromHex('04 18 55'))).toMatchObject({ cmd: 0x18, ok: true, kind: 'other' });
  });

  it('throws FrameError for payloads that are too short or lack the 04 marker', () => {
    for (const hex of ['', '04', '04 46', '05 46 55', '46 55 00']) {
      expect(() => parseReply(fromHex(hex))).toThrow(FrameError);
    }
  });
});
