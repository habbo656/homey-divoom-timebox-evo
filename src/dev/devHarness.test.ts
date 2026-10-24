import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFY_UUID, SERVICE_UUID, WRITE_UUID } from '../transport/BleTransport';
import type {
  BleAdvertisementLike,
  BleCharacteristicLike,
  BleManagerLike,
  BlePeripheralLike,
} from '../transport/BleTransport';
import { opcodeOf, replyFrame, statusFrame } from '../transport/__fixtures__/frames';
import { ConnectionManager } from '../transport/ConnectionManager';
import { MockTransport } from '../transport/MockTransport';
import {
  attachDevLink,
  detachDevLink,
  formatMemory,
  parseDevCommand,
  readMemory,
  registerDevHarness,
} from './devHarness';
import type { DevLink, MemorySource } from './devHarness';
import { FaultTransport } from './FaultTransport';

describe('parseDevCommand', () => {
  it('parses the simple commands', () => {
    for (const kind of ['connect', 'drop', 'mute', 'stop', 'calendar', 'mem'] as const) {
      expect(parseDevCommand(kind)).toEqual({ kind });
    }
  });

  it('parses brightness and poll', () => {
    expect(parseDevCommand('brightness:0')).toEqual({ kind: 'brightness', percent: 0 });
    expect(parseDevCommand('brightness:100')).toEqual({ kind: 'brightness', percent: 100 });
    expect(parseDevCommand('poll:15')).toEqual({ kind: 'poll', seconds: 15 });
    expect(parseDevCommand('poll:3600')).toEqual({ kind: 'poll', seconds: 3600 });
  });

  it('parses channel:N for the simple channels only', () => {
    for (const code of [0, 2, 5, 6]) expect(parseDevCommand(`channel:${code}`)).toEqual({ kind: 'channel', code });
    expect(parseDevCommand('CHANNEL:2#again')).toEqual({ kind: 'channel', code: 2 });
    // 1 lighting and 4 visualization need arguments, 3 does nothing on the Evo.
    for (const bad of [
      'channel:1',
      'channel:3',
      'channel:4',
      'channel:7',
      'channel:',
      'channel:-1',
      'channel:2.5',
      'channel:0002',
      'channel:x',
    ]) {
      expect(parseDevCommand(bad)).toBeNull();
    }
  });

  it('parses time:YYYYMMDDhhmm into date parts with second 0', () => {
    expect(parseDevCommand('time:200101010101')).toEqual({
      kind: 'time',
      parts: { year: 2001, month: 1, day: 1, hour: 1, minute: 1, second: 0 },
    });
    expect(parseDevCommand('TIME:202610062359#2')).toEqual({
      kind: 'time',
      parts: { year: 2026, month: 10, day: 6, hour: 23, minute: 59, second: 0 },
    });
  });

  it('ignores a #suffix, whitespace and case, and accepts {cmd}', () => {
    expect(parseDevCommand('drop#2')).toEqual({ kind: 'drop' });
    expect(parseDevCommand('  MUTE # again ')).toEqual({ kind: 'mute' });
    expect(parseDevCommand({ cmd: 'brightness:30#7' })).toEqual({ kind: 'brightness', percent: 30 });
  });

  it('rejects invalid input', () => {
    for (const bad of [
      'brightness:101',
      'brightness:-1',
      'brightness:',
      'brightness:5.5',
      'poll:9',
      'poll:3601',
      'poll:abc',
      'time:',
      'time:20010101010', // 11 digits
      'time:2001010101011', // 13 digits
      'time:199912312359', // year before 2000
      'time:210001010000', // year after 2099
      'time:200113010101', // month 13
      'time:200102300101', // 30 February
      'time:200101012401', // hour 24
      'time:200101010160', // minute 60
      'reboot',
      '',
      '#drop',
      42,
      null,
      undefined,
      {},
      { cmd: 5 },
    ]) {
      expect(parseDevCommand(bad)).toBeNull();
    }
  });
});

const MB = 1024 * 1024;

/** `process.memoryUsage()` as it behaves in the Homey app sandbox. */
const sandboxMemory: MemorySource = {
  heap: () => ({ used_heap_size: 12.34 * MB, total_heap_size: 20 * MB }),
  usage: () => {
    throw new Error('ENOENT: no such file or directory, uv_resident_set_memory');
  },
};

describe('formatMemory', () => {
  it('formats bytes as MB with one decimal', () => {
    expect(formatMemory({ rss: 52.34 * MB, heapUsed: 10 * MB, heapTotal: 20.05 * MB, external: 0 })).toBe(
      '[dev] memory: rss=52.3 heapUsed=10.0 heapTotal=20.1 external=0.0',
    );
  });

  it('prints n/a for values the runtime cannot report', () => {
    expect(formatMemory({ rss: null, heapUsed: 10 * MB, heapTotal: 20 * MB, external: null })).toBe(
      '[dev] memory: rss=n/a heapUsed=10.0 heapTotal=20.0 external=n/a',
    );
  });
});

describe('readMemory', () => {
  it('takes the heap from the v8 statistics and rss/external from process.memoryUsage()', () => {
    const source: MemorySource = {
      heap: () => ({ used_heap_size: 1 * MB, total_heap_size: 2 * MB }),
      usage: () => ({ rss: 3 * MB, external: 4 * MB }),
    };
    expect(readMemory(source)).toEqual({ heapUsed: 1 * MB, heapTotal: 2 * MB, rss: 3 * MB, external: 4 * MB });
  });

  it('keeps the heap and reports rss/external as null when process.memoryUsage() throws (Homey sandbox)', () => {
    expect(readMemory(sandboxMemory)).toEqual({ heapUsed: 12.34 * MB, heapTotal: 20 * MB, rss: null, external: null });
  });

  it('reads real numbers from the running process by default', () => {
    const m = readMemory();
    expect(m.heapUsed).toBeGreaterThan(0);
    expect(m.heapTotal).toBeGreaterThanOrEqual(m.heapUsed);
  });
});

class FakeChar implements BleCharacteristicLike {
  callback: ((d: Buffer) => void) | null = null;
  constructor(
    readonly uuid: string,
    private readonly onWrite: (d: Buffer) => void = () => undefined,
  ) {}
  async write(d: Buffer) {
    this.onWrite(d);
  }
  async subscribeToNotifications(cb: (d: Buffer) => void) {
    this.callback = cb;
  }
}

function fakeDevice() {
  let brightness = 40;
  const notify = new FakeChar(NOTIFY_UUID);
  const writes: Buffer[] = [];
  const write = new FakeChar(WRITE_UUID, (d) => {
    writes.push(d);
    const op = opcodeOf(Uint8Array.from(d));
    if (op === 0x74) brightness = d[12];
    if (op === 0x46) notify.callback?.(Buffer.from(statusFrame(brightness, 0)));
    if (op === 0x18) notify.callback?.(Buffer.from(replyFrame(0x18)));
  });
  const peripheral = Object.assign(new EventEmitter(), {
    disconnects: 0,
    discoverAllServicesAndCharacteristics: async () => [{ uuid: SERVICE_UUID, characteristics: [write, notify] }],
    async disconnect() {
      this.disconnects++;
    },
  }) as unknown as BlePeripheralLike & { disconnects: number };
  const adv: BleAdvertisementLike = {
    uuid: 'dev-1',
    localName: 'TimeBox-Evo-audio',
    rssi: -40,
    connect: async () => peripheral,
  };
  const ble: BleManagerLike = { find: async () => adv, discover: async () => [adv] };
  return { ble, writes, peripheral, notify };
}

function fakeHomey(ble: BleManagerLike) {
  const emitter = new EventEmitter();
  const store = new Map<string, unknown>();
  store.set('devLink', 'drop#stale');
  return {
    homey: {
      ble,
      settings: {
        on: (e: 'set', l: (key: string) => void) => emitter.on(e, l),
        get: (k: string) => store.get(k),
      },
    },
    set(key: string, value: unknown) {
      store.set(key, value);
      emitter.emit('set', key);
    },
  };
}

describe('registerDevHarness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs ready, ignores the stored value and unrelated keys, reports invalid commands', async () => {
    const logs: string[] = [];
    const { homey, set } = fakeHomey(fakeDevice().ble);
    registerDevHarness(homey, (m) => logs.push(m));
    expect(logs).toEqual(['[dev] harness ready']);
    set('other', 'drop');
    set('devLink', 'bogus');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toEqual(['[dev] harness ready', '[dev] ignored invalid command: "bogus"']);
  });

  it('refuses commands before connect', async () => {
    const logs: string[] = [];
    const { homey, set } = fakeHomey(fakeDevice().ble);
    registerDevHarness(homey, (m) => logs.push(m));
    set('devLink', 'drop');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContain('[dev] command: drop');
    expect(logs).toContain('[dev] not started, send connect first');
  });

  it('connects, sets the brightness, drops the link and stops', async () => {
    const logs: string[] = [];
    const device = fakeDevice();
    const { homey, set } = fakeHomey(device.ble);
    registerDevHarness(homey, (m) => logs.push(m));
    const run = async (cmd: string, ms = 0) => {
      set('devLink', cmd);
      await vi.advanceTimersByTimeAsync(ms);
    };

    await run('connect');
    expect(logs).toContain('[link] poll ok: brightness=40 channel=0');

    await run('brightness:75#1');
    expect(logs).toContain('[dev] command: brightness:75');
    expect(logs).toContain('[dev] status: brightness=75 channel=0');
    expect(device.writes.some((w) => opcodeOf(Uint8Array.from(w)) === 0x74)).toBe(true);

    await run('poll:15');
    expect(logs).toContain('[dev] poll interval 15s');

    await run('drop', 0);
    expect(logs.some((l) => l.startsWith('[link] disconnected: link closed by device'))).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(logs.filter((l) => l.startsWith('[link] connected')).length).toBe(2);

    await run('mute');
    await vi.advanceTimersByTimeAsync(15_000 + 5_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(logs).toContain('[link] link dead, reconnecting');

    await run('stop');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends channel:N as 45 N on the link', async () => {
    const logs: string[] = [];
    const device = fakeDevice();
    const { homey, set } = fakeHomey(device.ble);
    registerDevHarness(homey, (m) => logs.push(m));
    set('devLink', 'connect');
    await vi.advanceTimersByTimeAsync(0);
    device.writes.length = 0;

    set('devLink', 'channel:2');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContain('[dev] command: channel:2');
    expect(logs).toContain('[dev] channel command sent: 45 02');
    expect(Array.from(device.writes[0].subarray(11, 13))).toEqual([0x45, 0x02]);

    set('devLink', 'stop');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('sets the device time and switches to the calendar clock view', async () => {
    const logs: string[] = [];
    const device = fakeDevice();
    const { homey, set } = fakeHomey(device.ble);
    registerDevHarness(homey, (m) => logs.push(m));
    set('devLink', 'connect');
    await vi.advanceTimersByTimeAsync(0);
    device.writes.length = 0;

    set('devLink', 'time:200101010101');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContain('[dev] time set to 2001-01-01 01:01:00');
    // 2001-01-01 was a Monday
    expect(Array.from(device.writes[0].subarray(11, 20))).toEqual([
      0x18, 0x01, 0x14, 0x01, 0x01, 0x01, 0x01, 0x00, 0x01,
    ]);

    device.writes.length = 0;
    set('devLink', 'calendar');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContain('[dev] calendar clock view sent');
    expect(Array.from(Buffer.concat(device.writes).subarray(11, 22))).toEqual([
      0x45, 0, 1, 0, 1, 1, 1, 1, 0xff, 0xff, 0xff,
    ]);

    set('devLink', 'stop');
    await vi.advanceTimersByTimeAsync(0);
  });

  it('logs the process memory in MB with mem, also without a link', async () => {
    const logs: string[] = [];
    const { homey, set } = fakeHomey(fakeDevice().ble);
    registerDevHarness(homey, (m) => logs.push(m));
    set('devLink', 'mem#1');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContain('[dev] command: mem');
    expect(logs.at(-1)).toMatch(/^\[dev\] memory: rss=\d+\.\d heapUsed=\d+\.\d heapTotal=\d+\.\d external=\d+\.\d$/);
    expect(logs).not.toContain('[dev] not started, send connect first');
  });

  it('logs the heap with rss/external n/a with mem where process.memoryUsage() throws (Homey sandbox)', async () => {
    const logs: string[] = [];
    const { homey, set } = fakeHomey(fakeDevice().ble);
    registerDevHarness(homey, (m) => logs.push(m), sandboxMemory);
    set('devLink', 'mem#2');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.at(-1)).toBe('[dev] memory: rss=n/a heapUsed=12.3 heapTotal=20.0 external=n/a');
    expect(logs.some((l) => l.includes('failed'))).toBe(false);
  });

  it('reports a discovery failure with the scan duration (not a transport failure) when no Timebox is found', async () => {
    const logs: string[] = [];
    const scans: Array<number | undefined> = [];
    const ble: BleManagerLike = {
      find: async () => {
        throw new Error('unused');
      },
      discover: (_filter, timeout) => {
        scans.push(timeout);
        return new Promise((resolve) => setTimeout(() => resolve([]), timeout));
      },
    };
    const { homey, set } = fakeHomey(ble);
    registerDevHarness(homey, (m) => logs.push(m));
    set('devLink', 'connect');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toContain('[dev] discovery: no Timebox found after 60 s');
    expect(logs.some((l) => l.includes('failed'))).toBe(false);
    expect(scans).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('device link', () => {
  const attached: DevLink[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    for (const link of attached.splice(0)) {
      detachDevLink(link);
      await link.manager.stop();
    }
    vi.useRealTimers();
  });

  function deviceLink(logs: string[], label = 'dev-uuid') {
    let brightness = 20;
    const transport = new MockTransport();
    transport.autoReply = (w) => {
      const op = opcodeOf(w);
      if (op === 0x74) brightness = w[12];
      if (op === 0x46 || op === 0x74) return [statusFrame(brightness, 0)];
      return undefined;
    };
    const fault = new FaultTransport(transport);
    const manager = new ConnectionManager(fault, {
      random: () => 0,
      log: (m) => logs.push(m),
      error: (m) => logs.push(m),
    });
    const link: DevLink = { manager, fault, label };
    attached.push(link);
    return { link, transport, fault, manager };
  }

  it('refuses connect and stop while a device owns the link and acts on it for the other commands', async () => {
    const logs: string[] = [];
    const scans: unknown[] = [];
    const ble: BleManagerLike = {
      find: async () => {
        throw new Error('unused');
      },
      discover: async (...args) => {
        scans.push(args);
        return [];
      },
    };
    const { homey, set } = fakeHomey(ble);
    registerDevHarness(homey, (m) => logs.push(m));
    const d = deviceLink(logs);
    await attachDevLink(d.link);
    d.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    const run = async (cmd: string, ms = 0) => {
      set('devLink', cmd);
      await vi.advanceTimersByTimeAsync(ms);
    };

    await run('connect', 60_000);
    expect(logs).toContain('[dev] connect refused: device dev-uuid owns the BLE link');
    expect(scans).toEqual([]);

    await run('stop');
    expect(logs).toContain('[dev] stop refused: device dev-uuid owns the BLE link');
    expect(d.manager.state).toBe('connected');

    await run('brightness:75');
    expect(logs).toContain('[dev] status: brightness=75 channel=0');

    await run('poll:15');
    expect(logs).toContain('[dev] poll interval 15s');

    const opens = d.transport.opens;
    await run('drop', 2_000);
    expect(d.transport.opens).toBe(opens + 1);
    expect(d.manager.state).toBe('connected');

    await run('mute');
    expect(d.fault.isMuted).toBe(true);
    expect(logs).toContain('[dev] muted until the next reconnect');
  });

  it('stops the harness link when a device attaches, then acts on the device link only', async () => {
    const logs: string[] = [];
    const own = fakeDevice();
    const { homey, set } = fakeHomey(own.ble);
    registerDevHarness(homey, (m) => logs.push(m));
    set('devLink', 'connect');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toContain('[link] poll ok: brightness=40 channel=0');

    const d = deviceLink(logs);
    await attachDevLink(d.link);
    expect(logs).toContain('[dev] harness link stopped: device took over');
    expect(own.peripheral.disconnects).toBeGreaterThan(0);
    expect(logs.filter((l) => l === '[dev] harness link stopped: device took over')).toHaveLength(1);

    d.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    const writesBefore = own.writes.length;
    set('devLink', 'brightness:30');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContain('[dev] status: brightness=30 channel=0');
    expect(own.writes.length).toBe(writesBefore);

    // A second attach does not log the take-over again.
    await attachDevLink(deviceLink(logs, 'second').link);
    expect(logs.filter((l) => l === '[dev] harness link stopped: device took over')).toHaveLength(1);
  });

  it('a connect whose scan finishes after a device attached is refused', async () => {
    const logs: string[] = [];
    const own = fakeDevice();
    const slow: BleManagerLike = {
      find: own.ble.find,
      discover: (...args) => new Promise((resolve) => setTimeout(() => resolve(own.ble.discover(...args)), 5_000)),
    };
    const { homey, set } = fakeHomey(slow);
    registerDevHarness(homey, (m) => logs.push(m));
    set('devLink', 'connect');
    await vi.advanceTimersByTimeAsync(1_000);
    const d = deviceLink(logs);
    await attachDevLink(d.link);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logs).toContain('[dev] connect refused: device dev-uuid owns the BLE link');
    expect(own.peripheral.disconnects).toBe(0);
  });

  it('is back to "not started" after the device detached', async () => {
    const logs: string[] = [];
    const { homey, set } = fakeHomey(fakeDevice().ble);
    registerDevHarness(homey, (m) => logs.push(m));
    const d = deviceLink(logs);
    await attachDevLink(d.link);
    detachDevLink(d.link);
    set('devLink', 'drop');
    await vi.advanceTimersByTimeAsync(0);
    expect(logs).toContain('[dev] not started, send connect first');
  });
});
