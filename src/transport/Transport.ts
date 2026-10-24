// Transport interface: the only hardware boundary of the app (docs/architecture.md). A transport moves raw bytes over
// ONE physical link: no envelope, no sequence numbers, no reply parsing (that is `ConnectionManager`'s job).

export interface LinkHandlers {
  /** Called for every notification chunk from the device (arbitrary split points, may contain partial frames). */
  onData(bytes: Uint8Array): void;
  /** Called when the link is gone without `close()` having been called (device powered off, out of range, ...). */
  onClose(): void;
}

export interface Transport {
  /**
   * Connect and subscribe to notifications. Resolves only when the link is ready for `write` and `handlers.onData` is
   * already wired (no notification may be lost). Rejects with a `TransportError` (or any other error, treated as
   * transient). May be called again after `close()` or after `onClose`.
   */
  open(handlers: LinkHandlers): Promise<void>;
  /** One single GATT write; the caller chunks (`chunk()`). Rejects if the link is not open or the write fails. */
  write(bytes: Uint8Array): Promise<void>;
  /** Tear the link down. Never rejects, never calls `onClose`; also cancels an `open` that is still in flight. */
  close(): Promise<void>;
}

/** Raised by `open` when connecting failed. `permanent` means that retrying quickly is pointless (e.g. wrong device). */
export class TransportError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent = false) {
    super(message);
    this.name = 'TransportError';
    this.permanent = permanent;
  }
}
