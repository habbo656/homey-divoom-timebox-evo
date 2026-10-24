// Decoding of device replies and notifications (SPP frames), docs/divoom-protocol.md sections 1.4 and 2.
import { FrameError } from './errors';

const START = 0x01;
const END = 0x02;
/** Reply marker: the payload of every device frame starts with `04`, followed by the opcode and the status byte. */
const REPLY_MARKER = 0x04;
const STATUS_OK = 0x55;
/** Largest accepted LEN field. The biggest reply seen is a few hundred bytes (`42` alarms); anything larger is garbage. */
export const MAX_SPP_LEN = 1024;
/** Bytes around the payload: start, LEN (2), CRC (2), end. */
const FRAME_OVERHEAD = 6;

export type ReplyKind = 'heartbeat' | 'seqEcho' | 'brightness' | 'status' | 'other';

export interface Reply {
  /** Opcode the device answers (or reports, for unsolicited frames). */
  cmd: number;
  /** True if the status byte is `55`. */
  ok: boolean;
  /** Bytes after the status byte. */
  data: Uint8Array;
  kind: ReplyKind;
}

export interface SplitResult {
  /** Complete, CRC-checked SPP frames (including start, length, CRC and end bytes). */
  frames: Uint8Array[];
  /** Trailing bytes of an incomplete frame; prepend them to the next chunk. */
  rest: Uint8Array;
  /** Number of bytes dropped while resynchronising on garbage. */
  skipped: number;
}

function crcOf(bytes: Uint8Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += bytes[i];
  return sum & 0xffff;
}

/** Checks the frame that starts at `at` (`total` bytes, already known to fit in `buf`). Returns an error text or null. */
function frameProblem(buf: Uint8Array, at: number, total: number): string | null {
  if (buf[at + total - 1] !== END) return 'missing end byte 02';
  const crcAt = at + total - 3;
  const crc = buf[crcAt] | (buf[crcAt + 1] << 8);
  if (crc !== crcOf(buf, at + 1, crcAt)) return 'CRC mismatch';
  return null;
}

/**
 * Split a byte stream into complete SPP frames `01 | LEN (LE16) | payload | CRC (LE16) | 02`
 * (LEN = payload + 2, CRC = 16-bit sum over the LEN bytes and the payload).
 *
 * Never throws. A start byte whose LEN is implausible (< 2 or > `MAX_SPP_LEN`), whose end byte is not `02` or whose CRC
 * does not match is skipped one byte at a time to resynchronise (counted in `skipped`). An incomplete tail is returned
 * in `rest`. Callers must clear `rest` on reconnect or timeout, otherwise stale bytes would be glued to the next frame.
 */
export function splitFrames(buf: Uint8Array): SplitResult {
  const frames: Uint8Array[] = [];
  let skipped = 0;
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== START) {
      i++;
      skipped++;
      continue;
    }
    if (buf.length - i < 3) break;
    const len = buf[i + 1] | (buf[i + 2] << 8);
    if (len < 2 || len > MAX_SPP_LEN) {
      i++;
      skipped++;
      continue;
    }
    const total = len + 4;
    if (i + total > buf.length) break;
    if (frameProblem(buf, i, total) !== null) {
      i++;
      skipped++;
      continue;
    }
    frames.push(buf.slice(i, i + total));
    i += total;
  }
  return { frames, rest: buf.slice(i), skipped };
}

/** Validate one complete SPP frame and return its payload. Throws `FrameError` if it is malformed. */
export function decodeSppFrame(frame: Uint8Array): Uint8Array {
  if (frame.length < FRAME_OVERHEAD) throw new FrameError('frame too short', frame);
  if (frame[0] !== START) throw new FrameError('missing start byte 01', frame);
  const len = frame[1] | (frame[2] << 8);
  if (len < 2 || len > MAX_SPP_LEN) throw new FrameError(`implausible LEN ${len}`, frame);
  if (frame.length !== len + 4) {
    throw new FrameError(`LEN ${len} does not match frame length ${frame.length}`, frame);
  }
  const problem = frameProblem(frame, 0, frame.length);
  if (problem !== null) throw new FrameError(problem, frame);
  return frame.slice(3, frame.length - 3);
}

function kindOf(cmd: number): ReplyKind {
  switch (cmd) {
    case 0xf7:
      return 'heartbeat';
    case 0x33:
      return 'seqEcho';
    case 0x31:
      return 'brightness';
    case 0x46:
      return 'status';
    default:
      return 'other';
  }
}

/**
 * Parse the payload of a device frame (`04 | CMD | STATUS | DATA…`, as returned by `decodeSppFrame`).
 * Unknown opcodes are not an error: they come back with kind `other`. Throws `FrameError` only if the payload is too
 * short or lacks the `04` marker.
 */
export function parseReply(payload: Uint8Array): Reply {
  if (payload.length < 3) throw new FrameError('reply payload too short', payload);
  if (payload[0] !== REPLY_MARKER) throw new FrameError('reply payload does not start with 04', payload);
  const cmd = payload[1];
  return { cmd, ok: payload[2] === STATUS_OK, data: payload.slice(3), kind: kindOf(cmd) };
}
