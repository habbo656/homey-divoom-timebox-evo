/**
 * Raised for invalid input to a low-level encoder such as the envelope or `fromHex` (the Evo has no NAK, so nothing
 * invalid may be sent). Command builders in `commands.ts` validate their arguments with `validate.ts` and throw the
 * built-in `RangeError` instead.
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Raised for a malformed device frame; `frame` carries the offending bytes for logging. */
export class FrameError extends ProtocolError {
  readonly frame: Uint8Array;

  constructor(message: string, frame: Uint8Array) {
    super(message);
    this.name = 'FrameError';
    this.frame = frame;
  }
}
