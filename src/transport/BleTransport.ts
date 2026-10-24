// Transport on top of homey.ble (docs/divoom-protocol.md section 1.1). Homey is only imported as a type: the BLE
// manager is injected through the structural `BleManagerLike`, so the transport is unit tested with a fake.
import type Homey from 'homey';
import { NotConnectedError } from './errors';
import { DEFAULT_CHUNK_SIZE } from './chunk';
import { assertTimerMs, settleWithin } from './settle';
import { TransportError } from './Transport';
import type { LinkHandlers, Transport } from './Transport';

/** Evo GATT layout (VERIFIED, section 1.1). Homey reports UUIDs without dashes in lower case; compare normalised. */
export const SERVICE_UUID = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
export const WRITE_UUID = '49535343-8841-43f4-a8d4-ecbe34729bb3';
export const NOTIFY_UUID = '49535343-1e4d-4bd9-ba61-23c647249616';

export const normaliseUuid = (uuid: string): string => uuid.replace(/-/g, '').toLowerCase();

export interface BleCharacteristicLike {
  uuid: string;
  write(data: Buffer): Promise<unknown>;
  subscribeToNotifications(callback: (data: Buffer) => void): Promise<void>;
}

export interface BleServiceLike {
  uuid: string;
  characteristics: BleCharacteristicLike[];
}

export interface BlePeripheralLike {
  discoverAllServicesAndCharacteristics(): Promise<BleServiceLike[]>;
  disconnect(): Promise<void>;
  on(event: 'disconnect', listener: () => void): unknown;
  removeListener(event: 'disconnect', listener: () => void): unknown;
}

export interface BleAdvertisementLike {
  uuid: string;
  /** Not always present in Homey's advertisement; informational only (the pairing id is `uuid`). */
  address?: string;
  localName: string;
  rssi: number;
  /** Advertised service UUIDs; Homey may omit them, so treat absence as "unknown". */
  serviceUuids?: string[];
  connect(): Promise<BlePeripheralLike>;
}

export interface BleManagerLike {
  find(peripheralUuid: string): Promise<BleAdvertisementLike>;
  /** Resolves only after `timeout` ms (Homey default 10000), with everything seen in that window. */
  discover(serviceFilter?: string[], timeout?: number): Promise<BleAdvertisementLike[]>;
}

/** Compile-time proof that `homey.ble` satisfies `BleManagerLike`; returns it unchanged. */
export function asBleManager(ble: Homey.App['homey']['ble']): BleManagerLike {
  return ble;
}

/** Upper bound for one `peripheral.disconnect()`; a hung disconnect must not block the next connect. */
export const BLE_DISCONNECT_TIMEOUT_MS = 5_000;

/**
 * Upper bound for how long `open` waits for the previous connect/close to settle before it connects anyway. Kept well
 * below the ConnectionManager connect timeout (30 s), which also covers this wait.
 */
export const BLE_OPEN_WAIT_MS = 10_000;

/**
 * Homey invoked the notification callback 5 times per notification in the #21 hardware run (docs/divoom-protocol.md
 * section 10). A notification equal to the previous one is dropped when it is the same Buffer object (within 1 s) or
 * arrives within this window; the Evo never sends two identical chunks this close together.
 */
export const BLE_DUPLICATE_NOTIFY_WINDOW_MS = 20;

/** Longer window for a duplicate that is the very same Buffer object as the previous notification. */
export const BLE_DUPLICATE_SAME_BUFFER_WINDOW_MS = 1_000;

export interface BleTransportOptions {
  /** Default `BLE_DISCONNECT_TIMEOUT_MS`. */
  disconnectTimeoutMs?: number;
  /** Default `BLE_OPEN_WAIT_MS`. */
  openWaitMs?: number;
  /** Clock in ms for the duplicate-notification window, injectable for tests (default `Date.now`). */
  now?: () => number;
}

/** Everything `open` needs of one attempt; `cancelled` is set by `close()`, `started` once it may touch the radio. */
interface Attempt {
  cancelled: boolean;
  started: boolean;
  peripheral: BlePeripheralLike | null;
  onDisconnect: (() => void) | null;
  /** Stale connections of earlier attempts that were handed over to this one (see `release`). */
  orphans: BlePeripheralLike[];
}

const swallow = (): void => undefined;
const seconds = (ms: number): number => Math.round(ms / 100) / 10;

function describeServices(services: BleServiceLike[]): string {
  return services.map((s) => `${s.uuid}(${s.characteristics.map((c) => c.uuid).join(',')})`).join('; ');
}

export class BleTransport implements Transport {
  private readonly ble: BleManagerLike;
  private readonly peripheralUuid: string;
  private readonly log: (message: string) => void;
  private readonly disconnectTimeoutMs: number;
  private readonly openWaitMs: number;
  private readonly now: () => number;
  private attempt: Attempt | null = null;
  private writeChar: BleCharacteristicLike | null = null;
  /** Settles when the last open/close/release has finished (never rejects); the next `open` waits for it (bounded). */
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    ble: BleManagerLike,
    peripheralUuid: string,
    log: (message: string) => void = () => undefined,
    options: BleTransportOptions = {},
  ) {
    this.ble = ble;
    this.peripheralUuid = peripheralUuid;
    this.log = log;
    this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? BLE_DISCONNECT_TIMEOUT_MS;
    this.openWaitMs = options.openWaitMs ?? BLE_OPEN_WAIT_MS;
    this.now = options.now ?? Date.now;
    if (options.disconnectTimeoutMs !== undefined) assertTimerMs('disconnectTimeoutMs', options.disconnectTimeoutMs);
    if (options.openWaitMs !== undefined) assertTimerMs('openWaitMs', options.openWaitMs);
  }

  /**
   * Opens run one after another and behind any pending `close()`/release, so a late disconnect of an old attempt
   * cannot hit the peripheral of the new one. The wait is bounded by `openWaitMs`: a BLE call that never settles must
   * not block every later open; a stale attempt that finishes after that is kept off the new link by `release`. The
   * attempt is registered synchronously, so a `close()` that arrives while this `open` is still queued cancels it.
   */
  open(handlers: LinkHandlers): Promise<void> {
    const attempt: Attempt = { cancelled: false, started: false, peripheral: null, onDisconnect: null, orphans: [] };
    // A previous link that ended without close() (peripheral dropped) still owns a listener: release it first.
    const prior = this.attempt;
    if (prior) prior.cancelled = true;
    this.attempt = attempt;
    this.writeChar = null;
    const previous = this.inflight;
    const run = (async () => {
      const settled = await settleWithin(previous, this.openWaitMs);
      if (!settled && !attempt.cancelled) {
        this.log(`[ble] previous connect/disconnect still pending after ${seconds(this.openWaitMs)}s; opening anyway`);
      }
      if (prior) await this.release(prior);
      if (attempt.cancelled) throw new TransportError('closed while connecting');
      attempt.started = true;
      await this.connectAttempt(attempt, handlers);
    })();
    this.inflight = run.catch(swallow);
    return run;
  }

  private async connectAttempt(attempt: Attempt, handlers: LinkHandlers): Promise<void> {
    const cancelledError = () => new TransportError('closed while connecting');
    try {
      const advertisement = await this.ble.find(this.peripheralUuid);
      if (attempt.cancelled) throw cancelledError();
      const peripheral = await advertisement.connect();
      attempt.peripheral = peripheral;
      if (attempt.cancelled) throw cancelledError();
      attempt.onDisconnect = () => {
        if (!attempt.cancelled) handlers.onClose();
      };
      peripheral.on('disconnect', attempt.onDisconnect);

      const services = await peripheral.discoverAllServicesAndCharacteristics();
      if (attempt.cancelled) throw cancelledError();
      const service = services.find((s) => normaliseUuid(s.uuid) === normaliseUuid(SERVICE_UUID));
      const write = service?.characteristics.find((c) => normaliseUuid(c.uuid) === normaliseUuid(WRITE_UUID));
      const notify = service?.characteristics.find((c) => normaliseUuid(c.uuid) === normaliseUuid(NOTIFY_UUID));
      if (!service || !write || !notify) {
        this.log(`[ble] services: ${describeServices(services) || '(none)'}`);
        throw new TransportError(
          service ? 'Evo GATT characteristics not found' : 'Evo GATT service 49535343-fe7d not found',
          true,
        );
      }

      this.log(`[ble] services: ${describeServices(services)}`);

      // Subscribe before open resolves so no notification (e.g. the first poll reply) can be lost. The duplicate state
      // lives in this closure, so it is fresh for every attempt.
      let last: { source: unknown; copy: Uint8Array; at: number } | null = null;
      let duplicateLogged = false;
      await notify.subscribeToNotifications((data) => {
        if (attempt.cancelled) return;
        const at = this.now();
        // Homey passes a Buffer; compare through a Uint8Array view so that any Uint8Array works too.
        const view: Uint8Array =
          data instanceof Uint8Array
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : Uint8Array.from(data);
        // The bytes must equal the previous notification (compared with a copy, in case Homey reuses a Buffer) and it must
        // be recent: within the window, or, for the very same Buffer object, within the longer same-object window (a
        // reused Buffer must not swallow later identical replies for ever).
        const elapsed = last ? at - last.at : Infinity;
        const sameBytes =
          last !== null && last.copy.length === view.length && last.copy.every((byte, i) => byte === view[i]);
        const recent =
          elapsed <= BLE_DUPLICATE_NOTIFY_WINDOW_MS ||
          (last?.source === data && elapsed <= BLE_DUPLICATE_SAME_BUFFER_WINDOW_MS);
        if (sameBytes && recent) {
          if (!duplicateLogged) {
            duplicateLogged = true;
            this.log('[ble] duplicate notification dropped (Homey delivered it more than once)');
          }
          return;
        }
        const copy = Uint8Array.from(view);
        last = { source: data, copy, at };
        handlers.onData(copy.slice());
      });
      if (attempt.cancelled) throw cancelledError();
      this.writeChar = write;
    } catch (e) {
      await this.release(attempt);
      throw e;
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length > DEFAULT_CHUNK_SIZE) {
      throw new RangeError(`BLE write of ${bytes.length} bytes exceeds ${DEFAULT_CHUNK_SIZE}`);
    }
    const characteristic = this.writeChar;
    if (!characteristic) throw new NotConnectedError('BLE link is not open');
    await characteristic.write(Buffer.from(bytes));
  }

  async close(): Promise<void> {
    const attempt = this.attempt;
    this.attempt = null;
    this.writeChar = null;
    if (!attempt) return;
    const released = this.release(attempt);
    this.inflight = Promise.all([this.inflight, released]).then(swallow);
    await released;
  }

  /**
   * Cancel an attempt: stop its callbacks, drop the disconnect listener and disconnect (errors are swallowed, the
   * disconnect is bounded by `disconnectTimeoutMs`). A stale attempt that finishes late while a newer attempt is
   * already connecting or connected does not disconnect: both talk to the same device, so the disconnect could tear
   * down the newer link. Instead it hands its peripheral (and the orphans it holds itself) over to the newer attempt,
   * which disconnects them when its own link is torn down (including when it fails before it got a peripheral), so
   * a stale connection never loses its owner.
   */
  private async release(attempt: Attempt): Promise<void> {
    attempt.cancelled = true;
    if (this.attempt === attempt) {
      this.attempt = null;
      this.writeChar = null;
    }
    const { peripheral, onDisconnect, orphans } = attempt;
    attempt.peripheral = null;
    attempt.orphans = [];
    if (peripheral) {
      try {
        if (onDisconnect) peripheral.removeListener('disconnect', onDisconnect);
      } catch {
        // ignore
      }
    }
    // The same object may be listed twice (Homey hands out one object per device); disconnect it once.
    const targets = [...new Set(peripheral ? [peripheral, ...orphans] : orphans)];
    if (targets.length === 0) return;
    const newer = this.attempt;
    if (newer && newer !== attempt && newer.started) {
      for (const target of targets) if (!newer.orphans.includes(target)) newer.orphans.push(target);
      this.log('[ble] stale connect finished late; not disconnecting (a newer attempt owns the link)');
      return;
    }
    if (targets.some((target) => target !== peripheral)) {
      this.log('[ble] disconnecting a stale connection left by an earlier attempt');
    }
    const disconnecting = targets.map(async (target) => {
      try {
        await target.disconnect();
      } catch {
        // ignore
      }
    });
    if (!(await settleWithin(Promise.all(disconnecting), this.disconnectTimeoutMs))) {
      this.log(`[ble] disconnect did not finish within ${seconds(this.disconnectTimeoutMs)}s; continuing`);
    }
  }
}

/**
 * Total scan budget to find the Evo. The Evo alternates its advertised name (`TimeBox-Evo-audio` / `-light`), so the
 * short Homey default scan (~10 s) can miss it. Shared by the dev harness and the pairing flow (#22/#46).
 */
export const TIMEBOX_DISCOVERY_TIMEOUT_MS = 60_000;

/** Length of one `ble.discover` call; the scan is repeated until a Timebox shows up or the budget is spent. */
export const TIMEBOX_DISCOVERY_SCAN_MS = 10_000;

/**
 * Minimum length of one scan slice. A `ble.discover` that returns early (radio busy, or an implementation that ignores
 * the timeout) is padded with a pause, so the loop never calls discover back-to-back for the whole budget.
 */
export const TIMEBOX_DISCOVERY_MIN_SLICE_MS = 1_000;

/** The scan itself failed or found no Timebox; deliberately not a `TransportError` (no link was involved). */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    /** Wall-clock scan duration used, in ms. */
    readonly scannedMs: number,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

export interface DiscoveryOptions {
  /** Total budget in ms (default `TIMEBOX_DISCOVERY_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Length of one scan in ms (default `TIMEBOX_DISCOVERY_SCAN_MS`). */
  scanMs?: number;
  /** Minimum length of one slice in ms; a shorter scan is followed by a pause (default `TIMEBOX_DISCOVERY_MIN_SLICE_MS`). */
  minSliceMs?: number;
  /** Clock in ms, injectable for tests (default `Date.now`). */
  now?: () => number;
  /** Pause of `ms`, injectable for tests (default `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ScanOptions extends DiscoveryOptions {
  /** Polled before and after every slice; a cancelled scan ends without delivering the slice that just finished. */
  isCancelled?: () => boolean;
  /** Called with everything one slice saw and the elapsed ms; return true to end the scan early. */
  onSlice?: (advertisements: BleAdvertisementLike[], elapsedMs: number) => boolean | void;
}

export interface ScanResult {
  /** Wall-clock scan duration in ms. */
  elapsedMs: number;
  /** `budget`: the whole budget was used; `stopped`: `onSlice` returned true; `cancelled`: `isCancelled()` was true. */
  ended: 'budget' | 'stopped' | 'cancelled';
}

/**
 * Scan in slices (`scanMs` each, at least `minSliceMs` per slice including a pause after an early return) for the whole
 * `timeoutMs` budget, handing every slice to `onSlice`. Ends early only when `onSlice` returns true or `isCancelled()`
 * is true (checked between slices; a `ble.discover` in flight cannot be interrupted, so cancellation takes effect
 * after at most one slice). A failing slice throws a `DiscoveryError` with the scan duration.
 */
export async function scanPeripherals(ble: BleManagerLike, options: ScanOptions = {}): Promise<ScanResult> {
  const timeoutMs = options.timeoutMs ?? TIMEBOX_DISCOVERY_TIMEOUT_MS;
  const scanMs = options.scanMs ?? TIMEBOX_DISCOVERY_SCAN_MS;
  const minSliceMs = options.minSliceMs ?? TIMEBOX_DISCOVERY_MIN_SLICE_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const isCancelled = options.isCancelled ?? (() => false);
  const seconds = (ms: number): number => Math.round(ms / 1000);
  const started = now();
  for (;;) {
    if (isCancelled()) return { elapsedMs: now() - started, ended: 'cancelled' };
    const sliceStarted = now();
    const remaining = timeoutMs - (sliceStarted - started);
    if (remaining <= 0) break;
    let all: BleAdvertisementLike[];
    try {
      all = await ble.discover(undefined, Math.min(scanMs, remaining));
    } catch (e) {
      const elapsed = now() - started;
      throw new DiscoveryError(
        `discovery: scan failed after ${seconds(elapsed)} s: ${e instanceof Error ? e.message : String(e)}`,
        elapsed,
      );
    }
    if (isCancelled()) return { elapsedMs: now() - started, ended: 'cancelled' };
    if (options.onSlice?.(all, now() - started) === true) return { elapsedMs: now() - started, ended: 'stopped' };
    const pause = Math.min(minSliceMs - (now() - sliceStarted), timeoutMs - (now() - started));
    if (pause > 0) await sleep(pause);
  }
  return { elapsedMs: now() - started, ended: 'budget' };
}

const isTimebox = (a: BleAdvertisementLike): boolean => /timebox/i.test(a.localName ?? '');

/**
 * Timeboxes in range, strongest signal first, for the dev harness. Scans repeatedly (see `scanPeripherals`) and stops
 * at the first slice that sees a Timebox; throws `DiscoveryError` (with the scan duration in the message) when none is
 * seen within `timeoutMs` or when a scan throws. Matching on the name is acceptable for the dev harness only: pairing
 * does not filter on the name (`src/device/pairing.ts`).
 */
export async function discoverTimeboxes(
  ble: BleManagerLike,
  options: DiscoveryOptions = {},
): Promise<BleAdvertisementLike[]> {
  let found: BleAdvertisementLike[] = [];
  const { elapsedMs } = await scanPeripherals(ble, {
    ...options,
    onSlice: (all) => {
      found = all.filter(isTimebox);
      return found.length > 0;
    },
  });
  if (found.length > 0) return found.sort((a, b) => b.rssi - a.rssi);
  throw new DiscoveryError(`discovery: no Timebox found after ${Math.round(elapsedMs / 1000)} s`, elapsedMs);
}
