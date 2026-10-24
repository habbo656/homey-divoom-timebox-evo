import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { NOTIFY_UUID, SERVICE_UUID, WRITE_UUID } from '../transport/BleTransport';
import type {
  BleAdvertisementLike,
  BleCharacteristicLike,
  BleManagerLike,
  BlePeripheralLike,
  BleServiceLike,
} from '../transport/BleTransport';
import { opcodeOf, statusFrame } from '../transport/__fixtures__/frames';
import {
  PAIR_MAX_CANDIDATES,
  PAIR_SCAN_TIMEOUT_MS,
  PAIR_VERIFY_TIMEOUT_MS,
  registerPairHandlers,
  selectCandidates,
  verifyTimebox,
} from './pairing';
import type { PairSessionLike, ScanUpdate, VerifyUpdate } from './pairing';

const bare = (uuid: string) => uuid.replace(/-/g, '');

const advert = (uuid: string, rssi: number, extra: Partial<BleAdvertisementLike> = {}): BleAdvertisementLike => ({
  uuid,
  localName: '',
  rssi,
  connect: async () => {
    throw new Error('unused');
  },
  ...extra,
});

const ISSC = [bare(SERVICE_UUID)];

describe('constants', () => {
  it('scans for 60 s and verifies for up to 45 s', () => {
    expect(PAIR_SCAN_TIMEOUT_MS).toBe(60_000);
    expect(PAIR_VERIFY_TIMEOUT_MS).toBe(45_000);
  });
});

describe('selectCandidates', () => {
  const ids = (list: { id: string }[]) => list.map((c) => c.id);

  it('flags devices whose name matches timebox/divoom/evo (case-insensitive) and lists them first', () => {
    const list = selectCandidates([
      advert('p1', -40, { localName: 'Some Speaker' }),
      advert('p2', -70, { localName: 'TimeBox-Evo-light' }),
      advert('p3', -60, { localName: 'DIVOOM-Ditoo' }),
      advert('p4', -30, { localName: 'my EVO' }),
      advert('p5', -50, { localName: 'TIMEBOX' }),
    ]);
    expect(list.map((c) => [c.id, c.match])).toEqual([
      ['p4', true],
      ['p5', true],
      ['p3', true],
      ['p2', true],
      ['p1', false],
    ]);
    expect(list[3]).toMatchObject({ name: 'TimeBox-Evo-light', issc: false, rssi: -70 });
  });

  it('puts the non-matching named devices after the matching ones, sorted alphabetically (not by signal)', () => {
    const list = selectCandidates([
      advert('z', -20, { localName: 'zebra' }),
      advert('b', -90, { localName: 'Beta' }),
      advert('evo', -95, { localName: 'TimeBox-Evo-audio' }),
      advert('a', -80, { localName: 'alpha' }),
    ]);
    expect(ids(list)).toEqual(['evo', 'a', 'b', 'z']);
    expect(list.map((c) => c.match)).toEqual([true, false, false, false]);
  });

  it('never lists unnamed devices, whatever their signal, address or services', () => {
    const list = selectCandidates([
      advert('apple', -20),
      advert('addr', -30, { address: 'AA:BB' }),
      advert('blank', -25, { localName: '   ' }),
      advert('issc', -35, { serviceUuids: ISSC }),
      advert('named', -80, { localName: 'Evo' }),
    ]);
    expect(ids(list)).toEqual(['named']);
  });

  it('treats the ISSC service as an extra positive signal for a named device with another name', () => {
    const list = selectCandidates([
      advert('p1', -70, { localName: 'Kitchen Display', serviceUuids: ISSC }),
      advert('p2', -30, { localName: 'Speaker' }),
    ]);
    expect(list.map((c) => [c.id, c.match, c.issc])).toEqual([
      ['p1', true, true],
      ['p2', false, false],
    ]);
  });

  it('de-duplicates by uuid, keeping the latest rssi and the last non-empty name', () => {
    const list = selectCandidates([
      advert('p1', -80, { localName: 'First' }),
      advert('p1', -50, { localName: '' }),
      advert('p1', -55, { localName: 'Second', address: 'AA' }),
      advert('p1', -45),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'p1', name: 'Second', rssi: -45, address: 'AA' });
  });

  it('merges service uuids and the name over several advertisements (the Evo alternates -audio/-light)', () => {
    const list = selectCandidates([
      advert('p1', -50, { serviceUuids: ISSC }),
      advert('p1', -50, { serviceUuids: [], localName: 'Odd' }),
      advert('p1', -50, { localName: 'TimeBox-Evo-light' }),
    ]);
    expect(list).toMatchObject([{ id: 'p1', name: 'TimeBox-Evo-light', match: true, issc: true }]);
  });

  it('excludes paired ids and normalises uuids (case, dashes)', () => {
    const list = selectCandidates(
      [advert('AB-CD', -40, { localName: 'Evo' }), advert('ef01', -50, { localName: 'Evo 2' })],
      ['abcd'],
    );
    expect(ids(list)).toEqual(['ef01']);
    expect(ids(selectCandidates([advert('p1', -40, { localName: 'Evo' })], ['P1']))).toEqual([]);
  });

  it('caps the list at 30 candidates; matching devices are never cut off by others', () => {
    const ads = [
      ...Array.from({ length: 50 }, (_, i) =>
        advert(`o${i}`, -50, { localName: `Other ${String(i).padStart(2, '0')}` }),
      ),
      advert('evo', -99, { localName: 'TimeBox-Evo-light' }),
    ];
    const list = selectCandidates(ads);
    expect(list).toHaveLength(PAIR_MAX_CANDIDATES);
    expect(list[0].id).toBe('evo');
    expect(list[1].id).toBe('o0');
  });

  it('ignores malformed entries', () => {
    expect(
      ids(selectCandidates([advert('', -10, { localName: 'Evo' }), advert('ok', -20, { localName: 'Evo' })])),
    ).toEqual(['ok']);
  });
});

// --- fakes ----------------------------------------------------------------------------------------------------------

class FakeCharacteristic implements BleCharacteristicLike {
  callback: ((data: Buffer) => void) | null = null;
  constructor(
    readonly uuid: string,
    private readonly onWrite?: (data: Buffer) => void,
  ) {}
  async write(data: Buffer) {
    this.onWrite?.(data);
    return Buffer.alloc(0);
  }
  async subscribeToNotifications(cb: (data: Buffer) => void) {
    this.callback = cb;
  }
}

class FakePeripheral extends EventEmitter implements BlePeripheralLike {
  disconnects = 0;
  readonly notify = new FakeCharacteristic(bare(NOTIFY_UUID));
  readonly write: FakeCharacteristic;
  services: BleServiceLike[];
  constructor(answer: boolean) {
    super();
    this.write = new FakeCharacteristic(bare(WRITE_UUID), (data) => {
      if (answer && opcodeOf(data) === 0x46) {
        queueMicrotask(() => this.notify.callback?.(Buffer.from(statusFrame(70, 3))));
      }
    });
    this.services = [{ uuid: bare(SERVICE_UUID), characteristics: [this.write, this.notify] }];
  }
  async discoverAllServicesAndCharacteristics() {
    return this.services;
  }
  async disconnect() {
    this.disconnects++;
  }
}

interface FakeBle extends BleManagerLike {
  slices: Array<BleAdvertisementLike[] | Error>;
  discovers: number;
  clock: number;
  /** When set, the next discover waits for it (a slice in flight). */
  gate: Promise<void> | null;
  peripheral: FakePeripheral;
}

function fakeBle(options: { answer?: boolean } = {}): FakeBle {
  const peripheral = new FakePeripheral(options.answer ?? true);
  const adv = advert('dev', -40, { connect: async () => peripheral });
  const ble: FakeBle = {
    slices: [],
    discovers: 0,
    clock: 0,
    gate: null,
    peripheral,
    find: async () => adv,
    discover: async (_filter, timeout) => {
      const index = ble.discovers++;
      const gate = ble.gate;
      ble.gate = null;
      if (gate) await gate;
      ble.clock += timeout ?? 10_000;
      const next = ble.slices[index] ?? [];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return ble;
}

function fakeSession() {
  const handlers = new Map<string, (data?: unknown) => Promise<unknown>>();
  const emitted: Array<{ event: string; data: unknown }> = [];
  const session: PairSessionLike & { failEmit: boolean } = {
    failEmit: false,
    setHandler(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, data) {
      emitted.push({ event, data });
      return session.failEmit ? Promise.reject(new Error('view gone')) : Promise.resolve();
    },
  };
  return {
    session,
    emitted,
    call: async (event: string, data?: unknown) => handlers.get(event)!(data),
    updates: () => emitted.filter((e) => e.event === 'scan_update').map((e) => e.data as ScanUpdate),
    results: () => emitted.filter((e) => e.event === 'verify_result').map((e) => e.data as VerifyUpdate),
  };
}

function setup(options: { answer?: boolean; paired?: string[]; verifyTimeoutMs?: number } = {}) {
  const ble = fakeBle({ answer: options.answer });
  const s = fakeSession();
  const logs: string[] = [];
  registerPairHandlers(s.session, {
    ble,
    pairedIds: () => options.paired ?? [],
    log: (m) => logs.push(m),
    now: () => ble.clock,
    sleep: async (ms) => {
      ble.clock += ms;
    },
    verifyTimeoutMs: options.verifyTimeoutMs,
  });
  return { ble, logs, ...s };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const untilState = async (s: { updates: () => ScanUpdate[] }, state: ScanUpdate['state']) =>
  vi.waitFor(() => expect(s.updates().some((u) => u.state === state)).toBe(true));

// --- registerPairHandlers: scan -----------------------------------------------------------------------------------

describe('pair scan', () => {
  it('returns at once with the duration, scans 6 slices of 10 s and reports the list after each slice and at the end', async () => {
    const t = setup();
    t.ble.slices = [
      [advert('p1', -60, { localName: 'Odd Name', serviceUuids: ISSC })],
      [advert('p1', -50)],
      [advert('apple', -20)],
    ];
    await expect(t.call('scan')).resolves.toEqual({ durationMs: 60_000 });
    await untilState(t, 'done');
    const updates = t.updates();
    expect(updates).toHaveLength(7); // 6 slices + done
    expect(updates.slice(0, 6).every((u) => u.state === 'scanning' && u.durationMs === 60_000)).toBe(true);
    expect(updates.map((u) => u.elapsedMs)).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 60_000]);
    expect(updates[0].candidates).toMatchObject([{ id: 'p1', name: 'Odd Name', match: true, issc: true, rssi: -60 }]);
    expect(updates[1].candidates[0].rssi).toBe(-50);
    expect(updates[6]).toMatchObject({ state: 'done' });
    expect(updates[6].candidates.map((c) => c.id)).toEqual(['p1']); // the unnamed device is never listed
    expect(updates[6].error).toBeUndefined();
    expect(t.ble.discovers).toBe(6);
  });

  it('reports an empty list without an error when nothing is found', async () => {
    const t = setup();
    await t.call('scan');
    await untilState(t, 'done');
    const last = t.updates().at(-1)!;
    expect(last).toMatchObject({ state: 'done', candidates: [] });
    expect(last.error).toBeUndefined();
    expect(t.logs).toContain('[pair] scan finished after 60 s: 0 matching, 0 other named device(s)');
  });

  it('finds a late device after a rescan and excludes paired ones', async () => {
    const t = setup({ paired: ['old'] });
    await t.call('scan');
    await untilState(t, 'done');
    expect(t.updates().at(-1)!.candidates).toEqual([]);
    t.emitted.length = 0;
    t.ble.slices = [];
    t.ble.discovers = 0;
    t.ble.slices = [
      [],
      [],
      [advert('old', -20, { localName: 'TimeBox-Evo-audio' }), advert('late', -55, { localName: 'TimeBox-Evo-light' })],
    ];
    await t.call('scan');
    await untilState(t, 'done');
    expect(
      t
        .updates()
        .at(-1)!
        .candidates.map((c) => c.id),
    ).toEqual(['late']);
  });

  it('logs slices, the finish line and the top 5 candidates (matching first)', async () => {
    const t = setup();
    t.ble.slices = [
      Array.from({ length: 8 }, (_, i) =>
        advert(`p${i}`, -30 - i, {
          localName: i === 3 ? 'TimeBox-Evo-light' : `N${i}`,
          serviceUuids: i === 0 ? ISSC : [],
        }),
      ),
    ];
    await t.call('scan');
    await untilState(t, 'done');
    expect(t.logs[0]).toBe('[pair] scan started (60 s)');
    expect(t.logs[1]).toBe('[pair] slice: 8 peripherals, 1 advertise ISSC');
    expect(t.logs).toContain('[pair] scan finished after 60 s: 2 matching, 6 other named device(s)');
    const lines = t.logs.filter((l) => l.startsWith('[pair] candidate '));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(`[pair] candidate uuid=p0 name="N0" match=true rssi=-30 issc=true serviceUuids=${ISSC[0]}`);
    expect(lines[1]).toBe(
      '[pair] candidate uuid=p3 name="TimeBox-Evo-light" match=true rssi=-33 issc=false serviceUuids=-',
    );
    expect(lines[2]).toContain('name="N1" match=false');
  });

  it('stops the scan on disconnect: no more slices and no final update', async () => {
    const t = setup();
    let release!: () => void;
    t.ble.gate = new Promise<void>((r) => (release = r));
    await t.call('scan');
    await flush();
    expect(t.ble.discovers).toBe(1);
    const disconnecting = t.call('disconnect');
    release();
    await disconnecting;
    await flush();
    expect(t.ble.discovers).toBe(1);
    expect(t.updates()).toEqual([]);
  });

  it('cancels the running scan when a new one starts', async () => {
    const t = setup();
    let release!: () => void;
    t.ble.gate = new Promise<void>((r) => (release = r));
    await t.call('scan');
    await flush();
    const second = t.call('scan');
    release();
    await second;
    await untilState(t, 'done');
    // the first scan produced no update (cancelled after its slice); the second ran all 6 slices
    expect(t.updates().filter((u) => u.state === 'done')).toHaveLength(1);
    expect(t.updates()).toHaveLength(7);
    expect(t.ble.discovers).toBe(7);
  });

  it('reports a failing scan as failed with the message', async () => {
    const t = setup();
    t.ble.slices = [[advert('p1', -50, { localName: 'Evo' })], new Error('radio off')];
    await t.call('scan');
    await untilState(t, 'failed');
    const last = t.updates().at(-1)!;
    expect(last).toMatchObject({ state: 'failed', elapsedMs: 20_000 });
    expect(last.error).toBe('discovery: scan failed after 20 s: radio off');
    expect(last.candidates.map((c) => c.id)).toEqual(['p1']);
    expect(t.updates().some((u) => u.state === 'done')).toBe(false);
  });

  it('swallows rejected emits', async () => {
    const t = setup();
    t.session.failEmit = true;
    await t.call('scan');
    await untilState(t, 'done');
    await flush();
    expect(t.updates().at(-1)!.state).toBe('done');
  });
});

// --- verify -------------------------------------------------------------------------------------------------------

describe('verifyTimebox', () => {
  it('is ok on the first status reply and disconnects the peripheral afterwards', async () => {
    const ble = fakeBle();
    const result = await verifyTimebox(ble, 'dev', { timeoutMs: 2_000 });
    expect(result).toMatchObject({ ok: true, status: { brightness: 70, channel: 3 } });
    expect(ble.peripheral.disconnects).toBe(1);
  });

  it('fails fast as not_timebox when the ISSC service is missing', async () => {
    const ble = fakeBle();
    ble.peripheral.services = [{ uuid: '180f', characteristics: [] }];
    const started = Date.now();
    const result = await verifyTimebox(ble, 'dev', { timeoutMs: 30_000 });
    expect(result).toEqual({ ok: false, reason: 'not_timebox' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ble.peripheral.disconnects).toBeGreaterThanOrEqual(1);
  });

  it('times out when the device never answers, and still disconnects', async () => {
    const ble = fakeBle({ answer: false });
    const result = await verifyTimebox(ble, 'dev', { timeoutMs: 150 });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(ble.peripheral.disconnects).toBeGreaterThanOrEqual(1);
  });

  it('ends early when aborted', async () => {
    const ble = fakeBle({ answer: false });
    const abort = new AbortController();
    const pending = verifyTimebox(ble, 'dev', { timeoutMs: 30_000, signal: abort.signal });
    await flush();
    abort.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(ble.peripheral.disconnects).toBeGreaterThanOrEqual(1);
  });
});

describe('pair verify handler', () => {
  it('returns at once and emits verify_result with the device (name from the scan, data.id)', async () => {
    const t = setup();
    t.ble.slices = [[advert('dev', -40, { localName: 'TimeBox-Evo-audio', serviceUuids: ISSC })]];
    await t.call('scan');
    await untilState(t, 'done');
    await expect(t.call('verify', { id: 'dev' })).resolves.toEqual({ started: true });
    await vi.waitFor(() => expect(t.results()).toHaveLength(1));
    expect(t.results()[0]).toEqual({ ok: true, device: { name: 'TimeBox-Evo-audio', data: { id: 'dev' } } });
    expect(t.logs).toContain('[pair] verified dev: brightness=70 channel=3');
    expect(t.ble.peripheral.disconnects).toBe(1);
  });

  it('waits for the in-flight scan slice before it connects', async () => {
    const t = setup();
    let release!: () => void;
    t.ble.gate = new Promise<void>((r) => (release = r));
    await t.call('scan');
    await flush();
    const find = vi.spyOn(t.ble, 'find');
    await t.call('verify', { id: 'dev' });
    await flush();
    expect(find).not.toHaveBeenCalled(); // the slice has not returned yet
    release();
    await vi.waitFor(() => expect(t.results()).toHaveLength(1));
    expect(find).toHaveBeenCalledTimes(1);
    expect(t.ble.discovers).toBe(1); // the scan was cancelled, not continued
    expect(t.updates()).toEqual([]);
    expect(t.results()[0].ok).toBe(true);
    expect(t.results()[0].device?.name).toBe('dev');
  });

  it('reports not_timebox and timeout', async () => {
    const a = setup();
    a.ble.peripheral.services = [{ uuid: '180f', characteristics: [] }];
    await a.call('verify', { id: 'dev' });
    await vi.waitFor(() => expect(a.results()).toHaveLength(1));
    expect(a.results()[0]).toEqual({ ok: false, reason: 'not_timebox' });
    expect(a.logs).toContain('[pair] verify failed dev: not_timebox');

    const b = setup({ answer: false, verifyTimeoutMs: 150 });
    await b.call('verify', { id: 'dev' });
    await vi.waitFor(() => expect(b.results()).toHaveLength(1));
    expect(b.results()[0]).toEqual({ ok: false, reason: 'timeout' });
    expect(b.logs).toContain('[pair] verify failed dev: timeout');
  });

  it('rejects a verify without an id', async () => {
    const t = setup();
    await expect(Promise.resolve().then(() => t.call('verify', {}))).rejects.toThrow('missing device id');
    await expect(Promise.resolve().then(() => t.call('verify'))).rejects.toThrow('missing device id');
  });

  it('disconnect aborts a verification without a result', async () => {
    const t = setup({ answer: false });
    await t.call('verify', { id: 'dev' });
    await flush();
    await t.call('disconnect');
    await flush();
    await vi.waitFor(() => expect(t.ble.peripheral.disconnects).toBeGreaterThanOrEqual(1));
    expect(t.results()).toEqual([]);
  });
});

// --- overlapping events -------------------------------------------------------------------------------------------

describe('pair session races', () => {
  it('does not start a scan when the session disconnects while the previous scan is being stopped', async () => {
    const t = setup();
    let release!: () => void;
    t.ble.gate = new Promise<void>((r) => (release = r));
    await t.call('scan');
    await flush();
    const second = t.call('scan'); // waits for the in-flight slice of the first scan
    const disconnecting = t.call('disconnect');
    release();
    await Promise.all([second, disconnecting]);
    await flush();
    expect(t.ble.discovers).toBe(1);
    expect(t.updates()).toEqual([]);
    // and nothing starts afterwards either
    await t.call('scan');
    await t.call('verify', { id: 'dev' });
    await flush();
    expect(t.ble.discovers).toBe(1);
    expect(t.results()).toEqual([]);
  });

  it('lets only the newest of two overlapping scans run', async () => {
    const t = setup();
    let release!: () => void;
    t.ble.gate = new Promise<void>((r) => (release = r));
    await t.call('scan');
    await flush();
    const b = t.call('scan');
    const c = t.call('scan');
    release();
    await Promise.all([b, c]);
    await untilState(t, 'done');
    await flush();
    expect(t.updates().filter((u) => u.state === 'done')).toHaveLength(1);
    expect(t.ble.discovers).toBe(1 + 6); // the interrupted slice of the first scan plus one full scan
  });

  it('does not start a verification that a newer scan has replaced, and a scan waits for a running verification', async () => {
    const t = setup({ answer: false, verifyTimeoutMs: 60_000 });
    await t.call('verify', { id: 'dev' });
    await vi.waitFor(() => expect(t.ble.peripheral.notify.callback).not.toBeNull());
    const find = vi.spyOn(t.ble, 'find');
    let released = false;
    const disconnect = t.ble.peripheral.disconnect.bind(t.ble.peripheral);
    t.ble.peripheral.disconnect = async () => {
      await flush();
      released = true;
      return disconnect();
    };
    await t.call('scan'); // aborts the verification and waits until its link is closed
    expect(released).toBe(true);
    expect(t.results()).toEqual([]);
    await untilState(t, 'done');
    expect(find).not.toHaveBeenCalled();

    // verify then scan before the verification starts: the verification never connects
    const u = setup();
    let go!: () => void;
    u.ble.gate = new Promise<void>((r) => (go = r));
    await u.call('scan');
    await flush();
    await u.call('verify', { id: 'dev' });
    const findU = vi.spyOn(u.ble, 'find');
    const scanning = u.call('scan');
    go();
    await scanning;
    await untilState(u, 'done');
    expect(findU).not.toHaveBeenCalled();
    expect(u.results()).toEqual([]);
  });

  it('reports a throwing pairedIds as a failed scan instead of an unhandled rejection', async () => {
    const ble = fakeBle();
    const s = fakeSession();
    registerPairHandlers(s.session, {
      ble,
      pairedIds: () => {
        throw new Error('no devices');
      },
      log: () => undefined,
      now: () => ble.clock,
    });
    await s.call('scan');
    await vi.waitFor(() => expect(s.updates().some((u) => u.state === 'failed')).toBe(true));
    expect(s.updates().at(-1)).toMatchObject({ state: 'failed', error: 'no devices', candidates: [] });
  });
});
