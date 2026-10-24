/** Largest GATT write that is known to work on the Evo (docs/divoom-protocol.md section 1.1). */
export const DEFAULT_CHUNK_SIZE = 20;

/** Split `bytes` into consecutive pieces of at most `size` bytes. An empty input yields no chunks. */
export function chunk(bytes: Uint8Array, size = DEFAULT_CHUNK_SIZE): Uint8Array[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}
