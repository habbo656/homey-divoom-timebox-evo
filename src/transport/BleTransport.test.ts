import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLE_DISCONNECT_TIMEOUT_MS,
  BLE_DUPLICATE_NOTIFY_WINDOW_MS,
  BLE_DUPLICATE_SAME_BUFFER_WINDOW_MS,
  BLE_OPEN_WAIT_MS,
  BleTransport,
  DiscoveryError,
  discoverTimeboxes,
  NOTIFY_UUID,
  scanPeripherals,
  SERVICE_UUID,
  TIMEBOX_DISCOVERY_MIN_SLICE_MS,
  TIMEBOX_DISCOVERY_TIMEOUT_MS,
  WRITE_UUID,
} from './BleTransport';
import type {
  BleAdvertisementLike,
  BleCharacteristicLike,
  BleManagerLike,
  BlePeripheralLike,
  BleServiceLike,
} from './BleTransport';
import { ConnectionManager } from './ConnectionManager';
import { NotConnectedError } from './errors';
import { TransportError } from './Transport';
import type { LinkHandlers } from './Transport';

// Homey reports UUIDs without dashes.
const bare = (uuid: string) => uuid.replace(/-/g, '');

class FakeCharacteristic implements BleCharacteristicLike {
  written: Buffer[] = [];
  callback: ((data: Buffer) => void) | null = null;
  subscribed = false;
  constructor(readonly uuid: string) {}
  async write(data: Buffer) {
    this.written.push(data);
    return Buffer.alloc(0);
  }
  async subscribeToNotifications(cb: (data: Buffer) => void) {
    this.callback = cb;
    this.subscribed = true;
  }
}

class FakePeripheral extends EventEmitter implements BlePeripheralLike {
  disconnects = 0;
  readonly write = new FakeCharacteristic(bare(WRITE_UUID));
  readonly notify = new FakeCharacteristic(bare(NOTIFY_UUID));
  services: BleServiceLike[] = [{ uuid: bare(SERVICE_UUID), characteristics: [this.write, this.notify] }];
  async discoverAllServicesAndCharacteristics() {
    return this.services;
  }
  async disconnect() {
    this.disconnects++;
  }
}

function fakeBle(peripheral = new FakePeripheral()) {
  const adv: BleAdvertisementLike = {
    uuid: 'abc',
    localName: 'TimeBox-Evo-audio',
    rssi: -50,
    connect: async () => peripheral,
  };
  const ble: BleManagerLike = {
    find: vi.fn(async () => adv),
    discover: vi.fn(async () => [adv]),
  };
  return { ble, peripheral, adv };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function handlers() {
  const received: Uint8Array[] = [];
  const h: LinkHandlers & { closed: number } = {
    closed: 0,
    onData: (b) => received.push(b),
    onClose() {
      h.closed++;
    },
  };
  return { h, received };
}

describe('BleTransport', () => {
  it('finds the peripheral, subscribes before open resolves and forwards copies of notifications', async () => {
    const { ble, peripheral } = fakeBle();
    const t = new BleTransport(ble, 'abc');
    const { h, received } = handlers();
    await t.open(h);
    expect(ble.find).toHaveBeenCalledWith('abc');
    expect(peripheral.notify.subscribed).toBe(true);
    const buf = Buffer.from([1, 2, 3]);
    peripheral.notify.callback!(buf);
    buf[0] = 99;
    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(received[0])).toBe(false);
    expect([...received[0]]).toEqual([1, 2, 3]);
  });

  it('accepts UUIDs with dashes and in upper case', async () => {
    const p = new FakePeripheral();
    p.services = [
      {
        uuid: SERVICE_UUID.toUpperCase(),
        characteristics: [new FakeCharacteristic(WRITE_UUID.toUpperCase()), new FakeCharacteristic(NOTIFY_UUID)],
      },
    ];
    const t = new BleTransport(fakeBle(p).ble, 'abc');
    await expect(t.open(handlers().h)).resolves.toBeUndefined();
  });

  it('writes up to 20 bytes and rejects larger writes or writes while closed', async () => {
    const { ble, peripheral } = fakeBle();
    const t = new BleTransport(ble, 'abc');
    await expect(t.write(new Uint8Array(1))).rejects.toBeInstanceOf(NotConnectedError);
    await t.open(handlers().h);
    await t.write(Uint8Array.from({ length: 20 }, (_, i) => i));
    expect(peripheral.write.written).toHaveLength(1);
    expect(peripheral.write.written[0].length).toBe(20);
    await expect(t.write(new Uint8Array(21))).rejects.toBeInstanceOf(RangeError);
  });

  it('reports a missing service as a permanent error and logs the discovered services', async () => {
    const p = new FakePeripheral();
    p.services = [{ uuid: '180a', characteristics: [new FakeCharacteristic('2a29')] }];
    const logs: string[] = [];
    const t = new BleTransport(fakeBle(p).ble, 'abc', (l) => logs.push(l));
    const err = await t.open(handlers().h).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).permanent).toBe(true);
    expect(logs).toEqual(['[ble] services: 180a(2a29)']);
    expect(p.disconnects).toBe(1);
  });

  it('reports a missing characteristic as a permanent error', async () => {
    const p = new FakePeripheral();
    p.services = [{ uuid: bare(SERVICE_UUID), characteristics: [p.write] }];
    const t = new BleTransport(fakeBle(p).ble, 'abc');
    const err = (await t.open(handlers().h).catch((e: unknown) => e)) as TransportError;
    expect(err.permanent).toBe(true);
  });

  it('treats a find() failure as transient', async () => {
    const ble: BleManagerLike = {
      find: async () => {
        throw new Error('not found');
      },
      discover: async () => [],
    };
    const err = await new BleTransport(ble, 'abc').open(handlers().h).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransportError);
  });

  it('calls onClose when the peripheral disconnects, but not after close()', async () => {
    const { ble, peripheral } = fakeBle();
    const t = new BleTransport(ble, 'abc');
    const a = handlers();
    await t.open(a.h);
    peripheral.emit('disconnect');
    expect(a.h.closed).toBe(1);

    const b = handlers();
    await t.open(b.h);
    await t.close();
    peripheral.emit('disconnect');
    expect(b.h.closed).toBe(0);
    expect(peripheral.disconnects).toBeGreaterThanOrEqual(1);
    expect(peripheral.listenerCount('disconnect')).toBe(0);
  });

  it('close() swallows errors and is safe without open', async () => {
    const { ble, peripheral } = fakeBle();
    peripheral.disconnect = async () => {
      throw new Error('already gone');
    };
    const t = new BleTransport(ble, 'abc');
    await expect(t.close()).resolves.toBeUndefined();
    await t.open(handlers().h);
    await expect(t.close()).resolves.toBeUndefined();
    await expect(t.write(new Uint8Array(1))).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('close() during connect cancels the attempt and disconnects the late peripheral', async () => {
    const p = new FakePeripheral();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adv: BleAdvertisementLike = {
      uuid: 'abc',
      localName: 'TimeBox',
      rssi: 0,
      connect: async () => {
        await gate;
        return p;
      },
    };
    const t = new BleTransport({ find: async () => adv, discover: async () => [] }, 'abc');
    const { h } = handlers();
    const opening = t.open(h).catch((e: unknown) => e);
    await tick();
    await t.close();
    release();
    expect(await opening).toBeInstanceOf(TransportError);
    expect(p.disconnects).toBe(1);
    expect(p.notify.subscribed).toBe(false);
  });

  it('serialises a new open behind a pending connect, so a late release cannot disconnect the new peripheral', async () => {
    const a = new FakePeripheral();
    const b = new FakePeripheral();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    let calls = 0;
    const adv: BleAdvertisementLike = {
      uuid: 'abc',
      localName: 'TimeBox',
      rssi: 0,
      connect: async () => {
        const n = ++calls;
        order.push(`connect ${n}`);
        if (n === 1) await gate;
        return n === 1 ? a : b;
      },
    };
    const t = new BleTransport({ find: async () => adv, discover: async () => [] }, 'abc');
    const first = t.open(handlers().h).catch((e: unknown) => e);
    await tick();
    await t.close();
    const second = t.open(handlers().h);
    await tick();
    expect(order).toEqual(['connect 1']); // the second open waits for the first to settle
    release();
    expect(await first).toBeInstanceOf(TransportError);
    await second;
    expect(order).toEqual(['connect 1', 'connect 2']);
    expect(a.disconnects).toBe(1);
    expect(b.disconnects).toBe(0);
    expect(b.notify.subscribed).toBe(true);
    await t.write(new Uint8Array(2));
    expect(b.write.written).toHaveLength(1);
  });

  it('close() while an open is still queued cancels it without connecting', async () => {
    const { ble, peripheral } = fakeBle();
    const t = new BleTransport(ble, 'abc');
    const opening = t.open(handlers().h).catch((e: unknown) => e);
    await t.close();
    expect(await opening).toBeInstanceOf(TransportError);
    expect(ble.find).not.toHaveBeenCalled();
    expect(peripheral.disconnects).toBe(0);
  });

  it('can be reopened after close()', async () => {
    const { ble } = fakeBle();
    const t = new BleTransport(ble, 'abc');
    await t.open(handlers().h);
    await t.close();
    await t.open(handlers().h);
    await t.write(new Uint8Array(3));
  });
});

describe('BleTransport bounded waits (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const never = <T>() => new Promise<T>(() => undefined);

  it('uses a 5 s disconnect bound and a 10 s open wait by default', () => {
    expect(BLE_DISCONNECT_TIMEOUT_MS).toBe(5_000);
    expect(BLE_OPEN_WAIT_MS).toBe(10_000);
  });

  it('rejects an invalid openWaitMs or disconnectTimeoutMs with a RangeError naming the option', () => {
    const { ble } = fakeBle();
    expect(() => new BleTransport(ble, 'abc', undefined, { openWaitMs: Number.NaN })).toThrow(/openWaitMs/);
    expect(() => new BleTransport(ble, 'abc', undefined, { openWaitMs: Number.NaN })).toThrow(RangeError);
    expect(() => new BleTransport(ble, 'abc', undefined, { disconnectTimeoutMs: 2 ** 31 })).toThrow(
      /disconnectTimeoutMs/,
    );
    expect(() => new BleTransport(ble, 'abc', undefined, { disconnectTimeoutMs: 0 })).toThrow(RangeError);
    expect(
      () => new BleTransport(ble, 'abc', undefined, { openWaitMs: 1, disconnectTimeoutMs: 2 ** 31 - 1 }),
    ).not.toThrow();
    expect(() => new BleTransport(ble, 'abc')).not.toThrow();
  });

  it('a hung find() delays the next open by at most openWaitMs, then it connects', async () => {
    const { ble, adv, peripheral } = fakeBle();
    let calls = 0;
    ble.find = vi.fn(() => (++calls === 1 ? never<BleAdvertisementLike>() : Promise.resolve(adv)));
    const logs: string[] = [];
    const t = new BleTransport(ble, 'abc', (l) => logs.push(l));
    void t.open(handlers().h).catch(() => undefined);
    await advance(0);
    await t.close();
    let opened = false;
    void t.open(handlers().h).then(() => (opened = true));
    await advance(BLE_OPEN_WAIT_MS - 1);
    expect(opened).toBe(false);
    expect(ble.find).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(opened).toBe(true);
    expect(ble.find).toHaveBeenCalledTimes(2);
    expect(logs).toContain('[ble] previous connect/disconnect still pending after 10s; opening anyway');
    await t.write(new Uint8Array(1));
    expect(peripheral.write.written).toHaveLength(1);
  });

  it('close() resolves after disconnectTimeoutMs when disconnect() hangs, and a later open succeeds', async () => {
    const { ble, peripheral } = fakeBle();
    peripheral.disconnect = () => never<void>();
    const logs: string[] = [];
    const t = new BleTransport(ble, 'abc', (l) => logs.push(l), { disconnectTimeoutMs: 2_000 });
    await t.open(handlers().h);
    let closed = false;
    void t.close().then(() => (closed = true));
    await advance(1_999);
    expect(closed).toBe(false);
    await advance(1);
    expect(closed).toBe(true);
    expect(logs).toContain('[ble] disconnect did not finish within 2s; continuing');
    await t.open(handlers().h);
    await t.write(new Uint8Array(1));
    expect(ble.find).toHaveBeenCalledTimes(2);
  });

  it('a stale attempt that finishes late does not disconnect the peripheral the newer attempt holds', async () => {
    const p = new FakePeripheral();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    let calls = 0;
    const adv: BleAdvertisementLike = {
      uuid: 'abc',
      localName: 'TimeBox',
      rssi: 0,
      connect: async () => {
        if (++calls === 1) await gate;
        return p; // Homey hands out the same peripheral for the same device
      },
    };
    const logs: string[] = [];
    const t = new BleTransport({ find: async () => adv, discover: async () => [] }, 'abc', (l) => logs.push(l));
    const first = t.open(handlers().h).catch((e: unknown) => e);
    await advance(0);
    await t.close();
    const second = handlers();
    const opening = t.open(second.h);
    await advance(BLE_OPEN_WAIT_MS);
    await opening;
    releaseFirst();
    expect(await first).toBeInstanceOf(TransportError);
    expect(p.disconnects).toBe(0);
    expect(logs).toContain('[ble] stale connect finished late; not disconnecting (a newer attempt owns the link)');
    expect(p.listenerCount('disconnect')).toBe(1);
    p.emit('disconnect');
    expect(second.h.closed).toBe(1);
    await t.write(new Uint8Array(1));
    expect(p.write.written).toHaveLength(1);
  });

  it('with a ConnectionManager: a hung find() still leads to a later successful connect', async () => {
    const { ble, adv } = fakeBle();
    let calls = 0;
    ble.find = vi.fn(() => (++calls === 1 ? never<BleAdvertisementLike>() : Promise.resolve(adv)));
    const logs: string[] = [];
    const t = new BleTransport(ble, 'abc', (l) => logs.push(l));
    const m = new ConnectionManager(t, { random: () => 0, log: (l) => logs.push(l) });
    m.start();
    await advance(30_000); // connect timeout of the hung attempt
    expect(logs).toContain('[link] connect failed: timeout after 30s; retry in 1s');
    await advance(1_000 + BLE_OPEN_WAIT_MS); // backoff, then the bounded wait for the hung find
    expect(ble.find).toHaveBeenCalledTimes(2);
    expect(m.state).toBe('connected');
    await m.stop();
  });

  it('with a ConnectionManager: a hung disconnect() still leads to a later successful connect, and stop() is bounded', async () => {
    const { ble, peripheral } = fakeBle();
    peripheral.disconnect = () => never<void>();
    const logs: string[] = [];
    const t = new BleTransport(ble, 'abc', (l) => logs.push(l));
    const m = new ConnectionManager(t, { random: () => 0, log: (l) => logs.push(l) });
    m.start();
    await advance(0);
    expect(m.state).toBe('connected');
    peripheral.emit('disconnect');
    await advance(BLE_DISCONNECT_TIMEOUT_MS);
    expect(logs).toContain('[ble] disconnect did not finish within 5s; continuing');
    expect(ble.find).toHaveBeenCalledTimes(2);
    expect(m.state).toBe('connected');
    let stopped = false;
    void m.stop().then(() => (stopped = true));
    await advance(BLE_DISCONNECT_TIMEOUT_MS);
    expect(stopped).toBe(true);
  });
});

describe('BleTransport orphaned stale connections (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const STALE_LOG = '[ble] disconnecting a stale connection left by an earlier attempt';
  const HANDOVER_LOG = '[ble] stale connect finished late; not disconnecting (a newer attempt owns the link)';

  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  }
  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Controlled BLE: the n-th `connect()` and the n-th `find()` settle only when the test says so (find: if listed). */
  function rig() {
    const connects: Deferred<BlePeripheralLike>[] = [deferred(), deferred(), deferred()];
    const finds = new Map<number, Deferred<BleAdvertisementLike>>();
    let connectCalls = 0;
    let findCalls = 0;
    const adv: BleAdvertisementLike = {
      uuid: 'abc',
      localName: 'TimeBox',
      rssi: 0,
      connect: () => connects[connectCalls++].promise,
    };
    const ble: BleManagerLike = {
      find: vi.fn(() => finds.get(findCalls++)?.promise ?? Promise.resolve(adv)),
      discover: async () => [],
    };
    const logs: string[] = [];
    const t = new BleTransport(ble, 'abc', (l) => logs.push(l));
    /** Attempt #1 sits in connect(); then close(); then attempt #2 starts after the bounded wait. */
    const staleThenSecond = async (secondFind?: Deferred<BleAdvertisementLike>) => {
      if (secondFind) finds.set(1, secondFind);
      const first = t.open(handlers().h).catch((e: unknown) => e);
      await advance(0);
      await t.close();
      const second = t.open(handlers().h);
      const secondResult = second.then(
        () => 'opened',
        (e: unknown) => e,
      );
      await advance(BLE_OPEN_WAIT_MS);
      return { first, secondResult };
    };
    return { t, ble, connects, finds, logs, staleThenSecond };
  }

  it('A1: a stale peripheral handed to a newer attempt is disconnected once when that attempt fails in find()', async () => {
    const r = rig();
    const find2 = deferred<BleAdvertisementLike>();
    const { first, secondResult } = await r.staleThenSecond(find2);
    const p1 = new FakePeripheral();
    r.connects[0].resolve(p1);
    expect(await first).toBeInstanceOf(TransportError);
    expect(p1.disconnects).toBe(0);
    expect(r.logs).toContain(HANDOVER_LOG);
    find2.reject(new Error('no advertisement'));
    expect(await secondResult).toBeInstanceOf(Error);
    expect(p1.disconnects).toBe(1);
    expect(r.logs).toContain(STALE_LOG);
    await advance(BLE_DISCONNECT_TIMEOUT_MS);
    expect(p1.disconnects).toBe(1);
  });

  it('A2: a newer attempt whose find() hangs frees the orphan on close()', async () => {
    const r = rig();
    const { first } = await r.staleThenSecond(deferred<BleAdvertisementLike>());
    const p1 = new FakePeripheral();
    r.connects[0].resolve(p1);
    await first;
    expect(p1.disconnects).toBe(0);
    await r.t.close();
    expect(p1.disconnects).toBe(1);
    expect(r.logs).toContain(STALE_LOG);
  });

  it('A3: when the newer attempt gets the same peripheral object, close() disconnects it once', async () => {
    const r = rig();
    const { first, secondResult } = await r.staleThenSecond();
    const p1 = new FakePeripheral();
    r.connects[0].resolve(p1);
    await first;
    r.connects[1].resolve(p1);
    expect(await secondResult).toBe('opened');
    expect(p1.disconnects).toBe(0);
    await r.t.close();
    expect(p1.disconnects).toBe(1);
    expect(r.logs).not.toContain(STALE_LOG);
  });

  it('A4: when the newer attempt gets a different peripheral, close() disconnects both', async () => {
    const r = rig();
    const { first, secondResult } = await r.staleThenSecond();
    const p1 = new FakePeripheral();
    const p2 = new FakePeripheral();
    r.connects[0].resolve(p1);
    await first;
    r.connects[1].resolve(p2);
    expect(await secondResult).toBe('opened');
    expect(p1.disconnects).toBe(0);
    expect(p2.disconnects).toBe(0);
    await r.t.close();
    expect(p1.disconnects).toBe(1);
    expect(p2.disconnects).toBe(1);
    expect(r.logs).toContain(STALE_LOG);
  });

  it('A5: orphans of two earlier attempts both reach the third attempt and are disconnected with it', async () => {
    const r = rig();
    r.finds.set(2, deferred<BleAdvertisementLike>()); // the third attempt hangs in find()
    const first = r.t.open(handlers().h).catch((e: unknown) => e); // #1 hangs in connect (connects[0])
    await advance(0);
    await r.t.close();
    void r.t.open(handlers().h).catch(() => undefined); // #2 starts after the bounded wait, hangs in connect (connects[1])
    await advance(BLE_OPEN_WAIT_MS);
    await r.t.close();
    void r.t.open(handlers().h).catch(() => undefined); // #3 starts after the bounded wait
    await advance(BLE_OPEN_WAIT_MS);
    const [p1, p2] = [new FakePeripheral(), new FakePeripheral()];
    r.connects[1].resolve(p2);
    r.connects[0].resolve(p1);
    await first;
    await advance(0);
    expect(p1.disconnects).toBe(0);
    expect(p2.disconnects).toBe(0);
    await r.t.close();
    expect(p1.disconnects).toBe(1);
    expect(p2.disconnects).toBe(1);
    expect(r.logs.filter((l) => l === HANDOVER_LOG)).toHaveLength(2);
  });

  it('orphans are freed by the next open: when the hand-over target link drops, open() disconnects them first', async () => {
    const r = rig();
    const find3 = deferred<BleAdvertisementLike>();
    r.finds.set(2, find3);
    const { first, secondResult } = await r.staleThenSecond();
    const reopen = handlers();
    // attempt #2 connects and is live; the stale #1 then finishes late and hands its peripheral over to it
    const [p1, p2] = [new FakePeripheral(), new FakePeripheral()];
    r.connects[1].resolve(p2);
    expect(await secondResult).toBe('opened');
    r.connects[0].resolve(p1);
    await first;
    expect(r.logs).toContain(HANDOVER_LOG);
    expect(p1.disconnects).toBe(0);
    expect(p2.disconnects).toBe(0);
    // the link of #2 drops, the ConnectionManager opens again: release(prior) frees both before attempt #3 starts
    p2.emit('disconnect');
    const third = r.t.open(reopen.h).catch((e: unknown) => e);
    await advance(0);
    expect(p1.disconnects).toBe(1);
    expect(p2.disconnects).toBe(1);
    expect(r.logs).toContain(STALE_LOG);
    expect(r.ble.find).toHaveBeenCalledTimes(3);
    find3.reject(new Error('no advertisement'));
    expect(await third).toBeInstanceOf(Error);
    expect(p1.disconnects).toBe(1);
    expect(p2.disconnects).toBe(1);
  });

  it('a hung disconnect of an orphan stays bounded by disconnectTimeoutMs and the next open still connects', async () => {
    const r = rig();
    const { first } = await r.staleThenSecond(deferred<BleAdvertisementLike>());
    const p1 = new FakePeripheral();
    p1.disconnect = () => new Promise<void>(() => undefined);
    r.connects[0].resolve(p1);
    await first;
    let closed = false;
    void r.t.close().then(() => (closed = true));
    await advance(BLE_DISCONNECT_TIMEOUT_MS - 1);
    expect(closed).toBe(false);
    await advance(1);
    expect(closed).toBe(true);
    expect(r.logs).toContain('[ble] disconnect did not finish within 5s; continuing');
    r.connects[1].resolve(new FakePeripheral());
    const reopened = r.t.open(handlers().h);
    await advance(BLE_OPEN_WAIT_MS); // the hung find() of attempt #2 is waited for at most openWaitMs
    await reopened;
    await r.t.write(new Uint8Array(1));
  });
});

describe('BleTransport duplicate notifications', () => {
  async function opened(now: () => number, logs: string[] = []) {
    const { ble, peripheral } = fakeBle();
    const t = new BleTransport(ble, 'abc', (l) => logs.push(l), { now });
    const { h, received } = handlers();
    await t.open(h);
    return { t, h, received, peripheral, ble };
  }

  it('delivers one copy when Homey calls back 5 times with the same Buffer object', async () => {
    const logs: string[] = [];
    let clock = 0;
    const { received, peripheral } = await opened(() => clock, logs);
    const buf = Buffer.from([1, 2, 3]);
    for (let i = 0; i < 5; i++) {
      clock += 100; // beyond the 20 ms window: only the object identity identifies the copies
      peripheral.notify.callback!(buf);
    }
    expect(received).toHaveLength(1);
    expect([...received[0]]).toEqual([1, 2, 3]);
    expect(logs.filter((l) => l.includes('duplicate notification dropped'))).toEqual([
      '[ble] duplicate notification dropped (Homey delivered it more than once)',
    ]);
  });

  it('does not drop later identical replies when Homey reuses one Buffer object', async () => {
    let clock = 0;
    const { received, peripheral } = await opened(() => clock);
    const buf = Buffer.from([1, 2, 3]);
    peripheral.notify.callback!(buf);
    clock += BLE_DUPLICATE_SAME_BUFFER_WINDOW_MS; // still a duplicate at the edge
    peripheral.notify.callback!(buf);
    expect(received).toHaveLength(1);
    clock += BLE_DUPLICATE_SAME_BUFFER_WINDOW_MS + 1;
    peripheral.notify.callback!(buf);
    expect(received).toHaveLength(2);
  });

  it('accepts a plain Uint8Array (and a Buffer view into a larger ArrayBuffer) without throwing', async () => {
    let clock = 0;
    const { received, peripheral } = await opened(() => clock);
    const call = peripheral.notify.callback as unknown as (data: Uint8Array) => void;
    call(Uint8Array.of(1, 2, 3));
    call(Uint8Array.of(1, 2, 3));
    expect(received.map((r) => [...r])).toEqual([[1, 2, 3]]);
    clock += 100;
    const backing = Buffer.from([9, 1, 2, 3, 9]);
    call(backing.subarray(1, 4)); // equal bytes, but past the window: delivered with the right slice
    expect(received.map((r) => [...r])).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
  });

  it('delivers one copy for 5 equal Buffers within the window', async () => {
    let clock = 0;
    const { received, peripheral } = await opened(() => clock);
    for (let i = 0; i < 5; i++) {
      peripheral.notify.callback!(Buffer.from([1, 2, 3]));
      clock += 4; // 0, 4, 8, 12, 16 ms after the first
    }
    expect(received).toHaveLength(1);
  });

  it('delivers equal bytes again once the window has passed', async () => {
    let clock = 0;
    const { received, peripheral } = await opened(() => clock);
    peripheral.notify.callback!(Buffer.from([1, 2, 3]));
    clock += BLE_DUPLICATE_NOTIFY_WINDOW_MS;
    peripheral.notify.callback!(Buffer.from([1, 2, 3])); // exactly at the window edge: still a duplicate
    expect(received).toHaveLength(1);
    clock += 1;
    peripheral.notify.callback!(Buffer.from([1, 2, 3]));
    expect(received).toHaveLength(2);
  });

  it('delivers different bytes within the window', async () => {
    const { received, peripheral } = await opened(() => 0);
    peripheral.notify.callback!(Buffer.from([1, 2, 3]));
    peripheral.notify.callback!(Buffer.from([1, 2, 4]));
    peripheral.notify.callback!(Buffer.from([1, 2, 3]));
    expect(received.map((r) => [...r])).toEqual([
      [1, 2, 3],
      [1, 2, 4],
      [1, 2, 3],
    ]);
  });

  it('does not treat a reused Buffer object with new content as a duplicate', async () => {
    const { received, peripheral } = await opened(() => 0);
    const buf = Buffer.from([1, 2, 3]);
    peripheral.notify.callback!(buf);
    buf[2] = 9;
    peripheral.notify.callback!(buf);
    expect(received.map((r) => [...r])).toEqual([
      [1, 2, 3],
      [1, 2, 9],
    ]);
  });

  it('resets per attempt: open/close/open forwards only the current attempt data', async () => {
    const first = new FakePeripheral();
    const second = new FakePeripheral();
    const peripherals = [first, second];
    let n = 0;
    const adv: BleAdvertisementLike = {
      uuid: 'abc',
      localName: 'TimeBox',
      rssi: 0,
      connect: async () => peripherals[n++],
    };
    const t = new BleTransport({ find: async () => adv, discover: async () => [] }, 'abc', () => undefined, {
      now: () => 0,
    });
    const a = handlers();
    await t.open(a.h);
    first.notify.callback!(Buffer.from([1]));
    await t.close();
    const b = handlers();
    await t.open(b.h);
    first.notify.callback!(Buffer.from([2])); // stale subscription of the closed attempt
    second.notify.callback!(Buffer.from([1])); // equal to the old attempt's last frame, but a new link
    expect(a.received.map((r) => [...r])).toEqual([[1]]);
    expect(b.received.map((r) => [...r])).toEqual([[1]]);
  });

  it('logs the discovered services once per successful connect', async () => {
    const logs: string[] = [];
    const { t, h } = await opened(() => 0, logs);
    expect(logs.filter((l) => l.startsWith('[ble] services: '))).toHaveLength(1);
    expect(logs.find((l) => l.startsWith('[ble] services: '))).toContain(bare(SERVICE_UUID));
    await t.close();
    await t.open(h);
    expect(logs.filter((l) => l.startsWith('[ble] services: '))).toHaveLength(2);
  });
});

describe('discoverTimeboxes', () => {
  const adv = (localName: string, rssi: number): BleAdvertisementLike => ({
    uuid: localName + rssi,
    localName,
    rssi,
    connect: async () => {
      throw new Error('unused');
    },
  });

  /** A fake manager and clock: every `discover` call advances the clock by its timeout, as the real scan would. */
  function scanner(scans: Array<BleAdvertisementLike[] | Error>) {
    let clock = 0;
    const calls: Array<{ filter?: string[]; timeout?: number }> = [];
    const ble: BleManagerLike = {
      find: async () => {
        throw new Error('unused');
      },
      discover: async (filter, timeout) => {
        calls.push({ filter, timeout });
        clock += timeout ?? 10_000;
        const next = scans[calls.length - 1] ?? [];
        if (next instanceof Error) throw next;
        return next;
      },
    };
    return { ble, calls, now: () => clock };
  }

  it('uses a 60 s budget by default', () => {
    expect(TIMEBOX_DISCOVERY_TIMEOUT_MS).toBe(60_000);
  });

  it('keeps Timebox names (case-insensitive), sorted by signal strength, and stops after the first scan', async () => {
    const s = scanner([
      [adv('TimeBox-Evo-light', -80), adv('Phone', -30), adv('timebox-evo-audio', -45), adv('', -20)],
      [adv('TimeBox-Evo-light', -10)],
    ]);
    const found = await discoverTimeboxes(s.ble, { now: s.now });
    expect(found.map((a) => a.localName)).toEqual(['timebox-evo-audio', 'TimeBox-Evo-light']);
    expect(s.calls).toEqual([{ filter: undefined, timeout: 10_000 }]);
  });

  it('keeps scanning when a scan sees no Timebox and stops at the one that does', async () => {
    const s = scanner([[adv('Phone', -30)], [], [adv('TimeBox-Evo-light', -50)], [adv('TimeBox-Evo-audio', -20)]]);
    const found = await discoverTimeboxes(s.ble, { now: s.now });
    expect(found.map((a) => a.localName)).toEqual(['TimeBox-Evo-light']);
    expect(s.calls).toHaveLength(3);
  });

  it('throws a DiscoveryError with the scan duration when nothing is found within the budget', async () => {
    const s = scanner([]);
    const error = await discoverTimeboxes(s.ble, { now: s.now }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).message).toBe('discovery: no Timebox found after 60 s');
    expect((error as DiscoveryError).scannedMs).toBe(60_000);
    expect(s.calls.map((c) => c.timeout)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
  });

  it('shortens the last scan to the remaining budget', async () => {
    const s = scanner([]);
    await expect(discoverTimeboxes(s.ble, { now: s.now, timeoutMs: 25_000 })).rejects.toThrow('after 25 s');
    expect(s.calls.map((c) => c.timeout)).toEqual([10_000, 10_000, 5_000]);
  });

  it('pads a scan that returns early to the minimum slice length instead of spinning', async () => {
    let clock = 0;
    const timeouts: Array<number | undefined> = [];
    const pauses: number[] = [];
    const ble: BleManagerLike = {
      find: async () => {
        throw new Error('unused');
      },
      discover: async (_filter, timeout) => {
        timeouts.push(timeout);
        clock += 400; // returns long before its 10 s timeout
        return [];
      },
    };
    const sleep = async (ms: number) => {
      pauses.push(ms);
      clock += ms;
    };
    const error = await discoverTimeboxes(ble, { now: () => clock, sleep, timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect(TIMEBOX_DISCOVERY_MIN_SLICE_MS).toBe(1_000);
    expect((error as DiscoveryError).message).toBe('discovery: no Timebox found after 5 s');
    expect(timeouts).toEqual([5_000, 4_000, 3_000, 2_000, 1_000]);
    expect(pauses).toEqual([600, 600, 600, 600, 600]);
  });

  it('never pauses past the budget and not after a full-length scan', async () => {
    const s = scanner([]);
    const sleep = vi.fn(async () => undefined);
    await expect(discoverTimeboxes(s.ble, { now: s.now, sleep, timeoutMs: 25_000 })).rejects.toThrow('after 25 s');
    expect(sleep).not.toHaveBeenCalled();
    let clock = 0;
    const pauses: number[] = [];
    const ble: BleManagerLike = { ...s.ble, discover: async () => [] };
    await discoverTimeboxes(ble, {
      now: () => clock,
      sleep: async (ms) => {
        pauses.push(ms);
        clock += ms;
      },
      timeoutMs: 2_500,
    }).catch(() => undefined);
    expect(pauses).toEqual([1_000, 1_000, 500]);
  });

  it('wraps a failing scan in a DiscoveryError with the elapsed time', async () => {
    const s = scanner([[], new Error('radio off')]);
    const error = await discoverTimeboxes(s.ble, { now: s.now }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).message).toBe('discovery: scan failed after 20 s: radio off');
    expect((error as DiscoveryError).scannedMs).toBe(20_000);
    expect(s.calls).toHaveLength(2);
  });
});

describe('scanPeripherals', () => {
  const adv = (uuid: string): BleAdvertisementLike => ({
    uuid,
    localName: '',
    rssi: -50,
    connect: async () => {
      throw new Error('unused');
    },
  });

  function scanner(scans: Array<BleAdvertisementLike[] | Error> = [], durationMs?: number) {
    let clock = 0;
    const calls: number[] = [];
    const ble: BleManagerLike = {
      find: async () => {
        throw new Error('unused');
      },
      discover: async (_filter, timeout) => {
        calls.push(timeout ?? 0);
        clock += durationMs ?? timeout ?? 10_000;
        const next = scans[calls.length - 1] ?? [];
        if (next instanceof Error) throw next;
        return next;
      },
    };
    return { ble, calls, now: () => clock, advance: (ms: number) => (clock += ms) };
  }

  it('runs the whole 60 s budget in 6 slices of 10 s and reports every slice', async () => {
    const s = scanner([[adv('a')], [adv('b')]]);
    const slices: string[][] = [];
    const result = await scanPeripherals(s.ble, {
      now: s.now,
      onSlice: (ads, elapsed) => {
        slices.push([...ads.map((a) => a.uuid), String(elapsed)]);
      },
    });
    expect(s.calls).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(result).toEqual({ elapsedMs: 60_000, ended: 'budget' });
    expect(slices).toHaveLength(6);
    expect(slices[0]).toEqual(['a', '10000']);
    expect(slices[1]).toEqual(['b', '20000']);
  });

  it('ends early when onSlice returns true', async () => {
    const s = scanner();
    const result = await scanPeripherals(s.ble, { now: s.now, onSlice: (_ads, elapsed) => elapsed >= 20_000 });
    expect(s.calls).toHaveLength(2);
    expect(result).toEqual({ elapsedMs: 20_000, ended: 'stopped' });
  });

  it('stops when cancelled, between slices and without delivering the slice that finished meanwhile', async () => {
    const s = scanner();
    let cancelled = false;
    const onSlice = vi.fn();
    const result = await scanPeripherals(s.ble, {
      now: s.now,
      isCancelled: () => cancelled,
      onSlice: (...args) => {
        onSlice(...args);
        if (onSlice.mock.calls.length === 2) cancelled = true;
      },
    });
    expect(result.ended).toBe('cancelled');
    expect(s.calls).toHaveLength(2);
    expect(onSlice).toHaveBeenCalledTimes(2);

    // cancelled while a slice is in flight: that slice is dropped
    const t = scanner();
    let flag = false;
    const ble: BleManagerLike = {
      ...t.ble,
      discover: async (f, timeout) => {
        const r = await t.ble.discover(f, timeout);
        flag = true;
        return r;
      },
    };
    const late = vi.fn();
    const r2 = await scanPeripherals(ble, { now: t.now, isCancelled: () => flag, onSlice: late });
    expect(r2.ended).toBe('cancelled');
    expect(late).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(1);
  });

  it('does not scan at all when already cancelled', async () => {
    const s = scanner();
    const result = await scanPeripherals(s.ble, { now: s.now, isCancelled: () => true });
    expect(result).toEqual({ elapsedMs: 0, ended: 'cancelled' });
    expect(s.calls).toHaveLength(0);
  });

  it('throws a DiscoveryError when a slice fails', async () => {
    const s = scanner([[], new Error('radio off')]);
    const onSlice = vi.fn();
    const error = await scanPeripherals(s.ble, { now: s.now, onSlice }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscoveryError);
    expect((error as DiscoveryError).message).toBe('discovery: scan failed after 20 s: radio off');
    expect((error as DiscoveryError).scannedMs).toBe(20_000);
    expect(onSlice).toHaveBeenCalledTimes(1);
  });

  it('pads a slice that returns early and shortens the last slice to the remaining budget', async () => {
    const s = scanner([], 400);
    const pauses: number[] = [];
    const result = await scanPeripherals(s.ble, {
      now: s.now,
      timeoutMs: 2_500,
      sleep: async (ms) => {
        pauses.push(ms);
        s.advance(ms);
      },
    });
    expect(pauses).toEqual([600, 600, 100]);
    expect(s.calls).toEqual([2_500, 1_500, 500]);
    expect(result).toEqual({ elapsedMs: 2_500, ended: 'budget' });
  });
});
