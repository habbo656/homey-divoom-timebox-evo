import { describe, expect, it } from 'vitest';
import { FrameError, ProtocolError } from './errors';
import { fromHex } from './hex';
import { decodeSppFrame, parseReply, type Reply } from './replies';
import { MIN_STATUS_DATA, decodeCustomPage, decodeStatus, isCountdownEnd, isCustomPageReply } from './status';
import {
  COUNTDOWN_END,
  COUNTDOWN_END_BD_1E,
  COUNTDOWN_END_BD_32,
  REPLY_BRIGHTNESS,
  REPLY_CUSTOM_PAGE_2,
  REPLY_STATUS,
  STATUS_CLOCK_B20_GREEN,
  STATUS_CLOCK_B50,
  STATUS_LIGHTING_GREEN_B100,
  STATUS_UNSOLICITED_22,
  STATUS_VISUALIZATION_3,
} from './__fixtures__/golden';

/** An SPP frame around `payload` (`04 CMD 55 DATA…`): `01 | LEN | payload | CRC | 02`. */
function sppFrame(payload: number[]): Uint8Array {
  const body = [(payload.length + 2) & 0xff, (payload.length + 2) >> 8, ...payload];
  const crc = body.reduce((a, b) => a + b, 0) & 0xffff;
  return Uint8Array.from([0x01, ...body, crc & 0xff, crc >> 8, 0x02]);
}

const reply = (frameHex: string): Reply => parseReply(decodeSppFrame(fromHex(frameHex)));

describe('decodeStatus (real captures)', () => {
  it('decodes the clock view at brightness 50', () => {
    expect(decodeStatus(reply(STATUS_CLOCK_B50))).toEqual({
      channel: 0,
      lightingColor: { r: 0xff, g: 0, b: 0 },
      brightness: 50,
      visualization: 3,
      clockColor: { r: 0xff, g: 0x80, b: 0 },
      clockStyle: 0,
    });
  });

  it('decodes brightness 20 with a green lighting colour', () => {
    const s = decodeStatus(reply(STATUS_CLOCK_B20_GREEN));
    expect(s.channel).toBe(0);
    expect(s.brightness).toBe(20);
    expect(s.lightingColor).toEqual({ r: 0, g: 0xff, b: 0 });
  });

  it('decodes the lighting channel at brightness 100', () => {
    const s = decodeStatus(reply(STATUS_LIGHTING_GREEN_B100));
    expect(s.channel).toBe(1);
    expect(s.brightness).toBe(100);
    expect(s.lightingColor).toEqual({ r: 0, g: 0xff, b: 0 });
    expect(s.clockStyle).toBe(0);
  });

  it('decodes the visualization channel and index', () => {
    const s = decodeStatus(reply(STATUS_VISUALIZATION_3));
    expect(s.channel).toBe(4);
    expect(s.visualization).toBe(3);
  });

  it('accepts the 22-byte unsolicited report', () => {
    const r = reply(STATUS_UNSOLICITED_22);
    expect(r.data.length).toBe(22);
    const s = decodeStatus(r);
    expect(s.brightness).toBe(20);
    expect(s.clockColor).toEqual({ r: 0xff, g: 0x80, b: 0 });
  });

  it('decodes the synthetic 00..13 dump byte by byte', () => {
    expect(decodeStatus(reply(REPLY_STATUS))).toEqual({
      channel: 0x00,
      lightingColor: { r: 3, g: 4, b: 5 },
      brightness: 6,
      visualization: 9,
      clockColor: { r: 12, g: 13, b: 14 },
      clockStyle: 15,
    });
  });
});

describe('decodeStatus (rejections and edge cases)', () => {
  const make = (data: number[], cmd = 0x46, ok = true): Reply => ({
    cmd,
    ok,
    data: Uint8Array.from(data),
    kind: cmd === 0x46 ? 'status' : 'other',
  });
  const zeros = (n: number): number[] => new Array<number>(n).fill(0);

  it('accepts exactly the minimum data length', () => {
    expect(decodeStatus(make(zeros(MIN_STATUS_DATA))).clockStyle).toBe(0);
  });

  it.each([0, 1, MIN_STATUS_DATA - 1])('rejects %i data bytes with FrameError', (n) => {
    expect(() => decodeStatus(make(zeros(n)))).toThrow(FrameError);
  });

  it('rejects a reply for another opcode', () => {
    expect(() => decodeStatus(reply(REPLY_BRIGHTNESS))).toThrow(ProtocolError);
  });

  it('rejects a status byte other than 55', () => {
    expect(() => decodeStatus(make(zeros(20), 0x46, false))).toThrow(ProtocolError);
  });

  it('does not clamp an out-of-range brightness', () => {
    const data = zeros(20);
    data[6] = 126;
    expect(decodeStatus(make(data)).brightness).toBe(126);
    data[6] = 255;
    expect(decodeStatus(make(data)).brightness).toBe(255);
  });
});

describe('decodeCustomPage', () => {
  const make = (data: number[], cmd = 0xbd, ok = true): Reply => ({
    cmd,
    ok,
    data: Uint8Array.from(data),
    kind: 'other',
  });

  it.each([0, 1, 2, 0xff])('returns the raw page byte %i of bd 55 17 PP', (page) => {
    expect(decodeCustomPage(make([0x17, page]))).toBe(page);
  });

  it('decodes a parsed frame', () => {
    expect(decodeCustomPage(parseReply(Uint8Array.of(0x04, 0xbd, 0x55, 0x17, 0x02)))).toBe(2);
  });

  it('rejects another opcode', () => {
    expect(() => decodeCustomPage(make([0x17, 1], 0x46))).toThrow(ProtocolError);
  });

  it('rejects a status byte other than 55', () => {
    expect(() => decodeCustomPage(make([0x17, 1], 0xbd, false))).toThrow(ProtocolError);
  });

  it('rejects another sub-opcode', () => {
    expect(() => decodeCustomPage(make([0x18, 1]))).toThrow(ProtocolError);
  });

  it.each([[[]], [[0x17]]])('rejects %j with FrameError', (data) => {
    expect(() => decodeCustomPage(make(data))).toThrow(FrameError);
  });
});

describe('isCountdownEnd', () => {
  const frame = (payload: number[]): Reply => parseReply(decodeSppFrame(sppFrame(payload)));

  it('recognises the end frame 71 55 03 01 01 00', () => {
    expect(isCountdownEnd(reply(COUNTDOWN_END))).toBe(true);
  });

  it('refuses near-misses', () => {
    expect(isCountdownEnd(frame([0x04, 0x71, 0x55, 0x03, 0x01, 0x00, 0x00]))).toBe(false); // other data
    expect(isCountdownEnd(frame([0x04, 0x71, 0x55, 0x03, 0x01, 0x01]))).toBe(false); // too short
    expect(isCountdownEnd(frame([0x04, 0x71, 0x55, 0x03, 0x01, 0x01, 0x00, 0x00]))).toBe(false); // too long
    expect(isCountdownEnd(frame([0x04, 0x71, 0x55]))).toBe(false); // no data
    expect(isCountdownEnd(frame([0x04, 0x71, 0xaa, 0x03, 0x01, 0x01, 0x00]))).toBe(false); // status byte not 55
    expect(isCountdownEnd(frame([0x04, 0x72, 0x55, 0x03, 0x01, 0x01, 0x00]))).toBe(false); // other opcode
    expect(isCountdownEnd(frame([0x04, 0xbd, 0x55, 0x13, 0x01, 0x32, 0x00]))).toBe(false); // the bd frames that follow
  });
});

describe('isCustomPageReply', () => {
  const frame = (payload: number[]): Reply => parseReply(decodeSppFrame(sppFrame(payload)));

  it('accepts bd 55 17 PP and a malformed bd 17 (decodeCustomPage reports it)', () => {
    expect(isCustomPageReply(reply(REPLY_CUSTOM_PAGE_2))).toBe(true);
    expect(isCustomPageReply(frame([0x04, 0xbd, 0x55, 0x17, 0x01]))).toBe(true);
    expect(isCustomPageReply(frame([0x04, 0xbd, 0x55, 0x17]))).toBe(true);
  });

  it('refuses the unsolicited bd 55 13 frames and other opcodes', () => {
    expect(isCustomPageReply(reply(COUNTDOWN_END_BD_32))).toBe(false);
    expect(isCustomPageReply(reply(COUNTDOWN_END_BD_1E))).toBe(false);
    expect(isCustomPageReply(frame([0x04, 0xbd, 0x55]))).toBe(false);
    expect(isCustomPageReply(frame([0x04, 0x46, 0x55, 0x17, 0x01]))).toBe(false);
  });
});
