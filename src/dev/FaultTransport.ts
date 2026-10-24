// Fault injection for hardware tests (dev harness only, see devHarness.ts): wraps a real Transport and can make the
// link look dead (`mute`) or lost (`drop`) without touching the device.
import type { LinkHandlers, Transport } from '../transport/Transport';

export class FaultTransport implements Transport {
  private readonly inner: Transport;
  private handlers: LinkHandlers | null = null;
  private muted = false;

  constructor(inner: Transport) {
    this.inner = inner;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Swallow every notification from the device (writes still go out): polls stay unanswered. Reset by `open`. */
  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  /** Simulate a lost link: close the real link and report `onClose` as if the device had gone away. */
  async drop(): Promise<void> {
    const handlers = this.handlers;
    this.handlers = null;
    await this.inner.close();
    handlers?.onClose();
  }

  async open(handlers: LinkHandlers): Promise<void> {
    this.handlers = handlers;
    this.muted = false;
    await this.inner.open({
      onData: (bytes) => {
        if (!this.muted) handlers.onData(bytes);
      },
      onClose: () => {
        if (this.handlers === handlers) handlers.onClose();
      },
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    return this.inner.write(bytes);
  }

  async close(): Promise<void> {
    this.handlers = null;
    await this.inner.close();
  }
}
