import { ProtocolError } from './errors';

/** Parse a hex string (whitespace allowed, case-insensitive) into bytes. Throws `ProtocolError` if malformed. */
export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new ProtocolError(`invalid hex string: ${JSON.stringify(text)}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Format bytes as lowercase hex separated by single spaces (the notation used in docs/divoom-protocol.md). */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
