// Decoding of the device status reply (opcode 46), docs/divoom-protocol.md section 3.
import { FrameError, ProtocolError } from './errors';
import type { Reply } from './replies';

/** The reply carries at least data bytes d0..d15; the plain query answers 20, unsolicited reports 22. */
export const MIN_STATUS_DATA = 16;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface DeviceStatus {
  /** d0: current channel (`00` clock, `01` lighting, `02` cloud, `04` visualization, ...). */
  channel: number;
  /** d3..d5: lighting colour. */
  lightingColor: Rgb;
  /**
   * d6: brightness, normally 0..100. Not clamped: a truncated `74` command can leave the device at an out-of-range
   * value such as 126 (section 2), and callers should see what the device reports.
   */
  brightness: number;
  /** d9: last visualization index (`45 04 NN`). */
  visualization: number;
  /** d12..d14: clock colour. */
  clockColor: Rgb;
  /** d15: clock style (`TT` of `45 00 …`). */
  clockStyle: number;
}

/**
 * Decode a parsed `46` reply (`parseReply` result). Throws `ProtocolError` if the reply is not a successful `46`
 * and `FrameError` if it has fewer than `MIN_STATUS_DATA` data bytes. Extra trailing bytes are ignored.
 */
export function decodeStatus(reply: Reply): DeviceStatus {
  if (reply.cmd !== 0x46) throw new ProtocolError(`not a status reply: opcode ${reply.cmd.toString(16)}`);
  if (!reply.ok) throw new ProtocolError('status reply does not carry status byte 55');
  const d = reply.data;
  if (d.length < MIN_STATUS_DATA) {
    throw new FrameError(`status reply has ${d.length} data bytes, need at least ${MIN_STATUS_DATA}`, d);
  }
  return {
    channel: d[0],
    lightingColor: { r: d[3], g: d[4], b: d[5] },
    brightness: d[6],
    visualization: d[9],
    clockColor: { r: d[12], g: d[13], b: d[14] },
    clockStyle: d[15],
  };
}

/**
 * Decode the answer of `bd 17 ff` (`bd 55 17 PP`) to the raw custom page byte PP: 0..2 for a page, other values are
 * what the device reports (callers compare, never trust). Throws `ProtocolError` if the reply is not a successful `bd 17`
 * reply and `FrameError` if it has fewer than 2 data bytes.
 */
export function decodeCustomPage(reply: Reply): number {
  if (reply.cmd !== 0xbd) throw new ProtocolError(`not a custom page reply: opcode ${reply.cmd.toString(16)}`);
  if (!reply.ok) throw new ProtocolError('custom page reply does not carry status byte 55');
  const d = reply.data;
  if (d.length < 2) throw new FrameError(`custom page reply has ${d.length} data bytes, need 2`, d);
  if (d[0] !== 0x17) throw new ProtocolError(`not a custom page reply: sub-opcode ${d[0].toString(16)}`);
  return d[1];
}

/** Opcode of the countdown reports (`71`, section 2): the end of a countdown, `71 55 03 01 01 00`. */
export const COUNTDOWN_REPORT_OPCODE = 0x71;
/** Data bytes after the status byte of the countdown end report (`71 55 03 01 01 00`). */
const COUNTDOWN_END_DATA = [0x03, 0x01, 0x01, 0x00];

/**
 * True if `reply` is the unsolicited "countdown ended" report `71 55 03 01 01 00` (section 5.6, measurements P2/P5/P6/P8b).
 * Strict: any other `71` frame (other data, other length, status byte other than `55`) is not the end of a countdown.
 */
export function isCountdownEnd(reply: Reply): boolean {
  return (
    reply.cmd === COUNTDOWN_REPORT_OPCODE &&
    reply.ok &&
    reply.data.length === COUNTDOWN_END_DATA.length &&
    COUNTDOWN_END_DATA.every((b, i) => reply.data[i] === b)
  );
}

/**
 * True if `reply` can be the answer of `bd 17 ff`: opcode `bd` with sub-opcode `17`. The device also sends unsolicited
 * `bd 55 13 …` frames after a countdown ends (section 5.6, measurement P11); those must not answer the query.
 * A malformed `bd 17` reply is accepted so `decodeCustomPage` reports it.
 */
export function isCustomPageReply(reply: Reply): boolean {
  return reply.cmd === 0xbd && reply.data.length >= 1 && reply.data[0] === 0x17;
}
