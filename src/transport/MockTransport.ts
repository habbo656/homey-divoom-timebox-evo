// In-memory Transport for tests: records every call and lets the test drive the "device" side.
import type { LinkHandlers, Transport } from './Transport';
import { TransportError } from './Transport';

export class MockTransport implements Transport {
  /** Every `write`, in order (copies). */
  readonly writes: Uint8Array[] = [];
  /** Handlers of every `open`, in order (the last one is the live session; older ones are stale). */
  readonly handlerLog: LinkHandlers[] = [];
  opens = 0;
  closes = 0;
  /** Set to make `write` reject (once per entry, FIFO). */
  writeErrors: Error[] = [];
  /** Optional device simulation: called for every write, returns notification chunks to emit. */
  autoReply?: (write: Uint8Array) => Uint8Array[] | undefined;

  private handlers: LinkHandlers | null = null;
  private nextOpenError: Error | null = null;
  private hangOpen = false;
  private held = false;
  private heldWrites: Array<() => void> = [];
  private hungOpens: Array<() => void> = [];

  /** The next `open` rejects with `error` (default: a transient `TransportError`). */
  failNextOpen(error: Error = new TransportError('mock open failed')): void {
    this.nextOpenError = error;
  }

  /** The next `open` never settles (until `close`, which makes it reject). */
  hangNextOpen(): void {
    this.hangOpen = true;
  }

  /** `write` stays pending until `releaseWrites()`. */
  holdWrites(): void {
    this.held = true;
  }

  releaseWrites(): void {
    this.held = false;
    const waiting = this.heldWrites;
    this.heldWrites = [];
    for (const release of waiting) release();
  }

  /** Simulate a notification from the device. */
  emitData(bytes: Uint8Array): void {
    this.handlers?.onData(bytes);
  }

  /** Simulate the link going away (device off, out of range). */
  dropLink(): void {
    const h = this.handlers;
    this.handlers = null;
    h?.onClose();
  }

  get isOpen(): boolean {
    return this.handlers !== null;
  }

  async open(handlers: LinkHandlers): Promise<void> {
    this.opens++;
    this.handlerLog.push(handlers);
    if (this.nextOpenError) {
      const e = this.nextOpenError;
      this.nextOpenError = null;
      throw e;
    }
    if (this.hangOpen) {
      this.hangOpen = false;
      await new Promise<void>((_, reject) => {
        this.hungOpens.push(() => reject(new TransportError('mock open cancelled')));
      });
    }
    this.handlers = handlers;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.held) await new Promise<void>((resolve) => this.heldWrites.push(resolve));
    const err = this.writeErrors.shift();
    if (err) throw err;
    if (!this.handlers) throw new Error('mock transport is not open');
    this.writes.push(bytes.slice());
    const replies = this.autoReply?.(bytes);
    if (replies) for (const r of replies) this.emitData(r);
  }

  async close(): Promise<void> {
    this.closes++;
    this.handlers = null;
    // A hanging open is cancelled by close.
    const hung = this.hungOpens;
    this.hungOpens = [];
    for (const cancel of hung) cancel();
  }
}
