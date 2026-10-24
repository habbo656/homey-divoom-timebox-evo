import { describe, expect, it } from 'vitest';
import { MockTransport } from '../transport/MockTransport';
import type { LinkHandlers } from '../transport/Transport';
import { FaultTransport } from './FaultTransport';

function setup() {
  const inner = new MockTransport();
  const fault = new FaultTransport(inner);
  const data: number[][] = [];
  let closed = 0;
  const handlers: LinkHandlers = { onData: (b) => data.push([...b]), onClose: () => closed++ };
  return { inner, fault, data, handlers, closed: () => closed };
}

describe('FaultTransport', () => {
  it('passes writes and notifications through', async () => {
    const { inner, fault, data, handlers } = setup();
    await fault.open(handlers);
    await fault.write(Uint8Array.of(1, 2));
    inner.emitData(Uint8Array.of(9));
    expect(inner.writes).toEqual([Uint8Array.of(1, 2)]);
    expect(data).toEqual([[9]]);
  });

  it('mute swallows notifications until the next open', async () => {
    const { inner, fault, data, handlers } = setup();
    await fault.open(handlers);
    fault.mute();
    expect(fault.isMuted).toBe(true);
    await fault.write(Uint8Array.of(1));
    inner.emitData(Uint8Array.of(9));
    expect(data).toEqual([]);
    expect(inner.writes).toHaveLength(1);
    await fault.close();
    await fault.open(handlers);
    expect(fault.isMuted).toBe(false);
    inner.emitData(Uint8Array.of(7));
    expect(data).toEqual([[7]]);
  });

  it('drop closes the real link and reports onClose once', async () => {
    const { inner, fault, handlers, closed } = setup();
    await fault.open(handlers);
    await fault.drop();
    expect(inner.closes).toBe(1);
    expect(inner.isOpen).toBe(false);
    expect(closed()).toBe(1);
    await fault.drop();
    expect(closed()).toBe(1);
  });

  it('forwards a real link loss and ignores one after close', async () => {
    const { inner, fault, handlers, closed } = setup();
    await fault.open(handlers);
    inner.dropLink();
    expect(closed()).toBe(1);
    await fault.open(handlers);
    await fault.close();
    expect(inner.closes).toBe(1);
    expect(closed()).toBe(1);
  });
});
