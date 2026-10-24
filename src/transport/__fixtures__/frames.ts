// Test helpers: build device frames (SPP, docs/divoom-protocol.md section 1.4).

/** `01 | LEN (LE16) | payload | CRC (LE16) | 02`, LEN = payload + 2, CRC = sum over LEN bytes and payload. */
export function sppFrame(payload: number[]): Uint8Array {
  const len = payload.length + 2;
  const body = [len & 0xff, len >> 8, ...payload];
  const crc = body.reduce((a, b) => a + b, 0) & 0xffff;
  return Uint8Array.from([0x01, ...body, crc & 0xff, crc >> 8, 0x02]);
}

/** A `46` status reply with 20 data bytes: channel `d0` and brightness `d6`; `bytes` overrides data bytes by index (e.g. `{ 3: 255 }` for d3). */
export function statusFrame(brightness = 50, channel = 0, bytes: Record<number, number> = {}): Uint8Array {
  const data = new Array<number>(20).fill(0);
  for (const [index, value] of Object.entries(bytes)) data[Number(index)] = value;
  data[0] = channel;
  data[6] = brightness;
  return sppFrame([0x04, 0x46, 0x55, ...data]);
}

/** A reply `04 <cmd> 55 <data…>`. */
export function replyFrame(cmd: number, ...data: number[]): Uint8Array {
  return sppFrame([0x04, cmd, 0x55, ...data]);
}

/** `f7` heartbeat as sent by the device after the iOS init sequence. */
export function heartbeatFrame(): Uint8Array {
  return replyFrame(0xf7);
}

/** Opcode of an envelope (`FE EF AA 55 LEN LEN SEQ SEQ 00 00 00 OPCODE …`), or -1 if this is not a first chunk. */
export function opcodeOf(chunk: Uint8Array): number {
  return chunk.length > 11 && chunk[0] === 0xfe ? chunk[11] : -1;
}

/** Sequence number of the envelope that starts with `chunk`. */
export function seqOf(chunk: Uint8Array): number {
  return (chunk[6] << 8) | chunk[7];
}

export function concat(parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}
