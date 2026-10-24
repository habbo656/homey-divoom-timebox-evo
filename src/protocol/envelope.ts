// BLE envelope (FE EF AA 55 + sequence counter), docs/divoom-protocol.md section 1.2.
import { ProtocolError } from './errors';

const MAGIC = [0xfe, 0xef, 0xaa, 0x55] as const;
/** LEN counts seq (2) + zeros (3) + payload + crc (2) and is a 16-bit field. */
const ENVELOPE_OVERHEAD = 7;
export const MAX_PAYLOAD = 0xffff - ENVELOPE_OVERHEAD;
export const SEQ_MIN = 0x0100;
export const SEQ_MAX = 0xffff;

/**
 * Wrap a command payload (opcode + args) in the BLE envelope:
 * `FE EF AA 55 | LEN (LE16) | SEQ_hi SEQ_lo | 00 00 00 | PAYLOAD | CRC (LE16)`,
 * `CRC = (LEN_lo + LEN_hi + sum(seq, zeros, payload)) & 0xFFFF`.
 *
 * The Evo ignores packets whose SEQ high byte is 0, so `seq` must be within 0x0100..0xFFFF.
 */
export function envelope(payload: Uint8Array, seq: number): Uint8Array {
  if (!Number.isInteger(seq) || seq < SEQ_MIN || seq > SEQ_MAX) {
    throw new ProtocolError(`sequence number must be an integer within 0x0100..0xFFFF, got ${seq}`);
  }
  if (payload.length === 0 || payload.length > MAX_PAYLOAD) {
    throw new ProtocolError(`payload length must be 1..${MAX_PAYLOAD} bytes, got ${payload.length}`);
  }
  const len = payload.length + ENVELOPE_OVERHEAD;
  const out = new Uint8Array(MAGIC.length + 2 + len);
  out.set(MAGIC, 0);
  out[4] = len & 0xff;
  out[5] = len >> 8;
  out[6] = seq >> 8;
  out[7] = seq & 0xff;
  // out[8..10] stay 0x00
  out.set(payload, 11);
  let crc = out[4] + out[5];
  for (let i = 6; i < out.length - 2; i++) crc += out[i];
  crc &= 0xffff;
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = crc >> 8;
  return out;
}

/**
 * Per-connection sequence number generator. Values run 0x0101..0x01FF and wrap. The low byte 0x00 is skipped, so the
 * low byte never repeats back-to-back (the Evo drops a packet whose low byte equals the last accepted one) and the
 * high byte is always non-zero. Call `reset()` for every new connection.
 */
export class SequenceCounter {
  private n = 0;

  next(): number {
    this.n = this.n >= 0xff ? 1 : this.n + 1;
    return 0x0100 | this.n;
  }

  reset(): void {
    this.n = 0;
  }
}
